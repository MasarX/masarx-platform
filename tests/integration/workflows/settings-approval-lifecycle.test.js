const { randomUUID } = require('crypto');

const {
  createApprovalWorkflowLifecycleHelpers,
  createDbHarness,
} = require('../helpers/approval-workflow-lifecycle');
const {
  createOrganization,
  createUser,
} = require('../helpers/tenant-utils');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const { pool } = createDbHarness({
  connectionString: DATABASE_URL,
  max: 4,
});

async function expectSettingsApprovalWorkflowRunUsesRegistryTemplate(client, workflowRunId) {
  const {
    rows: [runRow],
  } = await client.query(
    `
      SELECT wt.name AS template_name, wr.workflow_template_id
      FROM public.workflow_runs wr
      JOIN public.workflow_templates wt
        ON wt.id = wr.workflow_template_id
      WHERE wr.id = $1::uuid
      LIMIT 1
    `,
    [workflowRunId],
  );

  expect(runRow).toMatchObject({
    template_name: 'settings_change_approval_v1',
  });
  expect(runRow.workflow_template_id).toBeTruthy();

  const { rows: stepRows } = await client.query(
    `
      SELECT sequence_order, handler_key
      FROM public.workflow_run_steps
      WHERE workflow_run_id = $1::uuid
      ORDER BY sequence_order ASC
    `,
    [workflowRunId],
  );

  expect(stepRows.map((row) => row.sequence_order)).toEqual([1, 2, 3]);
  expect(stepRows.map((row) => row.handler_key)).toEqual([
    'manual_review',
    'manual_review_wait',
    'settings_apply',
  ]);
}

