import {
  buildMutationFallbackEnvelope,
  liveBackendUnavailableError,
  liveRpc,
  liveRpcTarget,
  nestedScopeId,
  objectRecord,
  phaseC6ApiRpc,
  phaseC6Rpc,
  requireLiveMutationResult,
  requireLiveResourceReadback,
  sleep,
  state,
} from '../data-source';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { asNonEmptyString } from './shared';

async function requireLiveSettlementBatchReadback(
  rpcName: string,
  settlementBatchId: string,
): Promise<void> {
  await requireLiveResourceReadback('settlement_batches', settlementBatchId, rpcName);
  await requireLiveResourceReadback('settlement_batch_summary', settlementBatchId, rpcName);
}

async function requireLiveFinanceMutationReadback(
  rpcName: string,
  rec: Record<string, unknown>,
  args: Record<string, unknown> = {},
  idTarget: 'settlement_batch' | 'finance_event' | null = null,
): Promise<void> {
  const resultId = asNonEmptyString(rec.id);
  const settlementBatchId =
    asNonEmptyString(rec.settlement_batch_id) ??
    asNonEmptyString(args.settlement_batch_id) ??
    (idTarget === 'settlement_batch' ? resultId : null);
  if (settlementBatchId) {
    await requireLiveSettlementBatchReadback(rpcName, settlementBatchId);
  }
  const financeEventIds = Array.from(new Set([
    asNonEmptyString(rec.finance_event_id),
    asNonEmptyString(rec.from_finance_event_id),
    asNonEmptyString(rec.to_finance_event_id),
    asNonEmptyString(rec.reversed_finance_event_id),
    asNonEmptyString(rec.reversal_finance_event_id),
    idTarget === 'finance_event' ? resultId : null,
  ].filter((value): value is string => Boolean(value))));
  for (const financeEventId of financeEventIds) {
    await requireLiveFinanceEventReadback(rpcName, financeEventId);
  }
  const codEntryId =
    asNonEmptyString(rec.cod_entry_id) ??
    asNonEmptyString(args.cod_entry_id);
  if (codEntryId) {
    await requireLiveResourceReadback('cod_entries', codEntryId, rpcName);
  }
}

async function liveFinanceMutationResult(
  rpcName: string,
  args: Record<string, unknown>,
  evidenceKeys: string[],
  idTarget: 'settlement_batch' | 'finance_event' | null = null,
): Promise<Record<string, unknown> | null> {
  const live = await liveRpc<Record<string, unknown>>(rpcName, { p_args: args });
  if (!live) return null;
  const rec = requireLiveMutationResult(live.data, rpcName, evidenceKeys);
  await requireLiveFinanceMutationReadback(rpcName, rec, args, idTarget);
  return rec;
}

export async function apply_settlement_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('apply_settlement_v1', args, ['settlement_batch_id', 'id'], 'settlement_batch');
  if (live) return live;
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC apply_settlement_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'settlement_batch');
}

export async function reject_settlement_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('reject_settlement_v1', args, ['settlement_batch_id', 'id'], 'settlement_batch');
  if (live) return live;
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC reject_settlement_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'settlement_batch');
}

export async function ui_create_settlement_batch_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('ui_create_settlement_batch_v1', args, ['settlement_batch_id', 'id'], 'settlement_batch');
  if (live) return live;
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC ui_create_settlement_batch_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'settlement_batch');
}

export async function ui_transition_settlement_batch_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('ui_transition_settlement_batch_v1', args, ['settlement_batch_id', 'id'], 'settlement_batch');
  if (live) return live;
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC ui_transition_settlement_batch_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'settlement_batch');
}

export async function ui_record_cod_remittance_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('ui_record_cod_remittance_v1', args, [
    'finance_event_id',
    'from_finance_event_id',
    'to_finance_event_id',
    'settlement_batch_id',
    'settlement_event_id',
  ]);
  if (live) return live;
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC ui_record_cod_remittance_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'finance_event');
}

export async function ui_adjust_cod_collection_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('ui_adjust_cod_collection_v1', args, [
    'finance_event_id',
    'settlement_batch_id',
    'settlement_event_id',
  ]);
  if (live) return live;
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC ui_adjust_cod_collection_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'finance_event');
}

