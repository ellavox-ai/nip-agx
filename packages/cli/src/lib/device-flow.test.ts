import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "../test/helpers.js";
import { CONTRACT } from "../test/mock-index-server.js";
import {
	AGX_SCOPE_STRING,
	DEVICE_GRANT_TYPE,
	type DeviceFlowDeps,
	type PendingLogin,
	pollDeviceToken,
	requestDeviceCode,
	retryAfterSeconds,
	sanitizeServerText,
	tryAcquireLock,
} from "./device-flow.js";
import { AgxCliError, EXIT } from "./errors.js";

const BASE = "https://app.ellaworks.ai";
const T0 = Date.parse("2026-09-30T18:00:00.000Z");

interface Scripted {
	status: number;
	body?: unknown;
	raw?: string;
	headers?: Record<string, string>;
}

/** A fetch that answers from a script and records every request; a step that
 * is an Error makes the request fail like a network error. */
function harness(script: Array<Scripted | Error>) {
	let now = T0;
	const sleeps: number[] = [];
	const requests: Array<{ url: string; init: RequestInit; body: unknown }> = [];
	const deps: DeviceFlowDeps = {
		now: () => now,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			now += ms;
		},
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				url: String(input),
				init: init ?? {},
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			const step = script.shift();
			if (!step) {
				throw new Error("script exhausted");
			}
			if (step instanceof Error) {
				throw step;
			}
			return new Response(
				step.raw ?? (step.body === undefined ? null : JSON.stringify(step.body)),
				{
					status: step.status,
					headers: step.headers ?? {
						"Content-Type": step.raw ? "text/html" : "application/json",
					},
				},
			);
		}) as typeof fetch,
	};
	return {
		deps,
		sleeps,
		requests,
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
	};
}

const oauth = (error: string, extra: Record<string, unknown> = {}): Scripted => ({
	status: 400,
	body: { error, ...extra },
});
const success = (): Scripted => ({
	status: 200,
	body: { ...CONTRACT.deviceToken.success, access_token: "ela_THEKEY" },
});

function pending(overrides: Partial<PendingLogin> = {}): PendingLogin {
	return {
		version: 1,
		apiBaseUrl: BASE,
		clientId: "agx",
		deviceCode: "dc_1",
		userCode: "WDJB-MJHT",
		verificationUri: `${BASE}/auth/device`,
		verificationUriComplete: `${BASE}/auth/device?code=WDJB-MJHT`,
		scope: AGX_SCOPE_STRING,
		interval: 5,
		expiresAt: new Date(T0 + 1800_000).toISOString(),
		createdAt: new Date(T0).toISOString(),
		lastPolledAt: null,
		hostLabel: "host",
		request: { orgHint: null, newOrg: false, newOrgName: null, newOrgSlug: null },
		replacesApiKeyId: null,
		...overrides,
	};
}

async function exitOf(promise: Promise<unknown>): Promise<AgxCliError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(AgxCliError);
		return error as AgxCliError;
	}
	throw new Error("expected a rejection");
}

