import { Chip, type ChipKind } from '@/components/Chip';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import type { UseDrawerHandle } from '@/hooks/useOverlay';
import { fill, useI18n, type Translate } from '@/lib/i18n';

export interface ApiGatewayLifecycleRow {
  request_id: string;
  correlation_id?: string | null;
  status_code?: number | null;
  error_code?: string | null;
  outbound_error_message?: string | null;
  intake_state?: string | null;
  outbound_status?: string | null;
  workflow_run_id?: string | null;
  outbound_call_id?: string | null;
  shipment_id?: string | null;
  tracking_number?: string | null;
  settings_resolution_id?: string | null;
  occurred_at: string;
}

function outboundTone(status?: string | null, code?: number | null): ChipKind {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized.includes('fail') || normalized.includes('error')) return 'danger';
  if (typeof code === 'number' && code >= 400) return 'danger';
  if (normalized.includes('pending') || normalized.includes('queued')) return 'info';
  if (normalized.includes('success') || normalized.includes('complete')) return 'good';
  return 'neutral';
}

export function openApiGatewayOutboundLifecycleDrawer(
  drawer: UseDrawerHandle,
  row: ApiGatewayLifecycleRow,
  t: Translate,
): void {
  drawer.open({
    title: fill(t('insightsApiGatewayLifecycle.openApiGatewayOutboundLifecycleDrawer.providerDeliveryValue'), { value: String(row.outbound_call_id ?? row.request_id) }),
    size: 'lg',
    body: <ApiGatewayOutboundLifecycleBody row={row} />,
  });
}

export function ApiGatewayOutboundLifecycleBody({ row }: { row: ApiGatewayLifecycleRow }) {
  const { t } = useI18n();
  const rows: KvRow[] = [
    { key: 'request_id', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.gatewayRequest'), value: row.request_id, mono: true },
    { key: 'correlation_id', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.correlation'), value: row.correlation_id ?? '-', mono: true },
    { key: 'outbound_call_id', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.providerReference'), value: row.outbound_call_id ?? '-', mono: true },
    { key: 'outbound_status', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.providerDeliveryStatus'), value: row.outbound_status ?? '-', mono: true },
    { key: 'status_code', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.providerStatus'), value: row.status_code ?? '-', mono: true },
    { key: 'error_code', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.providerError'), value: row.error_code ?? '-' },
    { key: 'outbound_error_message', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.providerErrorDetail'), value: row.outbound_error_message ?? '-' },
    { key: 'workflow_run_id', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.workflowRun'), value: row.workflow_run_id ?? '-', mono: true },
    { key: 'shipment', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.shipment'), value: row.tracking_number ?? row.shipment_id ?? '-', mono: !row.tracking_number },
    { key: 'settings_resolution_id', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.policyCheck'), value: row.settings_resolution_id ? t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.recorded') : '-', mono: false },
    { key: 'occurred_at', label: t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.received'), value: row.occurred_at, mono: true },
  ];

  return (
    <div data-testid="api-gateway-outbound-lifecycle-drawer">
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 14px 14px',
          borderBottom: '1px solid var(--line)',
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div className="eyebrow">{t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.providerDeliveryStatus')}</div>
          <div className="serif" style={{ fontSize: 18 }}>
            {row.outbound_call_id ?? t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.noProviderDeliveryUpdate')}
          </div>
        </div>
        <Chip
          label={row.outbound_status ?? row.intake_state ?? t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.pending')}
          kind={outboundTone(row.outbound_status, row.status_code)}
          size="xs"
          className="mono"
        />
      </div>
      <KvGrid rows={rows} />
      {!row.outbound_call_id ? (
        <div className="state__hint" style={{ marginTop: 12 }}>
          {t('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.noProviderDeliveryUpdate2')}
        </div>
      ) : null}
    </div>
  );
}
