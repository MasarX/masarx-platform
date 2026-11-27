import {
  type BranchCapacityWindowMutationResult,
  type BranchCoverageWindowMutationResult,
  type BranchMarkOosResult,
  type BranchMembershipMutationResult,
  type BranchMutationResult,
  type BranchZoneMutationResult,
  buildEnvelope,
  buildMutationFallbackEnvelope,
  liveBackendUnavailableError,
  livePArgsMutationResult,
  liveRpc,
  nextResourceId,
  objectRecord,
  PARTICIPANT_REVIEW_READBACK_ATTEMPTS,
  PARTICIPANT_REVIEW_READBACK_DELAY_MS,
  readFunctionErrorMessage,
  readLiveResourceListReadback,
  requireFunctionMutationResult,
  requireLiveDomainEvidence,
  requireLiveMutationResult,
  requireLiveNumberField,
  requireLiveResourceReadback,
  seed,
  sleep,
  state,
  withRequiredLiveStringField,
  type ZoneCreateResult,
  type ZoneDistrictMutationResult,
  type ZoneProfileMutationResult,
} from '../data-source';
import { hostedInviteRedirect } from '../hosted-redirect';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { getSupabaseClient } from '../supabase';
import { asNonEmptyString } from './shared';

export async function zone_create_v1(
  args: Record<string, unknown>,
): Promise<ZoneCreateResult> {
  const live = await liveRpc<Record<string, unknown>>('zone_create_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'zone_create_v1', [
      'zone_id',
    ]) as ZoneCreateResult;
  }

  await sleep(60);
  return buildEnvelope({
    zone_id: (args.zone_id as string | undefined) ?? nextResourceId('zone'),
    initial_district_count: Array.isArray(args.initial_district_ids)
      ? (args.initial_district_ids as unknown[]).length
      : 0,
  }) as ZoneCreateResult;
}

export async function zone_update_v1(
  args: Record<string, unknown>,
): Promise<ZoneProfileMutationResult> {
  const live = await liveRpc<Record<string, unknown>>('zone_update_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'zone_update_v1', [
      'zone_id',
    ]) as ZoneProfileMutationResult;
  }

  await sleep(60);
  const zoneId = asNonEmptyString(args.zone_id) ?? asNonEmptyString(args.id);
  if (!zoneId) throw new Error('zone_update_v1 requires zone_id');
  const patch = objectRecord(args.patch);
  const zones = (seed as { zones?: Array<Record<string, unknown>> }).zones ?? [];
  const zone = zones.find((row) => row.id === zoneId);
  if (!zone) throw new Error(`zone_not_found:${zoneId}`);

  const changed: Record<string, unknown> = {};
  const nextMetadata = objectRecord(zone.metadata);
  if (patch.name !== undefined) {
    const next = asNonEmptyString(patch.name);
    if (!next) throw new Error('zone_update_v1 name cannot be blank');
    zone.name = next;
    changed.name = next;
  }
  if (patch.slug !== undefined) {
    const next = asNonEmptyString(patch.slug)?.toLowerCase();
    if (!next) throw new Error('zone_update_v1 slug cannot be blank');
    zone.slug = next;
    changed.slug = next;
  }
  if (patch.description !== undefined) {
    const next = asNonEmptyString(patch.description);
    zone.description = next;
    zone.notes = next ?? '';
    changed.description = next;
  }
  if (patch.sort_order !== undefined) {
    const next = Number(patch.sort_order);
    if (!Number.isFinite(next)) throw new Error('zone_update_v1 sort_order must be numeric');
    zone.sort_order = next;
    changed.sort_order = next;
  }
  const metadataPatch = objectRecord(patch.metadata);
  for (const [key, value] of Object.entries(metadataPatch)) {
    nextMetadata[key] = value;
  }
  if (patch.color_token !== undefined) {
    const next = asNonEmptyString(patch.color_token)?.toLowerCase() ?? null;
    nextMetadata.color_token = next;
    zone.color_token = next ?? undefined;
    changed.color_token = next;
  }
  zone.metadata = nextMetadata;
  zone.updated_at = new Date().toISOString();

  return buildEnvelope({
    zone_id: zoneId,
    changed,
  }) as ZoneProfileMutationResult;
}

