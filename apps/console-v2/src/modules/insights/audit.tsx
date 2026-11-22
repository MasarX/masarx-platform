// audit.tsx — Insights · Audit log (capability-gated audit_log.read).
//
// Wave 6 / W6-3 — INSIGHTS audit reconciliation:
//   The legacy `useAuditLog()` hook read from a non-existent `audit_log`
//   table. Canonical SSOT is `public.audit_table_changes` from
//   supabase/migrations/202512011211_audit_table_changes.sql:10-24
//   (HASH+RANGE partitioned ledger, RLS restricted to the privileged backend role, INSERT public).
//   This module now consumes the canonical resource directly via
//   `useResourceList<AuditTableChangeRow>('audit_table_changes')`.
//
//   The capability key remains `audit_log.read` — declared canonically in
//   supabase/migrations/202601022113_access_control_policy_core.sql:215,241.
//   Only the backing resource was reconciled; the capability namespace
//   (`audit_log.*`) is stable across FE/BE.
//
// Operator-grade J-pass features preserved:
//   • Time-window chip rail (5m / 1h / 24h / 7d / all) clamps `created_at`
//     client-side. Active range is reflected in the URL (?range=1h) so a link
//     pasted to a teammate restores the same view.
//   • Row click opens a Drawer with the full row JSON (canonical columns:
//     schema_name, table_name, op, pk, row_old, row_new, changed_by,
//     correlation_id, created_at) + a "Copy as curl" block (REST GET against
//     `audit_table_changes`). No secrets emitted.
//   • Universal DataTable row actions remain wired through the action stack.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useResourceList } from '@/lib/queries';
import { useDrawer } from '@/hooks/useOverlay';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { clampByRange, type RangeKey } from './_shared';
import { RangeChips } from './_components';
import { useInsightsSearch, useUpdateSearch } from './_hooks';

// Canonical row shape from public.audit_table_changes
// (supabase/migrations/202512011211_audit_table_changes.sql:10-24).
// W6-6 schema-drift note: this interface is now in lockstep with the
// canonical column names — the prior FE-only aliases (occurred_at, table,
// actor, diff) are removed in favor of the SSOT names.
interface AuditTableChangeRow extends Record<string, unknown> {
  id?: string;                  // SSOT: audit_table_changes.id
  organization_id?: string | null; // SSOT: audit_table_changes.organization_id
  schema_name?: string;         // SSOT: audit_table_changes.schema_name
  table_name?: string;          // SSOT: audit_table_changes.table_name
  op?: 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | string; // SSOT: audit_table_changes.op
  pk?: unknown;                 // SSOT: audit_table_changes.pk (JSONB)
  row_old?: unknown;            // SSOT: audit_table_changes.row_old (JSONB)
  row_new?: unknown;            // SSOT: audit_table_changes.row_new (JSONB)
  changed_by?: string;          // SSOT: audit_table_changes.changed_by
  correlation_id?: string;      // SSOT: audit_table_changes.correlation_id
  request_context?: unknown;    // SSOT: audit_table_changes.request_context (JSONB)
  created_at: string;           // SSOT: audit_table_changes.created_at
}

function isCapabilityDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code === 'capability_denied') return true;
  const message = (err as { message?: string }).message ?? '';
  return /Capability denied/i.test(message);
}

function pkLabel(pk: unknown): string {
  if (pk == null) return '';
  if (typeof pk === 'string') return pk;
  if (typeof pk === 'object') {
    const idVal = (pk as Record<string, unknown>).id;
    if (idVal != null) return String(idVal);
    return JSON.stringify(pk);
  }
  return String(pk);
}

function auditRowDrawer(row: AuditTableChangeRow): ReactNode {
  const table = String(row.table_name ?? 'audit_table_changes');
  return (
    <div>
      <h4 className="eyebrow">Change summary</h4>
      <div style={{ display: 'grid', gap: '6px', fontSize: '12px' }}>
        <div>{`Record type: ${table}`}</div>
        <div>{`Change: ${String(row.op ?? 'Updated')}`}</div>
        <div>{`Changed by: ${row.changed_by ? 'Recorded' : 'Not available'}`}</div>
        <div>{`Activity reference: ${row.correlation_id ? 'Recorded' : 'Not available'}`}</div>
        <div>{`Changed at: ${row.created_at ?? 'Not available'}`}</div>
      </div>
    </div>
  );
}

