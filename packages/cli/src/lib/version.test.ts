import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGX_CLI_VERSION } from "./version";

describe("AGX_CLI_VERSION", () => {
	it("matches the published package version", () => {
		const pkg = JSON.parse(
			readFileSync(
				new URL("../../package.json", import.meta.url),
				"utf8",
			),
		) as { version: string };
		expect(AGX_CLI_VERSION).toBe(pkg.version);
	});
});
