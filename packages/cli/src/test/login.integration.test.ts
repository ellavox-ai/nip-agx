import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileMode } from "../lib/paths.js";
import {
	agx,
	type CliRun,
	capture,
	fakeClock,
	jsonDocuments,
	sandbox,
	useClock,
} from "./helpers.js";
import { runCli } from "../program.js";
import { CONTRACT, type MockIndexServer, startMockIndexServer } from "./mock-index-server.js";

/**
 * `agx login` and the commands around it, end to end through the real
 * commander wiring, against the in-process mock index (which implements the
 * §1.3 rules), with a fake clock so minutes of polling take milliseconds.
 */

let box: ReturnType<typeof sandbox>;
let clock: ReturnType<typeof fakeClock>;
let restoreClock: () => void;
let mock: MockIndexServer;

beforeEach(async () => {
	box = sandbox();
	clock = fakeClock();
	restoreClock = useClock(clock);
	mock = await startMockIndexServer({ now: clock.now });
});

afterEach(async () => {
	await mock.close();
	restoreClock();
	box.restore();
});

const credentialsFile = () => join(box.home, "credentials.json");
const configFile = () => join(box.home, "config.json");
const pendingFile = (profile = "default") =>
	join(box.home, "profiles", profile, "pending-login.json");

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, "utf8"));
}

function onlyJson(run: CliRun): Record<string, any> {
	const docs = jsonDocuments(run.stdout);
	expect(docs, `stdout was:\n${run.stdout}\nstderr:\n${run.stderr}`).toHaveLength(1);
	return docs[0] as Record<string, any>;
}

/** Log in with `--no-wait` twice around an approval. */
async function loginViaNoWait(...extra: string[]): Promise<CliRun> {
	const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, ...extra);
	expect(first.code).toBe(7);
	mock.approve();
	return agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, ...extra);
}

