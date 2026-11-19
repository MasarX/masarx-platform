// _branch-band.ts — shared visual-band helper for canonical
// `branch_zones.priority` projection. Extracted out of branches.tsx +
// zones-drawer.tsx (W27 Cycle D Network closure: P2 redundancy).
//
// Canonical `public.branch_zones` has no `role` column; precedence is
// priority-ordered only (0 = highest). The FE projects priority into a
// visual band so the existing primary/secondary/fallback chip palette
// keeps working without inventing a non-canonical column.
//
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): the priority-band threshold
// is row-driven via the `branch_zone_band_priority_threshold` settings
// policy (settings_versions row sv_490). Callers resolve the policy and
// pass the canonical `fallback_min` to `priorityToBand(priority, fallbackMin)`.
//
// E2 closure (P2 #7) — `DEFAULT_BRANCH_ZONE_BAND_FALLBACK_MIN` removed.
// The previous behavior masked a missing canonical policy with a
// hardcoded baseline of 20; per closure policy a missing canonical row
// must surface a "(no policy)" chip rather than silently render a
// fallback band. `priorityToBand` now accepts a nullable `fallbackMin`
// and returns a sentinel `'no_policy'` band when the canonical policy is
// not seeded so callers can render an explicit error chip. Adding a new
// scope-level override is a settings_versions edit (no FE edit).

export type BranchZoneBand = 'primary' | 'secondary' | 'fallback' | 'no_policy';

/**
 * Project canonical `branch_zones.priority` to a visual band so the FE
 * keeps its existing primary/secondary/fallback chip palette without
 * inventing a non-canonical `role` column.
 *
 * Bands match the canonical `branch_zone_band` lookup category:
 *   priority 0          → primary
 *   priority 1..(fallback_min-1) → secondary
 *   priority >= fallback_min     → fallback
 *   (canonical policy missing)   → 'no_policy' sentinel for fail-loud chip
 *
 * `fallback_min` is row-driven via the
 * `branch_zone_band_priority_threshold` settings policy. Callers resolve
 * via `useResolveSettings('branch_zone_band_priority_threshold')` and
 * pass the canonical value here. When the policy resolves to null /
 * undefined, the function returns the `'no_policy'` sentinel so consumers
 * render a "(no policy)" chip rather than silently masking the gap.
 */
export function priorityToBand(
  priority: number | null | undefined,
  fallbackMin: number | null | undefined,
): BranchZoneBand {
  if (fallbackMin == null || !Number.isFinite(Number(fallbackMin)) || Number(fallbackMin) <= 0) {
    return 'no_policy';
  }
  const p = Number(priority);
  if (!Number.isFinite(p) || p <= 0) return 'primary';
  if (p < fallbackMin) return 'secondary';
  return 'fallback';
}
