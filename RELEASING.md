# Releasing

The three packages publish to the public `@nostr-agx` npm scope as ESM + CJS + `.d.ts`, built
with `tsup`. Release them together at the same version.

1. Bump `version` in `packages/core`, `packages/nostr` and `packages/cli` `package.json`, plus
   `AGX_CORE_VERSION` (`packages/core/src/index.ts`), `AGX_NOSTR_VERSION`
   (`packages/nostr/src/index.ts`) and `.version(…)` in `packages/cli/src/bin/agx.ts`.
2. Build, test and check what each tarball ships:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build && pnpm type-check && pnpm test
   pnpm check:packages
   ```

3. Publish in dependency order. Use `pnpm publish`, not `npm publish`: only pnpm rewrites the
   `workspace:*` dependencies to real versions.

   ```sh
   pnpm --filter @nostr-agx/core publish --access public
   pnpm --filter @nostr-agx/nostr publish --access public   # depends on @nostr-agx/core
   pnpm --filter @nostr-agx/cli publish --access public     # bundles core and nostr
   ```

A published version can never be changed or reused, including its description and README; any
change to what npm shows needs a new version.
