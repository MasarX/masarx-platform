const { randomUUID } = require('crypto');

const {
  createApprovalWorkflowLifecycleHelpers,
  createDbHarness,
} = require('../helpers/approval-workflow-lifecycle');
const {
  createClient: createTenantClient,
  createOrganization,
  createUser,
} = require('../helpers/tenant-utils');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const { pool } = createDbHarness({
  connectionString: DATABASE_URL,
  max: 4,
});
const EFFECT_CAPABILITY_KEY = 'manual_review.read';
const EFFECT_NAVIGATION_ITEM_ID = 'portal-approvals';
const EFFECT_NAVIGATION_LABEL = 'Approvals';

function buildAccessPolicyWithRequesterEffect({ requesterUserId, includeEffect }) {
  const requesterRole = 'e2e_access_policy_requester';
  const effectRole = 'e2e_manual_review_reader';
  return {
    version: 1,
    capabilities: [
      { key: 'access_policy.read', label: 'Access policy read' },
      { key: 'access_policy.request', label: 'Access policy request change' },
      { key: EFFECT_CAPABILITY_KEY, label: 'Manual review read' },
    ],
    roles: [
      {
        key: requesterRole,
        label: 'E2E access policy requester',
        capability_keys: ['access_policy.read', 'access_policy.request'],
      },
      {
        key: effectRole,
        label: 'E2E manual review reader',
        capability_keys: [EFFECT_CAPABILITY_KEY],
      },
    ],
    assignments: {
      user_id: {
        [requesterUserId]: includeEffect
          ? [requesterRole, effectRole]
          : [requesterRole],
      },
    },
    resource_map: {
      manual_review_tasks: {
        read: EFFECT_CAPABILITY_KEY,
        write: 'manual_review.resolve',
      },
    },
    denies: [],
  };
}

function findNavigationItem(payload, itemId) {
  const sections = Array.isArray(payload?.sections) ? payload.sections : [];
  const stack = [...sections];

  while (stack.length > 0) {
    const entry = stack.shift();
    if (!entry || typeof entry !== 'object') continue;
    if (entry.id === itemId) return entry;
    if (Array.isArray(entry.items)) stack.push(...entry.items);
  }

  return null;
}

async function readRequesterRuntimeEffect({
  dbClient,
  workflowHelpers,
  organizationId,
  requesterUserId,
  scopeType,
  scopeId,
}) {
  await workflowHelpers.setTenantAuthContext(organizationId, requesterUserId);
  const {
    rows: [row],
  } = await dbClient.query(
    `
      SELECT
        public.user_capability_eval_v1($1::text, $2::text, $3::uuid) AS eval,
        public.ui_navigation_v1('portal') AS navigation
    `,
    [EFFECT_CAPABILITY_KEY, scopeType, scopeId],
  );
  const navigationItem = findNavigationItem(row.navigation, EFFECT_NAVIGATION_ITEM_ID);
  return {
    capabilityAllowed: row.eval?.allowed === true,
    capabilityReason: row.eval?.reason ?? null,
    grantedCapabilities: Array.isArray(row.eval?.granted_capabilities)
      ? row.eval.granted_capabilities
      : [],
    roleKeys: Array.isArray(row.eval?.role_keys) ? row.eval.role_keys : [],
    navigationDisabledReason: navigationItem?.disabled_reason ?? null,
    navigationHref: navigationItem?.href ?? null,
    navigationItemFound: Boolean(navigationItem),
    navigationLabel: navigationItem?.label ?? null,
  };
}

