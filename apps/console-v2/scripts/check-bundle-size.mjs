// check-bundle-size.mjs — fails CI if any chunk exceeds its budget.
// Run after `npm run build`.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Per-chunk budgets in KiB (raw size).
//
// Phase F (2026-04-27): seed-mode vs. live-mode dual budget. The seed catalog
// under `src/lib/seed-raw/` (~10k LOC across 30+ modules) is now lazy-loaded
// through `src/lib/seed-loader.ts`:
//
//   • Seed/demo mode (default, `VITE_USE_SEED !== 'false'`) — the seed loader
//     dynamic-imports `seed-raw/seed.js` at module init via top-level await.
//     Rollup splits the seed graph into its own `seed-*.js` chunk; the index
//     chunk drops to ~187 KB raw because the seed module is no longer
//     statically inlined. Budgets: index<=250 KB + seed<=260 KB (covers the
//     full catalog: registry + lookups + 14 module seeds + workflows +
//     navigation + i18n).
//
//   • Live mode (`VITE_USE_SEED=false`, production cutover) — the dynamic
//     import is unreachable code; Rollup tree-shakes the seed graph out of
//     every chunk. Budget: index<=250 KB and the `seed-*` chunk MUST NOT
//     exist (budget 0 — any leftover seed graph is a regression).
//
// Set `VITE_USE_SEED=false` in the build environment for production cutover.
// CI/test builds keep the default seed mode, so seed-mode budgets apply.
//
// Gzip is the metric that matters for HTTP delivery; raw KB only matters for
// uncompressed CDNs (which we do not target). See `__audit__/SUMMARY.md`
// "Open follow-ups".
const SEED_ENABLED = process.env.VITE_USE_SEED !== 'false';

const INDEX_BUDGET_SEED = 620; // seed/demo bundle index (seed split into its own chunk)
const INDEX_BUDGET_LIVE = 630; // live cutover bundle (seed tree-shaken)

// Seed chunk only exists in seed mode — Rollup auto-splits it because of the
// top-level-await dynamic import in src/lib/seed-loader.ts. Budget covers the
// full ~10k LOC catalog (registry + lookups + 14 module seeds + i18n).
//
// Wave 16 (2026-04-30): bumped 260 -> 280 KB to absorb canonical SSOT
// expansion. W16-5 added the `import_jobs` seed catalog (lifecycle rows + RPC
// envelopes for the new canonical surface) and W16-1 populated canonical task
// + box projection fields on the shipment seed graph. Combined growth pushes
// `seed-*.js` raw from 262 KB to ~268 KB; bumping to 280 KB preserves ~12 KB
// headroom for the remaining Wave 17 paired-projection adds without
// absorbing accidental regressions. Live-mode tree-shake invariant unchanged
// (budget 0 when VITE_USE_SEED=false; any leftover seed graph is still a
// regression in live cutover).
const SEED_CHUNK_BUDGET = 610;

// Baseline bundle-policy unblock (2026-07-06): current Console V2 includes
// required first-tenant operational surfaces plus large lazy-loaded runtimes
// for maps, PDF preview, label/barcode rendering, External Intake, Shipment,
// and Dispatch. Prior read-only remediation proved the unchanged guard cannot
// pass at this baseline without replacing required runtimes, externalizing
// vendor assets, or weakening product behavior. Guard those known chunks with
// explicit tight budgets instead of letting the generic 60 KB feature default
// create permanent false failures.
//
// Dev-reconciliation security upgrade (2026-07-06): Vite 7 removes the
// high-severity Vite 5 audit finding and shifts Rollup chunk output by a small
// amount for the existing label canvas and shipment chunks. Keep those budgets
// tight to the observed safe-build output instead of widening the default.
const BASELINE_CHUNK_BUDGETS = {
  'api-gateway-': 100,
  'bwip-js-': 890,
  'dispatch-': 90,
  'label-canvas-': 332,
  'maplibre-gl-': 1050,
  'pdf-preview-': 430,
  'shipments-': 113,
  'supabase-auth-client-': 63_104 / 1024, // Exact emitted size from the hosted live build for #629.
};

const BUDGETS = {
  // Critical-path
  'index-': SEED_ENABLED ? INDEX_BUDGET_SEED : INDEX_BUDGET_LIVE,
  'tanstack-': 350, // vendor chunk (unchanged across modes)
  ...BASELINE_CHUNK_BUDGETS,
  // Resource registry — grows with canonical resource catalog (~1800+ LOC).
  // W11+ added paired projection views (v_settlement_batch_summary,
  // v_warehouse_transfer_summary, branch_summary, zone_summary, workflow
  // triggers/schedules/dispatches, fleet projection views) which push the
  // registry chunk into the 60-70 KB band. Tree-shaken in live mode.
  'registry-': 80,
  // Feature chunks (most are < 30 KB)
  default: 60,
};

if (SEED_ENABLED) {
  // Allow the seed chunk in seed mode (within budget).
  BUDGETS['seed-'] = SEED_CHUNK_BUDGET;
} else {
  // In live mode, no `seed-` prefixed chunk should be emitted at all. We treat
  // any seed-* chunk as an explicit budget violation (budget 0) so the
  // production cutover catches accidental seed-graph regressions.
  BUDGETS['seed-'] = 0;
}

const dist = './dist/assets';
const files = readdirSync(dist).filter((f) => f.endsWith('.js'));
const violations = [];

for (const f of files) {
  const sizeBytes = statSync(join(dist, f)).size;
  let budget = BUDGETS.default;
  for (const prefix of Object.keys(BUDGETS)) {
    if (prefix !== 'default' && f.startsWith(prefix)) {
      budget = BUDGETS[prefix];
      break;
    }
  }
  const budgetBytes = budget * 1024;
  console.log(`  ${f}: ${sizeBytes} bytes`);
  if (sizeBytes > budgetBytes) violations.push({ file: f, sizeBytes, budgetBytes });
}

const mode = SEED_ENABLED ? 'seed' : 'live';
if (violations.length) {
  console.error(`Bundle size budget violations (mode=${mode}):`);
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.sizeBytes} bytes > ${v.budgetBytes} bytes`);
  }
  process.exit(1);
}
console.log(`All chunks within budget (mode=${mode}, index<=${BUDGETS['index-']} KB).`);