export async function zone_delete_v1(
  args: Record<string, unknown>,
): Promise<ZoneProfileMutationResult> {
  const live = await liveRpc<Record<string, unknown>>('zone_delete_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'zone_delete_v1', [
      'zone_id',
    ]) as ZoneProfileMutationResult;
  }

  await sleep(60);
  const zoneId = asNonEmptyString(args.zone_id) ?? asNonEmptyString(args.id);
  if (!zoneId) throw new Error('zone_delete_v1 requires zone_id');
  const zones = (seed as { zones?: Array<Record<string, unknown>> }).zones ?? [];
  const zone = zones.find((row) => row.id === zoneId);
  if (!zone) throw new Error(`zone_not_found:${zoneId}`);
  const metadata = objectRecord(zone.metadata);
  const alreadyProcessed = zone.is_active === false && metadata.lifecycle === 'retired';
  if (!alreadyProcessed) {
    const now = new Date().toISOString();
    zone.is_active = false;
    zone.status = 'retired';
    zone.metadata = {
      ...metadata,
      lifecycle: 'retired',
      retired_at: now,
      retired_by_user_id: state.user.id ?? null,
      retired_reason: asNonEmptyString(args.reason),
      retired_metadata: objectRecord(args.metadata),
    };
    zone.updated_at = now;
  }

  return buildEnvelope({
    zone_id: zoneId,
    is_active: false,
    lifecycle: 'retired',
    already_processed: alreadyProcessed,
  }) as ZoneProfileMutationResult;
}

export async function zone_district_add_v1(
  args: Record<string, unknown>,
): Promise<ZoneDistrictMutationResult> {
  const live = await liveRpc<Record<string, unknown>>('zone_district_add_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'zone_district_add_v1', [
      'zone_district_id',
    ]) as ZoneDistrictMutationResult;
  }
  await sleep(60);
  return buildEnvelope({
    zone_district_id:
      (args.zone_district_id as string | undefined) ?? nextResourceId('zone_district'),
    already_processed: false,
  }) as ZoneDistrictMutationResult;
}

export async function zone_district_remove_v1(
  args: Record<string, unknown>,
): Promise<ZoneDistrictMutationResult> {
  const live = await liveRpc<Record<string, unknown>>('zone_district_remove_v1', { p_args: args });
  if (live) {
    return requireLiveMutationResult(live.data, 'zone_district_remove_v1', [
      'zone_district_id',
    ]) as ZoneDistrictMutationResult;
  }
  await sleep(60);
  return buildEnvelope({
    zone_district_id:
      (args.zone_district_id as string | undefined) ?? nextResourceId('zone_district'),
    already_processed: false,
  }) as ZoneDistrictMutationResult;
}

function normalizeParticipantReviewDecision(value: string | null | undefined): string | null {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized) return null;
  if (normalized === 'approve') return 'approved';
  if (normalized === 'reject') return 'rejected';
  return normalized;
}

function assertParticipantReviewReadbackState(
  row: Record<string, unknown>,
  expectedDecision: string,
  resourceKey: string,
  requestId: string,
): void {
  const expected = normalizeParticipantReviewDecision(expectedDecision);
  if (!expected) return;
  const status = asNonEmptyString(row.status)?.toLowerCase() ?? null;
  const reviewDecision = asNonEmptyString(row.review_decision)?.toLowerCase() ?? null;
  const reviewedAt = asNonEmptyString(row.reviewed_at);
  if (expected === 'approved' || expected === 'rejected') {
    if (status !== expected && reviewDecision !== expected) {
      throw new Error(
        `marketplace-participant-review backend readback ${resourceKey}:${requestId} is not ${expected}`,
      );
    }
    if (!reviewedAt) {
      throw new Error(
        `marketplace-participant-review backend readback ${resourceKey}:${requestId} missing reviewed_at`,
      );
    }
    return;
  }
  if (expected === 'request_additional_docs') {
    const decisionMetadata = row.decision_metadata && typeof row.decision_metadata === 'object' && !Array.isArray(row.decision_metadata)
      ? row.decision_metadata as Record<string, unknown>
      : {};
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {};
    if (decisionMetadata.request_additional_docs !== true && metadata.request_additional_docs !== true) {
      throw new Error(
        `marketplace-participant-review backend readback ${resourceKey}:${requestId} missing request_additional_docs evidence`,
      );
    }
  }
}

