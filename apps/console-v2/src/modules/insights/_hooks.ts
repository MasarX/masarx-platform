// _hooks.ts — Insights-only hooks (no JSX). Pulled out of `_components.tsx`
// so the JSX file stays component-only, satisfying `react-refresh/only-export-components`.

import { useCallback, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useScopedSearch } from '@/hooks/useScopedSearch';
import { useResourceList } from '@/lib/queries';
import { isRangeKey, isScopeKey, SCOPE_OPTIONS, type InsightsSearchShape, type ScopeKey } from './_shared';

// W54-D — `scope_type_registry` row shape mirrors the canonical SSOT seed
// (`scope_type_registry` in policies.js + the paired backend migration
// 202601301100_scope_registry_ssot.sql).
interface ScopeTypeRegistryRow {
  id: string;
  scope_type: string;
  description?: string;
  ladder_rank: number;
  is_enabled?: boolean;
}

/**
 * W54-D — Canonical scope-options hook. Subscribes to `scope_type_registry`
 * and returns the rank-sorted enabled scope rows plus the explicit `'all'`
 * sentinel chip prepended at the head. Replaces the inline `SCOPE_OPTIONS`
 * ReadonlyArray literal that previously hardcoded the override-ladder order
 * in `_shared.ts`. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
 *
 * The `'all'` sentinel remains row-independent (it represents "no scope
 * filter"), but the per-scope chips now follow whatever order
 * `scope_type_registry.ladder_rank` declares. Adding a new tier or
 * disabling an existing one is a row mutation; ScopeChips picks it up
 * without source change.
 *
 * Consumers: `<ScopeChips>` in `_components.tsx`. The pure
 * `clampByScope` / `isScopeKey` helpers in `_shared.ts` continue to consult
 * `SCOPE_OPTIONS` since they are pure non-React utilities used by tests
 * and clamping logic — they need a static canonical set, not a registry
 * subscription.
 */
export function useScopeOptions(): ReadonlyArray<{ key: ScopeKey; label: string }> {
  const { data } = useResourceList<ScopeTypeRegistryRow>('scope_type_registry');
  return useMemo<ReadonlyArray<{ key: ScopeKey; label: string }>>(() => {
    const rows = data?.rows ?? [];
    const sorted = rows
      .filter((r) => r.is_enabled !== false)
      .slice()
      .sort((a, b) => a.ladder_rank - b.ladder_rank)
      .map((r) => ({
        key: r.scope_type as ScopeKey,
        label: r.scope_type.charAt(0).toUpperCase() + r.scope_type.slice(1),
      }));
    // Registry not yet resolved → fall through to the static canonical set
    // so the chip rail never renders empty during initial mount. The static
    // `SCOPE_OPTIONS` already includes the `'all'` sentinel + canonical
    // ladder order.
    if (sorted.length === 0) return SCOPE_OPTIONS;
    return [{ key: 'all' as ScopeKey, label: 'All' }, ...sorted];
  }, [data]);
}

/**
 * Returns a navigate callback that PATCHES the typed search params for the
 * current route. We use `to: '.'` so we stay on the same route and only the
 * search param changes (back/forward then preserves the timeline).
 */
export function useUpdateSearch() {
  const navigate = useNavigate();
  return useCallback(
    (patch: Partial<InsightsSearchShape>) => {
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown> | undefined) => {
          const next: Record<string, unknown> = { ...(prev ?? {}) };
          for (const [k, v] of Object.entries(patch)) {
            if (v == null || v === '' || v === 'all') {
              delete next[k];
            } else {
              next[k] = v;
            }
          }
          return next;
        },
        replace: false,
      });
    },
    [navigate],
  );
}

/**
 * Reads the typed insights search params off the URL with safe coercion. Uses
 * TanStack's `useSearch({ strict: false })` via `useScopedSearch` so a route
 * without a `validateSearch` still returns `{}` (no throw).
 */
export function useInsightsSearch(): InsightsSearchShape {
  const raw = useScopedSearch<InsightsSearchShape>();
  return useMemo(() => {
    const out: InsightsSearchShape = {};
    if (isRangeKey(raw.range)) out.range = raw.range;
    if (isScopeKey(raw.scope)) out.scope = raw.scope;
    if (typeof raw.category === 'string' && raw.category) out.category = raw.category;
    if (typeof raw.cor === 'string' && raw.cor) out.cor = raw.cor;
    if (typeof raw.q === 'string' && raw.q) out.q = raw.q;
    return out;
  }, [raw]);
}
