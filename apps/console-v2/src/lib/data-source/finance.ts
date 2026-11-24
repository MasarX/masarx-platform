import {
  buildMutationFallbackEnvelope,
  liveBackendUnavailableError,
  liveRpc,
  nestedScopeId,
  requireLiveFinanceEventReadback,
  requireLiveMutationResult,
  requireLiveResourceReadback,
  sleep,
  state,
} from '../data-source';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { asNonEmptyString } from './shared';

// FINANCE — settlements
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
