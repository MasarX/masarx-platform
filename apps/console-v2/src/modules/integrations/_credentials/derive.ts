import { lookupRow } from '@/lib/api';

// W26 Cycle B closure: `expiringDaysThreshold` is now a parameter (default 30)
// resolved at call site through the canonical `provider_credential_policy`
// settings category. Tests rely on the default for determinism; the live
// component reads the resolved value via `useResolveSettings`.
export const DEFAULT_EXPIRING_DAYS_THRESHOLD = 30;

// Cycle E2 P2 closure: the imminent-expiry escalation window resolves through
// the canonical `provider_credential_policy` settings category.
export const DEFAULT_DANGER_DAYS_THRESHOLD = 7;

export function deriveCredStatus(
  row: { status?: string; expires_at?: string; created_at?: string },
  nowMs: number = Date.now(),
  expiringDaysThreshold: number = DEFAULT_EXPIRING_DAYS_THRESHOLD,
): 'active' | 'expiring' | 'expired' | 'revoked' | 'unknown' {
  const lifecycle = lookupRow('provider_auth_status', row.status ?? '')?.metadata?.lifecycle;
  if (lifecycle === 'revoked') return 'revoked';
  if (!row.expires_at) return lifecycle === 'active' ? 'active' : 'unknown';
  const exp = Date.parse(row.expires_at);
  if (Number.isNaN(exp)) return 'unknown';
  if (exp <= nowMs) return 'expired';
  const daysLeft = Math.floor((exp - nowMs) / (1000 * 60 * 60 * 24));
  if (daysLeft <= expiringDaysThreshold) return 'expiring';
  return 'active';
}

export function deriveLastRotatedAt(row: { last_rotated_at?: string; created_at?: string }): string | undefined {
  return row.last_rotated_at ?? row.created_at;
}
