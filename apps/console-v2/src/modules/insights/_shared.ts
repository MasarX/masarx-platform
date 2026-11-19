// _shared.ts — Insights-only helpers (no JSX, no components).
//
// Component exports (RangeChips / ScopeChips / CurlBlock) live in
// `_shared.tsx`. Splitting here keeps `react-refresh/only-export-components`
// happy: a `.tsx` file should ONLY export components.
//
// Owns:
//   • RangeKey + getRangeOptions() + isRangeKey + rangeMs + clampByRange
//   • ScopeKey + getScopeOptions() + isScopeKey + clampByScope
//   • buildCurlGet / buildCurlRpc — copy-paste curl templates with placeholder
//     env vars only (no secrets emitted).
//   • InsightsSearchShape contract used by useInsightsSearch.
//
// W27-cycle-D §8 — Scope options derive from the canonical `scope_type`
// lookup catalog via `getLookups('scope_type')` instead of an inline literal
// array, so adding a new scope tier upstream lights up the FilterBar/ScopeChips
// automatically.
//
// W-Cycle-E2 (P1 #4) — Range/Scope keys are now widened to `string` and the
// option arrays are read on every call (no module-top snapshot frozen at
// import time). Per-window milliseconds project from canonical
// `time_range_options` lookup `metadata.window_ms`. AGENTS.md §2 (ZERO
// HARDCODING) + §4 (SSOT).

import { getLookups } from '@/lib/api';

// ---------- Range ----------

// W-Cycle-E2 (P1 #4) — `RangeKey` is now a wider `string` so the module
// absorbs any window registered in `lookups.time_range_options` (currently
// 5m/1h/24h/7d/all, but extensible). Consumers narrow at the call site via
// `isRangeKey()` if needed.
export type RangeKey = string;

interface RangeOption {
  key: string;
  label: string;
  ms: number | null;
}

/**
 * W-Cycle-E2 (P1 #4) — Returns the canonical time-range options derived from
 * the `time_range_options` lookup catalog. Re-reads on each call so the array
 * never freezes at import time (the lookups module loads asynchronously via
 * data-source bootstrap; module-top snapshots have miss-the-bus risk).
 */
export function getRangeOptions(): ReadonlyArray<RangeOption> {
  const rows = getLookups('time_range_options') as Array<{
    value: string;
    label: string;
    rank?: number;
    metadata?: { window_ms?: number | null };
  }>;
  return rows
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((row) => ({
      key: row.value,
      label: row.label,
      ms: row.metadata?.window_ms ?? null,
    }));
}

/**
 * Back-compat constant kept as a `Proxy` over `getRangeOptions()` so legacy
 * consumers (and tests) that iterate `RANGE_OPTIONS` continue to function
 * while reading row-driven data. Prefer `getRangeOptions()` in new code so
 * the lazy/per-call read is explicit.
 */