async function requireParticipantReviewStateReadback(
  resourceKey: string,
  requestId: string,
  rpcName: string,
  decision: string,
): Promise<Record<string, unknown>> {
  const readRow = async () => {
    if (resourceKey === 'marketplace_participant_requests') {
      const rows = await readLiveResourceListReadback(
        resourceKey,
        { id: requestId },
        rpcName,
      );
      const row = rows[0];
      if (!row || Object.keys(row).length === 0) {
        throw new Error(`${rpcName} backend readback missing ${resourceKey}:${requestId}`);
      }
      return row;
    }
    return requireLiveResourceReadback(resourceKey, requestId, rpcName);
  };
  let row = await readRow();
  let lastStateError: unknown;
  for (let attempt = 1; attempt <= PARTICIPANT_REVIEW_READBACK_ATTEMPTS; attempt += 1) {
    try {
      assertParticipantReviewReadbackState(row, decision, resourceKey, requestId);
      return row;
    } catch (err) {
      lastStateError = err;
      if (attempt >= PARTICIPANT_REVIEW_READBACK_ATTEMPTS) break;
      await sleep(PARTICIPANT_REVIEW_READBACK_DELAY_MS);
      row = await readRow();
    }
  }
  throw lastStateError instanceof Error
    ? lastStateError
    : new Error(`${rpcName} backend readback ${resourceKey}:${requestId} did not reflect review state`);
}

async function participantReviewSuccessFromReadback({
  requestId,
  decision,
  metadata,
  merged = {},
  result = {},
  envelope = {},
  recoveredFromFunctionError,
  functionErrorMessage,
}: {
  requestId: string;
  decision: string;
  metadata: Record<string, unknown>;
  merged?: Record<string, unknown>;
  result?: Record<string, unknown>;
  envelope?: Record<string, unknown>;
  recoveredFromFunctionError?: boolean;
  functionErrorMessage?: string;
}): Promise<Record<string, unknown>> {
  const normalizedDecision = normalizeParticipantReviewDecision(decision);
  const requestReadback = await requireParticipantReviewStateReadback(
    'marketplace_participant_requests',
    requestId,
    'marketplace-participant-review',
    decision,
  );
  const returnedDecision =
    asNonEmptyString(merged.decision) ??
    asNonEmptyString(merged.status) ??
    asNonEmptyString(requestReadback.review_decision) ??
    asNonEmptyString(requestReadback.status) ??
    normalizedDecision;
  if (!returnedDecision) throw new Error('marketplace-participant-review did not return decision status');
  const participantType =
    asNonEmptyString(requestReadback.requested_participant_type_key) ??
    asNonEmptyString(merged.requested_participant_type_key) ??
    asNonEmptyString(metadata.participant_type);
  const driverApplicationReadback = participantType === 'freelancer_driver'
    ? await requireParticipantReviewStateReadback(
        'driver_application_directory',
        requestId,
        'marketplace-participant-review',
        decision,
      )
    : null;
  return {
    ...result,
    ...envelope,
    ok: true,
    marketplace_participant_request_id: requestId,
    participant_request_readback: requestReadback,
    ...(driverApplicationReadback ? { driver_application_readback: driverApplicationReadback } : {}),
    decision: returnedDecision,
    ...(recoveredFromFunctionError
      ? {
          recovered_from_function_error: true,
          function_error_message: functionErrorMessage,
        }
      : {}),
  };
}

