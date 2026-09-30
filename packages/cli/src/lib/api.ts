import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ApiCredentials } from "./config.js";
import { AgxCliError, EXIT } from "./errors.js";

/**
 * oRPC client over the Agent Index HTTP surface, following the existing pattern
 * in `apps/cli/src/lib/registry-client.ts`: an `RPCLink` at `${base}/api/rpc`
 * authenticated with `X-API-Key`.
 *
 * `X-API-Key` rather than `Authorization: Bearer` deliberately — the bearer path
 * only routes to API-key verification for tokens matching the index's key prefix,
 * while the header is accepted verbatim, so a renamed key prefix cannot silently
 * turn into a session-auth attempt.
 *
 * Every procedure takes `orgSlug` as an INPUT FIELD, not a header, and the key's
 * `metadata.organizationId` must resolve to that same organization.
 */

/**
 * The oRPC client is only statically typed when the SERVER ROUTER TYPE is
 * imported — which would pull the index's server package into this one and break
 * the open-source boundary. Call sites declare the response shapes they rely on
 * instead, so the untyped surface stops at this seam.
 */
export type AgxApiClient = any;

export function createApiClient(creds: ApiCredentials): AgxApiClient {
	const link = new RPCLink({
		url: `${creds.baseUrl}/api/rpc`,
		headers: async () => ({
			"Content-Type": "application/json",
			"X-API-Key": creds.apiKey,
		}),
	});
	return createORPCClient(link);
}

/** True when the CLI is talking to an index on this machine, which is the only
 * case where "start it" is useful advice rather than confusing. */
function isLocal(baseUrl?: string): boolean {
	if (!baseUrl) {
		return false;
	}
	try {
		const host = new URL(baseUrl).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "::1";
	} catch {
		return false;
	}
}

interface OrpcErrorLike {
	code?: string;
	status?: number;
	message?: string;
	cause?: { code?: string };
	data?: { message?: string };
}

/**
 * Turn a transport or oRPC failure into something with a next action. The three
 * that actually happen in this workflow — index unreachable, key unscoped, key
 * bound to another org — are indistinguishable from a generic 500 otherwise.
 */
export function toCliError(
	error: unknown,
	context: string,
	baseUrl?: string,
): AgxCliError {
	if (error instanceof AgxCliError) {
		return error;
	}
	const err = error as OrpcErrorLike;
	const code = err?.code ?? err?.cause?.code;
	const message = err?.data?.message ?? err?.message ?? String(error);

	if (
		code === "ECONNREFUSED" ||
		code === "ENOTFOUND" ||
		code === "ETIMEDOUT" ||
		/fetch failed/i.test(message)
	) {
		return new AgxCliError(
			`${context}: cannot reach the API (${message}).`,
			{
				exitCode: EXIT.network,
				// "Start it" is only offered when the target actually is local; for a real
				// deployment the useful check is the configured URL.
				remediation: isLocal(baseUrl)
					? `Start the agent index at ${baseUrl}, then re-run the command.\n  To use a different index:  agx config set apiBaseUrl <url>`
					: "Check the API is running and that `apiBaseUrl` is correct:\n    agx config show",
			},
		);
	}

	if (code === "UNAUTHORIZED" || err?.status === 401) {
		const unscoped = /organization scope/i.test(message);
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.auth,
			remediation: unscoped
				? "This key carries no organization scope, so it cannot act on any org. Mint one that is bound to an organization."
				: "Mint a fresh key, then:\n    agx config set apiKey <key>",
		});
	}

	if (code === "FORBIDDEN" || err?.status === 403) {
		if (/does not have access to this organization/i.test(message)) {
			return new AgxCliError(`${context}: ${message}`, {
				exitCode: EXIT.auth,
				remediation:
					"An API key is bound to a single organization and cannot act on another. Mint a key for this organization, or switch profiles:\n    agx config use <profile>",
			});
		}
		if (/[Pp]rove possession/.test(message)) {
			return new AgxCliError(`${context}: ${message}`, {
				exitCode: EXIT.remote,
				remediation:
					"This is the anti-squatting control working. Run the proof flow:\n    agx register --slug <slug> --display-name <name> --capability <key>",
			});
		}
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.remote,
		});
	}

	if (code === "NOT_FOUND" || err?.status === 404) {
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.remote,
			remediation: /Organization not found/i.test(message)
				? "Check the organization slug your API key belongs to:\n    agx config set orgSlug <slug>"
				: null,
		});
	}

	if (code === "TOO_MANY_REQUESTS" || err?.status === 429) {
		return new AgxCliError(`${context}: rate limited (${message}).`, {
			exitCode: EXIT.remote,
			remediation: "Wait a moment and retry.",
		});
	}

	if (code === "UNPROCESSABLE_CONTENT" || err?.status === 422) {
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.remote,
		});
	}

	return new AgxCliError(`${context}: ${message}`, {
		exitCode: EXIT.generic,
	});
}
