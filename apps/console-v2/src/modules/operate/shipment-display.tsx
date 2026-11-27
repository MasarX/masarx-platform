import type { ReactNode } from 'react';
import { englishT, useI18n, type Translate } from '@/lib/i18n';

export function compactReferenceToken(raw: unknown, label?: string, t: Translate = englishT): string {
  const value = String(raw ?? '').trim();
  if (!value) return '—';
  const parts = value
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const meaningful = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const suffix = String(meaningful ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(-6);
  return `${label ?? t('shipments.common.reference', 'Reference')} #${suffix || 'UNKNOWN'}`;
}

export function compactReference(raw: unknown, label = 'Reference'): ReactNode {
  const compact = compactReferenceToken(raw, label);
  if (compact === '—') return compact;
  return <ShipmentReference label={label} compact={compact} />;
}

function ShipmentReference({ label, compact }: { label: string; compact: string }) {
  const { t } = useI18n();
  return (
    <span className="mono" title={t('shipmentHistory.referenceTitle').replace('{label}', () => label)}>
      {compact}
    </span>
  );
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return null;
}
