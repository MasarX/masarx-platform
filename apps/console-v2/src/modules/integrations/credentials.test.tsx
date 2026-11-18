// credentials.test.tsx — covers the derivation helpers added to remove
// the invented `status` and `last_rotated_at` fields. The helpers MUST
// stay pure so they can be swapped to a real history table without
// changing call sites.

import { describe, it, expect, vi } from 'vitest';
import { deriveCredStatus, deriveLastRotatedAt } from './_credentials/derive';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const providerAuthRows = {
    active: { value: 'active', label: 'Active', tone: 'good', metadata: { lifecycle: 'active' } },
    revoked: { value: 'revoked', label: 'Revoked', tone: 'danger', metadata: { lifecycle: 'revoked' } },
  };
  return {
    ...actual,
    lookupRow: (category: string, value: string) =>
      category === 'provider_auth_status'
        ? providerAuthRows[value as keyof typeof providerAuthRows] ?? null
        : null,
  };
});

const NOW = Date.UTC(2026, 3, 26, 0, 0, 0); // 2026-04-26

describe('credentials · deriveCredStatus', () => {
  it('returns active when expires_at is more than 30 days away', () => {
    expect(deriveCredStatus({ expires_at: '2026-12-01T00:00:00Z' }, NOW)).toBe('active');
  });

  it('returns expiring within the 30-day window', () => {
    expect(deriveCredStatus({ expires_at: '2026-05-10T00:00:00Z' }, NOW)).toBe('expiring');
  });

  it('returns expired when expires_at is in the past', () => {
    expect(deriveCredStatus({ expires_at: '2026-04-01T00:00:00Z' }, NOW)).toBe('expired');
  });

  it('returns revoked when explicit status is revoked', () => {
    expect(deriveCredStatus({ status: 'revoked', expires_at: '2027-01-01T00:00:00Z' }, NOW)).toBe(
      'revoked',
    );
  });

  it('returns active when explicit status is active and no expires_at', () => {
    expect(deriveCredStatus({ status: 'active' }, NOW)).toBe('active');
  });

  it('returns unknown when expires_at is malformed', () => {
    expect(deriveCredStatus({ expires_at: 'not-a-date' }, NOW)).toBe('unknown');
  });

  it('returns unknown when there is no expires_at and no explicit active', () => {
    expect(deriveCredStatus({}, NOW)).toBe('unknown');
  });
});

describe('credentials · deriveLastRotatedAt', () => {
  it('prefers last_rotated_at when provided', () => {
    expect(
      deriveLastRotatedAt({ last_rotated_at: '2026-03-15T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }),
    ).toBe('2026-03-15T00:00:00Z');
  });

  it('falls back to created_at', () => {
    expect(deriveLastRotatedAt({ created_at: '2026-01-01T00:00:00Z' })).toBe('2026-01-01T00:00:00Z');
  });

  it('returns undefined when neither is set', () => {
    expect(deriveLastRotatedAt({})).toBeUndefined();
  });
});