export async function marketplace_participant_request_review_apply_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId =
    asNonEmptyString(args.participant_request_id) ??
    asNonEmptyString(args.request_id) ??
    asNonEmptyString(args.id);
  const decision = asNonEmptyString(args.decision)?.toLowerCase() ?? null;
  if (!requestId) throw new Error('participant_request_id is required');
  if (!decision) throw new Error('decision is required');

  const client = getSupabaseClient();
  if (client) {
    const metadata = args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
      ? (args.metadata as Record<string, unknown>)
      : {};
    const requestedDocuments = Array.isArray(args.requested_documents)
      ? args.requested_documents.filter((doc): doc is string => typeof doc === 'string' && doc.trim().length > 0)
      : [];
    const note = asNonEmptyString(args.note);
    const decisionMetadata = {
      ...metadata,
      ...(requestedDocuments.length ? { requested_documents: requestedDocuments } : {}),
      ...(note ? { note } : {}),
    };
    const body: Record<string, unknown> = {
      request_id: requestId,
      decision,
      metadata: decisionMetadata,
    };
    const reason = asNonEmptyString(args.reason) ?? note ?? asNonEmptyString(metadata.reason);
    if (reason) body.reason = reason;
    const normalizedDecision = normalizeParticipantReviewDecision(decision);
    const inviteRedirectTo =
      asNonEmptyString(args.invite_redirect_to) ??
      (normalizedDecision === 'approved' ? hostedInviteRedirect() : null);
    if (inviteRedirectTo) body.invite_redirect_to = inviteRedirectTo;

    const { data, error } = await client.functions.invoke<Record<string, unknown>>(
      'marketplace-participant-review',
      { body },
    );
    if (error) {
      const errorMessage = await readFunctionErrorMessage(error, 'marketplace participant review failed');
      try {
        return await participantReviewSuccessFromReadback({
          requestId,
          decision,
          metadata,
          recoveredFromFunctionError: true,
          functionErrorMessage: errorMessage,
        });
      } catch {
        throw new Error(errorMessage);
      }
    }
    const { envelope, result, merged } = requireFunctionMutationResult(
      data,
      'marketplace-participant-review',
      [
        'marketplace_participant_request_id',
        'participant_request_id',
        'request_id',
        'id',
        'reviewed_at',
        'decision_log_id',
        'domain_event_id',
        'participant_profile_id',
      ],
    );
    const returnedRequestId =
      asNonEmptyString(merged.marketplace_participant_request_id) ??
      asNonEmptyString(merged.participant_request_id) ??
      asNonEmptyString(merged.request_id) ??
      asNonEmptyString(merged.id);
    if (!returnedRequestId) {
      throw new Error('marketplace-participant-review did not return participant request evidence');
    }
    return participantReviewSuccessFromReadback({
      requestId: returnedRequestId,
      decision,
      metadata,
      merged,
      result,
      envelope,
    });
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('marketplace_participant_request_review_apply_v1');
  await sleep(60);
  return buildEnvelope({
    marketplace_participant_request_id: requestId,
    decision,
  });
}

export async function branch_create_v1(
  args: Record<string, unknown>,
): Promise<BranchMutationResult> {
  const live = await livePArgsMutationResult('branch_create_v1', args, ['branch_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<BranchMutationResult>(
      live,
      ['branch_id', 'id'],
      'branch_id',
      'branch_create_v1 did not return branch_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_id: (args.branch_id as string | undefined) ?? nextResourceId('branch'),
  }) as BranchMutationResult;
}

export async function branch_update_v1(
  args: Record<string, unknown>,
): Promise<BranchMutationResult> {
  const live = await livePArgsMutationResult('branch_update_v1', args, ['branch_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<BranchMutationResult>(
      live,
      ['branch_id', 'id'],
      'branch_id',
      'branch_update_v1 did not return branch_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_id: (args.branch_id as string | undefined) ?? nextResourceId('branch'),
  }) as BranchMutationResult;
}

