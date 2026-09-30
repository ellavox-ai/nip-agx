import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	target: "es2022",
	platform: "neutral",
	outDir: "dist",
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
});
