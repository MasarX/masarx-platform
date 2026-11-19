// Unit coverage for review-queue helpers (saved views, search, snooze,
// row-driven action resolution + next-status mapping).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteView,
  formatTimeUntilCanonical,
  listSavedViews,
  matchesSearch,
  nextStatusForAction,
  resolveAllowedActions,
  saveView,
  snoozeUntil,
  type DurationFormatPolicy,
} from './views';

vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => null,
}));

// W63 (Workflows Cycle F-R-3 P1-1/P1-2) — canonical duration policy
// mirror used by the formatter tests. Mirrors
// `ui_presentation_policy.{duration_buckets,overdue_label}` (sv_360).
const DURATION_POLICY: DurationFormatPolicy = {
  duration_buckets: [
    { unit: 'd', threshold_ms: 86400000, label: 'd' },
    { unit: 'h', threshold_ms: 3600000, label: 'h' },
    { unit: 'm', threshold_ms: 60000, label: 'm' },
  ],
  overdue_label: 'overdue',
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('views: saved-view persistence', () => {
  it('starts empty', () => {
    expect(listSavedViews()).toEqual([]);
  });
  it('saves and retrieves a view', () => {
    const v = saveView('My queue', 'queue', '');
    const all = listSavedViews();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(v.id);
    expect(all[0]?.label).toBe('My queue');
    expect(all[0]?.filter).toBe('queue');
  });
  it('caps at 12 entries', () => {
    for (let i = 0; i < 15; i++) saveView(`v-${i}`, 'all', '');
    expect(listSavedViews()).toHaveLength(12);
  });
  it('deletes a view', () => {
    const v = saveView('X', 'mine', '');
    deleteView(v.id);
    expect(listSavedViews()).toEqual([]);
  });
  it('survives malformed storage', () => {
    window.localStorage.setItem('console-v2.review-queue.views', '{not json}');
    expect(listSavedViews()).toEqual([]);
  });
});

describe('views: search', () => {
  const t = {
    task_id: 'TSK-2901',
    subject: 'SHP-9381 · Recipient unavailable',
    queue: 'ndr',
    assigned_to: 'usr_amir',
  };
  it('matches empty query', () => {
    expect(matchesSearch(t, '')).toBe(true);
  });
  it('matches by task_id substring', () => {
    expect(matchesSearch(t, '2901')).toBe(true);
  });
  it('matches by subject case-insensitively', () => {
    expect(matchesSearch(t, 'recipient')).toBe(true);
  });
  it('matches by queue', () => {
    expect(matchesSearch(t, 'ndr')).toBe(true);
  });
  it('rejects on miss', () => {
    expect(matchesSearch(t, 'driver-foo')).toBe(false);
  });
});

describe('views: SLA formatting (formatTimeUntilCanonical — W63)', () => {
  it('returns minutes when within an hour', () => {
    expect(formatTimeUntilCanonical(30 * 60000, DURATION_POLICY)).toBe('30m');
  });
  it('returns hours when within a day', () => {
    expect(formatTimeUntilCanonical(5 * 3600000, DURATION_POLICY)).toBe('5h');
  });
  it('returns days for longer windows', () => {
    expect(formatTimeUntilCanonical(3 * 86400000, DURATION_POLICY)).toBe('3d');
  });
  it('reports overdue when negative', () => {
    expect(formatTimeUntilCanonical(-15 * 60000, DURATION_POLICY)).toBe('15m overdue');
  });
  it('renders 0<smallest-unit> when ms is below the smallest bucket', () => {
    expect(formatTimeUntilCanonical(0, DURATION_POLICY)).toBe('0m');
  });
  it('returns "—" placeholder when canonical policy is missing', () => {
    expect(formatTimeUntilCanonical(60000, null)).toBe('—');
    expect(formatTimeUntilCanonical(60000, undefined)).toBe('—');
  });
  it('returns "—" placeholder when bucket array is empty', () => {
    expect(
      formatTimeUntilCanonical(60000, { duration_buckets: [], overdue_label: 'overdue' }),
    ).toBe('—');
  });
  it('walks buckets largest→smallest regardless of seed-row order', () => {
    const reversedPolicy: DurationFormatPolicy = {
      duration_buckets: [
        { unit: 'm', threshold_ms: 60000, label: 'm' },
        { unit: 'h', threshold_ms: 3600000, label: 'h' },
        { unit: 'd', threshold_ms: 86400000, label: 'd' },
      ],
      overdue_label: 'overdue',
    };
    expect(formatTimeUntilCanonical(3 * 86400000, reversedPolicy)).toBe('3d');
    expect(formatTimeUntilCanonical(5 * 3600000, reversedPolicy)).toBe('5h');
  });
  it('honours a custom overdue label from policy', () => {
    const policyWithCustomLabel: DurationFormatPolicy = {
      ...DURATION_POLICY,
      overdue_label: 'late',
    };
    expect(formatTimeUntilCanonical(-15 * 60000, policyWithCustomLabel)).toBe('15m late');
  });
});

describe('views: snoozeUntil (Cycle E — canonical option only, string overload retired)', () => {
  const BASE = new Date('2026-04-25T12:00:00Z').getTime();
  it('accepts a resolved canonical option (only supported path)', () => {
    expect(
      snoozeUntil({ value: '1h', label: '1 hour', duration_seconds: 3600 }, BASE),
    ).toBe('2026-04-25T13:00:00.000Z');
    expect(
      snoozeUntil({ value: '4h', label: '4 hours', duration_seconds: 14400 }, BASE),
    ).toBe('2026-04-25T16:00:00.000Z');
    expect(
      snoozeUntil({ value: '1d', label: '1 day', duration_seconds: 86400 }, BASE),
    ).toBe('2026-04-26T12:00:00.000Z');
    expect(
      snoozeUntil({ value: '3d', label: '3 days', duration_seconds: 259200 }, BASE),
    ).toBe('2026-04-28T12:00:00.000Z');
  });

  it('returns null for malformed option (non-positive duration_seconds)', () => {
    expect(
      snoozeUntil({ value: '1h', label: '1 hour', duration_seconds: 0 }, BASE),
    ).toBeNull();
    expect(
      snoozeUntil({ value: '1h', label: '1 hour', duration_seconds: -10 }, BASE),
    ).toBeNull();
  });

  it('returns null for malformed option (missing duration_seconds)', () => {
    // Coerce `undefined` through Number() inside snoozeUntil → NaN → null.
    const malformed = { value: '1h', label: '1 hour' } as unknown as Parameters<typeof snoozeUntil>[0];
    expect(snoozeUntil(malformed, BASE)).toBeNull();
  });
});

describe('views: resolveAllowedActions (row-driven)', () => {
  it('reads task.allowed_actions verbatim and ignores task_type defaults', () => {
    const acts = resolveAllowedActions({
      task_type: 'dispatch_exception_review', // catalog default would be 4 actions
      allowed_actions: ['reschedule', 'cancel'],
    });
    expect(acts.map((a) => a.kind)).toEqual(['reschedule', 'cancel']);
    expect(acts).toHaveLength(2);
  });

  it('preserves the row-driven order', () => {
    const acts = resolveAllowedActions({
      task_type: 'dispatch_exception_review',
      allowed_actions: ['cancel', 'reschedule', 'retry'],
    });
    expect(acts.map((a) => a.kind)).toEqual(['cancel', 'reschedule', 'retry']);
  });

  it('falls back to task_type_catalog defaults when allowed_actions is null', () => {
    const acts = resolveAllowedActions({
      task_type: 'dispatch_exception_review',
      allowed_actions: null,
    });
    expect(acts.map((a) => a.kind)).toEqual([
      'reschedule',
      'reassign',
      'rtb',
      'resolve',
    ]);
  });

  it('falls back to catalog defaults when allowed_actions is empty []', () => {
    const acts = resolveAllowedActions({
      task_type: 'shipment_amend_review',
      allowed_actions: [],
    });
    expect(acts.map((a) => a.kind)).toEqual(['approve', 'reject']);
  });

  it('returns [] when neither row nor catalog has anything', () => {
    expect(resolveAllowedActions({ task_type: 'unknown_kind', allowed_actions: null })).toEqual([]);
    expect(resolveAllowedActions({ allowed_actions: null })).toEqual([]);
  });

  it('synthesises a label for unknown kinds (no hardcoded matrix)', () => {
    const acts = resolveAllowedActions({
      allowed_actions: ['custom_kind_xyz'],
    });
    expect(acts).toHaveLength(1);
    expect(acts[0]?.kind).toBe('custom_kind_xyz');
    // label is derived from the kind; not crashing is the contract.
    expect(typeof acts[0]?.label).toBe('string');
    expect(acts[0]?.label.length).toBeGreaterThan(0);
  });

  it('assigns 1-based shortcut digits 1..9 and skips beyond 9', () => {
    const kinds = Array.from({ length: 10 }, (_, i) => `k${i + 1}`);
    const acts = resolveAllowedActions({ allowed_actions: kinds });
    expect(acts[0]?.shortcut).toBe('1');
    expect(acts[8]?.shortcut).toBe('9');
    expect(acts[9]?.shortcut).toBeUndefined();
  });
});

describe('views: nextStatusForAction (kind -> next_status mapping)', () => {
  it('maps resolve / approve to completed', () => {
    expect(nextStatusForAction('resolve')).toBe('completed');
    expect(nextStatusForAction('approve')).toBe('completed');
  });
  it('maps escalate to escalated', () => {
    expect(nextStatusForAction('escalate')).toBe('escalated');
  });
  it('maps snooze to snoozed', () => {
    expect(nextStatusForAction('snooze')).toBe('snoozed');
  });
  it('maps reject / decline / cancel to rejected', () => {
    expect(nextStatusForAction('reject')).toBe('rejected');
    expect(nextStatusForAction('decline')).toBe('rejected');
    expect(nextStatusForAction('cancel')).toBe('rejected');
  });
  it('defaults unknown kinds to in_progress', () => {
    expect(nextStatusForAction('reschedule')).toBe('in_progress');
    expect(nextStatusForAction('reassign')).toBe('in_progress');
    expect(nextStatusForAction('totally_made_up')).toBe('in_progress');
  });
});