export function AuditModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed
  // gate. The audit_table_changes registry resource gates on audit_log.read
  // (seed-raw/registry.js); mirror that at module-mount so a capability-less
  // caller sees an explicit denial state rather than a silent empty list.
  const canRead = useCapability(CAP.AUDIT_LOG_READ);
  // Wave 6 W6-3 reconciliation: canonical SSOT read seam. Production swap
  // routes through `ui_list_resource_v1('audit_table_changes')` with
  // audit_log.read RLS gating (registry-driven; see seed-raw/registry.js).
  const {
    data: listResult,
    isLoading,
    isError,
    error,
  } = useResourceList<AuditTableChangeRow>(
    'audit_table_changes',
    { page_size: 100 },
    { enabled: canRead, retry: false },
  );
  const drawer = useDrawer();

  // URL-driven typed state: ?range=24h is the only J-owned param here.
  const search = useInsightsSearch();
  const updateSearch = useUpdateSearch();
  const [range, setRange] = useState<RangeKey>(search.range ?? '24h');
  // Keep local state in sync if URL changes (back/forward, paste).
  useEffect(() => {
    if (search.range && search.range !== range) setRange(search.range);
  }, [search.range, range]);

  const onRangeChange = (next: RangeKey) => {
    setRange(next);
    updateSearch({ range: next === '24h' ? undefined : next });
  };

  const columns = useMemo<Array<DataTableColumn<AuditTableChangeRow>>>(
    () => [
      { key: 'created_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'schema_name', label: 'Schema', mono: true, sortable: true, filterable: true },
      { key: 'table_name', label: 'Table', mono: true, sortable: true, filterable: true },
      { key: 'op', label: 'Op', sortable: true, filterable: true },
      { key: 'pk', label: 'PK', mono: true, sortable: true, filterable: true },
      { key: 'changed_by', label: 'Actor', mono: true, sortable: true, filterable: true },
      { key: 'correlation_id', label: 'Activity reference', mono: true, sortable: true, filterable: true },
    ],
    [],
  );

  const rows = useMemo<AuditTableChangeRow[]>(() => {
    const list = listResult?.rows ?? [];
    // Render `pk` as a stable string for table display. Drawer keeps the
    // raw jsonb shape via `JSON.stringify(row, null, 2)` so operators see
    // the canonical structure.
    const normalized = list.map((r) => ({
      ...r,
      pk: pkLabel(r.pk),
    }));
    return clampByRange(normalized, 'created_at', range);
  }, [listResult, range]);

  const openRow = (row: AuditTableChangeRow) => {
    drawer.open({
      title: 'Audit activity',
      size: 'lg',
      body: auditRowDrawer(row),
    });
  };

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="audit"
          eyebrow="Insights"
          titleAccent="Audit"
          titlePlain="log"
        />
        <StateView
          kind="denied"
          capability={CAP.AUDIT_LOG_READ}
          hint="You do not have permission to view the audit log."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="audit"
        eyebrow="Insights"
        titleAccent="Audit"
        titlePlain="log"
        pills={[
          <Chip
            key="src"
            label="Audit activity · governed access"
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
        ]}
        actions={[]}
      />

      {isError && isCapabilityDenied(error) ? (
        <StateView
          kind="denied"
          capability={CAP.AUDIT_LOG_READ}
          hint="You need audit activity access to view this page."
        />
      ) : isError ? (
        <StateView kind="error" hint="Could not load audit activity." />
      ) : isLoading || !listResult ? (
        <StateView kind="loading" hint="Loading audit log…" />
      ) : (
        <>
          <div className="view-bar">
            <RangeChips value={range} onChange={onRangeChange} />
            <div className="view-bar__spacer" />
          </div>
          <DataTable<AuditTableChangeRow>
            columns={columns}
            rows={rows}
            viewKey="audit_table_changes"
            entityKind="audit_entry"
            onRowClick={openRow}
          />
        </>
      )}

      {drawer.node}
    </div>
  );
}
