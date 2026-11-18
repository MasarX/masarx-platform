// decisions.tsx — Insights · Decision log (decision_log SSOT viewer).
//
// Backed by useDecisionLog() (TanStack Query) — no direct api.* calls in the
// body. Row-click + the explicit "Open trail" row action open a Drawer rendering
// decision_inputs and the linkage block (settings_resolution_id, resolved_from).
//
// J pass additions:
//   • Deep-linkable URL params (category / range / scope) via useScopedSearch
//     and useUpdateSearch. Pasting `?category=route_assignment&scope=client`
//     restores the same view.
//   • Time-window chip rail (5m / 1h / 24h / 7d / all) clamps `occurred_at`
//     client-side using the typed `clampByRange` helper.
//   • Scope chip rail (global/tenant/client/sender/source/resource) over
//     `resolved_from` — the canonical override-ladder enum (AGENTS.md
//     "override ladder").
//   • Live-tail toggle subscribes to `api.streamEvidence(cb)` (the canonical
//     evidence stream the data-source already exposes for this very table).
//     Incoming rows are prepended; a "live · n new" pill ticks up.
//   • "View trace" row action passes the row's `correlation_id` via search
//     params so the traces page can preload it via its own `?cor=` reader.
//   • Drawer footer adds "Copy as curl" derived from the row's id (REST GET
//     against decision_log via env placeholders).
//
// ============================================================================
// LIVE-TAIL ENV CONTRACT (W33 closure — mirrors api-gateway Phase F)
// ============================================================================
// The live-tail behaviour is environment-conditional and zero-hardcoded:
//
//   • DEMO mode (default): when `VITE_REALTIME_ENABLED` is unset/`false` OR
//     `getSupabaseClient()` returns null, the surface uses
//     `api.streamEvidence(cb)` (the canonical synthetic evidence stream the
//     data-source exposes for `decision_log`). The "PREVIEW · synthetic
//     stream" pill stays surfaced.
//
//   • LIVE mode: when `VITE_REALTIME_ENABLED=true` AND a Supabase client is
//     available, the surface subscribes to `postgres_changes` on
//     `public.decision_log` via `client.channel('decision_log')`. INSERT
//     payloads are shaped through `shapeDecisionRealtimePayload` and prepended
//     onto the live buffer (capped at 50 rows). The synthetic stream is
//     bypassed.
//
// Both modes obey the same 50-row buffer cap and the same column rendering.
// The cutover is a pure environment change — no source edits required. See
// `apps/console-v2/.env.example` for the env contract and
// `apps/console-v2/src/lib/supabase.ts` for the factory. This is the
// W33 closure of the deferred INSIGHTS P1 (decisions Realtime channel)
// per `__audit__/REAUDIT2/INSIGHTS.md §3` and mirrors the api-gateway
// Phase F2 channel pattern (1:1).
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { DataTable, type DataTableColumn, type DataTableAction } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useDecisionLog, useResolveSettings, useResourceList } from '@/lib/queries';
import * as api from '@/lib/api';
import { useDrawer } from '@/hooks/useOverlay';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { getSupabaseClient } from '@/lib/supabase';
import type { DecisionLogEntry } from '@/types/domain';
import {
  clampByRange,
  clampByScope,
  isDecisionsRealtimeEnabled,
  shapeDecisionRealtimePayload,
  type RangeKey,
  type ScopeKey,
} from './_shared';
import { RangeChips, ScopeChips } from './_components';
import { useInsightsSearch, useUpdateSearch } from './_hooks';

// W30 — `DecisionLogDirectoryRow` mirrors the SQL view
// `public.v_decision_log_directory`
// (supabase/migrations/202604302810_v_decision_log_directory.sql). Read-only
// projection over decision_log + settings_resolution_log. Consumed
// additively as a header summary chip + drawer linkage cross-reference;
// the canonical SSOT seam for the table list stays
// `useDecisionLog({category})` (api.listDecisionLog).
interface DecisionLogDirectoryRow extends Record<string, unknown> {
  id: string;
  resolved_from: string | null;
  scope_path: unknown;
  scope_category: string | null;
  winning_settings_id: string | null;
  winning_version: number | null;
  age_seconds: number | null;
  has_correlation: boolean;
  has_resolution: boolean;
}

