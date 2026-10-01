import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCredential } from "../lib/credentials.js";
import { setStdinForTests } from "../lib/stdin.js";
import { agx, jsonDocuments, sandbox } from "../test/helpers.js";

const KEY = "ela_ManualKeyManualKeyManualKeyManualKeyWXYZ";

let box: ReturnType<typeof sandbox>;
beforeEach(() => {
	box = sandbox();
	process.env.AGX_API_URL = "https://app.ellaworks.ai";
});
afterEach(() => box.restore());

async function withStdin<T>(input: string | null, fn: () => Promise<T>): Promise<T> {
	const restore = setStdinForTests(input);
	try {
		return await fn();
	} finally {
		restore();
	}
}

describe("agx config set apiKey", () => {
	it("--stdin stores a manual key in credentials.json, bound to the effective origin", async () => {
		const run = await withStdin(`${KEY}\n`, () => agx("config", "set", "apiKey", "--stdin", "--json"));
		expect(run.code, run.stderr).toBe(0);
		expect(getCredential("default")).toMatchObject({
			apiKey: KEY,
			apiKeyId: null,
			source: "manual",
			apiBaseUrl: "https://app.ellaworks.ai",
		});
		const config = join(box.home, "config.json");
		expect(existsSync(config) ? readFileSync(config, "utf8") : "").not.toContain(KEY);
		expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
	});

	it("reads a piped stdin even without --stdin", async () => {
		const run = await withStdin(KEY, () => agx("config", "set", "apiKey"));
		expect(run.code).toBe(0);
		expect(getCredential("default")?.apiKey).toBe(KEY);
	});

	it("refuses an empty or multi-line stdin, and a terminal with nothing piped (exit 2)", async () => {
		expect((await withStdin("", () => agx("config", "set", "apiKey", "--stdin"))).code).toBe(2);
		expect((await withStdin("a\nb\n", () => agx("config", "set", "apiKey", "--stdin"))).code).toBe(2);
		expect((await withStdin(null, () => agx("config", "set", "apiKey"))).code).toBe(2);
		expect(getCredential("default")).toBeNull();
	});

	it("a positional key still works but prints a deprecation on stderr, even under --json", async () => {
		const run = await withStdin(null, () => agx("config", "set", "apiKey", KEY, "--json"));
		expect(run.code).toBe(0);
		expect(run.stderr).toMatch(/deprecated/);
		expect(run.stderr).toMatch(/--stdin/);
		expect(run.stdout).not.toMatch(/deprecated/);
		expect(getCredential("default")?.source).toBe("manual");
	});

	it("clears a 0.3 key from config.json", async () => {
		writeFileSync(
			join(box.home, "config.json"),
			JSON.stringify({ version: 1, currentProfile: "default", profiles: { default: { apiKey: "ela_OLD" } } }),
		);
		const run = await withStdin(KEY, () => agx("config", "set", "apiKey", "--stdin"));
		expect(run.code).toBe(0);
		expect(readFileSync(join(box.home, "config.json"), "utf8")).not.toContain("ela_OLD");
		expect(getCredential("default")?.apiKey).toBe(KEY);
	});
});

describe("agx config show", () => {
	it("never prints a key, in either mode, and summarises the credential", async () => {
		await withStdin(KEY, () => agx("config", "set", "apiKey", "--stdin"));
		const human = await agx("config", "show");
		const json = await agx("config", "show", "--json");
		for (const run of [human, json]) {
			expect(run.code).toBe(0);
			expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
		}
		expect(human.stdout).toMatch(/credentials\s+manual/);
		const [doc] = jsonDocuments(json.stdout) as Array<Record<string, any>>;
		expect(doc?.apiKey).toBeUndefined();
		expect(doc?.credentials).toEqual({
			source: "manual",
			origin: "https://app.ellaworks.ai",
			organization: null,
			expiresAt: null,
			key: "ela_…WXYZ",
		});
	});

	it("never prints AGX_API_KEY either", async () => {
		process.env.AGX_API_KEY = KEY;
		const run = await agx("config", "show", "--json");
		expect(run.stdout).not.toContain(KEY);
		expect((jsonDocuments(run.stdout)[0] as Record<string, any>).credentials.source).toBe("env (AGX_API_KEY)");
	});

	it("--reveal is a usage error (exit 2)", async () => {
		await withStdin(KEY, () => agx("config", "set", "apiKey", "--stdin"));
		const run = await agx("config", "show", "--reveal");
		expect(run.code).toBe(2);
		expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
	});
});

describe("migration of a 0.3 key", () => {
	it("moves on the next config write, with a stderr notice", async () => {
		delete process.env.AGX_API_URL;
		writeFileSync(
			join(box.home, "config.json"),
			JSON.stringify({
				version: 1,
				currentProfile: "default",
				profiles: { default: { apiBaseUrl: "http://localhost:3000", apiKey: "ela_OLD", orgSlug: "acme" } },
			}),
		);
		const run = await agx("config", "set", "orgSlug", "acme-robotics", "--json");
		expect(run.code).toBe(0);
		expect(run.stderr).toMatch(/Moved the API key of profile "default"/);
		expect(readFileSync(join(box.home, "config.json"), "utf8")).not.toContain("ela_OLD");
		expect(getCredential("default")).toMatchObject({
			apiKey: "ela_OLD",
			source: "migrated",
			apiBaseUrl: "http://localhost:3000",
		});
	});
});

describe("agx config set apiBaseUrl", () => {
	it("refuses plain http to a remote host (exit 2)", async () => {
		expect((await agx("config", "set", "apiBaseUrl", "http://app.ellaworks.ai")).code).toBe(2);
	});

	it("warns when the stored credential belongs to another origin", async () => {
		await withStdin(KEY, () => agx("config", "set", "apiKey", "--stdin"));
		delete process.env.AGX_API_URL;
		const run = await agx("config", "set", "apiBaseUrl", "http://localhost:3000");
		expect(run.code).toBe(0);
		expect(run.stderr).toMatch(/belongs to https:\/\/app\.ellaworks\.ai/);
	});
});