export const RANGE_OPTIONS: ReadonlyArray<RangeOption> = new Proxy([] as RangeOption[], {
  get(_, prop) {
    const arr = getRangeOptions();
    if (prop === 'length') return arr.length;
    if (prop === Symbol.iterator) return arr[Symbol.iterator].bind(arr);
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return arr[Number(prop)];
    const value = (arr as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? value.bind(arr) : value;
  },
}) as ReadonlyArray<RangeOption>;

export function isRangeKey(v: unknown): v is RangeKey {
  return typeof v === 'string' && getRangeOptions().some((r) => r.key === v);
}

export function rangeMs(key: RangeKey | undefined | null): number | null {
  if (!key) return null;
  return getRangeOptions().find((r) => r.key === key)?.ms ?? null;
}

/** Returns rows whose `[atKey]` falls within `now - rangeMs`. 'all' or unknown returns input. */
export function clampByRange<T extends Record<string, unknown>>(
  rows: T[],
  atKey: keyof T & string,
  range: RangeKey | undefined | null,
): T[] {
  const ms = rangeMs(range ?? 'all');
  if (ms == null) return rows;
  const cutoff = Date.now() - ms;
  return rows.filter((r) => {
    const raw = r[atKey];
    if (raw == null) return true; // do not silently drop rows missing the column
    const t = new Date(raw as string | number | Date).getTime();
    if (Number.isNaN(t)) return true;
    return t >= cutoff;
  });
}

// ---------- Scope ----------

// W-Cycle-E2 (P1 #4) — `ScopeKey` is now a wider `string` so the module
// absorbs any tier registered in `scope_type_registry` (currently
// global/tenant/client/sender/source/resource, but extensible) plus the FE-only
// `'all'` sentinel. Consumers narrow at the call site via `isScopeKey()`.
export type ScopeKey = string;

interface ScopeOption {
  key: string;
  label: string;
}

/**
 * W-Cycle-E2 (P1 #4) — Returns the canonical scope options derived from the
 * `scope_type` lookup catalog with the explicit `'all'` sentinel prepended.
 * Re-reads on each call so the array never freezes at import time. Mirrors
 * the registry-driven contract of `_hooks.ts#useScopeOptions()` for non-React
 * call sites (clamping helpers + tests).
 */
export function getScopeOptions(): ReadonlyArray<ScopeOption> {
  const rows = getLookups('scope_type') as Array<{ value: string; label: string; rank?: number }>;
  return [
    { key: 'all', label: 'All' },
    ...rows
      .slice()
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .map((row) => ({ key: row.value, label: row.label })),
  ];
}

/**
 * Back-compat constant kept as a `Proxy` over `getScopeOptions()` so legacy
 * consumers (and tests) that iterate `SCOPE_OPTIONS` continue to function while
 * reading row-driven data. Prefer `getScopeOptions()` in new code so the
 * lazy/per-call read is explicit.
 */
export const SCOPE_OPTIONS: ReadonlyArray<ScopeOption> = new Proxy([] as ScopeOption[], {
  get(_, prop) {
    const arr = getScopeOptions();
    if (prop === 'length') return arr.length;
    if (prop === Symbol.iterator) return arr[Symbol.iterator].bind(arr);
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return arr[Number(prop)];
    const value = (arr as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? value.bind(arr) : value;
  },
}) as ReadonlyArray<ScopeOption>;

export function isScopeKey(v: unknown): v is ScopeKey {
  return typeof v === 'string' && getScopeOptions().some((s) => s.key === v);
}

/** Returns rows whose `[scopeKey]` matches the chosen scope. 'all' or unknown returns input. */
export function clampByScope<T extends Record<string, unknown>>(
  rows: T[],
  scopeKey: keyof T & string,
  scope: ScopeKey | undefined | null,
): T[] {
  if (!scope || scope === 'all') return rows;
  return rows.filter((r) => String(r[scopeKey] ?? '') === scope);
}

// ---------- Curl templates ----------

export interface CurlGetOpts {
  /** REST resource (e.g. "decision_log", "ui_event_log"). */
  table: string;
  /** PostgREST predicate string (e.g. "id=eq.aud_4501"). */
  predicate: string;
  /** Optional comma-separated select list. Defaults to `*`. */
  select?: string;
}

/**
 * Builds a copy-paste curl command targeting the Supabase REST URL via env
 * placeholders. No secrets are emitted; the operator paste-replaces $SUPABASE_*.
 */
export function buildCurlGet({ table, predicate, select = '*' }: CurlGetOpts): string {
  const path = `/rest/v1/${table}?${predicate}&select=${encodeURIComponent(select)}`;
  // Keep on one logical line; wrap visually with backslash continuation so the
  // copy still pastes cleanly into a POSIX shell.
  return [
    `curl -sS \\`,
    `  -H "apikey: $SUPABASE_KEY" \\`,
    `  -H "Authorization: Bearer $SUPABASE_KEY" \\`,
    `  -H "Accept: application/json" \\`,
    `  "$SUPABASE_URL${path}"`,
  ].join('\n');
}

/** Builds a curl that calls a Supabase RPC by name. */
export function buildCurlRpc(name: string, body: Record<string, unknown>): string {
  const json = JSON.stringify(body);
  return [
    `curl -sS \\`,
    `  -X POST \\`,
    `  -H "apikey: $SUPABASE_KEY" \\`,
    `  -H "Authorization: Bearer $SUPABASE_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Accept: application/json" \\`,
    `  "$SUPABASE_URL/rest/v1/rpc/${name}" \\`,
    `  -d ${JSON.stringify(json)}`,
  ].join('\n');
}

// ---------- URL search shape ----------

export interface InsightsSearchShape extends Record<string, unknown> {
  range?: RangeKey;
  scope?: ScopeKey;
  category?: string;
  cor?: string;
  q?: string;
}

// ---------- Decisions Realtime envelope (W33 closure) ----------
//
// Mirrors the api-gateway Phase F2 channel pattern (`shapeRealtimePayload`
// + `isRealtimeEnabled`) for `public.decision_log`. Used by
// `decisions.tsx` to swap the synthetic `streamEvidence` stream for a
// canonical Supabase Realtime `postgres_changes` subscription when env +
// client are both available. See REAUDIT2/INSIGHTS.md §3 for the deferred
// P1 closure contract.

/**
 * Lightweight FE row shape for canonical `public.decision_log` columns we
 * surface on the decisions table + drawer. Mirrors `DecisionRow` /
 * `DecisionLogEntry` but lives in `_shared.ts` so the helpers here remain
 * pure (no JSX, no React imports). Realtime payloads route through this
 * shaper before being prepended onto the live buffer.
 */
export interface DecisionRowLite {
  id: string;
  timestamp: string;
  decision_category: string;
  settings_resolution_id?: string | null;
  resource_id?: string | null;
  resource_type?: string | null;
  decision_inputs?: Record<string, unknown>;
  correlation_id?: string | null;
  // PROJECTED via JOIN with settings_resolution_log.winning_scope_type;
  // not a direct column on decision_log. Realtime envelopes that originate
  // from the raw decision_log INSERT will not carry this — null is safe and
  // the directory projection backfills it on next refetch.
  resolved_from?: string | null;
}

/**
 * Shape a Supabase Realtime `postgres_changes` payload row into the FE
 * `DecisionRowLite` contract. The Realtime row mirrors the canonical
 * `public.decision_log` columns; we map column names directly and fall back
 * to safe defaults for the projected fields (`resolved_from`) which are
 * populated by the directory projection on the read side. Returns null when
 * the payload is missing required fields so the caller can skip the prepend.
 */
export function shapeDecisionRealtimePayload(
  newRow: Record<string, unknown> | null | undefined,
): DecisionRowLite | null {
  if (!newRow || typeof newRow !== 'object') return null;
  const r = newRow as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : null;
  const decisionCategory =
    typeof r.decision_category === 'string' ? r.decision_category : null;
  if (!id || !decisionCategory) return null;

  // `timestamp` aliases the canonical decision_log.timestamp column.
  // Older FE-side envelopes used `occurred_at`; tolerate that for safety.
  const timestamp =
    typeof r.timestamp === 'string'
      ? r.timestamp
      : typeof r.occurred_at === 'string'
        ? r.occurred_at
        : new Date().toISOString();

  const decisionInputs =
    r.decision_inputs && typeof r.decision_inputs === 'object' && !Array.isArray(r.decision_inputs)
      ? (r.decision_inputs as Record<string, unknown>)
      : undefined;

  return {
    id,
    timestamp,
    decision_category: decisionCategory,
    settings_resolution_id:
      typeof r.settings_resolution_id === 'string' ? r.settings_resolution_id : null,
    resource_id: typeof r.resource_id === 'string' ? r.resource_id : null,
    resource_type: typeof r.resource_type === 'string' ? r.resource_type : null,
    decision_inputs: decisionInputs,
    correlation_id: typeof r.correlation_id === 'string' ? r.correlation_id : null,
    // resolved_from is projected from settings_resolution_log via JOIN; raw
    // decision_log INSERT envelopes will not carry it. Null is correct here —
    // the directory projection backfills it on next refetch.
    resolved_from: typeof r.resolved_from === 'string' ? r.resolved_from : null,
  };
}

/**
 * Pure environment probe — returns true when `VITE_REALTIME_ENABLED=true`
 * (case-insensitive) and a non-null Supabase client is supplied. Mirror of
 * `isRealtimeEnabled` from the api-gateway helpers; kept here so the
 * decisions surface stays self-contained (decision_log is the SSOT for the
 * 2AM-debugging surface and warrants its own probe seam for tests).
 *
 * The lookup is deliberately lazy: callers re-read each render so that env
 * stubbing in tests (`vi.stubEnv`) and runtime client memoization both stay
 * authoritative — there is no per-module cached boolean.
 */
export function isDecisionsRealtimeEnabled(
  client: { channel: (name: string) => unknown } | null,
): boolean {
  if (!client) return false;
  const raw = (import.meta.env as Record<string, string | undefined>)
    .VITE_REALTIME_ENABLED;
  if (typeof raw !== 'string') return false;
  return raw.toLowerCase() === 'true';
}