// SCHEMA-DRIFT NOTE (Wave 11 / W11-5 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §6):
// `DecisionLogEntry` (in `types/domain.ts`) now exposes only canonical
// `decision_log` columns:
//   • id, timestamp, decision_category, settings_resolution_id, resource_type,
//     resource_id (all native columns of public.decision_log).
//
// `resolved_from` is NOT a direct column on `public.decision_log`; it is
// projected from a JOIN with `settings_resolution_log.winning_scope_type` and
// is exposed here as an extended row field. The synthetic seed simulates this
// projection so the FE seam stays stable; live mode performs the actual JOIN.
//
// All other fields below are canonical: decision_inputs, correlation_id.
interface DecisionRow extends DecisionLogEntry {
  decision_inputs?: Record<string, unknown>;   // SSOT: decision_log.decision_inputs
  correlation_id?: string;                     // SSOT: decision_log.correlation_id
  resolved_from?: string;                      // PROJECTED: settings_resolution_log.winning_scope_type
}

function buildCategoryOptions(): Array<{ value: string; label: string }> {
  try {
    const list = (api.getLookups('decision_category') || []) as Array<{
      value: string;
      label?: string;
    }>;
    return list.map((c) => ({ value: c.value, label: c.label ?? c.value }));
  } catch {
    return [];
  }
}