function expectRequesterRuntimeEffect(snapshot, expectedAllowed) {
  expect(snapshot.navigationItemFound).toBe(true);
  expect(snapshot.navigationLabel).toBe(EFFECT_NAVIGATION_LABEL);
  expect(snapshot.navigationHref).toBe('/portal/resources/manual_review_tasks');
  expect(snapshot.capabilityAllowed).toBe(expectedAllowed);

  if (expectedAllowed) {
    expect(snapshot.capabilityReason).toBe('allowed');
    expect(snapshot.grantedCapabilities).toContain(EFFECT_CAPABILITY_KEY);
    expect(snapshot.roleKeys).toContain('e2e_manual_review_reader');
    expect(snapshot.navigationDisabledReason).toBeNull();
    return;
  }

  expect(snapshot.capabilityReason).toBe('missing_capability');
  expect(snapshot.grantedCapabilities).not.toContain(EFFECT_CAPABILITY_KEY);
  expect(snapshot.roleKeys).not.toContain('e2e_manual_review_reader');
  expect(snapshot.navigationDisabledReason).toBe('missing_capability');
}

async function readManualReviewResolveDecisionCount(client, reviewTaskId) {
  const {
    rows: [countRow],
  } = await client.query(
    `
      SELECT COUNT(*)::int AS count
      FROM public.decision_log
      WHERE resource_type = 'manual_review_task'
        AND resource_id = $1::uuid
        AND decision_point = 'resolve_task'
    `,
    [reviewTaskId],
  );
  return countRow?.count ?? 0;
}

async function readAccessPolicyLifecycleTrace(client, {
  settingsVersionId,
  domainEventId,
  workflowRunId,
  reviewTaskId,
}) {
  const {
    rows: [trace],
  } = await client.query(
    `
      SELECT
        sv.id::text AS settings_version_id,
        sv.category AS settings_category,
        sv.scope_type AS settings_scope_type,
        sv.scope_hash::text AS settings_scope_id,
        de.id::text AS domain_event_id,
        de.organization_id::text AS domain_event_organization_id,
        de.event_type AS domain_event_type,
        de.resource_type AS domain_event_resource_type,
        de.resource_id::text AS domain_event_resource_id,
        de.workflow_run_id::text AS domain_event_workflow_run_id,
        wr.id::text AS workflow_run_id,
        wr.workflow_status AS workflow_run_status,
        mrt.id::text AS manual_review_task_id,
        mrt.resource_type AS manual_review_resource_type,
        mrt.resource_id::text AS manual_review_resource_id,
        mrt.status AS manual_review_status,
        mrt.resolution_outcome AS manual_review_resolution_outcome,
        mrt.metadata->>'workflow_run_id' AS manual_review_workflow_run_id
      FROM public.settings_versions sv
      JOIN public.domain_events de ON de.id = $2::uuid
      JOIN public.workflow_runs wr ON wr.id = $3::uuid
      JOIN public.manual_review_tasks mrt ON mrt.id = $4::uuid
      WHERE sv.id = $1::uuid
      LIMIT 1
    `,
    [settingsVersionId, domainEventId, workflowRunId, reviewTaskId],
  );

  return trace ?? null;
}

function expectAccessPolicyLifecycleTrace(trace, {
  settingsVersionId,
  domainEventId,
  workflowRunId,
  reviewTaskId,
  organizationId,
  scopeType,
  scopeId,
  workflowStatus,
  manualReviewStatus,
  manualReviewResolutionOutcome = null,
}) {
  expect(trace).toMatchObject({
    settings_version_id: settingsVersionId,
    settings_category: 'access_control_policy',
    settings_scope_type: scopeType,
    settings_scope_id: scopeId,
    domain_event_id: domainEventId,
    domain_event_organization_id: organizationId,
    domain_event_type: 'settings_change.requested',
    domain_event_resource_type: 'settings_version',
    domain_event_resource_id: settingsVersionId,
    domain_event_workflow_run_id: workflowRunId,
    workflow_run_id: workflowRunId,
    workflow_run_status: workflowStatus,
    manual_review_task_id: reviewTaskId,
    manual_review_resource_type: 'settings_version',
    manual_review_resource_id: settingsVersionId,
    manual_review_status: manualReviewStatus,
    manual_review_resolution_outcome: manualReviewResolutionOutcome,
    manual_review_workflow_run_id: workflowRunId,
  });
}

