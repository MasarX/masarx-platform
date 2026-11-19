// resolutions.tsx - Insights policy decision log.
//
// Backed by useResolutionLog() (TanStack Query). Each row, when clicked, opens
// a Drawer rendering the override-ladder traversal via <LadderViz>.
//
// J pass additions:
//   • Scope chip rail filters by `winning_scope_type` against the canonical
//     scope ladder (Global/Tenant/Client/Sender/Source/Resource — registry-
//     derived per AGENTS.md "override ladder"). URL reflects state.
//   • Range chip rail clamps `resolved_at` client-side. URL reflects.
//   • Drawer keeps operator-facing activity details out of terminal/debug flows.
//
// SCHEMA-DRIFT NOTE (W14-6 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §8):
// The FE row interface is now flat-aligned with `public.settings_resolution_log`
// (`supabase/migrations/202511021310_settings_resolution_log.sql:12-26`).
// Fields previously nested under `winning` are now top-level columns
// (`winning_scope_type`, `winning_scope_id`, `winning_settings_id`,
// `winning_settings_version_id`, `winning_version`). The FE-only `ladder_path`
// alias has been retired in favour of canonical `scope_path` (JSONB). The
// LadderViz component accepts `ResolutionLogRow` directly — no adapter.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { LadderViz } from '@/components/LadderViz';
import { StateView } from '@/components/StateView';
import { useResolutionLog, useResourceList } from '@/lib/queries';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useDrawer } from '@/hooks/useOverlay';
import type { ResolutionLogRow } from '@/types/domain';
import {
  clampByRange,
  type RangeKey,
  type ScopeKey,
} from './_shared';
import { RangeChips, ScopeChips } from './_components';
import { useInsightsSearch, useUpdateSearch } from './_hooks';

// W30 — `SettingsResolutionDirectoryRow` mirrors the SQL view
// `public.v_settings_resolution_directory`
// (supabase/migrations/202604302820_v_settings_resolution_directory.sql).
// Read-only projection over settings_resolution_log. Consumed additively
// as a header summary chip + per-row "ladder levels visited" / "overrides"
// columns; the canonical SSOT seam stays `useResolutionLog`.
//
// W-Cycle-E (P2 #8) — winner aggregation reads the canonical
// `winning_scope_type` column directly. The prior `is_global_winner` /
// `is_tenant_winner` / `is_client_winner` / `is_sender_winner` boolean
// explosion was a documented FE-only projection that silently dropped
// `source`/`resource` winners (they collapsed into `is_sender_winner`).
// The interface now exposes only the canonical column; aggregations build
// a tier→count map generically so any new ladder tier added to
// `scope_type_registry` lights up automatically without code changes.
interface SettingsResolutionDirectoryRow extends Record<string, unknown> {
  id: string;
  ladder_levels_visited: number;
  override_count: number;
  age_seconds: number | null;
  winning_scope_type: string | null;
}

function ladderDrawerBody(row: ResolutionLogRow): ReactNode {
  return (
    <div>
      <p className="state__hint">
        Walk along the scope ladder. Winning scope marked with the green stripe.
      </p>
      <LadderViz resolution={row} />
    </div>
  );
}

