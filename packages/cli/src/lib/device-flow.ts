import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { userAgent } from "./api.js";
import { AgxCliError, authError, EXIT, networkError } from "./errors.js";
import {
	ensureDir,
	pendingLoginPath,
	removePrivateFile,
	writePrivateJson,
} from "./paths.js";
import { type Runtime, runtime, timeoutSignal } from "./runtime.js";

/**
 * The CLI half of the device authorization grant (RFC 8628) as the index
 * implements it (spec §1.2, §1.3): plain `fetch`, JSON bodies, never a
 * redirect, and nothing from a response body ever echoed into an error — the
 * one body that matters holds the key.
 */

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const AGX_CLIENT_ID = "agx";
/** Canonical order (spec §1.1). `:write` does not imply `:read`, so all four. */
export const AGX_SCOPES = [
	"listings:read",
	"listings:write",
	"domains:read",
	"domains:write",
] as const;
export const AGX_SCOPE_STRING = AGX_SCOPES.join(" ");

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const SLOW_DOWN_STEP_SECONDS = 5;
const DEFAULT_INTERVAL_SECONDS = 5;

export interface DeviceCodeRequest {
	clientId: typeof AGX_CLIENT_ID;
	scope: string;
	hostLabel: string;
	orgHint?: string | null;
	newOrg?: boolean;
	newOrgName?: string | null;
	newOrgSlug?: string | null;
}

