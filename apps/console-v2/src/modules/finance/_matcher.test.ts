// _matcher.test.ts — Unit tests for the pure finance helpers.
// Covers reconciliation match logic (per audit prompt §3.7), aging buckets,
// variance state, and double-entry ledger balance.

import { describe, it, expect } from 'vitest';
import {
  matchBankStatementLines,
  agingBucket,
  varianceState,
  ledgerBalance,
  type FinanceEventLine,
  type MatchInput,
} from './_matcher';

const baseCandidate: FinanceEventLine = {
  id: 'fe_base',
  event_type: 'bank_statement',
  account_type: 'bank_account',
  account_id: 'ba_ncb',
  bank_account_key: 'ncb-ruh-001',
  direction: 'in',
  amount: 1000,
  currency: 'SAR',
  occurred_at: '2026-04-25T10:00:00Z',
};

function input(overrides: Partial<MatchInput>): MatchInput {
  return {
    anchor_at: '2026-04-25T10:00:00Z',
    expected_amount: 1000,
    expected_currency: 'SAR',
    direction: 'in',
    bank_account_id: 'ba_ncb',
    candidates: [baseCandidate],
    policy: {
      window_days_before: 2,
      window_days_after: 2,
      amount_tolerance: 0,
      require_unique: true,
    },
    ...overrides,
  };
}

