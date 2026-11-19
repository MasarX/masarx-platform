import { humanizeToken } from '@/lib/display-text';

export type ShipmentTimelineRow = {
  time: string;
  status?: string;
  action: string;
  detail: string;
  [key: string]: unknown;
};

function getRecordValue(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function humanizeProfileToken(value: string): string {
  return humanizeToken(value)
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bKsa\b/g, 'KSA');
}

function normalizeTimelineDetail(detail: string | undefined): string {
  if (!detail) return '';
  let next = detail
    .replace(/\bpolicy[_\s-]+not[_\s-]+found\b/gi, 'Policy configuration needs review')
    .replace(/\binvalid\s+url\b/gi, 'Communication provider endpoint needs configuration')
    .replace(/\broute\.allow_partial_publish=true\b/gi, 'Partial route publish allowed')
    .replace(/\broute\.allow_partial_publish=false\b/gi, 'Partial route publish not allowed')
    .replace(/\bmapping_config\s+([A-Za-z0-9_.-]+)/gi, (_, token: string) => `mapping profile ${humanizeProfileToken(token)}`)
    .replace(/\bscan_event\s+verified\b/gi, 'scan verified')
    .replace(/\bdriver_safety_policy\b/gi, 'driver safety policy')
    .replace(/\bexecution pack hash\s+0x[0-9a-f]+…?/gi, 'execution pack ready');

  if (/^[a-z0-9_.-]+$/i.test(next)) {
    next = humanizeToken(next);
  }
  return next;
}

function normalizeTimelineRow(row: unknown): ShipmentTimelineRow | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;

  const record = row as Record<string, unknown>;
  const time = getRecordValue(record, ['time', 'event_time', 'timestamp', 'created_at']);
  const action = getRecordValue(record, ['action', 'event_type', 'event_source']);
  const detail = getRecordValue(record, ['detail', 'summary', 'description', 'notes']);
  const status = getRecordValue(record, ['status', 'canonical_status']);

  if (!time || !action) return null;

  return {
    ...record,
    time,
    action: humanizeToken(action),
    detail: normalizeTimelineDetail(detail),
    ...(typeof status === 'string' ? { status } : {}),
  };
}

export function normalizeShipmentTimelineRows(payload: unknown): ShipmentTimelineRow[] {
  const source =
    Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>).timeline_events
        : [];

  if (!Array.isArray(source)) return [];

  return source
    .map((row) => normalizeTimelineRow(row))
    .filter((row): row is ShipmentTimelineRow => row !== null);
}
