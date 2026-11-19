import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { StateView } from '@/components/StateView';
import { CAP } from '@/lib/capabilities';

export interface CustomerRelatedShipmentRow extends Record<string, unknown> {
  id: string;
  tracking_number?: string | null;
  client_reference_number?: string | null;
  status?: string | null;
  service_type?: string | null;
  recipient_label?: string | null;
  destination_city?: string | null;
  promised_delivery_date?: string | null;
}

interface RelatedShipmentsPanelProps {
  canReadShipments: boolean;
  error?: unknown;
  isLoading?: boolean;
  rows: CustomerRelatedShipmentRow[];
  scopeLabel: string;
  onOpenShipment: (shipment: CustomerRelatedShipmentRow) => void;
}

function readableShipmentError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Shipment details unavailable');
}

function statusTone(status?: string | null): 'good' | 'warn' | 'danger' | 'info' | 'neutral' {
  if (!status) return 'neutral';
  const normalized = status.toLowerCase();
  if (['delivered', 'completed', 'closed'].includes(normalized)) return 'good';
  if (['cancelled', 'failed_attempt', 'exception', 'returned'].includes(normalized)) return 'danger';
  if (['pending', 'created', 'planned'].includes(normalized)) return 'warn';
  return 'info';
}

export function RelatedShipmentsPanel({
  canReadShipments,
  error,
  isLoading = false,
  rows,
  scopeLabel,
  onOpenShipment,
}: RelatedShipmentsPanelProps) {
  if (!canReadShipments) {
    return (
      <StateView
        kind="denied"
        capability={CAP.SHIPMENTS_READ}
        title="Shipment context hidden"
        hint="You do not have permission to view related shipments."
      />
    );
  }

  if (isLoading) {
    return <StateView kind="loading" title="Loading related shipments" hint="Loading the latest shipment context." />;
  }

  if (error) {
    return (
      <StateView
        kind="error"
        title="Related shipments unavailable"
        hint={readableShipmentError(error)}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <StateView
        kind="empty"
        title="No related shipments yet"
        hint={`No shipments are currently linked to this ${scopeLabel}.`}
      />
    );
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {rows.map((shipment) => {
        const tracking = shipment.tracking_number ?? shipment.id;
        const status = shipment.status ?? 'unknown';
        return (
          <div
            key={shipment.id}
            className="card"
            style={{ display: 'grid', gap: 6, padding: 10 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <strong>{tracking}</strong>
              <Chip label={status} kind={statusTone(status)} size="xs" />
            </div>
            <div className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>
              {[
                shipment.client_reference_number,
                shipment.service_type,
                shipment.recipient_label,
                shipment.destination_city,
                shipment.promised_delivery_date,
              ].filter(Boolean).join(' - ') || 'Shipment context'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                label="Open shipment"
                iconName="package"
                kind="ghost"
                capability={CAP.SHIPMENTS_READ}
                onClick={() => onOpenShipment(shipment)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
