// _matcher.ts — Pure (no-React, no-DOM) helpers used by finance modules.
//
// These are the only places math/policy lives in finance UI code; everything
// here is unit-tested. The shapes mirror canonical backend fields so a switch
// to live Supabase responses is mechanical.
//
// Backend SSOT references (see __audit__/F/backend-evidence.md):
//   - bank_reconciliation_policy schema (window_days_before/after, amount_tolerance, require_unique)
//     migration 202601221120_bank_accounts_and_bank_reconciliation_policy_v1.sql
//   - workflow_handlers.execute_bank_statement_match_v1 (the equivalent SQL matcher)
//     migration 202601221130_wf_bank_statement_match_v1.sql
//   - settlement_policy.locking.max_variance_amount
//   - cod_policy.handover.window_hours

// ---------------------------------------------------------------------------
// Bank statement match
// ---------------------------------------------------------------------------

/** Single bank statement line as stored in `finance_events` (event_type='bank_statement'). */
export interface FinanceEventLine {
  id: string;
  organization_id?: string;
  event_type: string; // expected 'bank_statement'
  account_type: string; // expected 'bank_account'
  account_id?: string;
  bank_account_key?: string;
  direction: 'in' | 'out';
  amount: number;
  currency: string;
  occurred_at: string; // ISO timestamp
  /** True when this finance_event is already attached to a settlement_batch (joined via settlement_batch_finance_events). */
  attached?: boolean;
}

/** Resolved `bank_reconciliation_policy.match` block. */
export interface BankReconciliationMatchPolicy {
  window_days_before?: number | null;
  window_days_after?: number | null;
  amount_tolerance?: number | null;
  require_unique?: boolean | null;
}

export interface MatchInput {
  /** Anchor timestamp for the match window (ISO). Usually the settlement batch close time. */
  anchor_at: string;
  /** Expected amount to match (>= 0). */
  expected_amount: number;
  /** Optional currency to enforce. */
  expected_currency?: string;
  /** 'in' for deposits, 'out' for withdrawals/fees. */
  direction: 'in' | 'out';
  /** Bank account id (matches finance_events.account_id) — when present takes priority. */
  bank_account_id?: string;
  /** Bank account key (matches bank_accounts.key when no id is supplied). */
  bank_account_key?: string;
  /** Available statement lines to evaluate (pre-loaded from finance_events). */
  candidates: FinanceEventLine[];
  /** Resolved bank_reconciliation_policy.match block. */
  policy?: BankReconciliationMatchPolicy;
}

export type MatchOutcome =
  | { status: 'no_match'; reason: 'no_match'; match_count: 0 }
  | { status: 'pending'; reason: 'no_match'; match_count: 0 }
  | { status: 'ambiguous'; reason: 'ambiguous'; match_count: number; candidates: FinanceEventLine[] }
  | { status: 'matched'; reason: 'unique' | 'closest'; match: FinanceEventLine; match_count: number };

const DAY_MS = 24 * 60 * 60 * 1000;

