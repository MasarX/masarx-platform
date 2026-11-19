// ui-events.tsx — Insights · UI events (ui_event_log).
//
// Backed by useUiEventLog() (TanStack Query). Columns mirror the canonical
// public.ui_event_log shape (event_type, app, event_context, event_name,
// user_id, meta) so the persisted view stash remains compatible.
//
// J pass additions:
//   • Time-window chip rail (5m / 1h / 24h / 7d / all) clamps `created_at`
//     client-side. URL reflects state.
//   • Row click opens a Drawer with operator-safe activity details.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useUiEventLog, useResourceList } from '@/lib/queries';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useDrawer } from '@/hooks/useOverlay';
import { clampByRange, type RangeKey } from './_shared';
import { RangeChips } from './_components';
import { useInsightsSearch, useUpdateSearch } from './_hooks';

// W30 — `UiEventLogDirectoryRow` mirrors the SQL view
// `public.v_ui_event_log_directory`
// (supabase/migrations/202604302830_v_ui_event_log_directory.sql). Read-only
// projection over ui_event_log. Consumed additively as a header summary
// chip + drawer linkage source; the canonical SSOT seam stays
// `useUiEventLog({limit:100})`.
interface UiEventLogDirectoryRow extends Record<string, unknown> {
  id: string;
  path_label: string | null;
  command_label: string | null;
  age_seconds: number | null;
  is_action: boolean;
  has_resolution: boolean;
  has_scope: boolean;
}

// SCHEMA-DRIFT NOTE (W17-4 closure — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §9):
// FE shape now in lockstep with canonical `public.ui_event_log`
// (supabase/migrations/202601162000_ui_event_log.sql:7-22). Prior FE-only
// aliases retired:
//   • occurred_at → created_at (W17-4; was deferred per W11-5 cascade defer)
//   • path        → DROPPED (resolved via event_context / meta->>'path')
//   • command     → DROPPED (resolved via event_name / meta->>'command')
// Canonical-only fields surfaced via projection (event_message, digest,
// settings_resolution_id, scope_type, scope_id) are deferred for G1 expansion
// of the registry projection; the surface is closed for `UiEventRow`
// extended-field drift.
interface UiEventRow extends Record<string, unknown> {
  id?: string;                  // SSOT: ui_event_log.id
  created_at: string;           // SSOT: ui_event_log.created_at
  event_type?: string;          // SSOT: ui_event_log.event_type
  app?: string;                 // SSOT: ui_event_log.app
  event_context?: string;       // SSOT: ui_event_log.event_context
  event_name?: string;          // SSOT: ui_event_log.event_name
  user_id?: string;             // SSOT: ui_event_log.user_id
  meta?: Record<string, unknown>;  // SSOT: ui_event_log.meta (jsonb)
}

/** Resolve path through canonical projection paths. W13-2: `path` was a
 *  fictional top-level column; canonical SSOT is `event_context` or
 *  `meta->>'path'`. */
function pathOf(row: UiEventRow | null | undefined): string | undefined {
  if (!row) return undefined;
  if (typeof row.event_context === 'string' && row.event_context) return row.event_context;
  const fromMeta = row.meta && typeof row.meta === 'object'
    ? (row.meta as { path?: unknown }).path
    : undefined;
  return typeof fromMeta === 'string' ? fromMeta : undefined;
}

/** Resolve command through canonical projection paths. W13-2: same pattern
 *  as `pathOf` — `command` resolves to `event_name` or `meta->>'command'`. */
function commandOf(row: UiEventRow | null | undefined): string | undefined {
  if (!row) return undefined;
  if (typeof row.event_name === 'string' && row.event_name) return row.event_name;
  const fromMeta = row.meta && typeof row.meta === 'object'
    ? (row.meta as { command?: unknown }).command
    : undefined;
  return typeof fromMeta === 'string' ? fromMeta : undefined;
}

function uiEventDrawer(row: UiEventRow): ReactNode {
  const activityReference = String(row.id ?? '').trim() || 'Not available';
  return (
    <div>
      <h4 className="eyebrow">Activity details</h4>
      <p className="state__hint">
        Activity reference: {activityReference}
      </p>
      <p className="state__hint">
        Activity: {commandOf(row) ?? row.event_type ?? 'Not available'}
      </p>
      <p className="state__hint">
        Area: {pathOf(row) ?? row.app ?? 'Not available'}
      </p>
      <p className="state__hint">
        Recorded: {row.created_at}
      </p>
    </div>
  );
}

