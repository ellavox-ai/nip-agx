import { chmod } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
	entry: { agx: "src/bin/agx.ts" },
	format: ["esm"],
	target: "node20",
	platform: "node",
	outDir: "dist",
	splitting: false,
	sourcemap: true,
	clean: true,
	shims: true,
	// Bundled so the published CLI is self-contained apart from its runtime deps.
	noExternal: ["@nostr-agx/core", "@nostr-agx/nostr"],
	// `ws` is a real runtime dependency (the relay server needs WebSocketServer);
	// never bundle a native-ish socket implementation.
	external: ["ws"],
	banner: {
		js: "#!/usr/bin/env node",
	},
	// The shebang alone does not make the file executable; without this, a global
	// install resolves the bin and then fails with EACCES.
	onSuccess: async () => {
		await chmod("dist/agx.js", 0o755);
	},
});
