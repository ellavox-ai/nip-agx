import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Runs before every test file. No test may ever read or write the real
 * `~/.agx`, or send a real credential anywhere: point AGX_HOME at a throwaway
 * directory and drop every inherited AGX_* override before any module loads.
 * Tests that need their own home use `sandbox()` on top of this.
 */
for (const key of Object.keys(process.env)) {
	if (key.startsWith("AGX_")) {
		delete process.env[key];
	}
}
const home = mkdtempSync(join(tmpdir(), "agx-test-home-"));
process.env.AGX_HOME = home;
process.env.AGX_NO_BROWSER = "1";

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});
