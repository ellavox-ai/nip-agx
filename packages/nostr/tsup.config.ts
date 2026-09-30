import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	target: "es2022",
	platform: "node",
	outDir: "dist",
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	// WebSocket is injected by the consumer (Node passes `ws`, browser/edge use
	// the global); never bundle a WS impl.
	external: ["ws"],
});
