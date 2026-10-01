import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "../test/helpers.js";
import { CONTRACT, type MockIndexServer, startMockIndexServer } from "../test/mock-index-server.js";
import { createApiClient, isKeyRejected, resolveActionUrl, toCliError, userAgent } from "./api.js";
import { AgxCliError, EXIT, HumanActionRequiredError } from "./errors.js";

const BASE = "https://app.ellaworks.ai";

/** The §1.7 wire body, decoded the way RPCLink decodes it. */
function fromFixture(name: string): ORPCError<string, unknown> {
	const wire = (CONTRACT.rpcErrors[name]?.body as { json: Record<string, any> }).json;
	return new ORPCError(wire.code, {
		status: wire.status,
		message: wire.message,
		data: wire.data,
	});
}

describe("exit codes", () => {
	it("7 is human action required", () => {
		expect(EXIT.humanAction).toBe(7);
		const error = new HumanActionRequiredError("x", {
			reason: "LOGIN_APPROVAL_REQUIRED",
			url: BASE,
			userCode: "WDJB-MJHT",
			expiresIn: 1,
		});
		expect(error.exitCode).toBe(7);
		expect(error).toBeInstanceOf(AgxCliError);
	});
});

describe("toCliError: every §1.7 data.code", () => {
	it.each([
		["HUMAN_CONFIRMATION_REQUIRED", 7],
		["TERMS_ACCEPTANCE_REQUIRED", 7],
		["INSUFFICIENT_SCOPE", 4],
		["API_KEY_INVALID", 4],
		["API_KEY_EXPIRED", 4],
		["API_KEY_DISABLED", 4],
		["API_KEY_RATE_LIMITED", 6],
		["API_KEY_USAGE_EXCEEDED", 6],
		["API_KEY_OWNER_NOT_MEMBER", 4],
		["API_KEY_SELF_REVOKE_ONLY", 6],
		["LISTING_SLUG_TAKEN", 6],
		["LISTING_ADDRESS_LIVE", 6],
	])("%s → exit %i", (name, exit) => {
		const error = toCliError(fromFixture(name), "someProcedure", BASE);
		expect(error.exitCode).toBe(exit);
		expect(error.remediation).toBeTruthy();
	});

	it("data.code wins over the status and over the 0.3 message regexes", () => {
		// A 403 whose message would match a 0.3 regex, but whose code says scope.
		const error = toCliError(
			new ORPCError("FORBIDDEN", {
				message: "does not have access to this organization",
				data: { code: "INSUFFICIENT_SCOPE", required: "listings:write", granted: [] },
			}),
			"agentIndex.createListing",
			BASE,
		);
		expect(error.exitCode).toBe(4);
		expect(error.message).toMatch(/covers listings and domains only/);
		expect(error.message).toMatch(/listings:write/);
		expect(error.remediation).toMatch(/Settings/);
	});

	it("HUMAN_CONFIRMATION_REQUIRED carries the actionRequired object", () => {
		const error = toCliError(fromFixture("HUMAN_CONFIRMATION_REQUIRED"), "publishListing", BASE);
		expect(error).toBeInstanceOf(HumanActionRequiredError);
		expect((error as HumanActionRequiredError).actionRequired).toEqual({
			reason: "HUMAN_CONFIRMATION_REQUIRED",
			url: `${BASE}/elladex/listings/l_7?org=acme-robotics`,
			userCode: null,
			expiresIn: null,
			listingId: "l_7",
		});
	});

	it("TERMS_ACCEPTANCE_REQUIRED keeps the Terms URL on the same site (spec §1.8)", () => {
		const error = toCliError(fromFixture("TERMS_ACCEPTANCE_REQUIRED"), "x", BASE);
		expect((error as HumanActionRequiredError).actionRequired).toEqual({
			reason: "TERMS_ACCEPTANCE_REQUIRED",
			url: "https://www.ellaworks.ai/en/legal/terms",
			userCode: null,
			expiresIn: null,
		});
	});

	it("API_KEY_RATE_LIMITED says how long to wait", () => {
		expect(toCliError(fromFixture("API_KEY_RATE_LIMITED"), "x", BASE).message).toMatch(/2 s/);
	});

	it("LISTING_ADDRESS_LIVE points at our own listing when the server names it", () => {
		expect(toCliError(fromFixture("LISTING_ADDRESS_LIVE"), "createListing", BASE).remediation).toMatch(/agx listing get l_7/);
	});

	it("PRECONDITION_FAILED without a known code → 6", () => {
		const error = toCliError(new ORPCError("PRECONDITION_FAILED", { message: "nope" }), "x", BASE);
		expect(error.exitCode).toBe(6);
		expect(error).not.toBeInstanceOf(HumanActionRequiredError);
	});

	it("CONFLICT without a known code → 6", () => {
		expect(toCliError(new ORPCError("CONFLICT", { message: "That agent address is already listed on the index." }), "x", BASE).exitCode).toBe(6);
	});

	it("an unknown data.code falls back to the status", () => {
		const error = toCliError(
			new ORPCError("FORBIDDEN", { message: "m", data: { code: "SOMETHING_NEW" } }),
			"x",
			BASE,
		);
		expect(error.exitCode).toBe(6);
	});

	it("an UNAUTHORIZED without a code now says agx login", () => {
		const error = toCliError(new ORPCError("UNAUTHORIZED", { message: "Invalid API key" }), "x", BASE);
		expect(error.exitCode).toBe(4);
		expect(error.remediation).toBe("agx login");
	});

	it("keeps the 0.3 regex fallbacks for servers without data.code", () => {
		expect(
			toCliError(new ORPCError("UNAUTHORIZED", { message: "API key is missing organization scope" }), "x", BASE).remediation,
		).toMatch(/no organization scope/);
		expect(
			toCliError(new ORPCError("FORBIDDEN", { message: "API key does not have access to this organization" }), "x", BASE).exitCode,
		).toBe(4);
		expect(
			toCliError(new ORPCError("FORBIDDEN", { message: "Prove possession of this key first" }), "x", BASE).remediation,
		).toMatch(/anti-squatting/);
	});

	it("an unfollowed 3xx decoded as a body → 6", () => {
		const error = toCliError(
			new Error("Cannot parse response body, please check the response body and content-type."),
			"x",
			BASE,
		);
		expect(error.exitCode).toBe(6);
	});

	it("an unreachable server → 5", () => {
		const error = toCliError(
			Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
			"x",
			BASE,
		);
		expect(error.exitCode).toBe(5);
	});
});