/** What `agx login` asked for, so a re-run resumes only the same request. */
export const loginRequestSchema = z.object({
	orgHint: z.string().nullable(),
	newOrg: z.boolean(),
	newOrgName: z.string().nullable(),
	newOrgSlug: z.string().nullable(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** `profiles/<name>/pending-login.json`. Holds the device code, so `0600`. */
export const pendingLoginSchema = z.object({
	version: z.literal(1),
	apiBaseUrl: z.string(),
	clientId: z.literal(AGX_CLIENT_ID),
	deviceCode: z.string().min(1),
	userCode: z.string().min(1),
	verificationUri: z.string(),
	verificationUriComplete: z.string(),
	scope: z.string(),
	/** Seconds. Only ever raised (RFC 8628 §3.5). */
	interval: z.number().positive(),
	expiresAt: z.string(),
	createdAt: z.string(),
	/** When this code was last polled, by any agx process. */
	lastPolledAt: z.string().nullable(),
	hostLabel: z.string(),
	request: loginRequestSchema,
	/** The login key this code will replace, if any. A credential with any
	 * other id that appears while the code is pending came from this code. */
	replacesApiKeyId: z.string().nullable().default(null),
});
export type PendingLogin = z.infer<typeof pendingLoginSchema>;

/** The §1.3 success body. `organization` and `api_key_id` are required: a key
 * without them could not be bound or revoked, so it is never stored. */
const tokenSuccessSchema = z.object({
	access_token: z.string().min(1),
	token_type: z.string(),
	expires_in: z.number().nullable().optional(),
	expires_at: z.string().nullable().optional(),
	scope: z.string().optional(),
	api_key_id: z.string().min(1),
	user: z.object({
		id: z.string(),
		email: z.string().nullable().optional(),
		name: z.string().nullable().optional(),
	}),
	organization: z.object({
		id: z.string(),
		slug: z.string(),
		name: z.string(),
	}),
});
export type DeviceTokenSuccess = z.infer<typeof tokenSuccessSchema>;

const codeResponseSchema = z.object({
	device_code: z.string().min(1),
	user_code: z.string().min(1),
	verification_uri: z.string().min(1),
	verification_uri_complete: z.string().min(1).optional(),
	expires_in: z.number().positive(),
	interval: z.number().positive().optional(),
	scope: z.string().optional(),
});

export type DeviceFlowDeps = Runtime & { signal?: AbortSignal };

function resolveDeps(partial?: Partial<DeviceFlowDeps>): DeviceFlowDeps {
	return { ...runtime(), ...partial };
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** C0/C1 controls (ANSI escapes included), line and paragraph separators,
 * and bidi overrides. Built from code points so no separator ever sits raw in
 * this source file. */
const c = (code: number) => String.fromCharCode(code);
const UNSAFE_TEXT = new RegExp(
	`[${c(0x00)}-${c(0x1f)}${c(0x7f)}-${c(0x9f)}${c(0x2028)}${c(0x2029)}${c(0x202a)}-${c(0x202e)}${c(0x2066)}-${c(0x2069)}]`,
	"g",
);

/** Server-supplied text, made safe to print: no control characters (no ANSI,
 * no fake lines), and short. */
export function sanitizeServerText(text: unknown): string | null {
	if (typeof text !== "string") {
		return null;
	}
	const clean = text.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim();
	return clean ? clean.slice(0, 200) : null;
}

interface RawResponse {
	status: number;
	headers: Headers;
	/** The parsed body when it was a JSON object. */
	body: Record<string, unknown> | null;
}

class InterruptedError extends AgxCliError {}

function interrupted(): AgxCliError {
	return new InterruptedError("Interrupted.", {
		exitCode: EXIT.interrupted,
		remediation:
			"The login code stays valid until it expires. Resume it with the same command:\n    agx login",
	});
}

async function postJson(
	deps: DeviceFlowDeps,
	url: string,
	body: Record<string, unknown>,
): Promise<RawResponse> {
	let response: Response;
	try {
		response = await deps.fetch(url, {
			method: "POST",
			redirect: "manual",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"User-Agent": userAgent(),
			},
			body: JSON.stringify(body),
			signal: timeoutSignal(REQUEST_TIMEOUT_MS, deps.signal),
		});
	} catch (error) {
		if (deps.signal?.aborted) {
			throw interrupted();
		}
		throw error;
	}
	let parsed: Record<string, unknown> | null = null;
	try {
		const text = await response.text();
		const value: unknown = JSON.parse(text);
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			parsed = value as Record<string, unknown>;
		}
	} catch {
		parsed = null;
	}
	return { status: response.status, headers: response.headers, body: parsed };
}

function redirectRefused(status: number, what: string): AgxCliError {
	return new AgxCliError(
		`${what}: the server answered with a redirect (HTTP ${status}), which agx never follows during login.`,
		{
			exitCode: EXIT.remote,
			remediation:
				"Use the server's real origin:\n    agx login --api-base-url https://<host>",
		},
	);
}

function sameOrigin(url: string, base: string): boolean {
	try {
		return new URL(url).origin === new URL(base).origin;
	} catch {
		return false;
	}
}

/** Seconds from a `Retry-After` header (delta-seconds or an HTTP date). */
export function retryAfterSeconds(
	headers: Headers,
	now: number,
): number | null {
	const value = headers.get("retry-after");
	if (!value) {
		return null;
	}
	if (/^\d+$/.test(value.trim())) {
		return Number(value.trim());
	}
	const at = Date.parse(value);
	return Number.isFinite(at)
		? Math.max(0, Math.ceil((at - now) / 1000))
		: null;
}

/**
 * `POST {base}/api/auth/device/code` (spec §1.2).
 *
 * Aborts BEFORE a code is ever shown when the answer does not prove a Phase 1
 * server: no `scope` echo means the server would mint an unscoped key that
 * never expires; a verification URI on another origin means the code would be
 * typed into someone else's page.
 */
export async function requestDeviceCode(
	base: string,
	request: DeviceCodeRequest,
	partialDeps?: Partial<DeviceFlowDeps>,
): Promise<PendingLogin> {
	const deps = resolveDeps(partialDeps);
	const body: Record<string, unknown> = {
		client_id: request.clientId,
		scope: request.scope,
		host_label: request.hostLabel,
	};
	if (request.orgHint) {
		body.org_hint = request.orgHint;
	}
	if (request.newOrg) {
		body.new_org = true;
		if (request.newOrgName) {
			body.new_org_name = request.newOrgName;
		}
		if (request.newOrgSlug) {
			body.new_org_slug = request.newOrgSlug;
		}
	}

	const host = new URL(base).host;
	let response: RawResponse;
	try {
		response = await postJson(deps, `${base}/api/auth/device/code`, body);
	} catch (error) {
		if (error instanceof AgxCliError) {
			throw error;
		}
		throw networkError(
			`Cannot reach ${host} to start the login.`,
			"Check your connection and the server address, then re-run:\n    agx login",
		);
	}

	if (response.status >= 300 && response.status < 400) {
		throw redirectRefused(response.status, "Starting the login");
	}
	if (response.status === 429) {
		const wait = retryAfterSeconds(response.headers, deps.now());
		throw new AgxCliError(
			`${host} is rate limiting login requests.`,
			{
				exitCode: EXIT.remote,
				remediation: `Wait${wait !== null ? ` ${wait} s` : " a minute"}, then re-run:\n    agx login`,
			},
		);
	}
	if (response.status >= 500) {
		throw networkError(
			`${host} failed to start the login (HTTP ${response.status}).`,
			"Retry in a moment:\n    agx login",
		);
	}
	if (response.status !== 200 || !response.body) {
		const error = sanitizeServerText(response.body?.error);
		const description = sanitizeServerText(response.body?.error_description);
		throw new AgxCliError(
			`${host} refused to start the login${error ? ` (${error}${description ? `: ${description}` : ""})` : ` (HTTP ${response.status})`}.`,
			{
				exitCode: EXIT.remote,
				remediation:
					error === "invalid_request"
						? "Check --org / --new-org / --org-name / --org-slug and re-run."
						: "This server may not support `agx login` yet. Check the server address:\n    agx login --api-base-url https://<host>",
			},
		);
	}

	const parsed = codeResponseSchema.safeParse(response.body);
	if (!parsed.success) {
		throw new AgxCliError(
			`${host} answered the login request with an unexpected shape.`,
			{ exitCode: EXIT.remote },
		);
	}
	const code = parsed.data;
	if (!code.scope || code.scope.trim() === "") {
		throw new AgxCliError(
			`${host} does not support scoped logins yet: this server would issue an unscoped key that never expires, so agx stopped before showing a code.`,
			{
				exitCode: EXIT.remote,
				remediation:
					"Wait until the server supports `agx login`, or use a key minted in Settings:\n    printf %s \"$KEY\" | agx config set apiKey --stdin",
			},
		);
	}
	const complete =
		code.verification_uri_complete ??
		`${code.verification_uri}?code=${encodeURIComponent(code.user_code)}`;
	if (
		!sameOrigin(code.verification_uri, base) ||
		!sameOrigin(complete, base)
	) {
		throw new AgxCliError(
			`${host} sent a verification page on another origin, so agx stopped before showing a code.`,
			{
				exitCode: EXIT.remote,
				remediation:
					"A login code is only ever entered on the server you are logging in to. Check the server address.",
			},
		);
	}

	const now = deps.now();
	return {
		version: 1,
		apiBaseUrl: base,
		clientId: AGX_CLIENT_ID,
		deviceCode: code.device_code,
		userCode: code.user_code,
		verificationUri: code.verification_uri,
		verificationUriComplete: complete,
		scope: code.scope,
		interval: code.interval ?? DEFAULT_INTERVAL_SECONDS,
		expiresAt: iso(now + code.expires_in * 1000),
		createdAt: iso(now),
		lastPolledAt: null,
		hostLabel: request.hostLabel,
		request: {
			orgHint: request.orgHint ?? null,
			newOrg: Boolean(request.newOrg),
			newOrgName: request.newOrgName ?? null,
			newOrgSlug: request.newOrgSlug ?? null,
		},
		replacesApiKeyId: null,
	};
}

export type PollOutcome =
	| { kind: "approved"; token: DeviceTokenSuccess; pending: PendingLogin }
	/** `once` only: the code is still waiting for the human. */
	| { kind: "pending"; pending: PendingLogin }
	/** Another agx process finished this login; its credential is on disk. */
	| { kind: "recovered"; pending: PendingLogin };

export interface PollOptions {
	/** Poll once (after waiting out the interval), then report. */
	once?: boolean;
	/** Called whenever `lastPolledAt` or `interval` changes. */
	persist?: (pending: PendingLogin) => void;
	/** After `invalid_grant`: did another process already store this login? */
	recover?: () => boolean;
}

function codeExpired(): AgxCliError {
	return authError(
		"The login code expired before it was approved.",
		"Start again for a fresh code:\n    agx login",
	);
}

/**
 * Poll `POST {base}/api/auth/device/token` until the code is approved, denied
 * or expired (spec §1.3).
 *
 * - waits at least `interval` between polls, measured from the last poll by
 *   ANY process (`lastPolledAt` is persisted);
 * - `slow_down` raises the interval to the response's `interval`, else by 5 s,
 *   for the rest of the code's life; a 429 or an HTML page is treated as one,
 *   honouring `Retry-After`;
 * - 5xx and network failures back off (interval·2ⁿ, at most 30 s) and give up
 *   with exit 5 after five in a row;
 * - a redirect is refused (exit 6) and never followed.
 */
export async function pollDeviceToken(
	base: string,
	pending: PendingLogin,
	options: PollOptions = {},
	partialDeps?: Partial<DeviceFlowDeps>,
): Promise<PollOutcome> {
	const deps = resolveDeps(partialDeps);
	const host = new URL(base).host;
	let current: PendingLogin = { ...pending };
	const deadline = Date.parse(current.expiresAt);
	let failures = 0;
	/** Extra spacing on top of `interval` (backoff or Retry-After), in ms. */
	let spacingMs = 0;

	const save = () => options.persist?.(current);

	for (;;) {
		const reference = Date.parse(current.lastPolledAt ?? current.createdAt);
		const gapMs = Math.max(current.interval * 1000, spacingMs);
		const waitMs = Math.min(
			Math.max(0, reference + gapMs - deps.now()),
			Math.max(0, deadline - deps.now()),
		);
		if (waitMs > 0) {
			try {
				await deps.sleep(waitMs, deps.signal);
			} catch {
				throw interrupted();
			}
		}
		if (deps.signal?.aborted) {
			throw interrupted();
		}
		if (deps.now() >= deadline) {
			throw codeExpired();
		}

		current = { ...current, lastPolledAt: iso(deps.now()) };
		save();

		let response: RawResponse | null = null;
		try {
			response = await postJson(deps, `${base}/api/auth/device/token`, {
				grant_type: DEVICE_GRANT_TYPE,
				device_code: current.deviceCode,
				client_id: current.clientId,
			});
		} catch (error) {
			if (error instanceof InterruptedError) {
				throw error;
			}
			response = null;
		}

		if (response === null || response.status >= 500) {
			failures += 1;
			if (options.once || failures >= MAX_CONSECUTIVE_FAILURES) {
				throw networkError(
					response === null
						? `Cannot reach ${host} to finish the login${failures > 1 ? ` (${failures} attempts)` : ""}.`
						: `${host} keeps failing (HTTP ${response.status}) while finishing the login.`,
					"The code stays valid until it expires. Resume it with the same command:\n    agx login",
				);
			}
			spacingMs = Math.min(
				current.interval * 1000 * 2 ** failures,
				MAX_BACKOFF_MS,
			);
			continue;
		}

		if (response.status >= 300 && response.status < 400) {
			throw redirectRefused(response.status, "Finishing the login");
		}

		failures = 0;
		spacingMs = 0;

		if (response.status === 429 || response.body === null) {
			// Throttled by something in front of the API (or an HTML page in its
			// place): back off as for slow_down, and never sooner than asked.
			current = {
				...current,
				interval: current.interval + SLOW_DOWN_STEP_SECONDS,
			};
			const retryAfter = retryAfterSeconds(response.headers, deps.now());
			if (retryAfter !== null) {
				spacingMs = retryAfter * 1000;
			}
			save();
			if (options.once) {
				return { kind: "pending", pending: current };
			}
			continue;
		}

		if (response.status === 200) {
			const parsed = tokenSuccessSchema.safeParse(response.body);
			if (!parsed.success) {
				// Name the missing fields only: the body holds the key.
				const fields = [
					...new Set(
						parsed.error.issues.map((issue) =>
							String(issue.path[0] ?? "body"),
						),
					),
				].filter((field) => field !== "access_token");
				throw new AgxCliError(
					`${host} approved the login but its answer is missing ${fields.join(", ") || "required fields"}; the key was not stored.`,
					{
						exitCode: EXIT.remote,
						remediation:
							"Revoke the new key in Settings → API keys, then report this server bug.",
					},
				);
			}
			return { kind: "approved", token: parsed.data, pending: current };
		}

		const error =
			typeof response.body.error === "string" ? response.body.error : null;
		switch (error) {
			case "authorization_pending":
				if (options.once) {
					return { kind: "pending", pending: current };
				}
				continue;
			case "slow_down": {
				const asked =
					typeof response.body.interval === "number" &&
					response.body.interval > 0
						? response.body.interval
						: current.interval + SLOW_DOWN_STEP_SECONDS;
				current = {
					...current,
					interval: Math.max(current.interval, asked),
				};
				save();
				if (options.once) {
					return { kind: "pending", pending: current };
				}
				continue;
			}
			case "expired_token":
				throw codeExpired();
			case "access_denied":
				throw authError(
					"The login was denied in the browser.",
					"Start again if that was a mistake:\n    agx login",
				);
			case "invalid_grant":
				if (options.recover?.()) {
					return { kind: "recovered", pending: current };
				}
				throw authError(
					"The server no longer accepts this login code (already used, or unknown).",
					"Start again:\n    agx login",
				);
			default:
				throw new AgxCliError(
					`${host} refused agx's token request (${sanitizeServerText(error) ?? `HTTP ${response.status}`}).`,
					{
						exitCode: EXIT.remote,
						remediation:
							"Upgrade agx (npm install -g @nostr-agx/cli), then start again:\n    agx login",
					},
				);
		}
	}
}

// ------------------------------------------------------------ pending file

export function loadPendingLogin(profile: string): PendingLogin | null {
	const path = pendingLoginPath(profile);
	if (!existsSync(path)) {
		return null;
	}
	try {
		const parsed = pendingLoginSchema.safeParse(
			JSON.parse(readFileSync(path, "utf8")),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function savePendingLogin(profile: string, pending: PendingLogin): void {
	writePrivateJson(pendingLoginPath(profile), pending);
}

export function removePendingLogin(profile: string): boolean {
	return removePrivateFile(pendingLoginPath(profile));
}

// ------------------------------------------------------------------- lock

/** A lock younger than this whose owner cannot be read is still being written. */
const LOCK_GRACE_MS = 5_000;

function lockIsStale(path: string): boolean {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return true;
	}
	let pid: unknown;
	try {
		pid = (JSON.parse(raw) as { pid?: unknown }).pid;
	} catch {
		pid = undefined;
	}
	if (typeof pid !== "number") {
		try {
			return Date.now() - statSync(path).mtimeMs > LOCK_GRACE_MS;
		} catch {
			return true;
		}
	}
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		// EPERM: the process exists but is not ours, so the lock is live.
		return (error as NodeJS.ErrnoException).code !== "EPERM";
	}
}

/**
 * Take the per-profile poll lock with `O_EXCL`, so only one process polls a
 * code. Returns its release function, or null while another live process holds
 * it. A lock left behind by a dead process is taken over.
 */
export function tryAcquireLock(path: string): (() => void) | null {
	ensureDir(dirname(path));
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			try {
				writeSync(
					fd,
					JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
				);
			} finally {
				closeSync(fd);
			}
			let released = false;
			return () => {
				if (!released) {
					released = true;
					removePrivateFile(path);
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
			if (!lockIsStale(path)) {
				return null;
			}
			removePrivateFile(path);
		}
	}
	return null;
}