function ms(ts: string): number {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pure replica of `workflow_handlers.execute_bank_statement_match_v1` matching
 * predicate set. Selects unattached bank_statement events whose:
 *   - account_id (or resolved bank_account_key) matches
 *   - direction matches
 *   - currency matches when expected_currency is supplied
 *   - occurred_at is within [anchor - days_before, anchor + days_after]
 *   - amount is within [expected ± amount_tolerance]
 *
 * Tie-breaking when multiple candidates remain:
 *   - if policy.require_unique is true → return ambiguous
 *   - else select the candidate whose occurred_at is closest to anchor_at;
 *     ties broken by earliest occurred_at, then by id (stable).
 */
export function matchBankStatementLines(input: MatchInput): MatchOutcome {
  if (!Number.isFinite(input.expected_amount) || input.expected_amount < 0) {
    throw new Error('matchBankStatementLines: expected_amount must be a finite non-negative number');
  }
  if (input.direction !== 'in' && input.direction !== 'out') {
    throw new Error('matchBankStatementLines: direction must be "in" or "out"');
  }

  // W27 Cycle D — strict no-fallback. Drop the inline literal defaults
  // (`?? 2`, `?? 0`, `?? true`); the caller MUST supply a fully-resolved
  // `bank_reconciliation_policy.match` block via `input.policy`. When any
  // of the four canonical fields is null/undefined we fail loudly so the
  // operator surface (or test) sees the gap rather than silently
  // substituting hardcoded defaults.
  if (!input.policy) {
    throw new Error('matchBankStatementLines: bank_recon_policy.match not provided');
  }
  const policy = input.policy;
  if (policy.window_days_before == null) {
    throw new Error('matchBankStatementLines: bank_recon_policy.match.window_days_before not provided');
  }
  if (policy.window_days_after == null) {
    throw new Error('matchBankStatementLines: bank_recon_policy.match.window_days_after not provided');
  }
  if (policy.amount_tolerance == null) {
    throw new Error('matchBankStatementLines: bank_recon_policy.match.amount_tolerance not provided');
  }
  if (policy.require_unique == null) {
    throw new Error('matchBankStatementLines: bank_recon_policy.match.require_unique not provided');
  }
  const daysBefore = Math.max(0, policy.window_days_before);
  const daysAfter = Math.max(0, policy.window_days_after);
  const tolerance = Math.max(0, policy.amount_tolerance);
  const requireUnique = policy.require_unique;

  const anchorMs = ms(input.anchor_at);
  const minMs = anchorMs - daysBefore * DAY_MS;
  const maxMs = anchorMs + daysAfter * DAY_MS;

  const minAmount = input.expected_amount - tolerance;
  const maxAmount = input.expected_amount + tolerance;

  const accountIdFilter = input.bank_account_id ?? null;
  const accountKeyFilter = (input.bank_account_key ?? '').trim().toLowerCase();

  const matches = input.candidates.filter((c) => {
    if (c.event_type !== 'bank_statement') return false;
    if (c.account_type !== 'bank_account') return false;
    if (c.attached === true) return false;
    if (c.direction !== input.direction) return false;
    if (input.expected_currency && c.currency !== input.expected_currency) return false;

    if (accountIdFilter) {
      if (c.account_id !== accountIdFilter) return false;
    } else if (accountKeyFilter) {
      const key = (c.bank_account_key ?? '').trim().toLowerCase();
      if (key !== accountKeyFilter) return false;
    } else {
      // Without a bank account selector we cannot match deterministically.
      return false;
    }

    if (c.amount < minAmount || c.amount > maxAmount) return false;
    const t = ms(c.occurred_at);
    if (t < minMs || t > maxMs) return false;
    return true;
  });

  if (matches.length === 0) {
    return { status: 'no_match', reason: 'no_match', match_count: 0 };
  }

  if (matches.length === 1) {
    return {
      status: 'matched',
      reason: 'unique',
      match: matches[0]!,
      match_count: 1,
    };
  }

  if (requireUnique) {
    return {
      status: 'ambiguous',
      reason: 'ambiguous',
      match_count: matches.length,
      candidates: matches,
    };
  }

  // Closest-to-anchor tie break.
  const sorted = [...matches].sort((a, b) => {
    const da = Math.abs(ms(a.occurred_at) - anchorMs);
    const db = Math.abs(ms(b.occurred_at) - anchorMs);
    if (da !== db) return da - db;
    const ta = ms(a.occurred_at);
    const tb = ms(b.occurred_at);
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  return {
    status: 'matched',
    reason: 'closest',
    match: sorted[0]!,
    match_count: matches.length,
  };
}

// ---------------------------------------------------------------------------
// Aging bucket
// ---------------------------------------------------------------------------

export type AgingTone = 'info' | 'warn' | 'danger';

export interface AgingResult {
  hours: number;
  tone: AgingTone;
  label: string;
}

/**
 * Map an item's age (now - asOf) into an aging bucket + tone.
 * Defaults: <24h → info, 24h..slaHours → warn, ≥slaHours → danger.
 * `slaHours` MUST be supplied by the caller from the resolved policy
 * (e.g. cod_policy.handover.window_hours, dispute SLA), with sane fallbacks.
 *
 * The label is human-friendly ("3h", "2d") to keep table cells dense.
 */
export function agingBucket(asOf: string | Date, now: Date, slaHours: number): AgingResult {
  if (!Number.isFinite(slaHours) || slaHours <= 0) {
    throw new Error('agingBucket: slaHours must be a positive finite number');
  }
  const asMs = typeof asOf === 'string' ? Date.parse(asOf) : asOf.getTime();
  if (!Number.isFinite(asMs)) {
    return { hours: 0, tone: 'info', label: '—' };
  }
  const diffMs = Math.max(0, now.getTime() - asMs);
  const hours = diffMs / (60 * 60 * 1000);

  let tone: AgingTone;
  if (hours < 24) tone = 'info';
  else if (hours < slaHours) tone = 'warn';
  else tone = 'danger';

  let label: string;
  if (hours < 1) {
    const mins = Math.max(0, Math.round((diffMs / (60 * 1000))));
    label = `${mins}m`;
  } else if (hours < 24) {
    label = `${Math.round(hours)}h`;
  } else {
    label = `${Math.round(hours / 24)}d`;
  }

  return { hours, tone, label };
}

// ---------------------------------------------------------------------------
// Variance state (settlement / COD)
// ---------------------------------------------------------------------------

export type VarianceTone = 'good' | 'warn' | 'danger';

export interface VarianceResult {
  delta: number;
  tone: VarianceTone;
  exceeds_threshold: boolean;
}

/**
 * Compute variance state from collected vs expected amounts and a policy
 * threshold. Threshold comes from settlement_policy.locking.max_variance_amount
 * (resolved via the canonical ladder). Negative delta = shortfall.
 *
 * Tones:
 *   - delta == 0 → good
 *   - |delta| <= threshold → warn (within tolerance, watch)
 *   - |delta| > threshold → danger (variance gate triggers)
 */
export function varianceState(
  expected: number,
  collected: number,
  thresholdAmount: number,
): VarianceResult {
  const delta = collected - expected;
  const abs = Math.abs(delta);
  const threshold = Math.max(0, thresholdAmount);
  if (delta === 0) {
    return { delta, tone: 'good', exceeds_threshold: false };
  }
  if (abs <= threshold) {
    return { delta, tone: 'warn', exceeds_threshold: false };
  }
  return { delta, tone: 'danger', exceeds_threshold: true };
}

// ---------------------------------------------------------------------------
// Double-entry ledger balance (debit vs credit)
// ---------------------------------------------------------------------------

export interface BalanceRow {
  debit?: number;
  credit?: number;
}

export interface BalanceResult {
  total_debit: number;
  total_credit: number;
  balanced: boolean;
  drift: number;
}

/**
 * Sum visible ledger rows' debits and credits and report whether they balance.
 * Drift = total_debit - total_credit (zero when balanced).
 */
export function ledgerBalance(rows: BalanceRow[]): BalanceResult {
  let total_debit = 0;
  let total_credit = 0;
  for (const r of rows) {
    total_debit += Number(r.debit ?? 0);
    total_credit += Number(r.credit ?? 0);
  }
  // Use a tiny epsilon for FP rounding (1e-6 SAR is well under one halala).
  const drift = total_debit - total_credit;
  const balanced = Math.abs(drift) < 1e-6;
  return { total_debit, total_credit, balanced, drift };
}