describe("isKeyRejected (may a key be forgotten unrevoked?)", () => {
	it.each([
		["API_KEY_INVALID", true],
		["API_KEY_EXPIRED", true],
		["API_KEY_DISABLED", false],
		["API_KEY_OWNER_NOT_MEMBER", false],
		["API_KEY_SELF_REVOKE_ONLY", false],
		["INSUFFICIENT_SCOPE", false],
	])("%s → %s", (name, expected) => {
		expect(isKeyRejected(fromFixture(name))).toBe(expected);
	});

	it("a 401 without a code is (a pre-Phase-1 server's Invalid API key)", () => {
		expect(isKeyRejected(new ORPCError("UNAUTHORIZED", { message: "Invalid API key" }))).toBe(true);
		expect(
			isKeyRejected(new ORPCError("UNAUTHORIZED", { message: "API key is missing organization scope" })),
		).toBe(false);
	});

	it("a 404 never is: it means the procedure is missing, not the key", () => {
		expect(isKeyRejected(new ORPCError("NOT_FOUND", { message: "Not found" }))).toBe(false);
		expect(isKeyRejected(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe(false);
		expect(isKeyRejected(new AgxCliError("redirect", { exitCode: EXIT.remote }))).toBe(false);
	});
});

describe("resolveActionUrl", () => {
	it("resolves a relative URL against OUR base", () => {
		expect(resolveActionUrl("/elladex/listings/l_7?org=acme", BASE)).toBe(`${BASE}/elladex/listings/l_7?org=acme`);
		expect(resolveActionUrl("/x", "http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000/x");
	});

	it("keeps an absolute URL on our origin, minus any user info", () => {
		expect(resolveActionUrl(`${BASE}/elladex/x`, BASE)).toBe(`${BASE}/elladex/x`);
		expect(resolveActionUrl("https://me:pw@app.ellaworks.ai/a", BASE)).toBe(`${BASE}/a`);
	});

	it.each([
		"https://evil.example/elladex/listings/l_7",
		"//evil.example/x",
		"javascript:alert(1)",
		"https://app.ellaworks.ai.evil.example/x",
		"http://app.ellaworks.ai/x",
		"",
		42,
	])("replaces %s with the base's /elladex", (url) => {
		expect(resolveActionUrl(url, BASE)).toBe(`${BASE}/elladex`);
	});

	it("admits same-site hosts only when asked (the Terms page)", () => {
		expect(resolveActionUrl("https://www.ellaworks.ai/en/legal/terms", BASE)).toBe(`${BASE}/elladex`);
		expect(resolveActionUrl("https://www.ellaworks.ai/en/legal/terms", BASE, { sameSite: true })).toBe(
			"https://www.ellaworks.ai/en/legal/terms",
		);
		expect(resolveActionUrl("https://ellaworks.ai.evil.example/t", BASE, { sameSite: true })).toBe(`${BASE}/elladex`);
		expect(resolveActionUrl("https://www.ellaworks.ai/t", "http://localhost:3000", { sameSite: true })).toBe(
			"http://localhost:3000/elladex",
		);
	});
});

describe("createApiClient", () => {
	let box: ReturnType<typeof sandbox>;
	let mock: MockIndexServer;
	beforeEach(async () => {
		box = sandbox();
		mock = await startMockIndexServer();
	});
	afterEach(async () => {
		await mock.close();
		box.restore();
	});

	it("sends X-API-Key and an agx User-Agent", async () => {
		const key = mock.addKey();
		await createApiClient({ baseUrl: mock.origin, apiKey: key.key }).organizations.list({});
		const call = mock.calls("/api/rpc/organizations/list")[0];
		expect(call?.headers["x-api-key"]).toBe(key.key);
		expect(call?.headers["user-agent"]).toBe(userAgent());
		expect(userAgent()).toMatch(/^agx\/\d+\.\d+\.\d+ \(node \d+\.\d+\.\d+; \w+\)$/);
	});

	it("refuses a redirect instead of decoding it as a result (exit 6)", async () => {
		const key = mock.addKey();
		const elsewhere = await startMockIndexServer();
		try {
			mock.setRpc("organizations/list", () => ({
				status: 307,
				headers: { Location: `${elsewhere.origin}/api/rpc/organizations/list` },
			}));
			const call = createApiClient({ baseUrl: mock.origin, apiKey: key.key }).organizations.list({});
			await expect(call).rejects.toMatchObject({ exitCode: EXIT.remote });
			expect(elsewhere.requests).toEqual([]);
		} finally {
			await elsewhere.close();
		}
	});

	it("decodes a §1.7 wire error into data.code", async () => {
		const key = mock.addKey();
		const error = await createApiClient({ baseUrl: mock.origin, apiKey: key.key })
			.agentIndex.publishListing({ orgSlug: "acme-robotics", listingId: "l_7" })
			.catch((e: unknown) => e);
		const mapped = toCliError(error, "publishListing", mock.origin);
		expect(mapped).toBeInstanceOf(HumanActionRequiredError);
		expect((mapped as HumanActionRequiredError).actionRequired.url).toBe(
			`${mock.origin}/elladex/listings/l_7?org=acme-robotics`,
		);
	});
});
