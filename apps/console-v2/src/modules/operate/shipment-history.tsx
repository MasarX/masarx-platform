import { useMemo } from 'react';
import { DataTable } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { humanizeToken } from '@/lib/display-text';
import { useI18n } from '@/lib/i18n';
import { useResourceList } from '@/lib/queries';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { asRecord, compactReference, firstText } from './shipment-display';
import type { Shipment } from './shipments';

export function ScansTab({ shipment }: { shipment: Shipment }) {
  const { t } = useI18n();
  // CLAIM-OPERATIONS-WIRING (Phase C1) — read seam moved from `api.seed.*` to
  // canonical resource registry (`ui_list_resource_v1('scan_events')`).
  // Backed by public.scan_events (HASH partitioned;
  // supabase/migrations/202601251060_scan_events_v1.sql:49).
  const { data, isLoading, error } = useResourceList<Record<string, unknown>>('scan_events', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'occurred_at', dir: 'desc' },
  });
  if (isLoading) return <StateView kind="loading" />;
  if (error) return <StateView kind="error" hint={(error as Error).message} />;
  const scans = data?.rows ?? [];
  return (
    <DataTable
      columns={[
        { key: 'occurred_at', label: t('shipmentHistory.when'), format: 'datetime' },
        { key: 'scan_type', label: t('shipmentHistory.scanType'), render: (raw) => humanizeToken(raw) },
        { key: 'box_barcode', label: t('shipmentHistory.barcode'), mono: true },
        { key: 'user_id', label: t('shipmentHistory.user'), render: (raw) => compactReference(raw, t('shipmentHistory.user')) },
        { key: 'notes', label: t('shipmentHistory.notes') },
      ]}
      rows={scans}
      allowSelection={false}
      emptyText={t('shipmentHistory.noScans')}
    />
  );
}

export function DecisionsTab({ shipment }: { shipment: Shipment }) {
  const { t } = useI18n();
  const go = useConsoleNavigator();
  const destinationAddressId = String(
    (shipment as { destination_address_id?: string | null }).destination_address_id ?? '',
  ).trim();
  const log = useResourceList<Record<string, unknown>>('decision_log', {
    filter: { resource_type: 'shipment', resource_id: shipment.id },
    sort: { key: 'timestamp', dir: 'desc' },
  });
  const reviewTasks = useResourceList<Record<string, unknown>>('manual_review_tasks', {
    filter: destinationAddressId ? { address_id: destinationAddressId } : { address_id: '__none__' },
    sort: { key: 'updated_at', dir: 'desc' },
    page_size: 10,
  }, { enabled: Boolean(destinationAddressId) });
  const latestReviewTaskId = useMemo(() => {
    const rows = reviewTasks.data?.rows ?? [];
    return firstText(rows.find((row) => String(row.task_type ?? '').trim().toLowerCase() === 'geocoding')?.id);
  }, [reviewTasks.data?.rows]);
  const reviewDecisionLog = useResourceList<Record<string, unknown>>(
    'decision_log',
    {
      filter: latestReviewTaskId
        ? { resource_type: 'manual_review_task', resource_id: latestReviewTaskId }
        : { resource_type: 'manual_review_task', resource_id: '__none__' },
      sort: { key: 'timestamp', dir: 'desc' },
    },
    { enabled: Boolean(latestReviewTaskId) },
  );
  const rows = useMemo(() => {
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of [...(log.data?.rows ?? []), ...(reviewDecisionLog.data?.rows ?? [])]) {
      const key = String(row.id ?? `${row.resource_type ?? ''}:${row.resource_id ?? ''}:${row.timestamp ?? ''}`);
      byId.set(key, row);
    }
    return Array.from(byId.values()).sort((a, b) => {
      const at = Date.parse(String(a.timestamp ?? a.created_at ?? ''));
      const bt = Date.parse(String(b.timestamp ?? b.created_at ?? ''));
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
    });
  }, [log.data?.rows, reviewDecisionLog.data?.rows]);
  if (log.isLoading || reviewTasks.isLoading || reviewDecisionLog.isLoading) return <StateView kind="loading" />;
  if (log.error && reviewDecisionLog.error) return <StateView kind="error" hint={(log.error as Error).message} />;
  return (
    <div className="stack">
      {log.error || reviewDecisionLog.error ? (
        <p className="state__hint">
          {t('shipmentHistory.decisionStreamUnavailable')}
        </p>
      ) : null}
      <DataTable
        columns={[
          { key: 'timestamp', label: t('shipmentHistory.when'), format: 'datetime' },
          { key: 'decision_category', label: t('shipmentHistory.category'), lookup: 'decision_category' },
          { key: 'decision_point', label: t('shipmentHistory.decision'), render: (raw) => humanizeToken(raw) },
          { key: 'decision_outcome', label: t('shipmentHistory.outcome'), render: (raw) => humanizeToken(raw) },
          { key: 'resolved_from', label: t('shipmentHistory.scope') },
          { key: 'settings_resolution_id', label: t('shipmentHistory.resolution'), render: (raw) => compactReference(raw, t('shipmentHistory.resolution')) },
        ]}
        rows={rows}
        allowSelection={false}
        emptyText={t('shipmentHistory.noDecisions')}
        rowActions={[
          {
            label: t('shipmentHistory.viewActivity'),
            icon: 'trace_tree',
            onClick: (row) => {
              go(`/insights/traces?correlation_id=${encodeURIComponent(
                String(row.correlation_id ?? ''),
              )}`);
            },
          },
        ]}
      />
    </div>
  );
}

