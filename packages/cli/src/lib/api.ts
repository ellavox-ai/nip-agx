import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
	type ActionRequiredReason,
	AgxCliError,
	EXIT,
	HumanActionRequiredError,
} from "./errors.js";
import { DEFAULT_API_BASE_URL } from "./config.js";
import { runtime } from "./runtime.js";
import { AGX_CLI_VERSION } from "./version.js";

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

/** What the CLI calls itself on the wire. */
export function userAgent(): string {
	return `agx/${AGX_CLI_VERSION} (node ${process.versions.node}; ${process.platform})`;
}

/** Just the two things a call needs; `orgSlug` travels in each input. */
export interface ApiTarget {
	baseUrl: string;
	apiKey: string;
}

export function createApiClient(creds: ApiTarget): AgxApiClient {
	const link = new RPCLink({
		url: `${creds.baseUrl}/api/rpc`,
		headers: async () => ({
			"Content-Type": "application/json",
			"User-Agent": userAgent(),
			"X-API-Key": creds.apiKey,
		}),
		// RPCLink already asks for `redirect: "manual"`. A 3xx then has a
		// non-error status, so the link would decode its (usually empty) body
		// as a successful result; refuse it here instead. The key never
		// follows a redirect, and a redirect is never a result.
		fetch: async (request, init) => {
			const response = await runtime().fetch(request, {
				...init,
				redirect: "manual",
			});
			if (response.status >= 300 && response.status < 400) {
				throw redirectRefused(response.status);
			}
			return response;
		},
	});
	return createORPCClient(link);
}

function redirectRefused(status: number): AgxCliError {
	return new AgxCliError(
		`The server answered with a redirect (HTTP ${status}). agx never follows a redirect with a credential, so nothing was sent on.`,
		{
			exitCode: EXIT.remote,
			remediation:
				"Point agx at the server's real origin:\n    agx config show   (check apiBaseUrl)",
		},
	);
}

/** True when the CLI is talking to an index on this machine, which is the only
 * case where "start it" is useful advice rather than confusing. */
function isLocal(baseUrl?: string): boolean {
	if (!baseUrl) {
		return false;
	}
	try {
		const host = new URL(baseUrl).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
	} catch {
		return false;
	}
}

/**
 * Hosts on the same site as the base host: the base host's parent domain and
 * everything under it (`app.ellaworks.ai` → `ellaworks.ai`, `www.ellaworks.ai`).
 * Without a public-suffix list this is an approximation, so it is only used for
 * the Terms URL, which the server serves from its marketing host.
 */
function isSameSite(candidate: URL, base: URL): boolean {
	if (candidate.protocol !== "https:" || base.protocol !== "https:") {
		return false;
	}
	const labels = base.hostname.split(".");
	if (labels.length < 2 || /^[\d.]+$/.test(base.hostname)) {
		return false;
	}
	const site =
		labels.length >= 3 ? labels.slice(1).join(".") : base.hostname;
	return (
		candidate.hostname === site || candidate.hostname.endsWith(`.${site}`)
	);
}

/**
 * Turn a server-supplied URL into one that is safe to hand to a human.
 *
 * A relative URL is resolved against OUR base (the server's own idea of its
 * origin can differ on preview deploys). An absolute URL on our origin is kept.
 * Anything else — another origin, `//evil.example`, `javascript:` — is replaced
 * by `${base}/elladex`, so a response can never send the person somewhere the
 * CLI is not already talking to. `sameSite` additionally admits https hosts on
 * the base's own site (the Terms page).
 */
export function resolveActionUrl(
	url: unknown,
	baseUrl: string,
	options?: { sameSite?: boolean },
): string {
	const base = new URL(baseUrl);
	const fallback = `${base.origin}/elladex`;
	if (typeof url !== "string" || url.trim() === "") {
		return fallback;
	}
	let resolved: URL;
	try {
		resolved = new URL(url, `${base.origin}/`);
	} catch {
		return fallback;
	}
	if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
		return fallback;
	}
	resolved.username = "";
	resolved.password = "";
	if (resolved.origin === base.origin) {
		return resolved.toString();
	}
	if (options?.sameSite && isSameSite(resolved, base)) {
		return resolved.toString();
	}
	return fallback;
}