describe("agx login", () => {
	it("(a) blocking: survives slow_down, stores the key 0600, prints neither key nor device code", async () => {
		let polls = 0;
		mock.onTokenPoll = () => {
			polls += 1;
			if (polls === 2) {
				// The CLI must keep the raised interval for the rest of the code's life.
				mock.queueToken(CONTRACT.deviceToken.errors.slow_down as never);
			}
			if (polls === 3) {
				mock.approve();
			}
		};
		const run = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(run.code, run.stderr).toBe(0);

		// Exactly one code was requested.
		expect(mock.calls("/api/auth/device/code")).toHaveLength(1);

		// The hand-off went to stderr once, as one JSON line.
		const handoff = run.stderr
			.split("\n")
			.filter((line) => line.startsWith('{"actionRequired"'));
		expect(handoff).toHaveLength(1);
		const action = JSON.parse(handoff[0] ?? "{}").actionRequired;
		expect(action).toMatchObject({
			reason: "LOGIN_APPROVAL_REQUIRED",
			url: `${mock.origin}/auth/device?code=WDJB-MJHT`,
			userCode: "WDJB-MJHT",
			expiresIn: 1800,
			verificationUri: `${mock.origin}/auth/device`,
		});

		// Only the result on stdout, shaped like §1.8.
		const result = onlyJson(run);
		const key = mock.keys[0];
		expect(result).toEqual({
			loggedIn: true,
			alreadyLoggedIn: false,
			profile: "default",
			apiBaseUrl: mock.origin,
			user: { id: "u_1", email: "a•••@acme.com" },
			organization: { id: "o_1", slug: "acme-robotics", name: "Acme Robotics" },
			requestedOrg: null,
			scopes: CONTRACT.scopes,
			expiresAt: key?.expiresAt,
			apiKeyId: key?.id,
		});

		// Neither secret is printed anywhere.
		const deviceCode = mock.codes[0]?.deviceCode ?? "missing";
		for (const stream of [run.stdout, run.stderr]) {
			expect(stream).not.toContain(key?.key);
			expect(stream).not.toContain(deviceCode);
		}

		// credentials.json is 0600 in a 0700 home; config.json holds no key.
		expect(fileMode(credentialsFile())).toBe(0o600);
		expect(fileMode(box.home)).toBe(0o700);
		const creds = readJson(credentialsFile());
		expect(creds.profiles.default).toMatchObject({
			apiBaseUrl: mock.origin,
			apiKey: key?.key,
			apiKeyId: key?.id,
			source: "login",
			clientId: "agx",
			organization: { slug: "acme-robotics" },
			scopes: CONTRACT.scopes,
		});
		const config = readJson(configFile());
		expect(config.profiles.default.apiKey).toBeNull();
		expect(config.profiles.default.orgSlug).toBe("acme-robotics");
		expect(config.profiles.default.apiBaseUrl).toBe(mock.origin);
		expect(existsSync(pendingFile())).toBe(false);

		// The request bodies: JSON, client_id, the grant type URN.
		const codeCall = mock.calls("/api/auth/device/code")[0];
		expect(codeCall?.headers["content-type"]).toBe("application/json");
		expect(codeCall?.body).toMatchObject({
			client_id: "agx",
			scope: "listings:read listings:write domains:read domains:write",
		});
		for (const call of mock.calls("/api/auth/device/token")) {
			expect(call.body).toEqual({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: deviceCode,
				client_id: "agx",
			});
		}

		// Pacing: 5 s, 5 s, then 10 s after slow_down and every poll after it.
		expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([5000, 5000, 10000]);
	});

	it("(b) --json --no-wait exits 7, then the re-run resumes the same code and exits 0", async () => {
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
		expect(onlyJson(first)).toEqual({
			actionRequired: {
				reason: "LOGIN_APPROVAL_REQUIRED",
				url: `${mock.origin}/auth/device?code=WDJB-MJHT`,
				userCode: "WDJB-MJHT",
				expiresIn: 1800,
				expiresAt: new Date(clock.now() + 1800_000).toISOString(),
				verificationUri: `${mock.origin}/auth/device`,
			},
		});
		// A fresh code is never polled under --no-wait.
		expect(mock.calls("/api/auth/device/token")).toHaveLength(0);
		expect(fileMode(pendingFile())).toBe(0o600);

		// Still pending: same code, one poll, exit 7 again.
		const again = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(again.code).toBe(7);
		expect(onlyJson(again).actionRequired.userCode).toBe("WDJB-MJHT");
		expect(mock.calls("/api/auth/device/token")).toHaveLength(1);

		mock.approve();
		const done = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(done.code, done.stderr).toBe(0);
		expect(onlyJson(done)).toMatchObject({ loggedIn: true, alreadyLoggedIn: false });
		expect(mock.calls("/api/auth/device/code")).toHaveLength(1);
		const polled = new Set(
			mock.calls("/api/auth/device/token").map((c) => (c.body as { device_code: string }).device_code),
		);
		expect([...polled]).toEqual([mock.codes[0]?.deviceCode]);
		expect(existsSync(pendingFile())).toBe(false);

		// And once more: already logged in, confirmed by the server, no new code.
		const repeat = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(repeat.code).toBe(0);
		expect(onlyJson(repeat)).toMatchObject({ alreadyLoggedIn: true, organization: { slug: "acme-robotics" } });
		expect(mock.calls("/api/auth/device/code")).toHaveLength(1);
		expect(mock.calls("/api/rpc/account/principal/get")).toHaveLength(1);
	});

	it("(c) denied → exit 4 and the pending file is removed", async () => {
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
		mock.deny();
		const denied = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(denied.code).toBe(4);
		expect(denied.stderr).toMatch(/denied/);
		expect(existsSync(pendingFile())).toBe(false);
		expect(existsSync(credentialsFile())).toBe(false);
	});

	it("(c) expired → exit 4 and the pending file is removed", async () => {
		mock.onTokenPoll = (_code, n) => {
			if (n === 1) {
				mock.expire();
			}
		};
		const run = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(run.code).toBe(4);
		expect(run.stderr).toMatch(/expired/);
		expect(existsSync(pendingFile())).toBe(false);
	});

	it("(c) a code that runs out locally is never polled past its deadline", async () => {
		const run = await agx("login", "--json", "--api-base-url", mock.origin);
		expect(run.code).toBe(4);
		expect(run.stderr).toMatch(/expired before it was approved/);
		const polls = mock.calls("/api/auth/device/token").length;
		// 1800 s at 5 s per poll, and not one more.
		expect(polls).toBeGreaterThan(300);
		expect(polls).toBeLessThanOrEqual(360);
		expect(existsSync(pendingFile())).toBe(false);
	});

	it("(d) concurrent resumes poll once and mint one key", async () => {
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
		mock.approve();
		const args = ["login", "--json", "--no-wait", "--api-base-url", mock.origin];
		const { value: codes } = await capture(() =>
			Promise.all([runCli(args), runCli(args)]),
		);
		expect(codes.sort()).toEqual([0, 0]);
		const approvals = mock.calls("/api/auth/device/token");
		expect(approvals).toHaveLength(1);
		expect(mock.keys).toHaveLength(1);
		expect(readJson(credentialsFile()).profiles.default.apiKeyId).toBe(mock.keys[0]?.id);
		expect(existsSync(pendingFile())).toBe(false);
		expect(existsSync(join(box.home, "profiles", "default", "pending-login.lock"))).toBe(false);
	});

	it("(e) whoami reports the server's view, masked, and never the key", async () => {
		const notYet = await agx("whoami", "--json");
		expect(notYet.code).toBe(4);
		expect(onlyJson(notYet)).toEqual({ loggedIn: false, profile: "default" });

		expect((await loginViaNoWait()).code).toBe(0);
		const run = await agx("whoami", "--json");
		expect(run.code, run.stderr).toBe(0);
		const key = mock.keys[0];
		expect(onlyJson(run)).toEqual({
			loggedIn: true,
			verified: true,
			profile: "default",
			apiBaseUrl: mock.origin,
			source: "login",
			user: { id: "u_1", email: "a•••@acme.com" },
			organization: { id: "o_1", slug: "acme-robotics", name: "Acme Robotics", role: "owner" },
			apiKey: {
				id: key?.id,
				name: key?.name,
				scoped: true,
				scopes: CONTRACT.scopes,
				clientId: "agx",
				hostLabel: key?.hostLabel,
				expiresAt: key?.expiresAt,
			},
		});
		expect(run.stdout).not.toContain(key?.key);
		const call = mock.calls("/api/rpc/account/principal/get").at(-1);
		expect(call?.headers["x-api-key"]).toBe(key?.key);
		expect(String(call?.headers["user-agent"])).toMatch(/^agx\/\d+\.\d+\.\d+ \(node /);
	});

	it("(e) whoami falls back to the local record on a server without the endpoint", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		mock.setRpc("account/principal/get", () => ({
			status: 404,
			body: { json: { defined: false, code: "NOT_FOUND", status: 404, message: "Not found" } },
		}));
		const run = await agx("whoami", "--json");
		expect(run.code).toBe(0);
		expect(onlyJson(run)).toMatchObject({
			verified: false,
			organization: { slug: "acme-robotics", role: null },
		});
	});

	it("(f) org list shows a login key only its own organization", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const run = await agx("org", "list", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run)).toEqual({
			organizations: [
				{
					id: "o_1",
					name: "Acme Robotics",
					slug: "acme-robotics",
					logo: "https://…",
					role: "owner",
					current: true,
				},
			],
		});
	});

	it("(g) logout revokes a login key against its own origin, then whoami says logged out", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const key = mock.keys[0];
		const run = await agx("logout", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run)).toEqual({
			loggedOut: [{ profile: "default", revoked: true, reason: "revoked" }],
		});
		expect(key?.revoked).toBe(true);
		expect(mock.calls("/api/rpc/prm/apiKeys/delete")[0]?.body).toEqual({
			json: { apiKeyId: key?.id },
		});
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
		expect((await agx("whoami", "--json")).code).toBe(4);
	});

	it("(g) logout of a manual key asks the server for its id first", async () => {
		const manual = mock.addKey();
		process.env.AGX_API_URL = mock.origin;
		const set = await capture(async () => {
			const { setStdinForTests } = await import("../lib/stdin.js");
			const restore = setStdinForTests(manual.key);
			try {
				return await runCli(["config", "set", "apiKey", "--stdin"]);
			} finally {
				restore();
			}
		});
		expect(set.value).toBe(0);
		const run = await agx("logout", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: true, reason: "revoked" });
		expect(mock.calls("/api/rpc/account/principal/get")).toHaveLength(1);
		expect(manual.revoked).toBe(true);
	});

	it("(g) logout forgets a key the server no longer knows (401)", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const key = mock.keys[0];
		if (key) {
			key.revoked = true; // revoked in Settings meanwhile
		}
		const run = await agx("logout", "--json");
		expect(run.code).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "already-invalid" });
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
	});

	it("(g) logout keeps the key and exits 5 when the server is unreachable, unless --local", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		await mock.close();
		const kept = await agx("logout", "--json");
		expect(kept.code).toBe(5);
		expect(onlyJson(kept).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "revoke-failed" });
		expect(readJson(credentialsFile()).profiles.default).toBeDefined();

		const local = await agx("logout", "--json", "--local");
		expect(local.code).toBe(0);
		expect(onlyJson(local).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "not-revoked-local" });
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
		mock = await startMockIndexServer({ now: clock.now }); // for afterEach
	});

	it("(g) logout clears a 0.3 config.json key without revoking it; logged out is exit 0", async () => {
		const legacy = mock.addKey();
		const { writePrivateJson } = await import("../lib/paths.js");
		writePrivateJson(configFile(), {
			version: 1,
			currentProfile: "default",
			profiles: { default: { apiBaseUrl: mock.origin, apiKey: legacy.key, orgSlug: "acme-robotics" } },
		});
		const run = await agx("logout", "--json");
		expect(run.code).toBe(0);
		expect(onlyJson(run).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "legacy-key-cleared" });
		expect(run.stderr).toMatch(/NOT revoked/);
		expect(legacy.revoked).toBe(false);
		expect(mock.requests).toHaveLength(0);
		expect(readJson(configFile()).profiles.default.apiKey).toBeNull();

		const again = await agx("logout", "--json");
		expect(again.code).toBe(0);
		expect(onlyJson(again).loggedOut[0]).toEqual({ profile: "default", revoked: false, reason: "not-logged-in" });
	});

	it("(g) logout --all covers every profile", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		expect((await loginViaNoWait("--profile", "second")).code).toBe(0);
		const run = await agx("logout", "--all", "--json");
		expect(run.code, run.stderr).toBe(0);
		expect(onlyJson(run).loggedOut).toEqual([
			{ profile: "default", revoked: true, reason: "revoked" },
			{ profile: "second", revoked: true, reason: "revoked" },
		]);
		expect(mock.keys.every((k) => k.revoked)).toBe(true);
	});

	it("(h) a gated publish exits 7 with an absolute URL on the mock's origin", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const run = await agx("listing", "publish", "l_7", "--json");
		expect(run.code).toBe(7);
		expect(onlyJson(run)).toEqual({
			actionRequired: {
				reason: "HUMAN_CONFIRMATION_REQUIRED",
				url: `${mock.origin}/elladex/listings/l_7?org=acme-robotics`,
				userCode: null,
				expiresIn: null,
				listingId: "l_7",
			},
		});
	});

	it("(i) a login is never sent to another origin", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const other = await startMockIndexServer({ now: clock.now });
		try {
			process.env.AGX_API_URL = other.origin;
			for (const args of [["whoami", "--json"], ["search", "x", "--json"], ["org", "list"], ["listing", "publish", "l_7"]]) {
				const run = await agx(...args);
				expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(3);
				expect(run.stderr).toMatch(/Nothing was sent/);
			}
			expect(other.requests).toEqual([]);
		} finally {
			await other.close();
		}
	});

	it("(j) a redirect on /token is refused and never followed", async () => {
		const elsewhere = await startMockIndexServer({ now: clock.now });
		try {
			mock.queueToken({
				status: 307,
				headers: { Location: `${elsewhere.origin}/api/auth/device/token` },
				body: {},
			});
			const run = await agx("login", "--json", "--api-base-url", mock.origin);
			expect(run.code).toBe(6);
			expect(run.stderr).toMatch(/redirect/);
			expect(elsewhere.requests).toEqual([]);
			expect(existsSync(credentialsFile())).toBe(false);
		} finally {
			await elsewhere.close();
		}
	});
});

