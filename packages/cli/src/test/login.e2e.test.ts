import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockIndexServer, startMockIndexServer } from "./mock-index-server.js";

/**
 * The BUILT CLI (`dist/agx.js`) against the mock index, as a separate process
 * with every inherited AGX_* variable stripped: checks what the in-process
 * tests cannot — the bin entry, real exit statuses, and commander's parsing of
 * root options placed after the subcommand.
 *
 *   pnpm build && pnpm --filter @nostr-agx/cli test:e2e:login
 *
 * Not part of `test:unit`: it needs a fresh build.
 */

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

let home: string;
let mock: MockIndexServer;

function agx(...args: string[]): Promise<Run> {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", AGX_NO_BROWSER: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_") && key !== "AGX_NO_BROWSER") {
			delete env[key];
		}
	}
	env.AGX_HOME = home;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [AGX, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

describe.skipIf(!existsSync(AGX))("dist/agx.js login wiring", () => {
	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-login-"));
		mock = await startMockIndexServer();
	});
	afterAll(async () => {
		await mock?.close();
		rmSync(home, { recursive: true, force: true });
	});

	it("exit 7 prints exactly one actionRequired JSON object on stdout", async () => {
		const run = await agx("login", "--json", "--no-wait", "--api-base-url", mock.origin, "--profile", "e2e");
		expect(run.code, run.stderr).toBe(7);
		const lines = run.stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			actionRequired: expect.objectContaining({
				reason: "LOGIN_APPROVAL_REQUIRED",
				userCode: "WDJB-MJHT",
				url: `${mock.origin}/auth/device?code=WDJB-MJHT`,
			}),
		});
		expect(existsSync(join(home, "profiles", "e2e", "pending-login.json"))).toBe(true);
	});

	it("the re-run after approval exits 0; --profile after the subcommand picks the profile", async () => {
		mock.approve();
		// Real time here: the resume waits out the 5 s interval before its poll.
		const run = await agx("login", "--no-wait", "--json", "--profile", "e2e", "--api-base-url", mock.origin);
		expect(run.code, run.stderr).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({ loggedIn: true, profile: "e2e" });
		const who = await agx("whoami", "--json", "--profile", "e2e");
		expect(who.code, who.stderr).toBe(0);
		expect(JSON.parse(who.stdout)).toMatchObject({ verified: true, organization: { slug: "acme-robotics" } });
		const nobody = await agx("whoami", "--json", "-p", "nobody");
		expect(nobody.code).toBe(4);
		expect(JSON.parse(nobody.stdout)).toEqual({ loggedIn: false, profile: "nobody" });
	}, 20_000);

	it("a gated publish exits 7 with the URL on the mock's origin", async () => {
		const run = await agx("--profile", "e2e", "listing", "publish", "l_7", "--json");
		expect(run.code).toBe(7);
		expect(JSON.parse(run.stdout).actionRequired.url).toBe(`${mock.origin}/elladex/listings/l_7?org=acme-robotics`);
	});

	it("commander's own errors keep their exit status", async () => {
		expect((await agx("login", "--no-such-flag")).code).toBe(1);
		expect((await agx("--version")).code).toBe(0);
	});
});
