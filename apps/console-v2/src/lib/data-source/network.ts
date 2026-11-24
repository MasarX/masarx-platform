import {
  type BranchCapacityWindowMutationResult,
  type BranchCoverageWindowMutationResult,
  type BranchMarkOosResult,
  type BranchMembershipMutationResult,
  type BranchMutationResult,
  type BranchZoneMutationResult,
  buildEnvelope,
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