describe("agx login, more", () => {
	it("aborts before showing a code when the server does not echo a scope", async () => {
		await mock.close();
		mock = await startMockIndexServer({ now: clock.now, omitScopeEcho: true });
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(6);
		expect(run.stderr).toMatch(/unscoped key that never expires/);
		expect(run.stdout).not.toContain("WDJB-MJHT");
		expect(run.stderr).not.toContain("WDJB-MJHT");
		expect(existsSync(pendingFile())).toBe(false);
	});

	it("aborts before showing a code when the verification page is on another origin", async () => {
		await mock.close();
		mock = await startMockIndexServer({ now: clock.now, verificationOrigin: "https://evil.example" });
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(6);
		expect(`${run.stdout}${run.stderr}`).not.toContain("WDJB-MJHT");
	});

	it("validates flags with exit 2", async () => {
		expect((await agx("login", "--org", "a", "--new-org")).code).toBe(2);
		expect((await agx("login", "--org-name", "Acme")).code).toBe(2);
		expect((await agx("login", "--api-base-url", "http://example.com")).code).toBe(2);
		expect((await agx("login", "--api-base-url", "https://u:p@example.com")).code).toBe(2);
		expect(mock.requests).toEqual([]);
	});

	it("passes the org prefill and reports an approved org that differs from --org", async () => {
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, "--org", "acme");
		expect(first.code).toBe(7);
		expect(mock.calls("/api/auth/device/code")[0]?.body).toMatchObject({ org_hint: "acme" });
		mock.approve();
		const done = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, "--org", "acme");
		expect(done.code).toBe(0);
		expect(onlyJson(done)).toMatchObject({ requestedOrg: "acme", organization: { slug: "acme-robotics" } });
		expect(done.stderr).toMatch(/You asked for organization "acme"/);
	});

	it("org create is login --new-org with the name and slug prefilled", async () => {
		const run = await agx("org", "create", "Acme Robotics", "--slug", "acme-robotics", "--no-wait", "--api-base-url", mock.origin, "--json");
		expect(run.code).toBe(7);
		expect(mock.calls("/api/auth/device/code")[0]?.body).toMatchObject({
			new_org: true,
			new_org_name: "Acme Robotics",
			new_org_slug: "acme-robotics",
		});
	});

	it("a different request discards the pending code instead of resuming it", async () => {
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin)).code).toBe(7);
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, "--new-org")).code).toBe(7);
		expect(mock.calls("/api/auth/device/code")).toHaveLength(2);
		expect(readJson(pendingFile()).request.newOrg).toBe(true);
	});

	it("--force logs in again and revokes the replaced login key", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		const old = mock.keys[0];
		const run = await loginViaNoWait("--force");
		expect(run.code, run.stderr).toBe(0);
		expect(mock.keys).toHaveLength(2);
		expect(old?.revoked).toBe(true);
		expect(readJson(credentialsFile()).profiles.default.apiKeyId).toBe(mock.keys[1]?.id);
	});

	it("human mode: the URL and code go to stderr, the result to stdout", async () => {
		mock.onTokenPoll = (_code, n) => {
			if (n === 1) {
				mock.approve();
			}
		};
		const run = await agx("login", "--no-browser", "--api-base-url", mock.origin);
		expect(run.code, run.stderr).toBe(0);
		expect(run.stderr).toContain(`Open ${mock.origin}/auth/device?code=WDJB-MJHT and check the code WDJB-MJHT (expires in 30 min)`);
		expect(run.stdout).toMatch(/Logged in as a•••@acme\.com · org acme-robotics/);
		expect(run.stdout).not.toContain("WDJB-MJHT");
	});

	it("human mode --no-wait: exit 7 with the URL and code on stderr, nothing on stdout but the host line", async () => {
		const run = await agx("login", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(7);
		expect(run.stderr).toContain(`${mock.origin}/auth/device?code=WDJB-MJHT`);
		expect(run.stderr).toContain("code WDJB-MJHT");
		expect(run.stdout).not.toContain("WDJB-MJHT");
	});

	it("SIGINT while waiting keeps the pending code and exits 130", async () => {
		const others = process.listeners("SIGINT");
		process.removeAllListeners("SIGINT");
		try {
			mock.onTokenPoll = (_code, n) => {
				if (n === 2) {
					process.emit("SIGINT");
				}
			};
			const run = await agx("login", "--json", "--api-base-url", mock.origin);
			expect(run.code).toBe(130);
			expect(existsSync(pendingFile())).toBe(true);
			expect(process.listenerCount("SIGINT")).toBe(0);
			// And the code resumes.
			mock.onTokenPoll = null;
			mock.approve();
			const resumed = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
			expect(resumed.code).toBe(0);
			expect(mock.calls("/api/auth/device/code")).toHaveLength(1);
		} finally {
			for (const listener of others) {
				process.on("SIGINT", listener as () => void);
			}
		}
	});

	it("a pending code that has expired locally is replaced, not resumed", async () => {
		expect((await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin)).code).toBe(7);
		clock.advance(1801_000);
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(7);
		expect(mock.calls("/api/auth/device/code")).toHaveLength(2);
		expect(mock.calls("/api/auth/device/token")).toHaveLength(0);
	});

	it("an expired login is refused for API calls (exit 4) and replaced by agx login", async () => {
		expect((await loginViaNoWait()).code).toBe(0);
		clock.advance(91 * 86_400_000);
		expect((await agx("search", "x")).code).toBe(4);
		const first = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(first.code).toBe(7);
	});

	it("warns when AGX_API_KEY would override the new login", async () => {
		process.env.AGX_API_KEY = "ela_FromTheEnvironment";
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin);
		expect(run.code).toBe(7);
		expect(run.stderr).toMatch(/AGX_API_KEY is set/);
		expect(run.stdout).not.toContain("ela_FromTheEnvironment");
	});

	it("without --api-base-url, a stored 0.3 localhost default is ignored in favour of the production server", async () => {
		const { resolveLoginBaseUrl } = await import("../commands/login.js");
		const { writePrivateJson } = await import("../lib/paths.js");
		writePrivateJson(configFile(), {
			version: 1,
			currentProfile: "default",
			profiles: { default: { apiBaseUrl: "http://localhost:3000" } },
		});
		expect(resolveLoginBaseUrl("default", undefined)).toBe("https://app.ellaworks.ai");
		writePrivateJson(configFile(), {
			version: 1,
			currentProfile: "default",
			profiles: { default: { apiBaseUrl: "http://localhost:4000" } },
		});
		expect(resolveLoginBaseUrl("default", undefined)).toBe("http://localhost:4000");
		process.env.AGX_API_URL = "https://staging.ellaworks.ai";
		expect(resolveLoginBaseUrl("default", undefined)).toBe("https://staging.ellaworks.ai");
		expect(resolveLoginBaseUrl("default", "http://127.0.0.1:9/")).toBe("http://127.0.0.1:9");
	});

	it("--profile after the subcommand is honoured", async () => {
		expect((await loginViaNoWait("--profile", "work")).code).toBe(0);
		expect(readJson(credentialsFile()).profiles.work).toBeDefined();
		expect(readJson(credentialsFile()).profiles.default).toBeUndefined();
	});
});
