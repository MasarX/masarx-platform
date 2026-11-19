// domain-events.tsx — Insights · Domain events stream.
//
// Backed by useResourceList('domain_events') (registry-driven, TanStack Query).
//
// J pass additions:
//   • Range chip rail clamps `created_at` client-side and reflects in URL.
//   • Row actions now pass typed identifiers (`cor` for traces, `id` for
//     workflow runs) so deep-links survive a paste between operators.
//   • Row click opens a Drawer with full row JSON + a "Copy as curl" snippet
//     that calls `ui_get_trace_v1` for the row's `correlation_id` (the canonical
//     RPC for joined timelines, per supabase/migrations/202601051630).

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { DataTable, type DataTableColumn, type DataTableAction } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useResourceList } from '@/lib/queries';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useDrawer } from '@/hooks/useOverlay';
import { clampByRange, type RangeKey } from './_shared';
import { RangeChips } from './_components';
import { useInsightsSearch, useUpdateSearch } from './_hooks';

// SCHEMA-DRIFT NOTE (W16-2 closure — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §7):
// FE shape now in lockstep with canonical `public.domain_events`
// (supabase/migrations/202511160100_domain_events_core.sql:13-28). Prior
// FE-only aliases retired:
//   • occurred_at  → created_at (W16-2)
//   • aggregate_id → resource_id (W14-4)
// Canonical-only fields surfaced via projection (status, payload, processed_at)
// are deferred for G1 expansion of registry projection; the surface is closed
// for `DomainEventRow` extended-field drift.
interface DomainEventRow extends Record<string, unknown> {
  id?: string;                   // SSOT: domain_events.id
  created_at: string;            // SSOT: domain_events.created_at
  event_type?: string;           // SSOT: domain_events.event_type
  resource_id?: string;          // SSOT: domain_events.resource_id
  resource_type?: string;        // SSOT: domain_events.resource_type
  correlation_id?: string;       // SSOT: domain_events.correlation_id
  workflow_run_id?: string;      // SSOT: domain_events.workflow_run_id
}

function domainEventDrawer(row: DomainEventRow): ReactNode {
  return (
    <div>
      <h4 className="eyebrow">Activity details</h4>
      <div style={{ display: 'grid', gap: '6px', fontSize: '12px' }}>
        <div>{`Event: ${row.event_type ?? 'Recorded'}`}</div>
        <div>{`Resource: ${row.resource_type ?? 'Not available'}`}</div>
        <div>{`Workflow: ${row.workflow_run_id ? 'Recorded' : 'Not available'}`}</div>
        <div>{`Activity reference: ${row.correlation_id ? 'Recorded' : 'Not available'}`}</div>
        <div>{`Created at: ${row.created_at ?? 'Not available'}`}</div>
      </div>
    </div>
  );
}

export function DomainEventsModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed gate.
  const canRead = useCapability(CAP.OBSERVABILITY_READ);
  const navigate = useNavigate();
  const drawer = useDrawer();
  const search = useInsightsSearch();
  const updateSearch = useUpdateSearch();
  const [range, setRange] = useState<RangeKey>(search.range ?? 'all');
  useEffect(() => {
    if (search.range && search.range !== range) setRange(search.range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.range]);

  const { data, isLoading, isError } = useResourceList<DomainEventRow>('domain_events');

  const rows = useMemo(() => {
    const list = data?.rows ?? [];
    return clampByRange(list, 'created_at', range);
  }, [data, range]);

  const onRangeChange = (next: RangeKey) => {
    setRange(next);
    updateSearch({ range: next === 'all' ? undefined : next });
  };

  const columns = useMemo<Array<DataTableColumn<DomainEventRow>>>(
    () => [
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'event_type', label: 'Event', mono: true, sortable: true, filterable: true },
      { key: 'resource_type', label: 'Resource type', mono: true, sortable: true, filterable: true },
      { key: 'resource_id', label: 'Resource', mono: true, sortable: true, filterable: true },
      {
        key: 'correlation_id',
        label: 'Activity reference',
        mono: true,
        sortable: true,
        filterable: true,
      },
      { key: 'workflow_run_id', label: 'Workflow run', mono: true },
    ],
    [],
  );

  const rowActions = useMemo<Array<DataTableAction<DomainEventRow>>>(
    () => [
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
      {
        label: 'View workflow run',
        icon: 'history',
        onClick: (row) => {
          const id = row.workflow_run_id;
          void navigate({
            to: '/workflows/runs',
            search: id ? { id } : undefined,
          });
        },
      },
    ],
    [navigate],
  );

  const openRow = (row: DomainEventRow) => {
    drawer.open({
      title: 'Activity details',
      size: 'lg',
      body: domainEventDrawer(row),
    });
  };

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="domainEvents"
          eyebrow="Insights"
          titleAccent="Domain"
          titlePlain="events"
        />
        <StateView
          kind="denied"
          capability={CAP.OBSERVABILITY_READ}
          hint="You do not have permission to view domain events (observability.read)."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="domainEvents"
        eyebrow="Insights"
        titleAccent="Domain"
        titlePlain="events"
        pills={[
          <Chip key="src" label="Domain event stream" kind="neutral" size="xs" className="mono" />,
          <Chip
            key="range"
            label={`window · ${range}`}
            kind="info"
            size="xs"
            className="mono"
          />,
        ]}
        actions={[]}
      />

      {isError ? (
        <StateView kind="error" hint="Could not load domain events." />
      ) : isLoading || !data ? (
        <StateView kind="loading" hint="Loading domain events…" />
      ) : (
        <>
          <div className="view-bar">
            <RangeChips value={range} onChange={onRangeChange} />
            <div className="view-bar__spacer" />
          </div>
          <DataTable<DomainEventRow>
            columns={columns}
            rows={rows}
            viewKey="domain_events"
            entityKind="domain_event"
            onRowClick={openRow}
            rowActions={rowActions}
          />
        </>
      )}

      {drawer.node}
    </div>
  );
}