/** The fields of `ORPCError.data` the CLI branches on (spec §1.7). */
interface ErrorData {
	code?: unknown;
	message?: unknown;
	url?: unknown;
	listingId?: unknown;
	required?: unknown;
	granted?: unknown;
	retryAfterMs?: unknown;
	termsVersion?: unknown;
	loginRequired?: unknown;
}

interface OrpcErrorLike {
	code?: string;
	status?: number;
	message?: string;
	cause?: { code?: string };
	data?: ErrorData;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** The reasons whose fix is a click in a browser (exit 7). */
const HUMAN_ACTION_CODES: Record<string, ActionRequiredReason> = {
	HUMAN_CONFIRMATION_REQUIRED: "HUMAN_CONFIRMATION_REQUIRED",
	TERMS_ACCEPTANCE_REQUIRED: "TERMS_ACCEPTANCE_REQUIRED",
};

/**
 * Map a server error with a `data.code` (spec §1.7). Returns null for a code
 * this CLI does not know, so the status-based fallbacks below still apply.
 */
function fromDataCode(
	data: ErrorData,
	context: string,
	baseUrl: string | undefined,
): AgxCliError | null {
	const code = str(data.code);
	if (!code) {
		return null;
	}

	const reason = HUMAN_ACTION_CODES[code];
	if (reason) {
		const base = baseUrl ?? DEFAULT_API_BASE_URL;
		const url = resolveActionUrl(data.url, base, {
			sameSite: reason === "TERMS_ACCEPTANCE_REQUIRED",
		});
		const listingId = str(data.listingId);
		if (reason === "HUMAN_CONFIRMATION_REQUIRED") {
			return new HumanActionRequiredError(
				`${context}: an organization admin has to confirm this in the browser: ${url}`,
				{
					reason,
					url,
					userCode: null,
					expiresIn: null,
					...(listingId ? { listingId } : {}),
				},
				"Open the link (or send it to an org admin) and publish there. Nothing else will make the listing public.",
			);
		}
		return new HumanActionRequiredError(
			`${context}: the current Terms have to be accepted first: ${url}`,
			{ reason, url, userCode: null, expiresIn: null },
			data.loginRequired === true
				? "Accept them by logging in again:\n    agx login"
				: "Accept them in the browser, then re-run the command.",
		);
	}

	switch (code) {
		case "INSUFFICIENT_SCOPE": {
			const required = str(data.required);
			return new AgxCliError(
				`${context}: this login covers listings and domains only; \`${context}\` needs a key from Settings${required ? ` (it needs ${required})` : ""}.`,
				{
					exitCode: EXIT.auth,
					remediation:
						"Mint a key in Settings → API keys and give it its own profile:\n    printf %s \"$KEY\" | agx --profile settings-key config set apiKey --stdin",
				},
			);
		}
		case "API_KEY_INVALID":
			return new AgxCliError(
				`${context}: the API key is not valid (unknown, revoked or deleted).`,
				{ exitCode: EXIT.auth, remediation: "agx login" },
			);
		case "API_KEY_EXPIRED":
			return new AgxCliError(`${context}: the API key has expired.`, {
				exitCode: EXIT.auth,
				remediation: "agx login",
			});
		case "API_KEY_DISABLED":
			return new AgxCliError(`${context}: the API key is disabled.`, {
				exitCode: EXIT.auth,
				remediation:
					"Re-enable it in Settings → API keys, or log in for a new one:\n    agx login",
			});
		case "API_KEY_OWNER_NOT_MEMBER":
			return new AgxCliError(
				`${context}: the account that owns this key is no longer a member of its organization.`,
				{
					exitCode: EXIT.auth,
					remediation:
						"Log in with an account that belongs to the organization:\n    agx login --force",
				},
			);
		case "API_KEY_RATE_LIMITED": {
			const ms =
				typeof data.retryAfterMs === "number" ? data.retryAfterMs : null;
			return new AgxCliError(
				`${context}: this key is rate limited${ms !== null ? ` for ${Math.ceil(ms / 1000)} s` : ""}.`,
				{
					exitCode: EXIT.remote,
					remediation:
						"Wait, then retry. The limit resets only after a quiet gap, so retrying in a tight loop keeps it locked.",
				},
			);
		}
		case "API_KEY_USAGE_EXCEEDED":
			return new AgxCliError(
				`${context}: this key has used up its lifetime request quota.`,
				{
					exitCode: EXIT.remote,
					remediation:
						"Mint a new key, or log in for one that has no quota:\n    agx login",
				},
			);
		case "API_KEY_SELF_REVOKE_ONLY":
			return new AgxCliError(
				`${context}: an API key may only revoke itself.`,
				{
					exitCode: EXIT.remote,
					remediation: "Revoke other keys in Settings → API keys.",
				},
			);
		case "LISTING_SLUG_TAKEN":
			return new AgxCliError(
				`${context}: that listing slug is already taken in this organization.`,
				{
					exitCode: EXIT.remote,
					remediation: "Pick another one: use --slug <another-slug>.",
				},
			);
		case "LISTING_ADDRESS_LIVE": {
			const listingId = str(data.listingId);
			return new AgxCliError(
				`${context}: this agent address is already listed${listingId ? ` (listing ${listingId} in this organization)` : " by another organization"}.`,
				{
					exitCode: EXIT.remote,
					remediation: listingId
						? `Work with the existing listing:\n    agx listing get ${listingId}`
						: "An address can be live in only one listing. Use another identity for a new listing:\n    agx --profile <name> identity new",
				},
			);
		}
		default:
			// An unknown code from a newer server: fall through to the status
			// mapping, with the server's own message.
			return null;
	}
}

/**
 * Did the server refuse the KEY itself — unknown, revoked, deleted or expired?
 * Only then may agx forget a key without revoking it.
 *
 * A 404 is never that: an API-key caller whose key the server does not know
 * gets 401 `API_KEY_INVALID` (spec §1.6, §1.7), so a 404 means the procedure
 * is missing (a server without it, a proxy, a wrong path) and the key may
 * well still work. A disabled key still exists and can be re-enabled, and a
 * 0.3 server's "missing organization scope" 401 names a key that exists too.
 */
export function isKeyRejected(error: unknown): boolean {
	if (error instanceof AgxCliError) {
		return false;
	}
	const err = error as OrpcErrorLike;
	const dataCode = str(err?.data?.code);
	if (dataCode) {
		return dataCode === "API_KEY_INVALID" || dataCode === "API_KEY_EXPIRED";
	}
	if (err?.status !== 401 && err?.code !== "UNAUTHORIZED") {
		return false;
	}
	return !/organization scope/i.test(err?.message ?? "");
}

/**
 * Turn a transport or oRPC failure into something with a next action.
 *
 * `data.code` (spec §1.7) is consulted FIRST, then the oRPC code/status, and
 * the 0.3 message regexes only as a last resort for servers that predate
 * `data.code`.
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
	const message =
		str(err?.data?.message) ?? err?.message ?? String(error);

	if (err?.data && typeof err.data === "object") {
		const mapped = fromDataCode(err.data, context, baseUrl);
		if (mapped) {
			return mapped;
		}
	}

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

	// A 3xx the link decoded anyway, or an HTML error page: never a result.
	if (/Cannot parse response body/i.test(message)) {
		return new AgxCliError(
			`${context}: the server's answer was not an API response (a redirect or an HTML page).`,
			{
				exitCode: EXIT.remote,
				remediation:
					"Check that apiBaseUrl is the API's own origin:\n    agx config show",
			},
		);
	}

	if (code === "UNAUTHORIZED" || err?.status === 401) {
		const unscoped = /organization scope/i.test(message);
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.auth,
			remediation: unscoped
				? "This key carries no organization scope, so it cannot act on any org. Log in for a key bound to an organization:\n    agx login"
				: "agx login",
		});
	}

	if (code === "FORBIDDEN" || err?.status === 403) {
		if (/does not have access to this organization/i.test(message)) {
			return new AgxCliError(`${context}: ${message}`, {
				exitCode: EXIT.auth,
				remediation:
					"An API key is bound to a single organization and cannot act on another. Log in to this organization, or switch profiles:\n    agx login --org <slug>\n    agx config use <profile>",
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

	if (code === "CONFLICT" || err?.status === 409) {
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.remote,
			remediation: /already listed/i.test(message)
				? "This agent address already has a live listing. Find it with:\n    agx listing list"
				: null,
		});
	}

	if (code === "PRECONDITION_FAILED" || err?.status === 412) {
		return new AgxCliError(`${context}: ${message}`, {
			exitCode: EXIT.remote,
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
