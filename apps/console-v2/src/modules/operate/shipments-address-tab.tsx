import { useMemo } from 'react';
import { Button } from '@/components/Button';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import { pushToast } from '@/components/toastStore';
import { CAP } from '@/lib/capabilities';
import { useCapability } from '@/lib/identity';
import {
  useResource,
  useResourceList,
  useResourceRowsByIds,
  useResolveManualReviewTask,
  useShipmentAmendCancel,
} from '@/lib/queries';
import { formatCoordinatePair } from '@/lib/geo-coordinates';
import type { Shipment } from './shipments';

interface ShipmentAddressGeocodeRow extends Record<string, unknown> {
  id: string;
  address_id?: string | null;
  provider_name?: string | null;
  confidence_score?: number | string | null;
  accuracy_type?: string | null;
  formatted_address?: string | null;
  is_primary?: boolean | string | null;
  geocoded_at?: string | null;
  created_at?: string | null;
}

interface ShipmentAddressGeocodingAttemptRow extends Record<string, unknown> {
  id: string;
  address_id?: string | null;
  provider_name?: string | null;
  attempt_type?: string | null;
  status?: string | null;
  confidence?: number | string | null;
  confidence_score?: number | string | null;
  decision_outcome?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface ShipmentAddressReviewTaskRow extends Record<string, unknown> {
  id: string;
  address_id?: string | null;
  shipment_id?: string | null;
  task_type?: string | null;
  reason?: string | null;
  status?: string | null;
  queue_assignment?: string | null;
  resolution_outcome?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  resolved_at?: string | null;
  reviewed_at?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value ?? '').trim();
    if (text && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    const text = String(value ?? '').trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return null;
}

function titleCaseKey(raw: unknown, fallback = 'Not recorded'): string {
  const value = String(raw ?? '').trim();
  if (!value) return fallback;
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function addressText(address: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = address[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function buildDestinationAddressPayload(
  address: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, string> {
  const next: Record<string, string> = {
    line1: addressText(address, ['normalized_line1', 'line1', 'street', 'street_line_1']),
    line2: addressText(address, ['normalized_line2', 'line2', 'addressLine2']),
    district: addressText(address, ['district']),
    city: addressText(address, ['city', 'arabicCityName']),
    province: addressText(address, ['province', 'region', 'city']),
    country: addressText(address, ['country', 'country_code', 'countryCode']),
    postal_code: addressText(address, ['postal_code', 'zipCode']),
    building_number: addressText(address, ['building_number']),
    additional_directions: addressText(address, ['additional_directions', 'notes']),
  };
  const edited = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (key === 'line1') next.line1 = edited;
  else next[key] = edited;

  return Object.fromEntries(Object.entries(next).filter(([, v]) => v !== ''));
}

function timestampValue(value: unknown): number {
  const text = firstText(value);
  if (!text) return 0;
  const time = new Date(text).getTime();
  return Number.isFinite(time) ? time : 0;
}

function latestAddressGeocode(
  rows: ShipmentAddressGeocodeRow[],
): ShipmentAddressGeocodeRow | null {
  const primaryRows = rows.filter((row) => firstBoolean(row.is_primary) === true);
  const candidates = primaryRows.length ? primaryRows : rows;
  return [...candidates].sort((a, b) => (
    timestampValue(b.geocoded_at ?? b.created_at) - timestampValue(a.geocoded_at ?? a.created_at)
  ))[0] ?? null;
}

function latestAddressGeocodingAttempt(
  rows: ShipmentAddressGeocodingAttemptRow[],
): ShipmentAddressGeocodingAttemptRow | null {
  return [...rows].sort((a, b) => (
    timestampValue(b.created_at ?? b.updated_at) - timestampValue(a.created_at ?? a.updated_at)
  ))[0] ?? null;
}

function latestAddressReviewTask(
  rows: ShipmentAddressReviewTaskRow[],
): ShipmentAddressReviewTaskRow | null {
  return [...rows].sort((a, b) => (
    timestampValue(b.updated_at ?? b.created_at) - timestampValue(a.updated_at ?? a.created_at)
  ))[0] ?? null;
}

function confidenceDisplay(value: unknown): string {
  const score = firstNumber(value);
  if (score == null) return 'Not recorded';
  const percent = score <= 1 ? score * 100 : score;
  return `${Math.round(percent)}%`;
}

function addressGeocodeReadbackRows({
  address,
  latestGeocodeRow,
  latestAttempt,
  latestReview,
}: {
  address: Record<string, unknown>;
  latestGeocodeRow: ShipmentAddressGeocodeRow | null;
  latestAttempt: ShipmentAddressGeocodingAttemptRow | null;
  latestReview: ShipmentAddressReviewTaskRow | null;
}): KvRow[] {
  const attemptMetadata = asRecord(latestAttempt?.metadata);
  return [
    {
      key: 'geocode_provider',
      label: 'Geocode provider',
      value: titleCaseKey(firstText(latestGeocodeRow?.provider_name, latestAttempt?.provider_name), 'Not recorded'),
      editable: false,
    },
    {
      key: 'geocode_confidence',
      label: 'Confidence',
      value: confidenceDisplay(firstText(
        latestGeocodeRow?.confidence_score,
        latestAttempt?.confidence_score,
        latestAttempt?.confidence,
      )),
      mono: true,
      editable: false,
    },
    {
      key: 'geocode_accuracy',
      label: 'Accuracy',
      value: titleCaseKey(latestGeocodeRow?.accuracy_type, 'Not recorded'),
      editable: false,
    },
    {
      key: 'geocode_attempt',
      label: 'Last attempt',
      value: titleCaseKey(
        firstText(latestAttempt?.status, latestAttempt?.decision_outcome, address.validation_status),
        'Not recorded',
      ),
      editable: false,
    },
    {
      key: 'geocode_attempt_type',
      label: 'Attempt type',
      value: titleCaseKey(firstText(latestAttempt?.attempt_type, attemptMetadata?.attempt_type), 'Not recorded'),
      editable: false,
    },
    {
      key: 'geocoded_at',
      label: 'Geocoded at',
      value: firstText(latestGeocodeRow?.geocoded_at, latestAttempt?.created_at) ?? 'Not recorded',
      mono: Boolean(firstText(latestGeocodeRow?.geocoded_at, latestAttempt?.created_at)),
      editable: false,
    },
    {
      key: 'review_status',
      label: 'Review status',
      value: latestReview ? titleCaseKey(latestReview.status, 'Not recorded') : 'No review task',
      editable: false,
    },
    {
      key: 'review_queue',
      label: 'Review queue',
      value: latestReview ? titleCaseKey(latestReview.queue_assignment, 'Not recorded') : 'Not queued',
      editable: false,
    },
    {
      key: 'review_reason',
      label: 'Review reason',
      value: latestReview ? titleCaseKey(latestReview.reason, 'Not recorded') : 'Not recorded',
      editable: false,
    },
    {
      key: 'review_outcome',
      label: 'Review outcome',
      value: latestReview && firstText(latestReview.resolution_outcome)
        ? titleCaseKey(latestReview.resolution_outcome, 'Not resolved')
        : latestReview ? 'Not Resolved' : 'Not recorded',
      editable: false,
    },
    {
      key: 'reviewed_at',
      label: 'Reviewed at',
      value: latestReview ? firstText(latestReview.resolved_at, latestReview.reviewed_at) ?? 'Not recorded' : 'Not recorded',
      mono: Boolean(latestReview && firstText(latestReview.resolved_at, latestReview.reviewed_at)),
      editable: false,
    },
  ];
}

export function AddressTab({ shipment }: { shipment: Shipment }) {
  const latestShipmentQuery = useResource<Shipment>('shipments', shipment.id);
  const latestShipment = latestShipmentQuery.data ?? shipment;
  const destinationAddressId = (latestShipment as { destination_address_id?: string }).destination_address_id;
  const amend = useShipmentAmendCancel();
  const resolveReview = useResolveManualReviewTask();
  const canWrite = useCapability(CAP.SHIPMENTS_WRITE);
  const canResolveReview = useCapability(CAP.MANUAL_REVIEW_RESOLVE);
  const addressesQuery = useResourceRowsByIds<Record<string, unknown>>(
    'addresses',
    destinationAddressId ? [destinationAddressId] : [],
    { enabled: Boolean(destinationAddressId) },
  );
  const addressLineageFilter = useMemo(
    () => (destinationAddressId ? { address_id: destinationAddressId } : undefined),
    [destinationAddressId],
  );
  const geocodesQuery = useResourceList<ShipmentAddressGeocodeRow>(
    'geocodes',
    {
      filter: addressLineageFilter,
      sort: { key: 'geocoded_at', dir: 'desc' },
      page_size: 10,
    },
    { enabled: Boolean(addressLineageFilter) },
  );
  const attemptsQuery = useResourceList<ShipmentAddressGeocodingAttemptRow>(
    'geocoding_attempts',
    {
      filter: addressLineageFilter,
      sort: { key: 'created_at', dir: 'desc' },
      page_size: 10,
    },
    { enabled: Boolean(addressLineageFilter) },
  );
  const reviewTasksQuery = useResourceList<ShipmentAddressReviewTaskRow>(
    'manual_review_tasks',
    {
      filter: addressLineageFilter,
      sort: { key: 'updated_at', dir: 'desc' },
      page_size: 10,
    },
    { enabled: Boolean(addressLineageFilter) },
  );
  const address = useMemo<Record<string, unknown> | null | undefined>(() => {
    if (!destinationAddressId) return null;
    if (addressesQuery.isLoading) return undefined;
    const rows = addressesQuery.data?.rows ?? [];
    return rows.find((a) => a.id === destinationAddressId) ?? null;
  }, [addressesQuery.isLoading, addressesQuery.data, destinationAddressId]);
  if (addressesQuery.isError) {
    return (
      <StateView
        kind="error"
        title="Address unavailable"
        hint={(addressesQuery.error as Error).message}
      />
    );
  }
  if (address === undefined) return <StateView kind="loading" />;
  if (!address) return <div className="state__hint">No address on this shipment.</div>;

  const lineageLoading = geocodesQuery.isLoading || attemptsQuery.isLoading || reviewTasksQuery.isLoading;
  const lineageError = geocodesQuery.error ?? attemptsQuery.error ?? reviewTasksQuery.error;
  const latestGeocodeRow = latestAddressGeocode(geocodesQuery.data?.rows ?? []);
  const latestAttempt = latestAddressGeocodingAttempt(attemptsQuery.data?.rows ?? []);
  const latestReview = latestAddressReviewTask(reviewTasksQuery.data?.rows ?? []);
  const pendingGeocodeReview =
    latestReview?.id &&
    String(latestReview.task_type ?? '').trim().toLowerCase() === 'geocoding' &&
    String(latestReview.status ?? '').trim().toLowerCase() !== 'resolved'
      ? latestReview
      : null;
  const rows: KvRow[] = [
    {
      key: 'line1',
      label: 'Street',
      value: addressText(address, ['normalized_line1', 'line1', 'street', 'street_line_1']),
      editable: true,
    },
    { key: 'district', label: 'District', value: address.district, editable: true },
    { key: 'city', label: 'City', value: address.city, editable: true },
    { key: 'country', label: 'Country', value: address.country, editable: true },
    { key: 'postal_code', label: 'Postal', value: address.postal_code, mono: true, editable: true },
    {
      key: 'sa_short_code',
      label: 'Saudi short address',
      value: addressText(address, ['sa_short_code', 'short_national_address', 'short_address']) || '\u2014',
      mono: true,
      editable: false,
    },
    {
      key: 'coordinates',
      label: 'Coordinates',
      value: formatCoordinatePair(address.coordinates) || '\u2014',
      mono: true,
      editable: false,
    },
    { key: 'validation_status', label: 'Validation', value: address.validation_status, editable: false },
  ];
  return (
    <div style={{ display: 'grid', gap: '14px' }}>
      <KvGrid
        rows={rows}
        onEdit={
          canWrite
            ? async (key, value) => {
                try {
                  await amend.mutateAsync({
                    shipmentId: latestShipment.id,
                    op: 'address',
                    payload: {
                      address: buildDestinationAddressPayload(address, key, value),
                      source: 'console.shipments_drawer.address_tab',
                    },
                  });
                  pushToast(`Address ${key} updated`, 'good');
                } catch {
                  pushToast('Address details could not be updated. Try again.', 'danger');
                }
              }
            : undefined
        }
      />
      {lineageError ? (
        <StateView
          kind="error"
          title="Geocode state unavailable"
          hint="Could not load shipment address geocoding readback."
        />
      ) : lineageLoading ? (
        <StateView kind="loading" title="Loading geocode state" />
      ) : (
        <section aria-label="Address geocoding readback">
          <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>Geocoding readback</h4>
          <KvGrid
            rows={addressGeocodeReadbackRows({
              address,
              latestGeocodeRow,
              latestAttempt,
              latestReview,
            })}
          />
          {pendingGeocodeReview && canResolveReview ? (
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
              <Button
                label="Approve review"
                iconName="check"
                size="sm"
                disabled={resolveReview.isPending}
                onClick={async () => {
                  try {
                    await resolveReview.mutateAsync({
                      taskId: pendingGeocodeReview.id,
                      resolution_outcome: 'approved',
                      resolution_notes: `Approved from shipment ${latestShipment.tracking_number ?? latestShipment.id} address review.`,
                    });
                    pushToast('Address review approved', 'good');
                  } catch {
                    pushToast('Address review could not be approved. Try again.', 'danger');
                  }
                }}
              />
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