export function ResolutionsModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed gate.
  const canRead = useCapability(CAP.OBSERVABILITY_READ);
  const drawer = useDrawer();
  const search = useInsightsSearch();
  const updateSearch = useUpdateSearch();
  const [scope, setScope] = useState<ScopeKey>(search.scope ?? 'all');
  const [range, setRange] = useState<RangeKey>(search.range ?? 'all');

  useEffect(() => {
    if (search.scope && search.scope !== scope) setScope(search.scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.scope]);
  useEffect(() => {
    if (search.range && search.range !== range) setRange(search.range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.range]);

  const { data, isLoading, isError } = useResolutionLog();

  // W30 — paired projection view `public.v_settings_resolution_directory`
  // (supabase/migrations/202604302820_v_settings_resolution_directory.sql)
  // surfaces per-row ladder_levels_visited / override_count / age_seconds /
  // winner-bucket booleans. Consumed additively as decoration columns —
  // the canonical SSOT seam stays `useResolutionLog`.
  const directoryQuery = useResourceList<SettingsResolutionDirectoryRow>(
    'settings_resolution_directory',
  );
  const directory = useMemo(
    () => directoryQuery.data?.rows ?? [],
    [directoryQuery.data],
  );
  const directoryById = useMemo(() => {
    const m = new Map<string, SettingsResolutionDirectoryRow>();
    for (const r of directory) m.set(r.id, r);
    return m;
  }, [directory]);

  // W-Cycle-E (P2 #8) — winner aggregation derives generically from the
  // canonical `winning_scope_type` column instead of a per-tier boolean
  // explosion. Any tier added to `scope_type_registry` lights up here
  // without code changes (no silent drop of source/resource winners).
  const directoryStats = useMemo(() => {
    let totalOverrides = 0;
    const winnersByType: Record<string, number> = {};
    for (const row of directory) {
      totalOverrides += row.override_count;
      const t = row.winning_scope_type ?? 'unknown';
      winnersByType[t] = (winnersByType[t] ?? 0) + 1;
    }
    return {
      total: directory.length,
      totalOverrides,
      winnersByType,
    };
  }, [directory]);

  const rows = useMemo<ResolutionLogRow[]>(() => {
    const list = (data as ResolutionLogRow[]) ?? [];
    let out = clampByRange(list, 'resolved_at', range);
    if (scope !== 'all') {
      out = out.filter((r) => (r.winning_scope_type ?? '') === scope);
    }
    return out;
  }, [data, range, scope]);

  // W30 — Decorate per-row directory projection fields onto the canonical
  // ResolutionLogRow so the DataTable can render ladder_levels_visited /
  // override_count without per-row jsonb digging.
  type DecoratedRow = ResolutionLogRow & {
    ladder_levels_visited?: number;
    override_count?: number;
  };
  const decoratedRows = useMemo<DecoratedRow[]>(() => {
    return rows.map((r) => {
      const d = directoryById.get(String(r.id));
      return {
        ...r,
        ladder_levels_visited: d?.ladder_levels_visited,
        override_count: d?.override_count,
      };
    });
  }, [rows, directoryById]);

  const onScopeChange = (next: ScopeKey) => {
    setScope(next);
    updateSearch({ scope: next === 'all' ? undefined : next });
  };
  const onRangeChange = (next: RangeKey) => {
    setRange(next);
    updateSearch({ range: next === 'all' ? undefined : next });
  };

  const columns = useMemo<Array<DataTableColumn<DecoratedRow>>>(
    () => [
      { key: 'resolved_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'category', label: 'Category', mono: true, sortable: true, filterable: true },
      { key: 'winning_scope_type', label: 'Winner', sortable: true, filterable: true },
      // W30 — directory-projected counters from v_settings_resolution_directory
      // (jsonb_array_length(scope_path) + COUNT(scope_path elements WHERE
      // has_value=true AND scope_type<>global)).
      {
        key: 'ladder_levels_visited',
        label: 'Levels',
        mono: true,
        align: 'right',
        sortable: true,
        type: 'number',
      },
      {
        key: 'override_count',
        label: 'Overrides',
        mono: true,
        align: 'right',
        sortable: true,
        type: 'number',
      },
      { key: 'id', label: 'Resolution', mono: true, sortable: true, filterable: true },
    ],
    [],
  );

  const openLadder = (row: DecoratedRow) => {
    drawer.open({
      title: `${row.category} · ${row.id}`,
      size: 'lg',
      body: ladderDrawerBody(row),
    });
  };

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="resolutionLog"
          eyebrow="Insights"
          titleAccent="Settings"
          titlePlain="resolution log"
        />
        <StateView
          kind="denied"
          capability={CAP.OBSERVABILITY_READ}
          hint="You do not have permission to view the settings resolution log (observability.read)."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="resolutionLog"
        eyebrow="Insights"
        titleAccent="Settings"
        titlePlain="resolution log"
        pills={[
          <Chip
            key="src"
            label="Policy decision log"
            kind="neutral"
            size="xs"
            className="mono"
          />,
          <Chip
            key="scope"
            label={`scope · ${scope}`}
            kind="info"
            size="xs"
            className="mono"
          />,
          // W30 — Directory summary pill, sourced from
          // `public.v_settings_resolution_directory`. Surfaces winner-scope
          // distribution generically (one segment per ladder tier present in
          // the canonical scope_type lookup) so operators can spot
          // ladder-tilt at a glance, and `source`/`resource` winners are no
          // longer silently collapsed into `sender`. (P2 #8.)
          directoryStats.total > 0 ? (
            <Chip
              key="directory"
              label={`${directoryStats.totalOverrides} overrides · ${Object.entries(directoryStats.winnersByType)
                .map(([t, n]) => `${t.charAt(0)}${n}`)
                .join('/')}`}
              kind="info"
              size="xs"
              className="mono"
              data-testid="resolutions-directory-pill"
              title="Total overrides and winner counts across the settings scope ladder."
            />
          ) : null,
        ]}
        actions={[]}
      />

      {isError ? (
        <StateView kind="error" hint="Could not load resolution log." />
      ) : isLoading || !data ? (
        <StateView kind="loading" hint="Loading resolution log…" />
      ) : (
        <>
          <div className="view-bar">
            <RangeChips value={range} onChange={onRangeChange} />
            <ScopeChips value={scope} onChange={onScopeChange} />
            <div className="view-bar__spacer" />
          </div>
          <DataTable<DecoratedRow>
            columns={columns}
            rows={decoratedRows}
            viewKey="resolution_log"
            entityKind="settings_resolution"
            onRowClick={openLadder}
          />
        </>
      )}

      {drawer.node}
    </div>
  );
}