describe('matchBankStatementLines (pure replica of execute_bank_statement_match_v1)', () => {
  it('returns "matched" with reason="unique" for an exact single match', () => {
    const out = matchBankStatementLines(input({}));
    expect(out.status).toBe('matched');
    if (out.status === 'matched') {
      expect(out.reason).toBe('unique');
      expect(out.match.id).toBe('fe_base');
      expect(out.match_count).toBe(1);
    }
  });

  it('returns "no_match" when account_id does not match', () => {
    const out = matchBankStatementLines(
      input({ bank_account_id: 'ba_other', candidates: [baseCandidate] }),
    );
    expect(out.status).toBe('no_match');
  });

  it('matches by bank_account_key when no bank_account_id is provided', () => {
    const cand: FinanceEventLine = { ...baseCandidate, account_id: undefined };
    const out = matchBankStatementLines(
      input({
        bank_account_id: undefined,
        bank_account_key: 'ncb-ruh-001',
        candidates: [cand],
      }),
    );
    expect(out.status).toBe('matched');
  });

  it('rejects already-attached candidates', () => {
    const out = matchBankStatementLines(
      input({ candidates: [{ ...baseCandidate, attached: true }] }),
    );
    expect(out.status).toBe('no_match');
  });

  it('honors direction filter', () => {
    const out = matchBankStatementLines(
      input({ direction: 'out' }),
    );
    expect(out.status).toBe('no_match');
  });

  it('honors expected_currency filter', () => {
    const out = matchBankStatementLines(
      input({ expected_currency: 'USD' }),
    );
    expect(out.status).toBe('no_match');
  });

  it('honors window_days_before / window_days_after', () => {
    const tooEarly: FinanceEventLine = {
      ...baseCandidate,
      id: 'fe_early',
      occurred_at: '2026-04-22T09:00:00Z', // 3+ days before
    };
    const out = matchBankStatementLines(
      input({
        candidates: [tooEarly],
        policy: { window_days_before: 2, window_days_after: 2, amount_tolerance: 0, require_unique: true },
      }),
    );
    expect(out.status).toBe('no_match');
  });

  it('honors amount_tolerance', () => {
    const slight: FinanceEventLine = { ...baseCandidate, id: 'fe_slight', amount: 1003 };
    // W27 Cycle D — strict no-fallback. The four canonical
    // `bank_reconciliation_policy.match` fields must all be supplied.
    const exact = matchBankStatementLines(
      input({
        candidates: [slight],
        policy: { window_days_before: 2, window_days_after: 2, amount_tolerance: 0, require_unique: true },
      }),
    );
    expect(exact.status).toBe('no_match');

    const tolerant = matchBankStatementLines(
      input({
        candidates: [slight],
        policy: { window_days_before: 2, window_days_after: 2, amount_tolerance: 5, require_unique: true },
      }),
    );
    expect(tolerant.status).toBe('matched');
  });

  // W27 Cycle D — explicit fail-loud guards on missing canonical
  // `bank_reconciliation_policy.match` fields.
  it('throws when bank_recon_policy.match is missing', () => {
    expect(() =>
      matchBankStatementLines({ ...input({}), policy: undefined }),
    ).toThrow(/bank_recon_policy\.match not provided/);
  });

  it('throws when bank_recon_policy.match.window_days_before is missing', () => {
    expect(() =>
      matchBankStatementLines(
        input({
          policy: {
            window_days_after: 2,
            amount_tolerance: 0,
            require_unique: true,
          },
        }),
      ),
    ).toThrow(/window_days_before not provided/);
  });

  it('throws when bank_recon_policy.match.window_days_after is missing', () => {
    expect(() =>
      matchBankStatementLines(
        input({
          policy: {
            window_days_before: 2,
            amount_tolerance: 0,
            require_unique: true,
          },
        }),
      ),
    ).toThrow(/window_days_after not provided/);
  });

  it('throws when bank_recon_policy.match.amount_tolerance is missing', () => {
    expect(() =>
      matchBankStatementLines(
        input({
          policy: {
            window_days_before: 2,
            window_days_after: 2,
            require_unique: true,
          },
        }),
      ),
    ).toThrow(/amount_tolerance not provided/);
  });

  it('throws when bank_recon_policy.match.require_unique is missing', () => {
    expect(() =>
      matchBankStatementLines(
        input({
          policy: {
            window_days_before: 2,
            window_days_after: 2,
            amount_tolerance: 0,
          },
        }),
      ),
    ).toThrow(/require_unique not provided/);
  });

  it('returns "ambiguous" when multiple candidates match and policy.require_unique=true', () => {
    const a: FinanceEventLine = { ...baseCandidate, id: 'fe_a', occurred_at: '2026-04-25T09:00:00Z' };
    const b: FinanceEventLine = { ...baseCandidate, id: 'fe_b', occurred_at: '2026-04-25T11:00:00Z' };
    const out = matchBankStatementLines(input({ candidates: [a, b] }));
    expect(out.status).toBe('ambiguous');
    if (out.status === 'ambiguous') {
      expect(out.match_count).toBe(2);
      expect(out.candidates.length).toBe(2);
    }
  });

  it('selects closest-to-anchor when policy.require_unique=false', () => {
    const closest: FinanceEventLine = { ...baseCandidate, id: 'fe_close', occurred_at: '2026-04-25T10:30:00Z' };
    const further: FinanceEventLine = { ...baseCandidate, id: 'fe_far', occurred_at: '2026-04-25T14:00:00Z' };
    const out = matchBankStatementLines(
      input({
        candidates: [further, closest],
        policy: {
          window_days_before: 2,
          window_days_after: 2,
          amount_tolerance: 0,
          require_unique: false,
        },
      }),
    );
    expect(out.status).toBe('matched');
    if (out.status === 'matched') {
      expect(out.match.id).toBe('fe_close');
      expect(out.reason).toBe('closest');
      expect(out.match_count).toBe(2);
    }
  });

  it('throws on invalid expected_amount', () => {
    expect(() => matchBankStatementLines(input({ expected_amount: -1 }))).toThrow();
    expect(() => matchBankStatementLines(input({ expected_amount: NaN }))).toThrow();
  });

  it('returns no_match when neither bank_account_id nor bank_account_key is provided', () => {
    const out = matchBankStatementLines(
      input({ bank_account_id: undefined, bank_account_key: undefined }),
    );
    expect(out.status).toBe('no_match');
  });

  it('treats key matching as case/whitespace-insensitive (mirrors backend lower(btrim(...)))', () => {
    const cand: FinanceEventLine = { ...baseCandidate, account_id: undefined, bank_account_key: 'NCB-RUH-001' };
    const out = matchBankStatementLines(
      input({ bank_account_id: undefined, bank_account_key: '  ncb-ruh-001  ', candidates: [cand] }),
    );
    expect(out.status).toBe('matched');
  });
});