async function readSettingsPreviewForRequester({
  client,
  helpers,
  organizationId,
  requesterUserId,
  category,
  scopeType,
  scopeId,
}) {
  await helpers.setTenantAuthContext(organizationId, requesterUserId);
  const {
    rows: [previewRow],
  } = await client.query(
    `
      SELECT public.ui_settings_preview_v1($1::text, $2::text, $3::uuid) AS preview
    `,
    [category, scopeType, scopeId],
  );
  return previewRow?.preview ?? null;
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

describe('settings approval workflow lifecycle', () => {
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

  test('request_settings_change_v1 runs through manual approval and applies the approved version', async () => {
    const organization = await createOrganization(client, 'Settings Approval Org');
    const requesterUserId = await createUser(
      client,
      organization.id,
      `settings-requester-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const reviewerUserId = await createUser(
      client,
      organization.id,
      `settings-reviewer-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const replayReviewerUserId = await createUser(
      client,
      organization.id,
      `settings-replay-reviewer-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const outsideOrganization = await createOrganization(client, 'Settings Approval Outside Org');
    const outsideReviewerUserId = await createUser(
      client,
      outsideOrganization.id,
      `settings-outside-reviewer-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );

    const category = `it_settings_approval_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const baselineValue = { enabled: false, version_marker: 'baseline', threshold: 1 };
    const requestedValue = { enabled: true, version_marker: 'approved', threshold: 2 };

    const request = await helpers.prepareSettingsApprovalRequest({
      category,
      scopeType: 'tenant',
      scopeId: organization.id,
      baselineValue,
      organizationId: organization.id,
      requesterUserId,
      requestSql: `
        SELECT settings_version_id, domain_event_id
        FROM public.request_settings_change_v1(
          p_category := $1::text,
          p_scope_type := $2::text,
          p_scope_id := $3::uuid,
          p_value := $4::jsonb,
          p_change_reason := $5::text,
          p_effective_from := now()
        )
      `,
      requestParams: [
        category,
        'tenant',
        organization.id,
        JSON.stringify(requestedValue),
        'Request settings change through workflow lifecycle test',
      ],
    });

    const baselinePreview = await readSettingsPreviewForRequester({
      client,
      helpers,
      organizationId: organization.id,
      requesterUserId,
      category,
      scopeType: 'tenant',
      scopeId: organization.id,
    });
    expect(baselinePreview).toMatchObject({
      category,
      scope_type: 'tenant',
      scope_id: organization.id,
      settings_version_id: request.baselineVersionId,
      value: baselineValue,
    });
    expect(baselinePreview.settings_resolution_id).toBeTruthy();

    await helpers.setTenantAuthContext(outsideOrganization.id, outsideReviewerUserId);
    await client.query('SAVEPOINT settings_cross_tenant_review_denial');
    let crossTenantError = null;
    try {
      await client.query(
        `SELECT public.resolve_manual_review_task_v1($1::uuid, $2::text, $3::text)`,
        [
          request.reviewTask.id,
          'approved',
          'Cross-tenant settings review attempt should be denied',
        ],
      );
    } catch (error) {
      crossTenantError = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT settings_cross_tenant_review_denial');
    await client.query('RELEASE SAVEPOINT settings_cross_tenant_review_denial');
    expect(String(crossTenantError?.message || crossTenantError)).toMatch(
      /outside current tenant scope|requires manual_review\.resolve/,
    );

    await helpers.setServiceContext(organization.id, requesterUserId);
    await client.query('SAVEPOINT settings_unbound_review_denial');
    try {
      await client.query(
        `UPDATE public.manual_review_tasks SET metadata = metadata - 'workflow_run_id' WHERE id = $1::uuid`,
        [request.reviewTask.id],
      );
      await client.query(
        `UPDATE public.workflow_runs SET context = context || '{"manual_review_task_id":""}'::jsonb WHERE id = $1::uuid`,
        [request.domainEvent.workflowRunId],
      );
      await expect(client.query(
        `SELECT workflow_handlers.execute_settings_apply_v1(step, run, jsonb_build_object('manual_review_task_id', $2::text))
         FROM public.workflow_runs run
         JOIN public.workflow_run_steps step ON step.workflow_run_id = run.id AND step.handler_key = 'settings_apply'
         WHERE run.id = $1::uuid`,
        [request.domainEvent.workflowRunId, request.reviewTask.id],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT settings_unbound_review_denial');
      await client.query('RELEASE SAVEPOINT settings_unbound_review_denial');
    }

    await client.query(
      `
        UPDATE public.workflow_runs
           SET context = (context - 'manual_review_task_id') || jsonb_build_object(
             'manual_review',
             jsonb_build_object(
               'task_id', $2::text,
               'outcome', NULL
             )
           )
         WHERE id = $1::uuid
      `,
      [request.domainEvent.workflowRunId, request.reviewTask.id],
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

    const appliedPreview = await readSettingsPreviewForRequester({
      client,
      helpers,
      organizationId: organization.id,
      requesterUserId,
      category,
      scopeType: 'tenant',
      scopeId: organization.id,
    });
    expect(appliedPreview).toMatchObject({
      category,
      scope_type: 'tenant',
      scope_id: organization.id,
      settings_version_id: request.requestRow.settings_version_id,
      value: requestedValue,
    });

    await helpers.setServiceContext(organization.id, reviewerUserId);
    await expectSettingsApprovalWorkflowRunUsesRegistryTemplate(
      client,
      request.domainEvent.workflowRunId,
    );

    const settingsVersionRow = await helpers.readSettingsVersion(request.requestRow.settings_version_id);
    expect(settingsVersionRow.approved_by).toBe(reviewerUserId);
    expect(settingsVersionRow.approved_at).not.toBeNull();
    expect(settingsVersionRow.effective_until).toBeNull();

    const settingsProjectionVersionId = await helpers.readSettingsProjectionVersion(
      category,
      'tenant',
      organization.id,
    );
    expect(settingsProjectionVersionId).toBe(request.requestRow.settings_version_id);

    const resolvedValue = await helpers.readResolvedSetting(category, 'tenant', organization.id);
    expect(resolvedValue).toMatchObject(requestedValue);

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
        'Rejected replay should not replace approved settings review',
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
      category,
      'tenant',
      organization.id,
    );
    expect(settingsProjectionVersionAfterReplay).toBe(settingsProjectionVersionId);
    await expect(
      readManualReviewResolveDecisionCount(client, request.reviewTask.id),
    ).resolves.toBe(decisionLogCountBeforeReplay);

    const {
      rows: previousRows,
    } = await client.query(
      `
        SELECT effective_until
        FROM public.settings_versions
        WHERE category = $1
          AND scope_type = 'tenant'
          AND scope_hash = $2::uuid
          AND id <> $3::uuid
        ORDER BY version ASC
      `,
      [category, organization.id, request.requestRow.settings_version_id],
    );

    expect(previousRows).toHaveLength(1);
    expect(previousRows[0].effective_until).not.toBeNull();
  });

  test('request_settings_change_v1 rejection leaves the baseline version active and fails the workflow', async () => {
    const organization = await createOrganization(client, 'Settings Approval Rejection Org');
    const requesterUserId = await createUser(
      client,
      organization.id,
      `settings-reject-requester-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );
    const reviewerUserId = await createUser(
      client,
      organization.id,
      `settings-reject-reviewer-${randomUUID().slice(0, 8)}@example.test`,
      { userType: 'ops_admin', accessScopeType: 'tenant' },
    );

    const category = `it_settings_rejection_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const baselineValue = { enabled: false, version_marker: 'baseline', threshold: 3 };
    const requestedValue = { enabled: true, version_marker: 'rejected', threshold: 9 };
    const rejectionReason = 'Rejected during workflow lifecycle integration test';

    const request = await helpers.prepareSettingsApprovalRequest({
      category,
      scopeType: 'tenant',
      scopeId: organization.id,
      baselineValue,
      organizationId: organization.id,
      requesterUserId,
      requestSql: `
        SELECT settings_version_id, domain_event_id
        FROM public.request_settings_change_v1(
          p_category := $1::text,
          p_scope_type := $2::text,
          p_scope_id := $3::uuid,
          p_value := $4::jsonb,
          p_change_reason := $5::text,
          p_effective_from := now()
        )
      `,
      requestParams: [
        category,
        'tenant',
        organization.id,
        JSON.stringify(requestedValue),
        'Request settings rejection workflow lifecycle test',
      ],
    });

    const baselinePreviewBeforeReview = await readSettingsPreviewForRequester({
      client,
      helpers,
      organizationId: organization.id,
      requesterUserId,
      category,
      scopeType: 'tenant',
      scopeId: organization.id,
    });
    expect(baselinePreviewBeforeReview).toMatchObject({
      category,
      scope_type: 'tenant',
      scope_id: organization.id,
      settings_version_id: request.baselineVersionId,
      value: baselineValue,
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

    const baselinePreviewAfterRejection = await readSettingsPreviewForRequester({
      client,
      helpers,
      organizationId: organization.id,
      requesterUserId,
      category,
      scopeType: 'tenant',
      scopeId: organization.id,
    });
    expect(baselinePreviewAfterRejection).toMatchObject({
      category,
      scope_type: 'tenant',
      scope_id: organization.id,
      settings_version_id: request.baselineVersionId,
      value: baselineValue,
    });

    await helpers.setServiceContext(organization.id, reviewerUserId);
    await expectSettingsApprovalWorkflowRunUsesRegistryTemplate(
      client,
      request.domainEvent.workflowRunId,
    );

    const settingsVersionRow = await helpers.readSettingsVersion(request.requestRow.settings_version_id);
    expect(settingsVersionRow.approved_by).toBeNull();
    expect(settingsVersionRow.approved_at).toBeNull();
    expect(settingsVersionRow.effective_until).toBeNull();

    const resolvedTask = await helpers.readManualReviewTask(request.reviewTask.id);
    expect(resolvedTask).toMatchObject({
      status: 'resolved',
      resolution_outcome: 'rejected',
      resolution_notes: rejectionReason,
      resolved_by: reviewerUserId,
    });
    expect(resolvedTask.resolved_at).not.toBeNull();

    const settingsProjectionVersionId = await helpers.readSettingsProjectionVersion(
      category,
      'tenant',
      organization.id,
    );
    expect(settingsProjectionVersionId).toBe(request.baselineVersionId);

    const resolvedValue = await helpers.readResolvedSetting(category, 'tenant', organization.id);
    expect(resolvedValue).toMatchObject(baselineValue);
  });
});