export async function branch_mark_oos_v1(
  args: Record<string, unknown>,
): Promise<BranchMarkOosResult> {
  // Backend RPC name is `mark_branch_oos_v1`; FE facade keeps the
  // `branch_mark_oos_v1` name to avoid breaking existing call sites.
  const live = await livePArgsMutationResult('mark_branch_oos_v1', args, [
    'branch_ids',
    'branch_id',
    'already_oos',
    'updated_count',
  ]);
  if (live) {
    requireLiveDomainEvidence(
      live,
      'mark_branch_oos_v1',
      ['branch_ids', 'branch_id', 'already_oos'],
      'branch selection',
    );
    const updatedCount = requireLiveNumberField(
      live,
      ['updated_count', 'count', 'affected_count'],
      'mark_branch_oos_v1 did not return updated_count',
    );
    const branchIds = Array.isArray(live.branch_ids)
      ? live.branch_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : asNonEmptyString(live.branch_id)
        ? [asNonEmptyString(live.branch_id)!]
        : [];
    const alreadyOos = Array.isArray(live.already_oos)
      ? live.already_oos.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    return {
      ...live,
      branch_ids: branchIds.length ? branchIds : alreadyOos,
      already_oos: alreadyOos,
      updated_count: updatedCount,
    } as BranchMarkOosResult;
  }
  await sleep(60);
  const ids = Array.isArray(args.branch_ids)
    ? (args.branch_ids as string[])
    : args.branch_id
      ? [args.branch_id as string]
      : [];
  return buildEnvelope({
    branch_ids: ids,
    already_oos: [],
    updated_count: ids.length,
  }) as BranchMarkOosResult;
}

export async function branch_zone_assign_v1(
  args: Record<string, unknown>,
): Promise<BranchZoneMutationResult> {
  const live = await livePArgsMutationResult('branch_zone_assign_v1', args, ['branch_zone_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<BranchZoneMutationResult>(
      live,
      ['branch_zone_id', 'id'],
      'branch_zone_id',
      'branch_zone_assign_v1 did not return branch_zone_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_zone_id: nextResourceId('branch_zone'),
    already_processed: false,
  }) as BranchZoneMutationResult;
}

export async function branch_zone_unassign_v1(
  args: Record<string, unknown>,
): Promise<BranchZoneMutationResult> {
  const live = await livePArgsMutationResult('branch_zone_unassign_v1', args, ['branch_zone_id', 'id']);
  if (live) {
    return withRequiredLiveStringField<BranchZoneMutationResult>(
      live,
      ['branch_zone_id', 'id'],
      'branch_zone_id',
      'branch_zone_unassign_v1 did not return branch_zone_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_zone_id:
      (args.branch_zone_id as string | undefined) ?? nextResourceId('branch_zone'),
    already_processed: false,
  }) as BranchZoneMutationResult;
}

export async function add_branch_member_v1(
  args: Record<string, unknown>,
): Promise<BranchMembershipMutationResult> {
  const live = await livePArgsMutationResult('add_branch_member_v1', args, [
    'branch_membership_id',
    'membership_id',
    'id',
  ]);
  if (live) {
    return withRequiredLiveStringField<BranchMembershipMutationResult>(
      live,
      ['branch_membership_id', 'membership_id', 'id'],
      'branch_membership_id',
      'add_branch_member_v1 did not return branch_membership_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_membership_id: nextResourceId('branch_membership'),
    already_processed: false,
  }) as BranchMembershipMutationResult;
}

export async function remove_branch_member_v1(
  args: Record<string, unknown>,
): Promise<BranchMembershipMutationResult> {
  const live = await livePArgsMutationResult('remove_branch_member_v1', args, [
    'branch_membership_id',
    'membership_id',
    'id',
  ]);
  if (live) {
    return withRequiredLiveStringField<BranchMembershipMutationResult>(
      live,
      ['branch_membership_id', 'membership_id', 'id'],
      'branch_membership_id',
      'remove_branch_member_v1 did not return branch_membership_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_membership_id:
      (args.membership_id as string | undefined) ?? nextResourceId('branch_membership'),
    already_processed: false,
  }) as BranchMembershipMutationResult;
}