export async function ui_reverse_finance_event_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const live = await liveFinanceMutationResult('ui_reverse_finance_event_v1', args, [
    'finance_event_id',
    'reversed_finance_event_id',
    'reversal_finance_event_id',
    'id',
  ], 'finance_event');
  if (live) return live;
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC ui_reverse_finance_event_v1');
  await sleep(60);
  return buildMutationFallbackEnvelope(args, 'finance_event');
}

// ----------- COD / Settlements -----------
export async function compute_cod_payment_collection_summary_v1(scope?: unknown): Promise<{
  scope: unknown;
  expected: number;
  collected: number;
  remitted: number;
  variance: number;
}> {
  const scopeRec = (scope && typeof scope === 'object' ? scope : {}) as Record<string, unknown>;
  const organizationId =
    scopeRec.organization_id ??
    scopeRec.tenant_id ??
    nestedScopeId(scopeRec, 'tenant') ??
    (typeof scopeRec.tenant === 'string' ? scopeRec.tenant : null) ??
    state.user.organization_id ??
    null;
  const live = await liveRpc<Record<string, unknown>>('compute_cod_payment_collection_summary_v1', {
    p_organization_id: organizationId,
    p_branch_id: scopeRec.branch_id ?? nestedScopeId(scopeRec, 'branch') ?? null,
    p_subject_type: scopeRec.subject_type ?? null,
    p_subject_id: scopeRec.subject_id ?? null,
    p_window_start_at: scopeRec.window_start_at ?? scopeRec.from ?? null,
    p_window_end_at: scopeRec.window_end_at ?? scopeRec.to ?? null,
  });
  if (live) {
    if (!organizationId) throw new Error('compute_cod_payment_collection_summary_v1 requires organization_id');
    const rec = (live.data ?? {}) as Record<string, unknown>;
    const expected = Number(rec.expected_amount ?? rec.expected ?? 0);
    const collected = Number(rec.collected_amount ?? rec.collected ?? 0);
    const remitted = Number(rec.remitted_amount ?? rec.remitted ?? 0);
    return {
      scope,
      expected,
      collected,
      remitted,
      variance: Number(rec.variance_amount ?? rec.variance ?? collected - expected),
    };
  }

  await sleep(60);
  return { scope, expected: 7150, collected: 6970, remitted: 0, variance: -180 };
}

// ----------- Phase B5/C4 FINANCE mutations -----------
//
// Each RPC accepts a single jsonb envelope `p_args` and returns
//   { ok, <resource>_id, correlation_id, settings_resolution_id, ... }.
// All flow through the canonical phaseC6Rpc helper for zero-redundancy
// (the helper is named after C6 only because it landed first; the envelope
// shape is the same across B-suite jsonb RPCs, by design).
//
// Migrations of record (verified):
//   • create_billing_invoice_v1     202604281010
//   • update_billing_invoice_v1     202604281020
//   • void_billing_invoice_v1       202604281030
//   • billing_invoice_send_v1       202604281040
//   • billing_invoice_refund_v1     202604281050
//   • apply_settlement_v1           202604281060
//   • reject_settlement_v1          202604281070
//   • bank_recon_match_v1           202604281080
//   • bank_recon_unmatch_v1         202604281090
//   • dispute_resolve_v1            202604281100
//   • dispute_reject_v1             202604281110
//   • cancel_subscription_v1        202604281120
//
// Capability split (mirror of B5 access_control_policy registration in
// 202604281000_phase_b5_finance_caps_v1.sql):
//   • billing.write     — create / update / void / cancel_subscription
//   • invoices.send     — send (broadcast)
//   • invoices.refund   — refund
//   • settlements.write — apply / reject
//   • finance.write     — bank_recon_match / unmatch (reuse canonical RBAC)
//   • disputes.write    — dispute_resolve / dispute_reject (NEW per B5)

// FINANCE — billing invoices
function compactStringIds(values: unknown[]): string[] {
  return Array.from(new Set(values.flatMap((value) => {
    if (Array.isArray(value)) {
      return value.map((item) => asNonEmptyString(item)).filter((item): item is string => Boolean(item));
    }
    const id = asNonEmptyString(value);
    return id ? [id] : [];
  })));
}

