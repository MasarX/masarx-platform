import {
  assertLiveUserScopeReadback,
  assertReadbackValue,
  buildEnvelope,
  buildTenantSignupReviewSeedResult,
  compactRecord,
  type DataSourceOrganizationProfileUpdateArgs,
  type DataSourceTenantSignupConsoleRequestArgs,
  type DataSourceTenantUserInviteArgs,
  getLookups,
  hasCapability,
  type ListResult,
  liveBackendUnavailableError,
  livePArgsMutationResult,
  liveRpc,
  liveRpcTarget,
  nextResourceId,
  normalizeLiveListResult,
  objectRecord,
  type RbacRoleMutationResult,
  type RbacTemplateProvisionRoleResult,
  type RbacUserRoleAssignmentMutationResult,
  readFunctionErrorMessage,
  readLiveResourceListReadback,
  requireFunctionMutationResult,
  requireLiveDomainEvidence,
  requireLiveEvidence,
  requireLiveMutationResult,
  requireLiveResourceListReadback,
  requireLiveResourceReadback,
  requireLiveStringField,
  requireLiveUserLifecycleReadback,
  RESOURCE_DATA,
  seed,
  sleep,
  state,
  TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS,
  TENANT_SIGNUP_REVIEW_READBACK_DELAY_MS,
  type UserDeviceRevokeResult,
  type UserSecurityActionRow,
  type UserSessionRow,
  withRequiredLiveStringField,
} from '../data-source';
import { hostedInviteRedirect } from '../hosted-redirect';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { getSupabaseClient } from '../supabase';
import {
  asNonEmptyString,
  type ResourceRow,
} from './shared';

export async function rbac_create_role_v1(
  args: Record<string, unknown>,
): Promise<RbacRoleMutationResult> {
  const live = await livePArgsMutationResult('rbac_create_role_v1', args, ['rbac_role_id', 'role_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<RbacRoleMutationResult>(
      live,
      ['rbac_role_id', 'role_id', 'id'],
      'rbac_role_id',
      'rbac_create_role_v1 did not return rbac_role_id',
    );
    const idempotent = live.idempotent_no_op === true || asNonEmptyString(live.action) === 'noop';
    await requireLiveRbacRoleReadback('rbac_create_role_v1', result.rbac_role_id, {
      args,
      assertMutableFields: !idempotent,
    });
    return result;
  }
  await sleep(60);
  return buildEnvelope({
    rbac_role_id: (args.role_id as string | undefined) ?? nextResourceId('rbac_role'),
    action: 'created',
    idempotent_no_op: false,
  }) as RbacRoleMutationResult;
}

export async function rbac_update_role_v1(
  args: Record<string, unknown>,
): Promise<RbacRoleMutationResult> {
  const live = await livePArgsMutationResult('rbac_update_role_v1', args, ['rbac_role_id', 'role_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<RbacRoleMutationResult>(
      live,
      ['rbac_role_id', 'role_id', 'id'],
      'rbac_role_id',
      'rbac_update_role_v1 did not return rbac_role_id',
    );
    await requireLiveRbacRoleReadback('rbac_update_role_v1', result.rbac_role_id, {
      args,
      assertMutableFields: true,
    });
    return result;
  }
  await sleep(60);
  return buildEnvelope({
    rbac_role_id: (args.role_id as string | undefined) ?? nextResourceId('rbac_role'),
    action: 'updated',
  }) as RbacRoleMutationResult;
}

export async function rbac_delete_role_v1(
  args: Record<string, unknown>,
): Promise<RbacRoleMutationResult> {
  const live = await livePArgsMutationResult('rbac_delete_role_v1', args, ['rbac_role_id', 'role_id', 'id']);
  if (live) {
    const result = withRequiredLiveStringField<RbacRoleMutationResult>(
      live,
      ['rbac_role_id', 'role_id', 'id'],
      'rbac_role_id',
      'rbac_delete_role_v1 did not return rbac_role_id',
    );
    await requireLiveRbacRoleReadback('rbac_delete_role_v1', result.rbac_role_id, {
      args,
      requireInactive: true,
      requireAssignmentsRevoked: Number(live.assignments_revoked ?? 0) > 0,
    });
    return result;
  }
  await sleep(60);
  return buildEnvelope({
    rbac_role_id: (args.role_id as string | undefined) ?? nextResourceId('rbac_role'),
    action: 'deleted',
    idempotent_no_op: false,
    assignments_revoked: 0,
  }) as RbacRoleMutationResult;
}

export async function rbac_grant_role_v1(
  args: Record<string, unknown>,
): Promise<RbacUserRoleAssignmentMutationResult> {
  const live = await livePArgsMutationResult('rbac_grant_role_v1', args, [
    'rbac_user_role_assignment_id',
    'assignment_id',
    'id',
  ]);
  if (live) {
    const result = withRequiredLiveStringField<RbacUserRoleAssignmentMutationResult>(
      live,
      ['rbac_user_role_assignment_id', 'assignment_id', 'id'],
      'rbac_user_role_assignment_id',
      'rbac_grant_role_v1 did not return role assignment evidence',
    );
    await requireLiveRbacAssignmentReadback('rbac_grant_role_v1', {
      assignmentId: result.rbac_user_role_assignment_id,
      targetUserId: asNonEmptyString(args.user_id) ?? asNonEmptyString(args.target_user_id),
      roleId: asNonEmptyString(args.role_id),
      expectedStatus: 'active',
    });
    return result;
  }
  await sleep(60);
  return buildEnvelope({
    rbac_user_role_assignment_id: nextResourceId('rbac_user_role_assignment'),
    action: 'granted',
    idempotent_no_op: false,
  }) as RbacUserRoleAssignmentMutationResult;
}

export async function rbac_revoke_role_v1(
  args: Record<string, unknown>,
): Promise<RbacUserRoleAssignmentMutationResult> {
  const live = await livePArgsMutationResult('rbac_revoke_role_v1', args, [
    'rbac_user_role_assignment_id',
    'assignment_id',
    'id',
    'target_user_id',
    'role_id',
    'role_key',
    'action',
  ]);
  if (live) {
    requireLiveDomainEvidence(
      live,
      'rbac_revoke_role_v1',
      ['rbac_user_role_assignment_id', 'assignment_id', 'id', 'target_user_id', 'role_id', 'role_key', 'action'],
      'role assignment',
    );
    const assignmentId =
      asNonEmptyString(live.rbac_user_role_assignment_id) ??
      asNonEmptyString(live.assignment_id) ??
      asNonEmptyString(live.id);
    const result = {
      ...live,
      rbac_user_role_assignment_id: assignmentId ?? null,
    } as RbacUserRoleAssignmentMutationResult;
    await requireLiveRbacAssignmentReadback('rbac_revoke_role_v1', {
      assignmentId,
      targetUserId:
        asNonEmptyString(live.target_user_id) ??
        asNonEmptyString(args.target_user_id) ??
        asNonEmptyString(args.user_id),
      roleId: asNonEmptyString(live.role_id) ?? asNonEmptyString(args.role_id),
      expectedStatus: 'revoked',
    });
    return result;
  }
  await sleep(60);
  return buildEnvelope({
    rbac_user_role_assignment_id:
      (args.assignment_id as string | undefined) ?? nextResourceId('rbac_user_role_assignment'),
    action: 'revoked',
    idempotent_no_op: false,
  }) as RbacUserRoleAssignmentMutationResult;
}