export async function branch_capacity_window_set_v1(
  args: Record<string, unknown>,
): Promise<BranchCapacityWindowMutationResult> {
  const live = await livePArgsMutationResult('branch_capacity_window_set_v1', args, [
    'branch_capacity_window_id',
    'capacity_window_id',
    'id',
  ]);
  if (live) {
    return withRequiredLiveStringField<BranchCapacityWindowMutationResult>(
      live,
      ['branch_capacity_window_id', 'capacity_window_id', 'id'],
      'branch_capacity_window_id',
      'branch_capacity_window_set_v1 did not return branch_capacity_window_id',
    );
  }
  await sleep(60);
  return buildEnvelope({
    branch_capacity_window_id:
      (args.capacity_window_id as string | undefined) ?? nextResourceId('branch_capacity_window'),
    already_processed: false,
  }) as BranchCapacityWindowMutationResult;
}

export async function branch_coverage_window_upsert_v1(
  args: Record<string, unknown>,
): Promise<BranchCoverageWindowMutationResult> {
  const live = await livePArgsMutationResult('branch_coverage_window_upsert_v1', args, [
    'branch_coverage_window_id',
    'coverage_window_id',
    'id',
  ]);
  if (live) {
    return withRequiredLiveStringField<BranchCoverageWindowMutationResult>(
      live,
      ['branch_coverage_window_id', 'coverage_window_id', 'id'],
      'branch_coverage_window_id',
      'branch_coverage_window_upsert_v1 did not return branch_coverage_window_id',
    );
  }
  await sleep(60);
  const isUpdate = typeof args.coverage_window_id === 'string' && args.coverage_window_id;
  return buildEnvelope({
    branch_coverage_window_id:
      (args.coverage_window_id as string | undefined) ?? nextResourceId('branch_coverage_window'),
    action: isUpdate ? 'updated' : 'created',
    already_processed: false,
  }) as BranchCoverageWindowMutationResult;
}

// NETWORK/marketplace
//
// Marketplace RPCs predate the shared Phase C6 `(p_args jsonb)` contract and
// expose named Postgres parameters through the api schema. Keep the mapping
// here explicit so live Console V2 calls exercise the real RPC signatures.
async function marketplaceNamedRpc(
  rpcName: string,
  rpcArgs: Record<string, unknown>,
  fallbackArgs: Record<string, unknown>,
  resourceKeyHint?: string,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>(rpcName, rpcArgs);
  if (live) {
    const evidenceKeys = resourceKeyHint ? [`${resourceKeyHint}_id`, 'id', 'refreshed_count'] : ['refreshed_count'];
    const rec = requireLiveMutationResult(
      live.data,
      rpcName,
      evidenceKeys,
    );
    requireLiveDomainEvidence(rec, rpcName, evidenceKeys, resourceKeyHint ?? 'marketplace mutation');
    return rec;
  }
  await sleep(60);
  return buildMutationFallbackEnvelope(fallbackArgs, resourceKeyHint);
}

function metadataWithReason(args: Record<string, unknown>): Record<string, unknown> {
  const metadata = args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
    ? { ...(args.metadata as Record<string, unknown>) }
    : {};
  const reason = asNonEmptyString(args.reason);
  if (reason && metadata.reason === undefined) metadata.reason = reason;
  return metadata;
}

function normalizeMarketplaceAwardDecision(args: Record<string, unknown>): string | null {
  const raw = asNonEmptyString(args.decision) ?? asNonEmptyString(args.response);
  const value = raw?.toLowerCase();
  if (!value) return null;
  if (value === 'accept' || value === 'accepted' || value === 'approve' || value === 'approved') {
    return 'approve';
  }
  if (
    value === 'reject' ||
    value === 'rejected' ||
    value === 'cancel' ||
    value === 'cancelled' ||
    value === 'canceled'
  ) {
    return 'reject';
  }
  return value;
}

export const marketplace_offer_submit_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_offer_submit_v1',
    {
      p_request_id: args.request_id,
      p_message: asNonEmptyString(args.message) ?? null,
      p_terms: args.terms ?? {},
      p_pricing: args.pricing ?? {},
      p_expires_at: args.expires_at ?? null,
      p_metadata: args.metadata ?? {},
    },
    args,
    'marketplace_offer',
  );