export function UiEventsModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed gate.
  const canRead = useCapability(CAP.OBSERVABILITY_READ);
  const { data, isLoading, isError } = useUiEventLog({ limit: 100 });
  const drawer = useDrawer();
  const search = useInsightsSearch();
  const updateSearch = useUpdateSearch();

  // W30 — paired projection view `public.v_ui_event_log_directory`
  // (supabase/migrations/202604302830_v_ui_event_log_directory.sql) projects
  // path_label / command_label / age_seconds / is_action / has_resolution /
  // has_scope per ui event row. Consumed additively as a header summary
  // chip + decoration source — the canonical SSOT seam stays
  // `useUiEventLog`.
  const directoryQuery = useResourceList<UiEventLogDirectoryRow>(
    'ui_event_log_directory',
  );
  const directory = useMemo(
    () => directoryQuery.data?.rows ?? [],
    [directoryQuery.data],
  );

  const directoryStats = useMemo(() => {
    let actions = 0;
    let withResolution = 0;
    let withScope = 0;
    for (const row of directory) {
      if (row.is_action) actions += 1;
      if (row.has_resolution) withResolution += 1;
      if (row.has_scope) withScope += 1;
    }
    return { total: directory.length, actions, withResolution, withScope };
  }, [directory]);

  const [range, setRange] = useState<RangeKey>(search.range ?? '24h');
  useEffect(() => {
    if (search.range && search.range !== range) setRange(search.range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.range]);

  const onRangeChange = (next: RangeKey) => {
    setRange(next);
    updateSearch({ range: next === '24h' ? undefined : next });
  };

  const columns = useMemo<Array<DataTableColumn<UiEventRow>>>(
    () => [
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'event_type', label: 'Event', sortable: true, filterable: true },
      { key: 'app', label: 'App', sortable: true, filterable: true },
      // W13-2: Path/Command columns resolve via canonical event_context /
      // event_name (or meta jsonb projection). Sort/filter still work because
      // DataTable falls back to the rendered string when no key value exists.
      // W17-4: column keys now point at canonical projection sources rather
      // than the dropped FE-only `path` / `command` aliases.
      {
        key: 'event_context',
        label: 'Path',
        sortable: true,
        filterable: true,
        render: (_raw, row) => pathOf(row) ?? '—',
      },
      {
        key: 'event_name',
        label: 'Command',
        sortable: true,
        filterable: true,
        render: (_raw, row) => commandOf(row) ?? '—',
      },
      { key: 'user_id', label: 'User', mono: true, sortable: true, filterable: true },
    ],
    [],
  );

  const rows = useMemo<UiEventRow[]>(() => {
    const list = (data as UiEventRow[]) ?? [];
    return clampByRange(list, 'created_at', range);
  }, [data, range]);

  const openRow = (row: UiEventRow) => {
    drawer.open({
      title: `UI event · ${row.id ?? '—'}`,
      size: 'lg',
      body: uiEventDrawer(row),
    });
  };

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="uiEvents"
          eyebrow="Insights"
          titleAccent="UI"
          titlePlain="events"
        />
        <StateView
          kind="denied"
          capability={CAP.OBSERVABILITY_READ}
          hint="You do not have permission to view UI events (observability.read)."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="uiEvents"
        eyebrow="Insights"
        titleAccent="UI"
        titlePlain="events"
        pills={[
          <Chip
            key="src"
            label="UI event stream"
            kind="neutral"
            size="xs"
            className="mono"
          />,
          <Chip
            key="range"
            label={`window · ${range}`}
            kind="info"
            size="xs"
            className="mono"
          />,
          // W30 — Directory summary pill, sourced from
          // `public.v_ui_event_log_directory`. Surfaces action / resolution /
          // scope coverage so operators can spot UI-instrumentation gaps.
          directoryStats.total > 0 ? (
            <Chip
              key="directory"
              label={`${directoryStats.actions} actions · ${directoryStats.withResolution} resolved`}
              kind="info"
              size="xs"
              className="mono"
              data-testid="ui-events-directory-pill"
              title={`${directoryStats.actions} action events, ${directoryStats.withResolution} with setting resolution, ${directoryStats.withScope} with explicit scope.`}
            />
          ) : null,
        ]}
        actions={[]}
      />

      {isError ? (
        <StateView kind="error" hint="Could not load UI events." />
      ) : isLoading || !data ? (
        <StateView kind="loading" hint="Loading UI events…" />
      ) : (
        <>
          <div className="view-bar">
            <RangeChips value={range} onChange={onRangeChange} />
            <div className="view-bar__spacer" />
          </div>
          <DataTable<UiEventRow>
            columns={columns}
            rows={rows}
            viewKey="ui_event_log"
            entityKind="ui_event"
            onRowClick={openRow}
          />
        </>
      )}

      {drawer.node}
    </div>
  );
}