describe('access policy approval workflow lifecycle', () => {
  let client;
  let helpers;

  beforeAll(async () => {
    if (!pool) throw new Error('DATABASE_URL is required for approval integration tests');
    client = await pool.connect();
    helpers = createApprovalWorkflowLifecycleHelpers(client);
  });

  afterAll(async () => {
    if (client) {
      client.release();
    }
    await pool?.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  test('ui_request_access_policy_change_v1 runs through manual approval and applies the approved policy row', async () => {
    const organization = await createOrganization(client, 'Access Policy Approval Org');
    const requesterUserId = await createUser(
      client,
      organization.id,
      `access-policy-requester-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const reviewerUserId = await createUser(
      client,
      organization.id,
      `access-policy-reviewer-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const replayReviewerUserId = await createUser(
      client,
      organization.id,
      `access-policy-replay-reviewer-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const outsideOrganization = await createOrganization(client, 'Access Policy Outside Org');
    const outsideReviewerUserId = await createUser(
      client,
      outsideOrganization.id,
      `access-policy-outside-reviewer-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );

    await helpers.setTenantAuthContext(organization.id, requesterUserId);

    const {
      rows: [policyRow],
    } = await client.query(
      `
        SELECT public.ui_access_policy_v1($1::text, $2::uuid) AS payload
      `,
      ['tenant', organization.id],
    );

    expect(policyRow.payload?.policy).toBeTruthy();
    const requestedPolicy = {
      ...(policyRow.payload?.policy &&
      typeof policyRow.payload.policy === 'object' &&
      !Array.isArray(policyRow.payload.policy)
        ? policyRow.payload.policy
        : {}),
      integration_test_marker: {
        source: 'access-policy-approval-lifecycle',
        run_id: randomUUID(),
      },
    };

    const request = await helpers.prepareSettingsApprovalRequest({
      category: 'access_control_policy',
      scopeType: 'tenant',
      scopeId: organization.id,
      baselineValue: policyRow.payload.policy,
      organizationId: organization.id,
      requesterUserId,
      requestSql: `
        SELECT settings_version_id, domain_event_id
        FROM public.ui_request_access_policy_change_v1(
          p_value := $1::jsonb,
          p_scope_type := $2::text,
          p_scope_id := $3::uuid,
          p_change_reason := $4::text,
          p_effective_from := now()
        )
      `,
      requestParams: [
        JSON.stringify(requestedPolicy),
        'tenant',
        organization.id,
        'Access policy request approval lifecycle test',
      ],
    });

    await helpers.setTenantAuthContext(outsideOrganization.id, outsideReviewerUserId);
    await client.query('SAVEPOINT access_policy_cross_tenant_review_denial');
    let crossTenantError = null;
    try {
      await client.query(
        `SELECT public.resolve_manual_review_task_v1($1::uuid, $2::text, $3::text)`,
        [
          request.reviewTask.id,
          'approved',
          'Cross-tenant access policy review attempt should be denied',
        ],
      );
    } catch (error) {
      crossTenantError = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT access_policy_cross_tenant_review_denial');
    await client.query('RELEASE SAVEPOINT access_policy_cross_tenant_review_denial');
    expect(String(crossTenantError?.message || crossTenantError)).toMatch(
      /outside current tenant scope|requires manual_review\.resolve/,
    );

    const terminalRun = await helpers.resolveApprovalWorkflow({
      organizationId: organization.id,
      reviewerUserId,
      reviewTaskId: request.reviewTask.id,
      workflowRunId: request.domainEvent.workflowRunId,
      resolutionOutcome: 'approved',
      resolutionNotes: 'Approved during workflow lifecycle integration test',
    });

    expect(terminalRun.status).toBe('completed');

    await helpers.setServiceContext(organization.id, reviewerUserId);

    const settingsVersionRow = await helpers.readSettingsVersion(request.requestRow.settings_version_id);
    expect(settingsVersionRow.category).toBe('access_control_policy');
    expect(settingsVersionRow.approved_by).toBe(reviewerUserId);
    expect(settingsVersionRow.approved_at).not.toBeNull();

    const settingsProjectionVersionId = await helpers.readSettingsProjectionVersion(
      'access_control_policy',
      'tenant',
      organization.id,
    );
    expect(settingsProjectionVersionId).toBe(request.requestRow.settings_version_id);

    const resolvedPolicy = await helpers.readResolvedSetting(
      'access_control_policy',
      'tenant',
      organization.id,
    );
    expect(resolvedPolicy.integration_test_marker).toMatchObject(
      requestedPolicy.integration_test_marker,
    );

    const resolvedTaskBeforeReplay = await helpers.readManualReviewTask(request.reviewTask.id);
    const decisionLogCountBeforeReplay = await readManualReviewResolveDecisionCount(
      client,
      request.reviewTask.id,
    );
    expect(resolvedTaskBeforeReplay).toMatchObject({
      status: 'resolved',
      resolution_outcome: 'approved',
      resolved_by: reviewerUserId,
    });
    expect(decisionLogCountBeforeReplay).toBe(1);

    await helpers.setTenantAuthContext(organization.id, replayReviewerUserId);
    await client.query(
      `SELECT public.resolve_manual_review_task_v1($1::uuid, $2::text, $3::text)`,
      [
        request.reviewTask.id,
        'rejected',
        'Rejected replay should not replace approved access policy review',
      ],
    );
    await helpers.setServiceContext(organization.id, replayReviewerUserId);

    const resolvedTaskAfterReplay = await helpers.readManualReviewTask(request.reviewTask.id);
    expect(resolvedTaskAfterReplay).toMatchObject({
      status: 'resolved',
      resolution_outcome: resolvedTaskBeforeReplay.resolution_outcome,
      resolved_by: resolvedTaskBeforeReplay.resolved_by,
    });

    const settingsVersionAfterReplay = await helpers.readSettingsVersion(
      request.requestRow.settings_version_id,
    );
    expect(settingsVersionAfterReplay.approved_by).toBe(settingsVersionRow.approved_by);

    const settingsProjectionVersionAfterReplay = await helpers.readSettingsProjectionVersion(
      'access_control_policy',
      'tenant',
      organization.id,
    );
    expect(settingsProjectionVersionAfterReplay).toBe(settingsProjectionVersionId);
    await expect(
      readManualReviewResolveDecisionCount(client, request.reviewTask.id),
    ).resolves.toBe(decisionLogCountBeforeReplay);
  });

  test('ui_request_access_policy_change_v1 rejection preserves the prior policy and fails the workflow', async () => {
    const organization = await createOrganization(client, 'Access Policy Rejection Org');
    const requesterUserId = await createUser(
      client,
      organization.id,
      `access-policy-reject-requester-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const reviewerUserId = await createUser(
      client,
      organization.id,
      `access-policy-reject-reviewer-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );

    await helpers.setTenantAuthContext(organization.id, requesterUserId);

    const {
      rows: [policyRow],
    } = await client.query(
      `
        SELECT public.ui_access_policy_v1($1::text, $2::uuid) AS payload
      `,
      ['tenant', organization.id],
    );

    expect(policyRow.payload?.policy).toBeTruthy();
    const requestedPolicy = {
      ...(policyRow.payload?.policy &&
      typeof policyRow.payload.policy === 'object' &&
      !Array.isArray(policyRow.payload.policy)
        ? policyRow.payload.policy
        : {}),
      integration_test_marker: {
        source: 'access-policy-approval-lifecycle',
        run_id: randomUUID(),
      },
    };
    const rejectionReason = 'Rejected access policy workflow lifecycle test';

    const request = await helpers.prepareSettingsApprovalRequest({
      category: 'access_control_policy',
      scopeType: 'tenant',
      scopeId: organization.id,
      baselineValue: policyRow.payload.policy,
      organizationId: organization.id,
      requesterUserId,
      requestSql: `
        SELECT settings_version_id, domain_event_id
        FROM public.ui_request_access_policy_change_v1(
          p_value := $1::jsonb,
          p_scope_type := $2::text,
          p_scope_id := $3::uuid,
          p_change_reason := $4::text,
          p_effective_from := now()
        )
      `,
      requestParams: [
        JSON.stringify(requestedPolicy),
        'tenant',
        organization.id,
        'Access policy rejection lifecycle test',
      ],
    });

    const terminalRun = await helpers.resolveApprovalWorkflow({
      organizationId: organization.id,
      reviewerUserId,
      reviewTaskId: request.reviewTask.id,
      workflowRunId: request.domainEvent.workflowRunId,
      resolutionOutcome: 'rejected',
      resolutionNotes: rejectionReason,
    });

    expect(terminalRun.status).toBe('failed');
    expect(terminalRun.failureReason).toBe(rejectionReason);

    await helpers.setServiceContext(organization.id, reviewerUserId);

    const settingsVersionRow = await helpers.readSettingsVersion(request.requestRow.settings_version_id);
    expect(settingsVersionRow.category).toBe('access_control_policy');
    expect(settingsVersionRow.approved_by).toBeNull();
    expect(settingsVersionRow.approved_at).toBeNull();

    const resolvedTask = await helpers.readManualReviewTask(request.reviewTask.id);
    expect(resolvedTask).toMatchObject({
      status: 'resolved',
      resolution_outcome: 'rejected',
      resolution_notes: rejectionReason,
      resolved_by: reviewerUserId,
    });
    expect(resolvedTask.resolved_at).not.toBeNull();

    const settingsProjectionVersionId = await helpers.readSettingsProjectionVersion(
      'access_control_policy',
      'tenant',
      organization.id,
    );
    expect(settingsProjectionVersionId).toBe(request.baselineVersionId);

    const resolvedPolicy = await helpers.readResolvedSetting(
      'access_control_policy',
      'tenant',
      organization.id,
    );
    expect(resolvedPolicy.integration_test_marker).toBeUndefined();
  });

  test('ui_request_access_policy_change_v1 denies users without access_policy.request capability and creates no draft row', async () => {
    const organization = await createOrganization(client, 'Access Policy Capability Deny Org');
    const requesterUserId = await createUser(
      client,
      organization.id,
      `access-policy-client-admin-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'client_admin', accessScopeType: 'tenant' },
    );

    await helpers.setTenantAuthContext(organization.id, requesterUserId);

    const {
      rows: [capabilityEvalRow],
    } = await client.query(
      `
        SELECT public.user_capability_eval_v1($1::text, $2::text, $3::uuid) AS eval
      `,
      ['access_policy.request', 'tenant', organization.id],
    );

    expect(capabilityEvalRow.eval.allowed).toBe(false);
    expect(capabilityEvalRow.eval.reason).toBe('missing_capability');

    await helpers.setServiceContext(organization.id, requesterUserId);

    const {
      rows: [beforeCountRow],
    } = await client.query(
      `
        SELECT COUNT(*)::int AS count
        FROM public.settings_versions
        WHERE category = 'access_control_policy'
          AND scope_type = 'tenant'
          AND scope_hash = $1::uuid
      `,
      [organization.id],
    );

    const deniedPolicy = {
      version: 1,
      denied_request_marker: randomUUID(),
    };

    await helpers.setTenantAuthContext(organization.id, requesterUserId);

    await client.query('SAVEPOINT access_policy_capability_deny');
    try {
      await client.query(
        `
          SELECT settings_version_id, domain_event_id
          FROM public.ui_request_access_policy_change_v1(
            p_value := $1::jsonb,
            p_scope_type := $2::text,
            p_scope_id := $3::uuid,
            p_change_reason := $4::text,
            p_effective_from := now()
          )
        `,
        [
          JSON.stringify(deniedPolicy),
          'tenant',
          organization.id,
          'Access policy capability deny lifecycle test',
        ],
      );
      throw new Error('Expected access policy capability denial');
    } catch (error) {
      expect(String(error?.message || error)).toMatch(/Capability denied: access_policy.request/i);
      await client.query('ROLLBACK TO SAVEPOINT access_policy_capability_deny');
    } finally {
      await client.query('RELEASE SAVEPOINT access_policy_capability_deny');
    }

    await helpers.setServiceContext(organization.id, requesterUserId);

    const {
      rows: [afterCountRow],
    } = await client.query(
      `
        SELECT COUNT(*)::int AS count
        FROM public.settings_versions
        WHERE category = 'access_control_policy'
          AND scope_type = 'tenant'
          AND scope_hash = $1::uuid
      `,
      [organization.id],
    );

    expect(afterCountRow.count).toBe(beforeCountRow.count);
  });

  test('approved access policy request changes requester capability and portal navigation effect', async () => {
    const organization = await createOrganization(client, 'Access Policy Visible Effect Org');
    const clientAccount = await createTenantClient(
      client,
      organization.id,
      'Access Policy Visible Effect Client',
    );
    const requesterUserId = await createUser(
      client,
      organization.id,
      `access-policy-effect-requester-${randomUUID().slice(0, 8)}@example.test`,
      {
        userType: 'client_admin',
        accessScopeType: 'client',
        accessScopeId: clientAccount.id,
      },
    );
    const reviewerUserId = await createUser(
      client,
      organization.id,
      `access-policy-effect-reviewer-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const baselinePolicy = buildAccessPolicyWithRequesterEffect({
      requesterUserId,
      includeEffect: false,
    });
    const requestedPolicy = buildAccessPolicyWithRequesterEffect({
      requesterUserId,
      includeEffect: true,
    });

    const request = await helpers.prepareSettingsApprovalRequest({
      category: 'access_control_policy',
      scopeType: 'client',
      scopeId: clientAccount.id,
      baselineValue: baselinePolicy,
      organizationId: organization.id,
      requesterUserId,
      requestSql: `
        SELECT settings_version_id, domain_event_id
        FROM public.ui_request_access_policy_change_v1(
          p_value := $1::jsonb,
          p_scope_type := $2::text,
          p_scope_id := $3::uuid,
          p_change_reason := $4::text,
          p_effective_from := now()
        )
      `,
      requestParams: [
        JSON.stringify(requestedPolicy),
        'client',
        clientAccount.id,
        'Access policy visible capability effect approval test',
      ],
    });

    expectRequesterRuntimeEffect(
      await readRequesterRuntimeEffect({
        dbClient: client,
        workflowHelpers: helpers,
        organizationId: organization.id,
        requesterUserId,
        scopeType: 'client',
        scopeId: clientAccount.id,
      }),
      false,
    );

    const terminalRun = await helpers.resolveApprovalWorkflow({
      organizationId: organization.id,
      reviewerUserId,
      reviewTaskId: request.reviewTask.id,
      workflowRunId: request.domainEvent.workflowRunId,
      resolutionOutcome: 'approved',
      resolutionNotes: 'Approved requester capability effect integration test',
    });

    expect(terminalRun.status).toBe('completed');
    expectAccessPolicyLifecycleTrace(
      await readAccessPolicyLifecycleTrace(client, {
        settingsVersionId: request.requestRow.settings_version_id,
        domainEventId: request.domainEvent.id,
        workflowRunId: request.domainEvent.workflowRunId,
        reviewTaskId: request.reviewTask.id,
      }),
      {
        settingsVersionId: request.requestRow.settings_version_id,
        domainEventId: request.domainEvent.id,
        workflowRunId: request.domainEvent.workflowRunId,
        reviewTaskId: request.reviewTask.id,
        organizationId: organization.id,
        scopeType: 'client',
        scopeId: clientAccount.id,
        workflowStatus: 'completed',
        manualReviewStatus: 'resolved',
        manualReviewResolutionOutcome: 'approved',
      },
    );
    expectRequesterRuntimeEffect(
      await readRequesterRuntimeEffect({
        dbClient: client,
        workflowHelpers: helpers,
        organizationId: organization.id,
        requesterUserId,
        scopeType: 'client',
        scopeId: clientAccount.id,
      }),
      true,
    );
  });

  test('rejected access policy request keeps requester capability and portal navigation denied', async () => {
    const organization = await createOrganization(client, 'Access Policy Rejected Effect Org');
    const clientAccount = await createTenantClient(
      client,
      organization.id,
      'Access Policy Rejected Effect Client',
    );
    const requesterUserId = await createUser(
      client,
      organization.id,
      `access-policy-effect-reject-requester-${randomUUID().slice(0, 8)}@example.test`,
      {
        userType: 'client_admin',
        accessScopeType: 'client',
        accessScopeId: clientAccount.id,
      },
    );
    const reviewerUserId = await createUser(
      client,
      organization.id,
      `access-policy-effect-reject-reviewer-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const baselinePolicy = buildAccessPolicyWithRequesterEffect({
      requesterUserId,
      includeEffect: false,
    });
    const requestedPolicy = buildAccessPolicyWithRequesterEffect({
      requesterUserId,
      includeEffect: true,
    });
    const rejectionReason = 'Rejected requester capability effect integration test';

    const request = await helpers.prepareSettingsApprovalRequest({
      category: 'access_control_policy',
      scopeType: 'client',
      scopeId: clientAccount.id,
      baselineValue: baselinePolicy,
      organizationId: organization.id,
      requesterUserId,
      requestSql: `
        SELECT settings_version_id, domain_event_id
        FROM public.ui_request_access_policy_change_v1(
          p_value := $1::jsonb,
          p_scope_type := $2::text,
          p_scope_id := $3::uuid,
          p_change_reason := $4::text,
          p_effective_from := now()
        )
      `,
      requestParams: [
        JSON.stringify(requestedPolicy),
        'client',
        clientAccount.id,
        'Access policy visible capability effect rejection test',
      ],
    });

    expectRequesterRuntimeEffect(
      await readRequesterRuntimeEffect({
        dbClient: client,
        workflowHelpers: helpers,
        organizationId: organization.id,
        requesterUserId,
        scopeType: 'client',
        scopeId: clientAccount.id,
      }),
      false,
    );

    const terminalRun = await helpers.resolveApprovalWorkflow({
      organizationId: organization.id,
      reviewerUserId,
      reviewTaskId: request.reviewTask.id,
      workflowRunId: request.domainEvent.workflowRunId,
      resolutionOutcome: 'rejected',
      resolutionNotes: rejectionReason,
    });

    expect(terminalRun.status).toBe('failed');
    expect(terminalRun.failureReason).toBe(rejectionReason);
    expectAccessPolicyLifecycleTrace(
      await readAccessPolicyLifecycleTrace(client, {
        settingsVersionId: request.requestRow.settings_version_id,
        domainEventId: request.domainEvent.id,
        workflowRunId: request.domainEvent.workflowRunId,
        reviewTaskId: request.reviewTask.id,
      }),
      {
        settingsVersionId: request.requestRow.settings_version_id,
        domainEventId: request.domainEvent.id,
        workflowRunId: request.domainEvent.workflowRunId,
        reviewTaskId: request.reviewTask.id,
        organizationId: organization.id,
        scopeType: 'client',
        scopeId: clientAccount.id,
        workflowStatus: 'failed',
        manualReviewStatus: 'resolved',
        manualReviewResolutionOutcome: 'rejected',
      },
    );
    expectRequesterRuntimeEffect(
      await readRequesterRuntimeEffect({
        dbClient: client,
        workflowHelpers: helpers,
        organizationId: organization.id,
        requesterUserId,
        scopeType: 'client',
        scopeId: clientAccount.id,
      }),
      false,
    );
  });
});
