import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Resolve the sibling AGX packages from source, as `packages/api` does, so unit
 * tests run without `pnpm build` first (CI runs `test:unit` on a fresh
 * install, where `@nostr-agx/core`'s `dist` does not exist).
 */
export default defineConfig({
	resolve: {
		alias: [
			{
				find: "@nostr-agx/core",
				replacement: fileURLToPath(
					new URL("../core/src/index.ts", import.meta.url),
				),
			},
			{
				find: "@nostr-agx/nostr",
				replacement: fileURLToPath(
					new URL("../nostr/src/index.ts", import.meta.url),
				),
			},
		],
	},
});