// W30 — extended drawer body that augments the canonical decision_log row
// with directory-projected fields (age_seconds, scope_category,
// winning_settings_id / winning_version) when the
// `v_decision_log_directory` projection is available.
function decisionDrawerBodyWithDirectory(
  d: DecisionRow,
  directoryRow: DecisionLogDirectoryRow | undefined,
): ReactNode {
  const ageSeconds = directoryRow?.age_seconds ?? null;
  const ageLabel = ageSeconds == null
    ? '—'
    : ageSeconds < 60
      ? `${ageSeconds}s ago`
      : ageSeconds < 3600
        ? `${Math.floor(ageSeconds / 60)}m ago`
        : `${Math.floor(ageSeconds / 3600)}h ${Math.floor((ageSeconds % 3600) / 60)}m ago`;

  return (
    <div data-testid="decisions-drawer-body">
      <h4 className="eyebrow">Decision summary</h4>
      <div style={{ display: 'grid', gap: '6px', fontSize: '12px' }}>
        <div>{`Decision: ${d.decision_point ?? 'Recorded'}`}</div>
        <div>{`Outcome: ${d.decision_outcome ?? 'Recorded'}`}</div>
        <div>{`Reason: ${d.decision_reason ?? 'Not available'}`}</div>
      </div>
      <h4 className="eyebrow" style={{ marginTop: '12px' }}>
        Related activity
      </h4>
      <div style={{ display: 'grid', gap: '6px', fontSize: '12px' }}>
        <div>{`Policy decision: ${d.settings_resolution_id ? 'Recorded' : 'Not available'}`}</div>
        <div>{`Resolved from: ${directoryRow?.resolved_from ?? d.resolved_from ?? '—'}`}</div>
        <div>{`Activity reference: ${d.correlation_id ? 'Recorded' : 'Not available'}`}</div>
        {directoryRow ? (
          <>
            <div>{`Scope category: ${directoryRow.scope_category ?? '—'}`}</div>
            <div>{`Policy source: ${directoryRow.winning_settings_id ? 'Recorded' : 'Not available'}`}</div>
            <div>{`Policy version: ${directoryRow.winning_version ? 'Recorded' : 'Not available'}`}</div>
            <div>{`Age: ${ageLabel}`}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function DecisionsModule() {
  const navigate = useNavigate();
  const drawer = useDrawer();
  const search = useInsightsSearch();
  const updateSearch = useUpdateSearch();
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed
  // gate. Mirrors the existing pattern in `insights/api-gateway.tsx`
  // and `insights/reporting.tsx`. The decision_log read surface follows
  // the observability.read gate used by Insights navigation and registry rows.
  const canRead = useCapability(CAP.OBSERVABILITY_READ);

  // Local state mirrors URL — modules read URL on mount, write URL on change.
  const [category, setCategory] = useState<string>(search.category ?? '');
  const [range, setRange] = useState<RangeKey>(search.range ?? 'all');
  const [scope, setScope] = useState<ScopeKey>(search.scope ?? 'all');
  const [liveOn, setLiveOn] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [liveRows, setLiveRows] = useState<DecisionRow[]>([]);
  // W-Cycle-E2 (P2 #9) — `live_tail_policy.decisions_buffer_size` resolves
  // through the canonical settings ladder. Strict no-fallback: when the
  // policy is missing the live tail retains only the latest single row so the
  // gap is observable but the buffer does not silently exhaust memory.
  const liveTailPolicyResolution = useResolveSettings('live_tail_policy', undefined);
  const liveTailBufferSize = (liveTailPolicyResolution.data?.value as
    | { decisions_buffer_size?: number }
    | undefined)?.decisions_buffer_size;

  // Sync external URL changes (back/forward, paste) into local state.
  useEffect(() => {
    if (search.category !== undefined && search.category !== category) {
      setCategory(search.category);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.category]);
  useEffect(() => {
    if (search.range && search.range !== range) setRange(search.range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.range]);
  useEffect(() => {
    if (search.scope && search.scope !== scope) setScope(search.scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.scope]);

  const filters = useMemo(() => (category ? { category } : undefined), [category]);
  const { data, isLoading, isError } = useDecisionLog(filters);

  // W30 — paired projection view `public.v_decision_log_directory`
  // (supabase/migrations/202604302810_v_decision_log_directory.sql) projects
  // resolved_from / has_correlation / has_resolution / age_seconds /
  // scope_category / winning_settings_id / winning_version per decision row.
  // Consumed additively as a header summary chip source — the canonical
  // SSOT seam stays `useDecisionLog`.
  const directoryQuery = useResourceList<DecisionLogDirectoryRow>('decision_log_directory');
  const directory = useMemo(
    () => directoryQuery.data?.rows ?? [],
    [directoryQuery.data],
  );
  const directoryById = useMemo(() => {
    const m = new Map<string, DecisionLogDirectoryRow>();
    for (const r of directory) m.set(r.id, r);
    return m;
  }, [directory]);

  const directoryStats = useMemo(() => {
    let withCorrelation = 0;
    let withResolution = 0;
    for (const row of directory) {
      if (row.has_correlation) withCorrelation += 1;
      if (row.has_resolution) withResolution += 1;
    }
    return { total: directory.length, withCorrelation, withResolution };
  }, [directory]);

  const categoryOptions = useMemo(buildCategoryOptions, []);

  // Live tail — subscribe only when toggled ON. Maintains a small buffer of
  // new rows that get prepended into the rendered set; the pill counts them.
  //
  // W33: live-tail is environment-conditional and zero-hardcoded. See the
  // LIVE-TAIL ENV CONTRACT block at the top of this file. The mode is
  // selected once per liveOn-toggle (not per render) by reading
  // `getSupabaseClient()` + `import.meta.env.VITE_REALTIME_ENABLED` so the
  // wiring stays zero-hardcoded and mirrors the api-gateway Phase F2
  // pattern 1:1.
  useEffect(() => {
    if (!liveOn) return undefined;

    // W-Cycle-E2 (P2 #9) — buffer cap resolves through canonical
    // `live_tail_policy.decisions_buffer_size`. When missing, the buffer
    // retains only the latest single row (strict no-fallback).
    const cap = liveTailBufferSize ?? 1;
    const client = getSupabaseClient();
    if (isDecisionsRealtimeEnabled(client) && client) {
      // LIVE mode — subscribe to decision_log inserts via Supabase Realtime.
      const channel = client
        .channel('decision_log')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'decision_log' },
          (payload: { new?: Record<string, unknown> | null }) => {
            const shaped = shapeDecisionRealtimePayload(payload?.new ?? null);
            if (!shaped) return;
            setLiveRows((prev) => [shaped as DecisionRow, ...prev].slice(0, cap));
            setLiveCount((c) => c + 1);
          },
        )
        .subscribe();
      return () => {
        // Detach in both shapes (newer realtime APIs return a Promise from
        // removeChannel; older ones expose .unsubscribe directly).
        try {
          if (typeof (channel as { unsubscribe?: () => unknown }).unsubscribe === 'function') {
            (channel as { unsubscribe: () => unknown }).unsubscribe();
          }
          const remove = (client as { removeChannel?: (c: unknown) => unknown }).removeChannel;
          if (typeof remove === 'function') remove.call(client, channel);
        } catch {
          // intentional: tear-down is best-effort.
        }
      };
    }

    // DEMO mode — synthetic evidence stream fallback (preview/no-env path).
    const unsubscribe = api.streamEvidence((entry) => {
      setLiveRows((prev) => [entry as DecisionRow, ...prev].slice(0, cap));
      setLiveCount((c) => c + 1);
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* swallow — subscriber teardown should never throw */
      }
    };
  }, [liveOn, liveTailBufferSize]);

  // Reset the live counter when the live toggle changes.
  const liveStartedRef = useRef(false);
  useEffect(() => {
    if (liveOn && !liveStartedRef.current) {
      liveStartedRef.current = true;
      setLiveCount(0);
    } else if (!liveOn) {
      liveStartedRef.current = false;
    }
  }, [liveOn]);

  const baseRows = useMemo<DecisionRow[]>(() => {
    const list = (data as DecisionRow[]) ?? [];
    return [...liveRows, ...list];
  }, [data, liveRows]);

  const filteredRows = useMemo<DecisionRow[]>(() => {
    let out = baseRows;
    // `timestamp` is the canonical `decision_log.timestamp` column (renamed
    // from FE-side `occurred_at` per W11-5 schema-drift closure).
    out = clampByRange(out, 'timestamp', range);
    // `resolved_from` is a JOIN-projected field; see DecisionRow note above.
    out = clampByScope(out, 'resolved_from', scope);
    return out;
  }, [baseRows, range, scope]);

  const openDrawer = useCallback(
    (d: DecisionRow) => {
      const directoryRow = directoryById.get(String(d.id));
      drawer.open({
        title: `Decision · ${d.id}`,
        size: 'lg',
        body: decisionDrawerBodyWithDirectory(d, directoryRow),
      });
    },
    [drawer, directoryById],
  );

  const onCategoryChange = (next: string) => {
    setCategory(next);
    updateSearch({ category: next || undefined });
  };
  const onRangeChange = (next: RangeKey) => {
    setRange(next);
    updateSearch({ range: next === 'all' ? undefined : next });
  };
  const onScopeChange = (next: ScopeKey) => {
    setScope(next);
    updateSearch({ scope: next === 'all' ? undefined : next });
  };

  const columns = useMemo<Array<DataTableColumn<DecisionRow>>>(
    () => [
      // canonical column on public.decision_log
      { key: 'timestamp', label: 'When', format: 'datetime', sortable: true },
      {
        key: 'decision_category',
        label: 'Category',
        lookup: 'decision_category',
        sortable: true,
        filterable: true,
      },
      { key: 'resource_type', label: 'Resource', sortable: true, filterable: true },
      { key: 'resource_id', label: 'ID', mono: true, sortable: true, filterable: true },
      // projected from settings_resolution_log.winning_scope_type (see DecisionRow note)
      { key: 'resolved_from', label: 'Scope', sortable: true, filterable: true },
      { key: 'settings_resolution_id', label: 'Resolution', mono: true },
    ],
    [],
  );

  const rowActions = useMemo<Array<DataTableAction<DecisionRow>>>(
    () => [
      { label: 'Open trail', icon: 'eye', onClick: openDrawer },
      {
        label: 'Open activity history',
        icon: 'trace_tree',
        onClick: (row) => {
          const cor = row.correlation_id;
          void navigate({
            to: '/insights/traces',
            search: cor ? { cor } : undefined,
          });
        },
      },
      { label: 'Open scope ladder', icon: 'layers', onClick: () => navigate({ to: '/platform/config' }) },
    ],
    [navigate, openDrawer],
  );

  // W33 — stream-mode reflection for the page-header pill (re-read on every
  // render so it stays in sync with env changes during HMR; the underlying
  // client is memoized inside the factory). Mirrors the api-gateway Phase F2
  // pill so operators see PREVIEW vs LIVE on the decisions surface too.
  const realtimeMode = isDecisionsRealtimeEnabled(getSupabaseClient());

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="decisionLog"
          eyebrow="Insights"
          titleAccent="Decision"
          titlePlain="log"
        />
        <StateView
          kind="denied"
          capability={CAP.OBSERVABILITY_READ}
          hint="You do not have permission to view the decision log (observability.read)."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="decisionLog"
        eyebrow="Insights"
        titleAccent="Decision"
        titlePlain="log"
        pills={[
          <Chip
            key="src"
            label="Decision log"
            kind="neutral"
            size="xs"
            className="mono"
          />,
          // W30 — Directory summary pill, sourced from
          // `public.v_decision_log_directory` (joined decision_log +
          // settings_resolution_log). Surfaces correlation/resolution
          // coverage so operators can spot trace-coverage gaps.
          directoryStats.total > 0 ? (
            <Chip
              key="directory"
              label={`${directoryStats.withCorrelation}/${directoryStats.total} linked · ${directoryStats.withResolution} resolved`}
              kind="info"
              size="xs"
              className="mono"
              data-testid="decision-directory-pill"
              title="Counts of decisions linked to activity references and setting resolutions."
            />
          ) : null,
          // W33 — stream-mode pill (PREVIEW vs LIVE) so operators can tell at
          // a glance whether the live-tail is reading the synthetic seed
          // generator or a real Supabase Realtime channel on
          // `public.decision_log`. Mirrors the api-gateway Phase F2 contract.
          realtimeMode ? (
            <Chip
              key="stream-mode"
              label="Live event stream"
              kind="good"
              size="xs"
              className="mono"
              title="Decision activity updates are connected to the live event stream."
              data-testid="decisions-stream-mode"
            />
          ) : (
            <Chip
              key="stream-mode"
              label="Preview event stream"
              kind="info"
              size="xs"
              className="mono"
              title="Decision activity updates are shown in preview mode until live events are enabled."
              data-testid="decisions-stream-mode"
            />
          ),
          liveOn ? (
            <Chip
              key="live"
              label={`live · ${liveCount} new`}
              kind="good"
              size="xs"
              className="mono"
            />
          ) : (
            <Chip key="live" label="live · off" kind="neutral" size="xs" className="mono" />
          ),
        ]}
        actions={[]}
      />

      <div className="view-bar">
        <div className="view-bar__group">
          <label className="eyebrow" htmlFor="decisions-category">
            Category
          </label>
          <select
            id="decisions-category"
            value={category}
            onChange={(e) => onCategoryChange(e.target.value)}
          >
            <option value="">— all categories —</option>
            {categoryOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <RangeChips value={range} onChange={onRangeChange} />
        <ScopeChips value={scope} onChange={onScopeChange} />
        <div className="view-bar__spacer" />
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          aria-pressed={liveOn}
          onClick={() => setLiveOn((v) => !v)}
          title="Subscribe to decision activity updates"
          data-testid="decisions-live-toggle"
        >
          {liveOn ? 'Pause live updates' : 'Start live updates'}
        </button>
      </div>

      {isError ? (
        <StateView kind="error" hint="Could not load decision activity." />
      ) : isLoading || !data ? (
        <StateView kind="loading" hint="Loading decision log…" />
      ) : (
        <DataTable<DecisionRow>
          columns={columns}
          rows={filteredRows}
          viewKey="decision_log"
          entityKind="decision"
          onRowClick={openDrawer}
          rowActions={rowActions}
        />
      )}

      {drawer.node}
    </div>
  );
}