export function AuditTab({ shipment }: { shipment: Shipment }) {
  const { t } = useI18n();
  const log = useResourceList<Record<string, unknown>>('audit_table_changes', {
    filter: { table_name: 'shipments', pk: { id: shipment.id } },
    sort: { key: 'created_at', dir: 'desc' },
  });
  const actions = useResourceList<Record<string, unknown>>('shipment_actions', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'timestamp', dir: 'desc' },
    page_size: 50,
  });
  if (log.isLoading || actions.isLoading) return <StateView kind="loading" />;
  if (log.error && actions.error) {
    return (
      <div className="state state--denied">
        <h3 className="state__title">{t('shipmentHistory.auditDenied')}</h3>
        <p className="state__hint">{t('shipmentHistory.auditPermissionRequired')}</p>
      </div>
    );
  }
  const all = log.data?.rows ?? [];
  const tableRows: Record<string, unknown>[] = log.error
    ? []
    : all
        .filter((row) => auditPkMatchesShipment(row.pk, shipment.id))
        .map((row) => ({
          ...row,
          audit_source: t('shipmentHistory.systemAudit'),
        }));
  const actionRows: Record<string, unknown>[] = actions.error
    ? []
    : (actions.data?.rows ?? []).map((row) => {
        const actionData = asRecord(row.action_data) ?? {};
        return {
          id: row.id ?? `shipment_action_${row.timestamp ?? row.created_at ?? ''}`,
          created_at: row.timestamp ?? row.created_at,
          op: row.action_type ?? 'shipment_action',
          changed_by: row.performed_by_user_id ?? row.performed_by_system ?? row.created_by ?? row.actor_user_id,
          correlation_id: row.correlation_id ?? actionData.correlation_id,
          audit_source: t('shipmentHistory.shipmentAction'),
        };
      });
  const rows: Record<string, unknown>[] = [...tableRows, ...actionRows].sort((a, b) => {
    const at = Date.parse(String(a['created_at'] ?? ''));
    const bt = Date.parse(String(b['created_at'] ?? ''));
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
  return (
    <div className="stack">
      {log.error || actions.error ? (
        <p className="state__hint">
          {t('shipmentHistory.auditStreamUnavailable')}
        </p>
      ) : null}
      <DataTable
        columns={[
          { key: 'created_at', label: t('shipmentHistory.when'), format: 'datetime' },
          { key: 'audit_source', label: t('shipmentHistory.source') },
          { key: 'op', label: t('shipmentHistory.operation'), render: (raw) => humanizeToken(raw) },
          { key: 'changed_by', label: t('shipmentHistory.actor'), render: (raw) => compactReference(raw, t('shipmentHistory.actor')) },
          { key: 'correlation_id', label: t('shipmentHistory.activity'), render: (raw) => (raw ? t('shipmentHistory.linked') : '-') },
        ]}
        rows={rows}
        allowSelection={false}
        emptyText={t('shipmentHistory.noAuditChanges')}
      />
    </div>
  );
}

function auditPkMatchesShipment(pk: unknown, shipmentId: string): boolean {
  if (pk === shipmentId) return true;
  if (typeof pk === 'string') {
    try {
      return auditPkMatchesShipment(JSON.parse(pk), shipmentId);
    } catch {
      return false;
    }
  }
  if (pk && typeof pk === 'object') {
    const rec = pk as Record<string, unknown>;
    return rec.id === shipmentId || rec.shipment_id === shipmentId;
  }
  return false;
}