async function requireLiveTenantSignupRequestReadback(
  rpcName: string,
  requestId: string,
): Promise<{ request: Record<string, unknown>; summary: Record<string, unknown> }> {
  const request = await requireLiveResourceReadback('tenant_signup_requests', requestId, rpcName);
  const summary = await requireLiveResourceReadback('tenant_signup_request_summary', requestId, rpcName);
  return { request, summary };
}

function tenantSignupReviewReadbackStates(
  request: Record<string, unknown>,
  summary: Record<string, unknown>,
): string[] {
  return [
    asNonEmptyString(request.review_decision),
    asNonEmptyString(request.status),
    asNonEmptyString(summary.review_decision),
    asNonEmptyString(summary.status),
  ].map((value) => value?.toLowerCase()).filter((value): value is string => Boolean(value));
}

async function requireLiveResourceReadbackEventually(
  resourceKey: string,
  id: string,
  rpcName: string,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS; attempt += 1) {
    try {
      return await requireLiveResourceReadback(resourceKey, id, rpcName);
    } catch (err) {
      lastError = err;
      if (attempt < TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS) {
        await sleep(TENANT_SIGNUP_REVIEW_READBACK_DELAY_MS);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${rpcName} backend readback missing ${resourceKey}:${id}`);
}

async function requireLiveTenantSignupReviewReadback(
  rpcName: string,
  requestId: string,
  decision: string,
  merged: Record<string, unknown>,
): Promise<{ request: Record<string, unknown>; summary: Record<string, unknown> }> {
  const expectedDecision = decision.toLowerCase();
  let latest: { request: Record<string, unknown>; summary: Record<string, unknown> } | null = null;
  let observedRequestState: string[] = [];
  for (let attempt = 1; attempt <= TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS; attempt += 1) {
    latest = await requireLiveTenantSignupRequestReadback(rpcName, requestId);
    observedRequestState = tenantSignupReviewReadbackStates(latest.request, latest.summary);
    if (observedRequestState.includes(expectedDecision)) break;
    if (attempt < TENANT_SIGNUP_REVIEW_READBACK_ATTEMPTS) {
      await sleep(TENANT_SIGNUP_REVIEW_READBACK_DELAY_MS);
    }
  }
  if (!latest || !observedRequestState.includes(expectedDecision)) {
    const observed = observedRequestState.length ? observedRequestState.join(', ') : 'none';
    throw new Error(`${rpcName} backend readback did not reflect ${expectedDecision} decision (observed: ${observed})`);
  }
  const { request, summary } = latest;

  if (expectedDecision !== 'approved') return { request, summary };

  const organizationId =
    asNonEmptyString(merged.approved_organization_id) ??
    asNonEmptyString(merged.organization_id) ??
    asNonEmptyString(request.approved_organization_id) ??
    asNonEmptyString(summary.approved_organization_id);
  const userId =
    asNonEmptyString(merged.approved_user_id) ??
    asNonEmptyString(merged.user_id) ??
    asNonEmptyString(request.approved_user_id) ??
    asNonEmptyString(summary.approved_user_id);
  if (!organizationId) throw new Error(`${rpcName} approval readback missing approved organization`);
  if (!userId) throw new Error(`${rpcName} approval readback missing approved user`);

  await requireLiveResourceReadbackEventually('organizations', organizationId, rpcName);
  await requireLiveResourceReadbackEventually('users', userId, rpcName);
  await requireLiveResourceReadbackEventually('user_directory', userId, rpcName);
  return { request, summary };
}

export async function tenant_signup_review_apply_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId =
    asNonEmptyString(args.request_id) ??
    asNonEmptyString(args.tenant_signup_request_id) ??
    asNonEmptyString(args.id);
  const decision = asNonEmptyString(args.decision)?.toLowerCase() ?? null;
  if (!requestId) throw new Error('tenant_signup_request_id is required');
  if (!decision) throw new Error('decision is required');

  const client = getSupabaseClient();
  if (client) {
    const metadata =
      args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
        ? (args.metadata as Record<string, unknown>)
        : args.decision_metadata && typeof args.decision_metadata === 'object' && !Array.isArray(args.decision_metadata)
          ? (args.decision_metadata as Record<string, unknown>)
          : undefined;
    const body: Record<string, unknown> = {
      request_id: requestId,
      decision,
    };
    const reason = asNonEmptyString(args.reason) ?? asNonEmptyString(args.decision_reason);
    if (reason) body.reason = reason;
    const inviteRedirectTo = asNonEmptyString(args.invite_redirect_to) ?? hostedInviteRedirect();
    if (inviteRedirectTo) body.invite_redirect_to = inviteRedirectTo;
    if (metadata) body.metadata = metadata;

    const invokeResult = await client.functions.invoke<Record<string, unknown>>(
      'tenant-signup-review',
      { body },
    );
    const { data, error } = invokeResult ?? {};
    if (error) {
      throw new Error(await readFunctionErrorMessage(error, 'tenant signup review failed'));
    }

    const { envelope, result, merged } = requireFunctionMutationResult(
      data,
      'tenant-signup-review',
      [
        'id',
        'status',
        'tenant_signup_request_id',
        'request_id',
        'reviewed_at',
        'organization_id',
        'approved_organization_id',
        'user_id',
        'approved_user_id',
        'invite_id',
        'invite_email_sent_at',
      ],
      { allowedBusinessStatuses: ['rejected'] },
    );
    const alreadyProcessed = Boolean(merged.already_processed ?? result.already_processed);
    const returnedRequestId =
      asNonEmptyString(merged.tenant_signup_request_id) ??
      asNonEmptyString(merged.request_id) ??
      asNonEmptyString(merged.id);
    if (!returnedRequestId) throw new Error('tenant-signup-review did not return request evidence');
    const returnedDecision =
      asNonEmptyString(alreadyProcessed ? result.review_decision : null) ??
      asNonEmptyString(alreadyProcessed ? result.status : null) ??
      asNonEmptyString(alreadyProcessed ? merged.review_decision : null) ??
      asNonEmptyString(alreadyProcessed ? merged.status : null) ??
      asNonEmptyString(merged.decision) ??
      asNonEmptyString(merged.review_decision) ??
      asNonEmptyString(merged.status);
    if (!returnedDecision) throw new Error('tenant-signup-review did not return decision status');
    const reviewReadback = await requireLiveTenantSignupReviewReadback(
      'tenant-signup-review',
      returnedRequestId,
      returnedDecision,
      merged,
    );
    const readback = { ...reviewReadback.request, ...reviewReadback.summary };
    if (returnedDecision.toLowerCase() === 'approved') {
      requireLiveEvidence(
        { ...merged, ...readback },
        [
          'organization_id',
          'approved_organization_id',
          'user_id',
          'approved_user_id',
          'approved_auth_user_id',
          'invite_id',
          'invite_email_sent_at',
        ],
        'tenant-signup-review approval did not return provisioning or invite evidence',
      );
    }
    const status =
      asNonEmptyString(readback.status) ??
      asNonEmptyString(merged.status) ??
      returnedDecision;
    const reviewDecision =
      asNonEmptyString(readback.review_decision) ??
      asNonEmptyString(merged.review_decision) ??
      returnedDecision;
    const approvedOrganizationId =
      asNonEmptyString(merged.approved_organization_id) ??
      asNonEmptyString(merged.organization_id) ??
      asNonEmptyString(merged.tenant_id) ??
      asNonEmptyString(readback.approved_organization_id) ??
      null;
    const approvedUserId =
      asNonEmptyString(merged.approved_user_id) ??
      asNonEmptyString(merged.user_id) ??
      asNonEmptyString(readback.approved_user_id) ??
      null;
    const approvedAuthUserId =
      asNonEmptyString(merged.approved_auth_user_id) ??
      asNonEmptyString(merged.invited_auth_user_id) ??
      asNonEmptyString(readback.approved_auth_user_id) ??
      null;
    const inviteEmailSentAt =
      asNonEmptyString(merged.invite_email_sent_at) ??
      asNonEmptyString(readback.invite_email_sent_at) ??
      null;
    const readbackInviteRedirectTo =
      asNonEmptyString(merged.invite_redirect_to) ??
      asNonEmptyString(readback.invite_redirect_to) ??
      null;
    return {
      ...readback,
      ...result,
      ...envelope,
      ok: true,
      tenant_signup_request_id: returnedRequestId,
      request_id: returnedRequestId,
      id: returnedRequestId,
      decision: reviewDecision,
      status,
      review_decision: reviewDecision,
      approved_organization_id: approvedOrganizationId,
      approved_user_id: approvedUserId,
      approved_auth_user_id: approvedAuthUserId,
      invite_email_sent_at: inviteEmailSentAt,
      invite_redirect_to: readbackInviteRedirectTo,
    };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('tenant_signup_review_apply_v1');
  await sleep(60);
  return buildEnvelope(buildTenantSignupReviewSeedResult(requestId, decision));
}

export async function tenant_signup_console_request_v1(
  args: DataSourceTenantSignupConsoleRequestArgs,
): Promise<Record<string, unknown>> {
  const email = asNonEmptyString(args.email)?.toLowerCase();
  const fullName = asNonEmptyString(args.full_name);
  const organizationName = asNonEmptyString(args.organization_name);
  if (!email) throw new Error('email is required');
  if (!fullName) throw new Error('full_name is required');
  if (!organizationName) throw new Error('organization_name is required');

  const body = {
    ...args,
    email,
    full_name: fullName,
    organization_name: organizationName,
  };

  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<Record<string, unknown>>(
      'tenant-signup-console-request',
      { body },
    );
    if (error) {
      throw new Error(await readFunctionErrorMessage(error, 'tenant signup console request failed'));
    }
    const { envelope, result, merged } = requireFunctionMutationResult(
      data,
      'tenant-signup-console-request',
      ['tenant_signup_request_id', 'request_id', 'id', 'status'],
    );
    const requestId =
      asNonEmptyString(merged.tenant_signup_request_id) ??
      asNonEmptyString(merged.request_id) ??
      asNonEmptyString(merged.id);
    if (!requestId) throw new Error('tenant-signup-console-request did not return request id');
    const status = requireLiveStringField(
      merged,
      ['status'],
      'tenant-signup-console-request did not return status',
    );
    const requestReadback = await requireLiveTenantSignupRequestReadback(
      'tenant-signup-console-request',
      requestId,
    );
    const readback = { ...requestReadback.summary, ...requestReadback.request };
    const readbackStatus = asNonEmptyString(readback.status) ?? status;
    return {
      ...result,
      ...envelope,
      ...readback,
      ok: true,
      tenant_signup_request_id: requestId,
      request_id: requestId,
      id: requestId,
      status: readbackStatus,
    };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('tenant_signup_console_request_v1');
  await sleep(60);
  const requests = (seed as { tenant_signup_requests?: Array<Record<string, unknown>> }).tenant_signup_requests ?? [];
  const requestId = `tsr_console_${Date.now()}`;
  const now = new Date().toISOString();
  const row = {
    id: requestId,
    email,
    full_name: fullName,
    organization_name: organizationName,
    organization_slug: asNonEmptyString(args.organization_slug) ?? null,
    website_url: asNonEmptyString(args.website_url) ?? null,
    phone: asNonEmptyString(args.phone) ?? null,
    notes: asNonEmptyString(args.notes) ?? null,
    locale: asNonEmptyString(args.locale) ?? 'en',
    status: 'pending',
    org_name: organizationName,
    industry: 'console',
    size: 'pending',
    received_at: now,
    created_at: now,
    updated_at: now,
    turnstile_verified: true,
    marketing: { source: 'console-v2' },
    metadata: { created_via: 'tenant-signup-console-request' },
  };
  requests.unshift(row);
  return buildEnvelope({
    id: requestId,
    tenant_signup_request_id: requestId,
    status: 'pending',
  });
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergePlainObjects(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') continue;
    const previous = next[key];
    if (
      previous &&
      typeof previous === 'object' &&
      !Array.isArray(previous) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      next[key] = mergePlainObjects(previous as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function assertReadbackContainsPatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  path: string,
  rpcName: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) continue;
    const nextPath = `${path}.${key}`;
    const actualValue = actual[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      assertReadbackContainsPatch(objectRecord(actualValue), value as Record<string, unknown>, nextPath, rpcName);
    } else {
      assertReadbackValue(actualValue, value, nextPath, rpcName);
    }
  }
}

function requireOrganizationProfileReadback(
  args: DataSourceOrganizationProfileUpdateArgs,
  merged: Record<string, unknown>,
  readback: Record<string, unknown>,
  rpcName: string,
): void {
  for (const key of ['name', 'timezone', 'locale']) {
    const expected = asNonEmptyString(args[key]);
    if (expected) assertReadbackValue(readback[key], expected, key, rpcName);
  }

  const expectedBranding = compactRecord({
    logo_url: asNonEmptyString(args.logo_url) ?? undefined,
    logo_file_name: asNonEmptyString(args.file_name) ?? asNonEmptyString(args.logo_file_name) ?? undefined,
    logo_content_type: asNonEmptyString(args.content_type) ?? asNonEmptyString(args.logo_content_type) ?? undefined,
    primary_color: asNonEmptyString(args.primary_color) ?? undefined,
    secondary_color: asNonEmptyString(args.secondary_color) ?? undefined,
    logo_storage_bucket: asNonEmptyString(args.logo_storage_bucket) ?? undefined,
    logo_storage_key: asNonEmptyString(args.logo_storage_key) ?? undefined,
    logo_artifact_id: asNonEmptyString(args.logo_artifact_id) ?? undefined,
    ...objectRecord(merged.branding),
  });
  const expectedSettingsPatch = plainObject(args.default_settings_patch);
  if (Object.keys(expectedBranding).length === 0 && Object.keys(expectedSettingsPatch).length === 0) return;

  const settings = objectRecord(readback.default_settings);
  if (Object.keys(settings).length === 0) {
    throw new Error(`${rpcName} backend readback missing organizations.default_settings`);
  }
  if (Object.keys(expectedBranding).length > 0) {
    assertReadbackContainsPatch(objectRecord(settings.branding), expectedBranding, 'default_settings.branding', rpcName);
  }
  if (Object.keys(expectedSettingsPatch).length > 0) {
    assertReadbackContainsPatch(settings, expectedSettingsPatch, 'default_settings', rpcName);
  }
}

export async function ui_update_organization_profile_v1(
  args: DataSourceOrganizationProfileUpdateArgs,
): Promise<Record<string, unknown>> {
  const organizationId = asNonEmptyString(args.organization_id);
  if (!organizationId) throw new Error('organization_id is required');

  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<Record<string, unknown>>(
      'organization-profile',
      { body: args },
    );
    if (error) {
      throw new Error(await readFunctionErrorMessage(error, 'organization profile update failed'));
    }
    const { envelope, result, merged } = requireFunctionMutationResult(
      data,
      'organization-profile',
      [
        'updated_at',
        'branding',
        'profile',
        'changed',
        'changed_fields',
        'default_settings',
        'settings_resolution_id',
      ],
    );
    const returnedOrganizationId =
      asNonEmptyString(merged.organization_id) ??
      asNonEmptyString(merged.id);
    if (!returnedOrganizationId) throw new Error('organization-profile did not return organization_id');
    const readback = await requireLiveResourceReadback('organizations', returnedOrganizationId, 'organization-profile');
    requireOrganizationProfileReadback(args, merged, readback, 'organization-profile');
    return { ...result, ...envelope, ok: true, organization_id: returnedOrganizationId, readback };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('ui_update_organization_profile_v1');
  await sleep(60);
  const organizations = (seed as { organizations?: Array<Record<string, unknown>> }).organizations ?? [];
  const target = organizations.find((row) => row.id === organizationId);
  if (target) {
    const existingSettings = plainObject(target.default_settings);
    const existingBranding = plainObject(existingSettings.branding);
    const brandingPatch = {
      logo_url: asNonEmptyString(args.logo_url) ?? undefined,
      logo_file_name: asNonEmptyString(args.file_name) ?? asNonEmptyString(args.logo_file_name),
      logo_content_type: asNonEmptyString(args.content_type) ?? asNonEmptyString(args.logo_content_type),
      primary_color: asNonEmptyString(args.primary_color) ?? undefined,
      secondary_color: asNonEmptyString(args.secondary_color) ?? undefined,
    };
    if (asNonEmptyString(args.name)) target.name = asNonEmptyString(args.name)!;
    if (asNonEmptyString(args.timezone)) target.timezone = asNonEmptyString(args.timezone)!;
    if (asNonEmptyString(args.locale)) target.locale = asNonEmptyString(args.locale)!;
    target.default_settings = mergePlainObjects(existingSettings, {
      branding: mergePlainObjects(existingBranding, brandingPatch),
      ...plainObject(args.default_settings_patch),
    });
  }

  return buildEnvelope({
    organization_id: organizationId,
    name: target?.name ?? args.name,
    branding: plainObject(plainObject(target?.default_settings).branding),
  });
}

export async function ui_list_tenant_invitable_roles_v1(
  args: { organization_id?: string | null } = {},
): Promise<ListResult<ResourceRow>> {
  const organizationId =
    asNonEmptyString(args.organization_id) ??
    asNonEmptyString(state.user.organization_id) ??
    asNonEmptyString((state.scope?.tenant as Record<string, unknown> | undefined)?.id);
  if (!organizationId) throw new Error('organization_id is required');

  const live = await liveRpc('ui_list_tenant_invitable_roles_v1', {
    p_organization_id: organizationId,
  });
  if (live) return normalizeLiveListResult<ResourceRow>(live.data, 0, 200);

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC ui_list_tenant_invitable_roles_v1');
  await sleep(30);
  if (!hasCapability('users.manage')) {
    const err = new Error('Capability denied: users.manage') as Error & {
      code?: string;
      capability?: string;
    };
    err.code = 'capability_denied';
    err.capability = 'users.manage';
    throw err;
  }
  const rows = (RESOURCE_DATA().rbac_role_summary ?? [])
    .filter((row) => {
      const rec = row as Record<string, unknown>;
      return rec.organization_id === organizationId && rec.is_active !== false;
    })
    .map((row) => {
      const rec = row as Record<string, unknown>;
      return {
        id: rec.id,
        role_id: rec.id,
        organization_id: rec.organization_id,
        role_key: rec.key ?? rec.role_key,
        key: rec.key ?? rec.role_key,
        name: rec.name ?? rec.key ?? rec.role_key,
        description: rec.description ?? null,
        is_active: rec.is_active !== false,
      } as ResourceRow;
    })
    .sort((a, b) => String(a.role_key ?? a.key ?? '').localeCompare(String(b.role_key ?? b.key ?? '')));

  return {
    rows,
    total: rows.length,
    page: 0,
    page_size: rows.length || 200,
  };
}

export async function tenant_user_invite_v1(
  args: DataSourceTenantUserInviteArgs,
): Promise<Record<string, unknown>> {
  const email = asNonEmptyString(args.email)?.toLowerCase();
  const fullName = asNonEmptyString(args.full_name);
  const roleKey = asNonEmptyString(args.role_key)?.toLowerCase();
  if (!email) throw new Error('email is required');
  if (!fullName) throw new Error('full_name is required');
  if (!roleKey) throw new Error('role_key is required');

  const client = getSupabaseClient();
  if (client) {
    const shouldSendInviteEmail = args.send_invite_email !== false;
    const redirect = shouldSendInviteEmail
      ? asNonEmptyString(args.invite_redirect_to) ?? hostedInviteRedirect()
      : null;
    const body = {
      ...args,
      email,
      full_name: fullName,
      role_key: roleKey,
      send_invite_email: shouldSendInviteEmail,
      invite_redirect_to: redirect,
    };
    const { data, error } = await client.functions.invoke<Record<string, unknown>>(
      'tenant-user-invite',
      { body },
    );
    if (error) {
      throw new Error(await readFunctionErrorMessage(error, 'tenant user invite failed'));
    }
    const { envelope, result, merged } = requireFunctionMutationResult(
      data,
      'tenant-user-invite',
      ['user_id', 'auth_user_id', 'id', 'invite_id', 'invite_email_sent_at'],
    );
    const returnedUserId =
      asNonEmptyString(merged.user_id) ??
      asNonEmptyString(merged.auth_user_id) ??
      asNonEmptyString(merged.id);
    if (!returnedUserId) throw new Error('tenant-user-invite did not return user evidence');
    const assignmentId =
      asNonEmptyString(merged.rbac_user_role_assignment_id) ??
      asNonEmptyString(merged.user_role_assignment_id) ??
      asNonEmptyString(merged.assignment_id);
    const lifecycleReadback = await requireLiveUserLifecycleReadback('tenant-user-invite', returnedUserId);
    assertLiveUserScopeReadback(
      'tenant-user-invite',
      lifecycleReadback,
      asNonEmptyString(args.access_scope_type) ?? 'tenant',
      asNonEmptyString(args.access_scope_id),
    );
    await requireLiveUserRoleAssignmentReadback(
      'tenant-user-invite',
      returnedUserId,
      roleKey,
      assignmentId,
      lifecycleReadback.directory,
    );
    await requireLiveUserSecurityActionReadback(
      'tenant-user-invite',
      returnedUserId,
      'tenant_user_invite_apply_v1',
      merged,
      null,
      {
        roleKey,
        assignmentId,
        inviteEmail: email,
        inviteEmailSent: merged.invite_email_sent === true || merged.invite_email_sent === 'true',
        sendInviteEmailRequested: shouldSendInviteEmail,
        inviteRedirectTo: redirect,
      },
    );
    return {
      ...result,
      ...envelope,
      ok: true,
      user_id: returnedUserId,
      email: asNonEmptyString(merged.email) ?? email,
      role_key: asNonEmptyString(merged.role_key) ?? roleKey,
    };
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('tenant_user_invite_v1');
  await sleep(60);
  const users = (seed as { users?: Array<Record<string, unknown>> }).users ?? [];
  const organizationId =
    asNonEmptyString(args.organization_id) ??
    asNonEmptyString(state.user.organization_id) ??
    asNonEmptyString((state.scope?.tenant as Record<string, unknown> | undefined)?.id);
  if (!organizationId) throw new Error('organization_id is required');
  const userId = `usr_invited_${email.replace(/[^a-z0-9]+/g, '_')}`;
  const accessScopeType = asNonEmptyString(args.access_scope_type) ?? 'tenant';
  const userTypeRows = getLookups('user_type');
  const requestedUserType = asNonEmptyString(args.user_type);
  const userType =
    requestedUserType ??
    (userTypeRows.some((row) => row.value === roleKey)
      ? roleKey
      : userTypeRows.find((row) => row.is_default)?.value ?? userTypeRows[0]?.value ?? 'ops_admin');
  const accessScopeId =
    accessScopeType === 'client' || accessScopeType === 'sender'
      ? asNonEmptyString(args.access_scope_id)
      : null;
  const existing = users.find((row) => String(row.email ?? '').toLowerCase() === email);
  if (existing) {
    existing.full_name = fullName;
    existing.user_type = userType;
    existing.status = existing.status === 'suspended' ? existing.status : 'invited';
    existing.access_scope_type = accessScopeType;
    existing.access_scope_id = accessScopeId;
  } else {
    users.push({
      id: userId,
      organization_id: organizationId,
      email,
      full_name: fullName,
      user_type: userType,
      access_scope_type: accessScopeType,
      access_scope_id: accessScopeId,
      status: 'invited',
      last_login_at: null,
      created_at: new Date().toISOString(),
    });
  }

  return buildEnvelope({
    user_id: existing?.id ?? userId,
    organization_id: organizationId,
    email,
    full_name: fullName,
    role_key: roleKey,
    status: 'invited',
    invite_email_sent: false,
  });
}

export async function public_tracking_review_request_v1(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const target = liveRpcTarget();
  if (target) {
    const { data, error } = await target.rpc('public_tracking_review_request_v1', { p_input: args });
    if (error) throw new Error(error.message);
    return requireLiveMutationResult(data, 'public_tracking_review_request_v1', [
      'support_case_id',
      'outcome',
    ]);
  }
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC public_tracking_review_request_v1');
  await sleep(60);
  const decision = String(args.decision ?? '').toLowerCase();
  const outcome = decision.startsWith('reject') ? 'rejected' : 'applied';
  return buildEnvelope({
    support_case_id: args.support_case_id,
    outcome,
  });
}

export async function ui_execute_user_device_revoke_v1(
  deviceId: string,
  revokedReason: string,
): Promise<UserDeviceRevokeResult> {
  const id = asNonEmptyString(deviceId);
  const reason = asNonEmptyString(revokedReason);
  if (!id) throw new Error('ui_execute_user_device_revoke_v1 requires device_id');
  if (!reason) throw new Error('ui_execute_user_device_revoke_v1 requires revoked_reason');

  const live = await liveRpc<Record<string, unknown>>('ui_execute_user_device_revoke_v1', {
    p_action_key: 'user_devices.revoke',
    p_resource_key: 'user_devices',
    p_selection_ids: [id],
    p_selection_id: id,
    p_selection_count: 1,
    p_params: { revoked_reason: reason },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_user_device_revoke_v1', [
      'device_id',
      'revoked_at',
      'items',
      'count',
    ]);
    const items = Array.isArray(rec.items) ? (rec.items as Array<Record<string, unknown>>) : [];
    const first = items[0] ?? {};
    const readback = await requireLiveUserDeviceRevokeReadback(
      'ui_execute_user_device_revoke_v1',
      id,
      reason,
    );
    const revokedAt = requireLiveStringField(
      {
        ...readback.device,
        ...readback.summary,
        ...rec,
        revoked_at:
          first.revoked_at ??
          rec.revoked_at ??
          readback.summary.revoked_at ??
          readback.device.revoked_at,
      },
      ['revoked_at'],
      'ui_execute_user_device_revoke_v1 did not return backend revocation evidence',
    );
    return {
      ok: true,
      status: String(rec.status ?? first.status ?? 'revoked'),
      device_id: String(first.id ?? rec.device_id ?? id),
      revoked_at: revokedAt,
      action_key: String(rec.action_key ?? 'user_devices.revoke'),
      resource_key: String(rec.resource_key ?? 'user_devices'),
      count: Number(rec.count ?? items.length ?? 1),
      items,
      ...rec,
    };
  }

  await sleep(80);
  const revokedAt = new Date().toISOString();
  return {
    ok: true,
    status: 'revoked',
    device_id: id,
    revoked_at: revokedAt,
    action_key: 'user_devices.revoke',
    resource_key: 'user_devices',
    count: 1,
    items: [{ id, status: 'revoked', revoked_at: revokedAt }],
  };
}

export async function ui_list_user_sessions_v1(
  targetUserId?: string | null,
  limit = 50,
): Promise<ListResult<UserSessionRow>> {
  const pageSize = Math.max(1, Math.min(limit, 100));
  const live = await liveRpc<Record<string, unknown>>('ui_list_user_sessions_v1', {
    p_target_user_id: targetUserId ?? null,
    p_limit: pageSize,
  });
  if (live) return normalizeLiveListResult<UserSessionRow>(live.data, 0, pageSize);

  const rows = ((seed as { user_sessions?: Array<UserSessionRow> }).user_sessions ?? [])
    .filter((row) => !targetUserId || row.user_id === targetUserId)
    .slice()
    .sort((a, b) => {
      const aTime = Date.parse(String(a.updated_at ?? a.last_seen_at ?? a.created_at ?? ''));
      const bTime = Date.parse(String(b.updated_at ?? b.last_seen_at ?? b.created_at ?? ''));
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    })
    .slice(0, pageSize);
  return { rows, total: rows.length, page: 0, page_size: pageSize };
}

export async function ui_list_user_security_actions_v1(
  targetUserId: string,
  limit = 10,
): Promise<ListResult<UserSecurityActionRow>> {
  if (!targetUserId) {
    return { rows: [], total: 0, page: 0, page_size: limit };
  }
  const live = await liveRpc<Record<string, unknown>>('ui_list_user_security_actions_v1', {
    p_target_user_id: targetUserId,
    p_limit: limit,
  });
  if (live) return normalizeLiveListResult<UserSecurityActionRow>(live.data, 0, limit);

  const rows = ((seed.decision_log ?? []) as UserSecurityActionRow[])
    .filter((row) => row.resource_type === 'user' && String(row.resource_id ?? '') === targetUserId)
    .filter((row) =>
      [
        'grant_user_role_v1',
        'revoke_user_role_v1',
        'revoke_session_v1',
        'suspend_user_v1',
        'reactivate_user_v1',
        'force_password_reset_v1',
        'tenant_user_invite_apply_v1',
      ].includes(String(row.decision_point ?? '')),
    )
    .slice()
    .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))
    .slice(0, limit);
  return { rows, total: rows.length, page: 0, page_size: limit };
}

async function requireLiveUserDeviceRevokeReadback(
  rpcName: string,
  deviceId: string,
  revokedReason?: string | null,
): Promise<{
  device: Record<string, unknown>;
  summary: Record<string, unknown>;
}> {
  const device = await requireLiveResourceReadback('user_devices', deviceId, rpcName);
  const summary = await requireLiveResourceReadback('user_device_summary', deviceId, rpcName);
  const readbacks = [device, summary];
  for (const row of readbacks) {
    const revokedAt = asNonEmptyString(row.revoked_at);
    const isRevoked = row.is_revoked === true || Boolean(revokedAt);
    if (!isRevoked) {
      throw new Error(`${rpcName} backend readback device ${deviceId} is not revoked`);
    }
  }
  const expectedReason = asNonEmptyString(revokedReason);
  if (expectedReason) {
    const readbackReason = asNonEmptyString(summary.revoked_reason) ?? asNonEmptyString(device.revoked_reason);
    if (readbackReason !== expectedReason) {
      throw new Error(`${rpcName} backend readback missing device revocation reason`);
    }
  }
  return { device, summary };
}

export async function requireLiveUserSecurityActionReadback(
  rpcName: string,
  targetUserId: string,
  decisionPoint: string,
  result: Record<string, unknown>,
  actionReason: string | null | undefined,
  expected?: {
    roleKey?: string | null;
    assignmentId?: string | null;
    inviteEmail?: string | null;
    inviteEmailSent?: boolean | null;
    sendInviteEmailRequested?: boolean | null;
    inviteRedirectTo?: string | null;
  },
): Promise<Record<string, unknown>> {
  const expectedIntentId = asNonEmptyString(result.password_reset_intent_id);
  const expectedDecisionId = asNonEmptyString(result.settings_resolution_id);
  const expectedCorrelationId = asNonEmptyString(result.correlation_id);
  const expectedRoleKey = asNonEmptyString(expected?.roleKey);
  const expectedAssignmentId = asNonEmptyString(expected?.assignmentId);
  const expectedInviteEmail = asNonEmptyString(expected?.inviteEmail)?.toLowerCase();
  const expectedInviteEmailSent = expected?.inviteEmailSent;
  const expectedSendInviteEmailRequested = expected?.sendInviteEmailRequested;
  const expectedInviteRedirectTo = expected?.inviteRedirectTo;
  const inviteRedirectMatchesReadback = (readbackValue: string | null | undefined) => {
    if (expectedInviteRedirectTo === undefined) return true;
    if (expectedInviteRedirectTo === null) return readbackValue == null;
    if (readbackValue === expectedInviteRedirectTo) return true;
    const normalizeRootUrl = (value: string | null | undefined) => {
      const raw = asNonEmptyString(value);
      if (!raw) return null;
      try {
        const parsed = new URL(raw);
        if (parsed.pathname === '/' && !parsed.search && !parsed.hash) return parsed.origin;
      } catch {
        return raw;
      }
      return raw;
    };
    return normalizeRootUrl(readbackValue) === normalizeRootUrl(expectedInviteRedirectTo);
  };
  const hasOwn = (record: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(record, key);
  const boolMatches = (value: unknown, expectedValue: boolean | null | undefined) => {
    if (expectedValue == null) return true;
    if (typeof value === 'boolean') return value === expectedValue;
    const raw = asNonEmptyString(value)?.toLowerCase();
    if (raw === 'true' || raw === 't' || raw === '1' || raw === 'yes') return expectedValue === true;
    if (raw === 'false' || raw === 'f' || raw === '0' || raw === 'no') return expectedValue === false;
    return false;
  };
  let match: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const live = await liveRpc<Record<string, unknown>>('ui_list_user_security_actions_v1', {
      p_target_user_id: targetUserId,
      p_limit: 5,
    });
    if (!live) throw new Error(`${rpcName} user security action readback requires a live backend`);
    const rows = normalizeLiveListResult<Record<string, unknown>>(live.data, 0, 5).rows;
    match = rows.find((row) => {
      const inputs = objectRecord(row.decision_inputs);
      const intentId =
        asNonEmptyString(row.password_reset_intent_id) ??
        asNonEmptyString(inputs.password_reset_intent_id);
      const targetMatches =
        asNonEmptyString(row.resource_id) === targetUserId ||
        asNonEmptyString(inputs.target_user_id) === targetUserId;
      const pointMatches = asNonEmptyString(row.decision_point) === decisionPoint;
      const intentMatches = !expectedIntentId || intentId === expectedIntentId;
      const decisionMatches = !expectedDecisionId || asNonEmptyString(row.id) === expectedDecisionId;
      const correlationMatches = !expectedCorrelationId || asNonEmptyString(row.correlation_id) === expectedCorrelationId;
      const roleKey =
        asNonEmptyString(row.role_key) ??
        asNonEmptyString(inputs.role_key);
      const readbackAssignmentId =
        asNonEmptyString(inputs.rbac_user_role_assignment_id) ??
        asNonEmptyString(inputs.user_role_assignment_id) ??
        asNonEmptyString(inputs.assignment_id);
      const resourceType = asNonEmptyString(row.resource_type);
      const resourceId = asNonEmptyString(row.resource_id);
      const rowCarriesAssignmentResource =
        resourceType === 'rbac_user_role_assignment' ||
        resourceType === 'user_role_assignment' ||
        resourceType === 'role_assignment';
      const assignmentMatches =
        !expectedAssignmentId ||
        readbackAssignmentId === expectedAssignmentId ||
        (rowCarriesAssignmentResource && resourceId === expectedAssignmentId) ||
        (!readbackAssignmentId && !rowCarriesAssignmentResource);
      const roleMatches = !expectedRoleKey || roleKey === expectedRoleKey;
      const inviteEmail =
        asNonEmptyString(row.invite_email)?.toLowerCase() ??
        asNonEmptyString(inputs.email)?.toLowerCase();
      const inviteEmailMatches = !expectedInviteEmail || inviteEmail === expectedInviteEmail;
      const inviteEmailSentMatches = boolMatches(
        row.invite_email_sent ?? inputs.invite_email_sent,
        expectedInviteEmailSent,
      );
      const sendInviteEmailMatches = boolMatches(
        row.send_invite_email_requested ?? inputs.send_invite_email_requested,
        expectedSendInviteEmailRequested,
      );
      const readbackRedirect =
        asNonEmptyString(row.invite_redirect_to) ??
        asNonEmptyString(inputs.invite_redirect_to);
      const inviteRedirectRecorded =
        hasOwn(inputs, 'invite_redirect_to') ||
        asNonEmptyString(row.invite_redirect_to) != null;
      const inviteRedirectMatches =
        expectedInviteRedirectTo === undefined ||
        (expectedInviteRedirectTo === null
          ? inviteRedirectRecorded && readbackRedirect == null
          : inviteRedirectMatchesReadback(readbackRedirect));
      return targetMatches &&
        pointMatches &&
        intentMatches &&
        decisionMatches &&
        correlationMatches &&
        assignmentMatches &&
        roleMatches &&
        inviteEmailMatches &&
        inviteEmailSentMatches &&
        sendInviteEmailMatches &&
        inviteRedirectMatches;
    });
    if (match) break;
    if (attempt < 4) await sleep(300);
  }
  if (!match) {
    throw new Error(`${rpcName} backend readback missing user security action`);
  }
  const expectedReason = asNonEmptyString(actionReason);
  if (expectedReason) {
    const inputs = objectRecord(match.decision_inputs);
    const readbackReason =
      asNonEmptyString(match.action_reason) ??
      asNonEmptyString(match.decision_reason) ??
      asNonEmptyString(inputs.reason);
    if (readbackReason !== expectedReason) {
      throw new Error(`${rpcName} backend readback missing persisted action reason`);
    }
  }
  return match;
}

export async function requireLiveUserRoleAssignmentReadback(
  rpcName: string,
  targetUserId: string,
  roleKey?: string | null,
  assignmentId?: string | null,
  directory?: Record<string, unknown> | null,
  expectedStatus: 'active' | 'revoked' = 'active',
): Promise<void> {
  const normalizedRoleKey = asNonEmptyString(roleKey);
  await requireLiveRbacAssignmentReadback(rpcName, {
    assignmentId,
    targetUserId,
    roleKey: normalizedRoleKey,
    expectedStatus,
  });
  if (normalizedRoleKey && directory) {
    const activeRoleKeys = Array.isArray(directory.active_role_keys)
      ? directory.active_role_keys.map((value) => String(value))
      : [];
    if (expectedStatus === 'active' && activeRoleKeys.length > 0 && !activeRoleKeys.includes(normalizedRoleKey)) {
      throw new Error(`${rpcName} backend readback missing active role ${normalizedRoleKey}`);
    }
    if (expectedStatus === 'revoked' && activeRoleKeys.includes(normalizedRoleKey)) {
      throw new Error(`${rpcName} backend readback still has active role ${normalizedRoleKey}`);
    }
  }
}

async function requireLiveRbacRoleReadback(
  rpcName: string,
  roleId: string,
  options: {
    args?: Record<string, unknown>;
    assertMutableFields?: boolean;
    requireInactive?: boolean;
    requireAssignmentsRevoked?: boolean;
  } = {},
): Promise<{
  role: Record<string, unknown>;
  summary: Record<string, unknown>;
}> {
  const role = await requireLiveResourceReadback('rbac_roles', roleId, rpcName);
  const summary = await requireLiveResourceReadback('rbac_role_summary', roleId, rpcName);
  const args = options.args ?? {};
  const expectedOrganizationId = asNonEmptyString(args.organization_id);
  if (expectedOrganizationId) assertReadbackValue(role.organization_id, expectedOrganizationId, 'rbac_roles.organization_id', rpcName);

  const expectedKey = asNonEmptyString(args.key);
  if (expectedKey) assertReadbackValue(role.key, expectedKey, 'rbac_roles.key', rpcName);

  if (options.assertMutableFields) {
    const expectedName = asNonEmptyString(args.name);
    if (expectedName) assertReadbackValue(role.name, expectedName, 'rbac_roles.name', rpcName);
    if (Object.prototype.hasOwnProperty.call(args, 'description')) {
      assertReadbackValue(
        role.description ?? null,
        asNonEmptyString(args.description),
        'rbac_roles.description',
        rpcName,
      );
    }
    if (Object.prototype.hasOwnProperty.call(args, 'is_active')) {
      assertReadbackValue(Boolean(role.is_active), Boolean(args.is_active), 'rbac_roles.is_active', rpcName);
    }
  }

  if (options.requireInactive) {
    if (role.is_active !== false || summary.is_active !== false) {
      throw new Error(`${rpcName} backend readback role ${roleId} is still active`);
    }
  }

  if (options.requireAssignmentsRevoked) {
    const assignments = await readLiveResourceListReadback('rbac_user_role_assignments', { role_id: roleId }, rpcName);
    const active = assignments.filter((row) => !asNonEmptyString(row.revoked_at));
    if (active.length > 0) {
      throw new Error(`${rpcName} backend readback role ${roleId} still has active assignments`);
    }
  }

  return { role, summary };
}

async function requireLiveRbacAssignmentReadback(
  rpcName: string,
  {
    assignmentId,
    targetUserId,
    roleId,
    roleKey,
    expectedStatus,
  }: {
    assignmentId?: string | null;
    targetUserId?: string | null;
    roleId?: string | null;
    roleKey?: string | null;
    expectedStatus?: 'active' | 'revoked';
  },
): Promise<void> {
  const normalizedAssignmentId = asNonEmptyString(assignmentId);
  const normalizedTargetUserId = asNonEmptyString(targetUserId);
  const normalizedRoleId = asNonEmptyString(roleId);
  const normalizedRoleKey = asNonEmptyString(roleKey);
  let assignmentRows: Array<Record<string, unknown>> = [];
  if (normalizedAssignmentId) {
    assignmentRows = [
      await requireLiveResourceReadback('rbac_user_role_assignments', normalizedAssignmentId, rpcName),
    ];
  } else if (normalizedTargetUserId) {
    assignmentRows = await readLiveResourceListReadback(
      'rbac_user_role_assignments',
      { user_id: normalizedTargetUserId },
      rpcName,
    );
  } else {
    throw new Error(`${rpcName} backend readback missing rbac assignment target`);
  }

  const scopedRows = assignmentRows.filter((row) => {
    const roleIdMatches = !normalizedRoleId || asNonEmptyString(row.role_id) === normalizedRoleId;
    const roleKeyMatches = !normalizedRoleKey || asNonEmptyString(row.role_key) === normalizedRoleKey;
    return roleIdMatches && roleKeyMatches;
  });

  if (expectedStatus === 'active') {
    const active = scopedRows.find((row) => !asNonEmptyString(row.revoked_at));
    if (!active) {
      throw new Error(`${rpcName} backend readback missing active rbac assignment`);
    }
  } else if (expectedStatus === 'revoked') {
    const active = scopedRows.find((row) => !asNonEmptyString(row.revoked_at));
    if (active) {
      throw new Error(`${rpcName} backend readback assignment ${active.id ?? normalizedAssignmentId ?? normalizedTargetUserId} is still active`);
    }
  } else if (scopedRows.length === 0) {
    throw new Error(`${rpcName} backend readback missing rbac assignment`);
  }

  for (const row of scopedRows) {
    if (normalizedTargetUserId) assertReadbackValue(row.user_id, normalizedTargetUserId, 'rbac_user_role_assignments.user_id', rpcName);
    if (normalizedRoleId) assertReadbackValue(row.role_id, normalizedRoleId, 'rbac_user_role_assignments.role_id', rpcName);
    if (normalizedRoleKey) assertReadbackValue(row.role_key, normalizedRoleKey, 'rbac_user_role_assignments.role_key', rpcName);
  }

  const readbackRoleId =
    assignmentRows
      .map((row) => asNonEmptyString(row.role_id) ?? asNonEmptyString(row.rbac_role_id))
      .find(Boolean) ?? normalizedRoleId ?? null;
  if (readbackRoleId) {
    await requireLiveRbacRoleReadback(rpcName, readbackRoleId);
  }
}

function normalizeRbacTemplateProvisionRoles(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): RbacTemplateProvisionRoleResult[] {
  const rows = Array.isArray(rec.rbac_roles)
    ? (rec.rbac_roles as RbacTemplateProvisionRoleResult[])
    : [];
  if (rows.length > 0) return rows;
  const roleId =
    asNonEmptyString(rec.rbac_role_id) ??
    asNonEmptyString(rec.role_id) ??
    asNonEmptyString(rec.id);
  if (!roleId) return [];
  const templateKey =
    asNonEmptyString(args.template_key) ??
    (Array.isArray(args.template_keys)
      ? args.template_keys.map(asNonEmptyString).find(Boolean)
      : null);
  return [{ role_id: roleId, template_key: templateKey ?? null }];
}

function normalizeRbacPermissionValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => Boolean(item))
    .map((item) => item.trim())
    .sort((a, b) => a.localeCompare(b));
}

async function requireLiveRbacTemplatePermissionReadback(
  rpcName: string,
  templateKey: string,
  roleSummary: Record<string, unknown>,
): Promise<void> {
  const templateRows = await requireLiveResourceListReadback(
    'rbac_role_templates',
    { key: templateKey },
    rpcName,
  );
  const template = templateRows.find((row) => asNonEmptyString(row.key) === templateKey);
  if (!template) {
    throw new Error(`${rpcName} backend readback missing rbac_role_templates:${templateKey}`);
  }

  const expectedValues = normalizeRbacPermissionValues(template.permission_values);
  const actualValues = normalizeRbacPermissionValues(roleSummary.permission_values);
  const expectedCount =
    typeof template.permission_count === 'number'
      ? template.permission_count
      : expectedValues.length;
  const actualCount =
    typeof roleSummary.permission_count === 'number'
      ? roleSummary.permission_count
      : actualValues.length;
  if (expectedCount > 0 && actualCount < expectedCount) {
    throw new Error(`${rpcName} backend readback role ${templateKey} has fewer permissions than its template`);
  }
  if (expectedValues.length > 0) {
    const actualSet = new Set(actualValues);
    const missing = expectedValues.filter((permission) => !actualSet.has(permission));
    if (missing.length > 0) {
      throw new Error(`${rpcName} backend readback role ${templateKey} missing template permissions: ${missing.join(', ')}`);
    }
  }
}

export async function requireLiveRbacTemplateProvisionReadback(
  rpcName: string,
  result: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<void> {
  const roles = normalizeRbacTemplateProvisionRoles(result, args);
  if (roles.length === 0) {
    throw new Error(`${rpcName} did not return provisioned RBAC role evidence`);
  }

  for (const provisioned of roles) {
    const roleId =
      asNonEmptyString(provisioned.role_id) ??
      asNonEmptyString(provisioned.rbac_role_id);
    if (!roleId) {
      throw new Error(`${rpcName} did not return provisioned RBAC role id`);
    }
    const { role, summary } = await requireLiveRbacRoleReadback(rpcName, roleId);
    const templateKey = asNonEmptyString(provisioned.template_key);
    if (templateKey) {
      const roleKey = asNonEmptyString(role.key) ?? asNonEmptyString(summary.key);
      if (roleKey !== templateKey) {
        throw new Error(`${rpcName} backend readback role ${roleId} did not match template ${templateKey}`);
      }
      await requireLiveRbacTemplatePermissionReadback(rpcName, templateKey, summary);
    }
  }
}