describe("requestDeviceCode", () => {
	const request = {
		clientId: "agx" as const,
		scope: AGX_SCOPE_STRING,
		hostLabel: "alices-mbp",
	};

	it("posts the §1.2 fields as JSON, without following redirects", async () => {
		const h = harness([{ status: 200, body: CONTRACT.deviceCode.response }]);
		const result = await requestDeviceCode(
			BASE,
			{ ...request, orgHint: "acme-robotics" },
			h.deps,
		);
		const [call] = h.requests;
		expect(call?.url).toBe(`${BASE}/api/auth/device/code`);
		expect(call?.init.method).toBe("POST");
		expect(call?.init.redirect).toBe("manual");
		expect((call?.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
		expect(call?.body).toEqual({
			client_id: "agx",
			scope: "listings:read listings:write domains:read domains:write",
			host_label: "alices-mbp",
			org_hint: "acme-robotics",
		});
		expect(result).toMatchObject({
			userCode: "WDJB-MJHT",
			interval: 5,
			expiresAt: new Date(T0 + 1800_000).toISOString(),
			scope: AGX_SCOPE_STRING,
			lastPolledAt: null,
		});
	});

	it("sends the new-org prefill only with new_org", async () => {
		const h = harness([{ status: 200, body: CONTRACT.deviceCode.response }]);
		await requestDeviceCode(
			BASE,
			{ ...request, newOrg: true, newOrgName: "Acme", newOrgSlug: "acme" },
			h.deps,
		);
		expect(h.requests[0]?.body).toMatchObject({ new_org: true, new_org_name: "Acme", new_org_slug: "acme" });
	});

	it("aborts before any code is shown when the server does not echo a scope", async () => {
		const { scope: _scope, ...legacy } = CONTRACT.deviceCode.response;
		const h = harness([{ status: 200, body: legacy }]);
		const error = await exitOf(requestDeviceCode(BASE, request, h.deps));
		expect(error.exitCode).toBe(EXIT.remote);
		expect(error.message).toMatch(/unscoped key that never expires/);
		expect(error.message).not.toContain("WDJB-MJHT");
	});

	it("aborts when either verification URI is on another origin", async () => {
		for (const patch of [
			{ verification_uri: "https://evil.example/auth/device" },
			{ verification_uri_complete: "https://evil.example/auth/device?code=WDJB-MJHT" },
		]) {
			const h = harness([{ status: 200, body: { ...CONTRACT.deviceCode.response, ...patch } }]);
			const error = await exitOf(requestDeviceCode(BASE, request, h.deps));
			expect(error.exitCode).toBe(EXIT.remote);
			expect(error.message).not.toContain("WDJB-MJHT");
		}
	});

	it("maps refusals: 3xx and 4xx → 6, 429 → 6 with the wait, 5xx and network → 5", async () => {
		const cases: Array<[Scripted | Error, number, RegExp?]> = [
			[{ status: 307, headers: { Location: "https://evil.example" } }, EXIT.remote, /redirect/],
			[CONTRACT.deviceCode.errors.invalid_client as Scripted, EXIT.remote, /invalid_client/],
			[
				{ status: 400, body: { error: "invalid_request", error_description: "Name is\u001b[31m too long\nX" } },
				EXIT.remote,
				/invalid_request: Name is \[31m too long X/,
			],
			[CONTRACT.deviceCode.errors.rate_limited as Scripted, EXIT.remote],
			[CONTRACT.deviceCode.errors.server_error as Scripted, EXIT.network],
			[new TypeError("fetch failed"), EXIT.network],
		];
		for (const [step, exit, message] of cases) {
			const h = harness([step]);
			const error = await exitOf(requestDeviceCode(BASE, request, h.deps));
			expect(error.exitCode).toBe(exit);
			if (message) {
				expect(error.message).toMatch(message);
			}
		}
		const limited = await exitOf(
			requestDeviceCode(BASE, request, harness([CONTRACT.deviceCode.errors.rate_limited as Scripted]).deps),
		);
		expect(limited.remediation).toMatch(/Wait 60 s/);
	});
});

describe("pollDeviceToken", () => {
	it("sends the grant type URN, the device code and client_id as JSON", async () => {
		const h = harness([success()]);
		const outcome = await pollDeviceToken(BASE, pending(), {}, h.deps);
		expect(outcome.kind).toBe("approved");
		expect(h.requests[0]?.url).toBe(`${BASE}/api/auth/device/token`);
		expect(h.requests[0]?.init.redirect).toBe("manual");
		expect(h.requests[0]?.body).toEqual({
			grant_type: DEVICE_GRANT_TYPE,
			device_code: "dc_1",
			client_id: "agx",
		});
	});

	it("waits the interval before every poll, and slow_down sticks", async () => {
		const persisted: number[] = [];
		const h = harness([
			oauth("authorization_pending"),
			oauth("slow_down", { interval: 10 }),
			oauth("authorization_pending"),
			oauth("slow_down"), // no interval field (the Phase 0 firewall): +5
			oauth("authorization_pending"),
			success(),
		]);
		const outcome = await pollDeviceToken(
			BASE,
			pending(),
			{ persist: (p) => persisted.push(p.interval) },
			h.deps,
		);
		expect(outcome.kind).toBe("approved");
		expect(h.sleeps).toEqual([5000, 5000, 10000, 10000, 15000, 15000]);
		expect(Math.max(...persisted)).toBe(15);
	});

	it("never lowers the interval when slow_down names a smaller one", async () => {
		const h = harness([oauth("slow_down", { interval: 2 }), success()]);
		await pollDeviceToken(BASE, pending({ interval: 20 }), {}, h.deps);
		expect(h.sleeps).toEqual([20000, 20000]);
	});

	it("treats a 429 HTML page as slow_down and honours Retry-After", async () => {
		const h = harness([
			{ status: 429, raw: "<html>Too Many Requests</html>", headers: { "Content-Type": "text/html", "Retry-After": "42" } },
			oauth("authorization_pending"),
			success(),
		]);
		const outcome = await pollDeviceToken(BASE, pending(), {}, h.deps);
		expect(outcome.kind).toBe("approved");
		// 5 s, then max(10 s raised interval, 42 s Retry-After), then the raised 10 s.
		expect(h.sleeps).toEqual([5000, 42000, 10000]);
	});

	it("treats a 200 HTML page (a proxy, a captive portal) as slow_down", async () => {
		const h = harness([{ status: 200, raw: "<html>login to wifi</html>" }, success()]);
		const outcome = await pollDeviceToken(BASE, pending(), {}, h.deps);
		expect(outcome.kind).toBe("approved");
		expect(h.sleeps).toEqual([5000, 10000]);
	});

	it.each([
		["expired_token", EXIT.auth],
		["access_denied", EXIT.auth],
		["invalid_grant", EXIT.auth],
		["invalid_client", EXIT.remote],
		["unsupported_grant_type", EXIT.remote],
		["invalid_request", EXIT.remote],
		["something_new", EXIT.remote],
	])("%s → exit %i", async (error, exit) => {
		const h = harness([oauth(error)]);
		expect((await exitOf(pollDeviceToken(BASE, pending(), {}, h.deps))).exitCode).toBe(exit);
	});

	it("invalid_grant after another process finished: recovered, not an error", async () => {
		const h = harness([oauth("invalid_grant", { error_description: "Device code already used" })]);
		const outcome = await pollDeviceToken(BASE, pending(), { recover: () => true }, h.deps);
		expect(outcome.kind).toBe("recovered");
	});

	it("backs off on 5xx and network errors, and gives up with exit 5 after five in a row", async () => {
		const h = harness([
			{ status: 502, raw: "bad gateway" },
			new TypeError("fetch failed"),
			{ status: 500, body: CONTRACT.deviceToken.errors.server_error?.body },
			new TypeError("fetch failed"),
			new TypeError("fetch failed"),
		]);
		const error = await exitOf(pollDeviceToken(BASE, pending(), {}, h.deps));
		expect(error.exitCode).toBe(EXIT.network);
		expect(h.requests).toHaveLength(5);
		// interval·2ⁿ, capped at 30 s.
		expect(h.sleeps).toEqual([5000, 10000, 20000, 30000, 30000]);
	});

	it("a success resets the failure count", async () => {
		const h = harness([
			new TypeError("fetch failed"),
			new TypeError("fetch failed"),
			oauth("authorization_pending"),
			new TypeError("fetch failed"),
			new TypeError("fetch failed"),
			new TypeError("fetch failed"),
			success(),
		]);
		expect((await pollDeviceToken(BASE, pending(), {}, h.deps)).kind).toBe("approved");
	});

	it("never follows a 307", async () => {
		const h = harness([{ status: 307, headers: { Location: "https://evil.example/token" } }]);
		const error = await exitOf(pollDeviceToken(BASE, pending(), {}, h.deps));
		expect(error.exitCode).toBe(EXIT.remote);
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]?.init.redirect).toBe("manual");
	});

	it("a 200 without organization or api_key_id → 6, and the error never contains the key", async () => {
		for (const drop of ["organization", "api_key_id"]) {
			const body: Record<string, unknown> = { ...CONTRACT.deviceToken.success, access_token: "ela_THEKEY" };
			delete body[drop];
			const h = harness([{ status: 200, body }]);
			const error = await exitOf(pollDeviceToken(BASE, pending(), {}, h.deps));
			expect(error.exitCode).toBe(EXIT.remote);
			expect(error.message).toContain(drop);
			expect(`${error.message} ${error.remediation}`).not.toContain("ela_THEKEY");
		}
	});

	it.each([
		["LF", "ela_THEKEYTHEKEY\nrest"],
		["CR", "ela_THEKEYTHEKEY\rrest"],
		["NUL", "ela_THEKEYTHEKEY\u0000rest"],
		["a space", "ela_THEKEYTHEKEY rest"],
		["empty", ""],
	])("a 200 whose access_token contains %s → 6, never stored, never quoted", async (_label, token) => {
		const body = { ...CONTRACT.deviceToken.success, access_token: token };
		const h = harness([{ status: 200, body }]);
		const error = await exitOf(pollDeviceToken(BASE, pending(), {}, h.deps));
		expect(error.exitCode).toBe(EXIT.remote);
		expect(error.message).toContain("access_token");
		expect(`${error.message} ${error.remediation}`).not.toContain("THEKEYTHEKEY");
	});

	it("once: waits out the rest of the interval since lastPolledAt, polls once, reports pending", async () => {
		const h = harness([oauth("authorization_pending")]);
		const outcome = await pollDeviceToken(
			BASE,
			pending({ lastPolledAt: new Date(T0 - 3000).toISOString() }),
			{ once: true },
			h.deps,
		);
		expect(outcome.kind).toBe("pending");
		expect(h.sleeps).toEqual([2000]);
		expect(h.requests).toHaveLength(1);
		expect(outcome.pending.lastPolledAt).toBe(new Date(T0 + 2000).toISOString());

		// Long past the interval: no wait at all.
		const later = harness([oauth("authorization_pending")]);
		later.advance(60_000);
		await pollDeviceToken(BASE, pending(), { once: true }, later.deps);
		expect(later.sleeps).toEqual([]);
	});

	it("once: a slow_down raises the interval and still reports pending", async () => {
		const h = harness([oauth("slow_down", { interval: 15 })]);
		const outcome = await pollDeviceToken(BASE, pending(), { once: true }, h.deps);
		expect(outcome).toMatchObject({ kind: "pending", pending: { interval: 15 } });
	});

	it("stops at the local deadline without polling past it", async () => {
		const script = Array.from({ length: 400 }, () => oauth("authorization_pending"));
		const h = harness(script);
		const error = await exitOf(
			pollDeviceToken(BASE, pending({ expiresAt: new Date(T0 + 30_000).toISOString() }), {}, h.deps),
		);
		expect(error.exitCode).toBe(EXIT.auth);
		expect(h.requests.length).toBe(5);
		expect(h.now()).toBe(T0 + 30_000);
	});

	it("an aborted signal is exit 130", async () => {
		const controller = new AbortController();
		const h = harness([oauth("authorization_pending")]);
		const deps: DeviceFlowDeps = {
			...h.deps,
			signal: controller.signal,
			sleep: async (_ms, signal) => {
				controller.abort();
				throw signal?.reason;
			},
		};
		expect((await exitOf(pollDeviceToken(BASE, pending(), {}, deps))).exitCode).toBe(EXIT.interrupted);
	});
});

describe("helpers", () => {
	it("Retry-After: seconds or an HTTP date", () => {
		expect(retryAfterSeconds(new Headers({ "Retry-After": "60" }), T0)).toBe(60);
		expect(
			retryAfterSeconds(new Headers({ "Retry-After": new Date(T0 + 30_000).toUTCString() }), T0),
		).toBe(30);
		expect(retryAfterSeconds(new Headers(), T0)).toBeNull();
	});

	it("server text is stripped of controls, separators and bidi overrides, and capped", () => {
		const rlo = String.fromCharCode(0x202e);
		const ls = String.fromCharCode(0x2028);
		expect(sanitizeServerText(`a\u001b[2Jb${rlo}c${ls}d\ne`)).toBe("a [2Jb c d e");
		expect(sanitizeServerText("x".repeat(500))).toHaveLength(200);
		expect(sanitizeServerText(42)).toBeNull();
	});
});

describe("the poll lock", () => {
	let box: ReturnType<typeof sandbox>;
	beforeEach(() => {
		box = sandbox();
	});
	afterEach(() => box.restore());

	it("is exclusive while held, and free after release", () => {
		const path = join(box.home, "profiles", "default", "pending-login.lock");
		const release = tryAcquireLock(path);
		expect(release).toBeTypeOf("function");
		expect(tryAcquireLock(path)).toBeNull();
		release?.();
		expect(existsSync(path)).toBe(false);
		const again = tryAcquireLock(path);
		expect(again).toBeTypeOf("function");
		again?.();
	});

	it("takes over a lock left by a process that no longer exists", () => {
		const path = join(box.home, "profiles", "default", "pending-login.lock");
		tryAcquireLock(path); // creates the directory
		writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, at: "2026-01-01T00:00:00Z" }));
		const release = tryAcquireLock(path);
		expect(release).toBeTypeOf("function");
		release?.();
	});
});