describe('agingBucket', () => {
  const now = new Date('2026-04-25T12:00:00Z');

  it('returns info when under 24h', () => {
    const out = agingBucket('2026-04-25T05:00:00Z', now, 48);
    expect(out.tone).toBe('info');
    expect(out.label).toBe('7h');
  });

  it('returns warn between 24h and SLA', () => {
    const out = agingBucket('2026-04-23T18:00:00Z', now, 72);
    expect(out.tone).toBe('warn');
    expect(out.label).toBe('2d');
  });

  it('returns danger at or beyond SLA', () => {
    const out = agingBucket('2026-04-22T11:00:00Z', now, 48);
    expect(out.tone).toBe('danger');
  });

  it('handles minutes-precision label below 1h', () => {
    const out = agingBucket('2026-04-25T11:30:00Z', now, 24);
    expect(out.label).toBe('30m');
    expect(out.tone).toBe('info');
  });

  it('clamps negative durations to 0', () => {
    const out = agingBucket('2026-04-26T00:00:00Z', now, 24);
    expect(out.hours).toBe(0);
    expect(out.tone).toBe('info');
  });

  it('throws on non-positive sla', () => {
    expect(() => agingBucket('2026-04-25T05:00:00Z', now, 0)).toThrow();
    expect(() => agingBucket('2026-04-25T05:00:00Z', now, -1)).toThrow();
  });

  it('returns dash label on invalid date', () => {
    const out = agingBucket('not-a-date', now, 24);
    expect(out.label).toBe('—');
  });
});

describe('varianceState', () => {
  it('returns good when delta == 0', () => {
    const v = varianceState(1000, 1000, 50);
    expect(v.tone).toBe('good');
    expect(v.exceeds_threshold).toBe(false);
    expect(v.delta).toBe(0);
  });

  it('returns warn when within tolerance', () => {
    const v = varianceState(1000, 1040, 50);
    expect(v.tone).toBe('warn');
    expect(v.exceeds_threshold).toBe(false);
  });

  it('returns danger when above tolerance', () => {
    const v = varianceState(1000, 1100, 50);
    expect(v.tone).toBe('danger');
    expect(v.exceeds_threshold).toBe(true);
  });

  it('handles negative delta (shortfall)', () => {
    const v = varianceState(1000, 800, 50);
    expect(v.tone).toBe('danger');
    expect(v.delta).toBe(-200);
  });

  it('treats negative threshold as 0', () => {
    const v = varianceState(1000, 1001, -5);
    expect(v.tone).toBe('danger');
  });
});

describe('ledgerBalance', () => {
  it('reports balanced when debits == credits', () => {
    const out = ledgerBalance([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 100 },
    ]);
    expect(out.balanced).toBe(true);
    expect(out.drift).toBe(0);
    expect(out.total_debit).toBe(100);
    expect(out.total_credit).toBe(100);
  });

  it('reports drift when out of balance', () => {
    const out = ledgerBalance([
      { debit: 100 },
      { credit: 90 },
    ]);
    expect(out.balanced).toBe(false);
    expect(out.drift).toBe(10);
  });

  it('treats undefined debit/credit as 0', () => {
    const out = ledgerBalance([{}, {}]);
    expect(out.balanced).toBe(true);
    expect(out.drift).toBe(0);
  });

  it('tolerates floating-point noise', () => {
    const out = ledgerBalance([
      { debit: 0.1 + 0.2 },
      { credit: 0.3 },
    ]);
    expect(out.balanced).toBe(true);
  });
});