function resolveBillingInvoiceIds(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string[] {
  const rowIds = Array.isArray(rec.results)
    ? rec.results.flatMap((row) => {
      const rowRec = objectRecord(row);
      const result = objectRecord(rowRec.result);
      return [
        asNonEmptyString(rowRec.billing_invoice_id),
        asNonEmptyString(result.billing_invoice_id),
        asNonEmptyString(result.id),
      ];
    })
    : [];
  return compactStringIds([
    rec.billing_invoice_id,
    rec.invoice_id,
    rec.id,
    args.billing_invoice_id,
    args.invoice_id,
    args.billing_invoice_ids,
    args.invoice_ids,
    rowIds,
  ]);
}

async function requireLiveBillingInvoiceReadback(
  rpcName: string,
  billingInvoiceIds: string[],
): Promise<void> {
  if (billingInvoiceIds.length === 0) {
    throw new Error(`${rpcName} did not return billing_invoice_id`);
  }
  for (const billingInvoiceId of billingInvoiceIds) {
    await requireLiveResourceReadback('billing_invoices', billingInvoiceId, rpcName);
    await requireLiveResourceReadback('billing_invoice_directory', billingInvoiceId, rpcName);
  }
}

async function billingInvoiceMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'billing_invoice');
  if (liveRpcTarget()) {
    await requireLiveBillingInvoiceReadback(rpcName, resolveBillingInvoiceIds(result, args));
  }
  return result;
}

export const create_billing_invoice_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('create_billing_invoice_v1', args);

export const update_billing_invoice_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('update_billing_invoice_v1', args);

export const void_billing_invoice_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('void_billing_invoice_v1', args);

export const billing_invoice_send_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('billing_invoice_send_v1', args);

export async function ui_bulk_billing_invoice_send_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6ApiRpc('ui_bulk_billing_invoice_send_v1', args);
  if (liveRpcTarget()) {
    await requireLiveBillingInvoiceReadback('ui_bulk_billing_invoice_send_v1', resolveBillingInvoiceIds(result, args));
  }
  return result;
}

export const billing_invoice_refund_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('billing_invoice_refund_v1', args);

export const billing_invoice_mark_paid_v1 = (args: Record<string, unknown>) =>
  billingInvoiceMutation('billing_invoice_mark_paid_v1', args);

async function requireLiveSubscriptionReadback(
  rpcName: string,
  subscriptionId: string,
  eventId?: string | null,
): Promise<void> {
  await requireLiveResourceReadback('subscriptions', subscriptionId, rpcName);
  const normalizedEventId = asNonEmptyString(eventId);
  if (normalizedEventId) {
    await requireLiveResourceReadback('subscription_events', normalizedEventId, rpcName);
  }
}

export async function cancel_subscription_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc('cancel_subscription_v1', args, 'subscription');
  if (liveRpcTarget()) {
    const subscriptionId =
      asNonEmptyString(result.subscription_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.subscription_id);
    if (!subscriptionId) throw new Error('cancel_subscription_v1 did not return subscription_id');
    await requireLiveSubscriptionReadback(
      'cancel_subscription_v1',
      subscriptionId,
      asNonEmptyString(result.subscription_event_id) ?? asNonEmptyString(result.event_id),
    );
  }
  return result;
}

export async function requireLiveFinanceEventReadback(
  rpcName: string,
  financeEventId: string,
): Promise<void> {
  await requireLiveResourceReadback('finance_events_ledger', financeEventId, rpcName);
}

// FINANCE — bank reconciliation
async function bankReconMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'bank_recon_match');
  if (liveRpcTarget()) {
    const matchId =
      asNonEmptyString(result.bank_recon_match_id) ??
      asNonEmptyString(result.match_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString(args.bank_recon_match_id);
    if (!matchId) throw new Error(`${rpcName} did not return bank_recon_match_id`);
    await requireLiveResourceReadback('bank_recon_matches', matchId, rpcName);
    const financeEventId =
      asNonEmptyString(result.finance_event_id) ??
      asNonEmptyString(args.bank_statement_event_id);
    if (financeEventId) {
      await requireLiveFinanceEventReadback(rpcName, financeEventId);
    }
  }
  return result;
}