export const marketplace_offer_withdraw_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_offer_withdraw_v1',
    {
      p_offer_id: args.offer_id,
      p_reason: asNonEmptyString(args.reason) ?? null,
    },
    args,
    'marketplace_offer',
  );

export const marketplace_award_offer_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_award_offer_v1',
    {
      p_offer_id: args.offer_id,
      p_award_reason: asNonEmptyString(args.award_reason) ?? asNonEmptyString(args.reason) ?? null,
      p_award_terms: args.award_terms ?? {},
      p_expires_at: args.expires_at ?? null,
      p_metadata: args.metadata ?? {},
    },
    args,
    'marketplace_award',
  );

export const marketplace_award_respond_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_award_respond_v1',
    {
      p_award_id: args.award_id,
      p_decision: normalizeMarketplaceAwardDecision(args),
      p_metadata: metadataWithReason(args),
    },
    args,
    'marketplace_award',
  );

export const marketplace_request_create_v1 = (args: Record<string, unknown>) => {
  const details = args.request_details && typeof args.request_details === 'object'
    ? (args.request_details as Record<string, unknown>)
    : {};
  const title =
    asNonEmptyString(args.title) ??
    asNonEmptyString(details.title) ??
    asNonEmptyString(details.lane) ??
    asNonEmptyString(args.request_kind_key) ??
    asNonEmptyString(args.request_kind) ??
    'Marketplace request';
  return marketplaceNamedRpc(
    'marketplace_request_create_v1',
    {
      p_request_kind_key: args.request_kind_key ?? args.request_kind,
      p_title: title,
      p_summary: asNonEmptyString(args.summary) ?? null,
      p_request_details: args.request_details ?? {},
      p_items: args.items ?? args.request_items ?? [],
      p_private_pool: args.private_pool ?? [],
      p_expires_at: args.expires_at ?? null,
      p_metadata: args.metadata ?? {},
    },
    args,
    'marketplace_request',
  );
};

export const marketplace_request_publish_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_request_publish_v1',
    {
      p_request_id: args.request_id,
      p_release_state: asNonEmptyString(args.release_state) ?? null,
    },
    args,
    'marketplace_request',
  );

export const marketplace_request_cancel_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_request_cancel_v1',
    {
      p_request_id: args.request_id,
      p_reason: asNonEmptyString(args.reason) ?? null,
    },
    args,
    'marketplace_request',
  );

export const marketplace_dispute_open_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_dispute_open_v1',
    {
      p_contract_id: args.contract_id ?? null,
      p_work_package_id: args.work_package_id ?? null,
      p_title: asNonEmptyString(args.title) ?? null,
      p_description: asNonEmptyString(args.description) ?? null,
      p_category: asNonEmptyString(args.category) ?? 'general',
      p_metadata: {
        ...metadataWithReason(args),
        ...(args.request_id ? { request_id: args.request_id } : {}),
      },
    },
    args,
    'marketplace_dispute',
  );

export const marketplace_dispute_resolve_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_dispute_resolve_v1',
    {
      p_dispute_id: args.dispute_id,
      p_resolution: args.resolution,
      p_status: asNonEmptyString(args.status) ?? 'resolved',
      p_metadata: args.metadata ?? {},
    },
    args,
    'marketplace_dispute',
  );

export const marketplace_work_package_materialize_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_work_package_materialize_v1',
    {
      p_work_package_id: args.work_package_id ?? null,
      p_award_id: args.award_id ?? null,
      p_execution_ref: args.execution_ref ?? {},
      p_summary: args.summary ?? {},
      p_metadata: args.metadata ?? {},
    },
    args,
    'marketplace_work_package',
  );

export const marketplace_refresh_reputation_snapshot_v1 = (args: Record<string, unknown>) =>
  marketplaceNamedRpc(
    'marketplace_refresh_reputation_snapshots_for_visible_v1',
    {
      p_participant_profile_id: args.participant_profile_id ?? null,
    },
    args,
    'marketplace_reputation_snapshot',
  );
