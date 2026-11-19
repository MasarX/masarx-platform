// seed-loader.ts — single bundle-aware seam for the in-memory seed catalog.
//
// CONTRACT
// --------
// The console-v2 app currently ships in two modes:
//
//   • Seed mode (default, `VITE_USE_SEED !== 'false'`): the in-memory adapter in
//     data-source.ts pulls every resource from `src/lib/seed-raw/*`. The seed
//     catalog is ~10k LOC across 30+ modules and is the SSOT for the demo build.
//
//   • Live mode (`VITE_USE_SEED=false`): adapters route through
//     `getSupabaseClient().rpc(...)`. The seed catalog is dead code — but it
//     was previously stuck in the index chunk because data-source.ts imported it
//     synchronously. This loader makes the import a build-time constant so Vite
//     can tree-shake the seed catalog out of the production bundle.
//
// HOW IT WORKS
// ------------
// `__SEED_ENABLED__` is a true compile-time boolean injected by Vite's
// `define` config (see vite.config.ts). Rollup folds `if (__SEED_ENABLED__)`
// into `if (true)` or `if (false)` and removes the unreachable branch — and
// crucially, the `await import('./seed-raw/seed.js')` literal goes with it,
// so Rollup does not even emit a code-split chunk for the seed graph in live
// mode.
//
// In seed mode (default), the dynamic import resolves at module-init via
// top-level await (Vite targets es2022) and the seed namespace is published
// for synchronous access from data-source.ts adapters. Rollup still splits
// the seed graph into its own `seed-*.js` chunk, which is loaded eagerly at
// app boot but no longer inflates the entry chunk.
//
// In live mode, every adapter takes the `getSupabaseClient()` branch first —
// the seed namespace is never read (and is an empty stub here as a safety net
// for sync helpers like `getNavigation()` that have not yet been ported to a
// live RPC).
//
// SEAM RULES (do not break)
// -------------------------
//   • This file is the ONLY place that statically references seed-raw at the
//     module level. data-source.ts must import `seed` from here, never from
//     './seed-raw/seed.js' directly. (api.ts already uses dynamic
//     `import('./seed-raw/...')` for its `seed.*` bridge — those are
//     intentionally lazy and unaffected by this loader.)
//   • The empty-seed stub in live mode must keep adapter call sites safe:
//     `seed.<key> ?? []` and `(seed.<key> as ...) ?? defaultValue` are valid;
//     adapters that read seed values without a fallback assume seed mode is
//     active.
//   • Tests run in seed mode by default (no env override) so the existing
//     vitest setup keeps the in-memory catalog intact.
//   • Vitest does not honor Vite's build-time `define`, so the typeof guard
//     below falls back to `import.meta.env.VITE_USE_SEED` (which Vite/Vitest
//     does replace at transform time). The `__SEED_ENABLED__` path is the
//     production-build branch; the `import.meta.env` path keeps the loader
//     working in vitest.

// Compile-time boolean injected by vite.config.ts `define`. Declared here so
// TypeScript is happy in source files; Vite replaces it with a literal `true`
// or `false` at build time.
declare const __SEED_ENABLED__: boolean | undefined;

// Resolve the seed-mode flag with a build-aware fallback chain:
//   1. `__SEED_ENABLED__` — production build, replaced by Vite's `define`.
//   2. `import.meta.env.VITE_USE_SEED !== 'false'` — vitest / dev server
//      (where `define` may not be applied uniformly).
// The expression is wrapped so that in production builds the typeof guard
// folds away too, leaving Rollup with a literal boolean for tree-shaking.
const SEED_ENABLED: boolean =
  typeof __SEED_ENABLED__ !== 'undefined'
    ? __SEED_ENABLED__
    : (import.meta.env.VITE_USE_SEED as string | undefined) !== 'false';

let seedNamespace: Record<string, unknown>;

if (SEED_ENABLED) {
  // Top-level await is supported by Vite (es2022 target) and produces an async
  // entry chunk. Rollup splits the seed module into a `seed-*.js` chunk; the
  // entry chunk only carries the import reference. In live mode this branch
  // is unreachable code and Rollup drops the import literal entirely.
  // @ts-expect-error - seed-raw/*.js has no declaration file by design
  const mod = await import('./seed-raw/seed.js');
  seedNamespace = mod as unknown as Record<string, unknown>;
} else {
  // Empty stub — adapters in live mode never read seed values (the
  // getSupabaseClient() branch fires first), but a few sync helpers
  // (getNavigation/getReadRegistry/...) guard with `?? {}` / `?? []` and need
  // a non-throwing access target.
  seedNamespace = {};
}

/**
 * Permissively-typed seed catalog. Cast to the expected shape at call sites
 * (matches the prior `seedModule as any` pattern in data-source.ts).
 *
 * In live mode (`VITE_USE_SEED=false`), this is `{}` and the seed-raw graph is
 * absent from the production bundle.
 */
export const seed = seedNamespace as Record<string, unknown>;

/**
 * Build-time flag exposed for diagnostics + tests. True in seed/demo mode,
 * false in live mode (`VITE_USE_SEED=false`).
 */
export const SEED_MODE_ENABLED = SEED_ENABLED;