export const bank_recon_match_v1 = (args: Record<string, unknown>) =>
  bankReconMutation('bank_recon_match_v1', args);

export const bank_recon_unmatch_v1 = (args: Record<string, unknown>) =>
  bankReconMutation('bank_recon_unmatch_v1', args);

export async function ui_record_bank_statement_event_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6ApiRpc('ui_record_bank_statement_event_v1', args, 'finance_event');
  if (liveRpcTarget()) {
    const financeEventId =
      asNonEmptyString(result.finance_event_id) ??
      asNonEmptyString(result.id);
    if (!financeEventId) throw new Error('ui_record_bank_statement_event_v1 did not return finance_event_id');
    await requireLiveFinanceEventReadback('ui_record_bank_statement_event_v1', financeEventId);
    await requireLiveResourceReadback('finance_events_bank_statement', financeEventId, 'ui_record_bank_statement_event_v1');
  }
  return result;
}

// FINANCE — disputes (FINANCE namespace; distinct from MARKETPLACE)
export async function ui_create_bank_account_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6ApiRpc('ui_create_bank_account_v1', args, 'bank_account');
  if (liveRpcTarget()) {
    const bankAccountId =
      asNonEmptyString(result.bank_account_id) ??
      asNonEmptyString(result.id);
    if (!bankAccountId) throw new Error('ui_create_bank_account_v1 did not return bank_account_id');
    await requireLiveResourceReadback('bank_accounts', bankAccountId, 'ui_create_bank_account_v1');
  }
  return result;
}

function resolveDisputeIds(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string[] {
  const rowIds = Array.isArray(rec.results)
    ? rec.results.flatMap((row) => {
      const rowRec = objectRecord(row);
      const result = objectRecord(rowRec.result);
      return [
        asNonEmptyString(rowRec.dispute_id),
        asNonEmptyString(result.dispute_id),
        asNonEmptyString(result.id),
      ];
    })
    : [];
  return compactStringIds([
    rec.dispute_id,
    rec.id,
    args.dispute_id,
    args.dispute_ids,
    rowIds,
  ]);
}

async function requireLiveDisputeReadback(
  rpcName: string,
  disputeIds: string[],
): Promise<void> {
  if (disputeIds.length === 0) throw new Error(`${rpcName} did not return dispute_id`);
  for (const disputeId of disputeIds) {
    await requireLiveResourceReadback('marketplace_disputes', disputeId, rpcName);
    await requireLiveResourceReadback('dispute_directory', disputeId, rpcName);
  }
}

async function disputeMutation(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await phaseC6Rpc(rpcName, args, 'dispute');
  if (liveRpcTarget()) {
    await requireLiveDisputeReadback(rpcName, resolveDisputeIds(result, args));
  }
  return result;
}

export const dispute_resolve_v1 = (args: Record<string, unknown>) =>
  disputeMutation('dispute_resolve_v1', args);

export const dispute_reject_v1 = (args: Record<string, unknown>) =>
  disputeMutation('dispute_reject_v1', args);

export async function ui_bulk_dispute_action_v1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await phaseC6ApiRpc('ui_bulk_dispute_action_v1', args);
  if (liveRpcTarget()) {
    await requireLiveDisputeReadback('ui_bulk_dispute_action_v1', resolveDisputeIds(result, args));
  }
  return result;
}

// W8-4 / W9-3 — non-terminal dispute lifecycle (acknowledge + escalate).
// Migrations: 202604301140 (acknowledge) + 202604301150 (escalate).
// Same `phaseC6Rpc` substrate as resolve/reject so the seam stays uniform;
// `marketplace_disputes` invalidation flows through the queries.ts hook layer.
export const dispute_acknowledge_v1 = (args: Record<string, unknown>) =>
  disputeMutation('dispute_acknowledge_v1', args);

export const dispute_escalate_v1 = (args: Record<string, unknown>) =>
  disputeMutation('dispute_escalate_v1', args);
