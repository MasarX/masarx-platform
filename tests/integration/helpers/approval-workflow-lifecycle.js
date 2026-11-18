const { Pool } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');

const {
  applySetting,
  setAuthContext,
} = require('./tenant-utils');
const { waitForDomainEventWorkflowRun } = require('./domain-event-waiter');
const { waitForWorkflowRunTerminal } = require('./workflow-run-waiter');
const { progressWorkflowRun } = require('./workflow-test-utils');

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function createDbHarness({ connectionString = process.env.DATABASE_URL, max = 4 } = {}) {
  return {
    describeIfDb: connectionString ? describe : describe.skip,
    pool: connectionString ? new Pool({ connectionString, max }) : null,
  };
}

function createApprovalWorkflowLifecycleHelpers(client) {
  async function assertSettingsApprovalDomainEventPolicy(organizationId) {
    const {
      rows: [templateRow],
    } = await client.query(
      `
        SELECT id
        FROM public.workflow_templates
        WHERE name = 'settings_change_approval_v1'
          AND status = 'active'
        ORDER BY published_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 1
      `,
    );

    if (!templateRow?.id) {
      throw new Error('settings_change_approval_v1 template missing for approval lifecycle tests');
    }

    const {
      rows: [policyRow],
    } = await client.query(
      `SELECT public.resolve_settings('domain_event_policy', 'tenant', $1::uuid) AS value`,
      [organizationId],
    );

    const workflowTemplateId =
      policyRow?.value &&
      typeof policyRow.value === 'object' &&
      !Array.isArray(policyRow.value) &&
      policyRow.value.events &&
      typeof policyRow.value.events === 'object' &&
      !Array.isArray(policyRow.value.events) &&
      policyRow.value.events['settings_change.requested'] &&
      typeof policyRow.value.events['settings_change.requested'] === 'object' &&
      !Array.isArray(policyRow.value.events['settings_change.requested'])
        ? policyRow.value.events['settings_change.requested'].workflow_template_id ?? null
        : null;

    expect(workflowTemplateId).toBe(templateRow.id);
  }

  async function setServiceContext(organizationId, userId) {
    await client.query('SET LOCAL ROLE service_role');
    const claims = {
      role: 'service_role',
      sub: userId,
      organization_id: organizationId,
    };
    await client.query(`SELECT set_config($1, $2, true)`, [
      'request.jwt.claims',
      JSON.stringify(claims),
    ]);
    await client.query(`SELECT set_config($1, $2, true)`, [
      'request.jwt.claim.sub',
      String(userId),
    ]);
  }

  async function setTenantAuthContext(organizationId, userId) {
    await setAuthContext(client, userId, {
      organization_id: organizationId,
      access_scope_type: 'tenant',
      access_scope_id: null,
    });
  }

  async function waitForManualReviewTask(settingsVersionId, workflowRunId, maxAttempts = 20) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { rows } = await client.query(
        `
          SELECT id, status, reason, metadata
          FROM public.manual_review_tasks
          WHERE resource_type = 'settings_version'
            AND resource_id = $1::uuid
            AND COALESCE(metadata->>'workflow_run_id', '') = $2
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [settingsVersionId, workflowRunId],
      );

      if (rows[0]?.id) {
        return rows[0];
      }

      await progressWorkflowRun(client, workflowRunId, {});
      await delay(150);
    }

    throw new Error(`manual review task was not created for settings_version ${settingsVersionId}`);
  }

  async function readResolvedSetting(category, scopeType, scopeId) {
    const { rows } = await client.query(
      `SELECT public.resolve_settings($1::text, $2::text, $3::uuid) AS value`,
      [category, scopeType, scopeId],
    );
    return rows[0]?.value ?? null;
  }

  async function readSettingsVersion(settingsVersionId) {
    const { rows } = await client.query(
      `
        SELECT category, approved_by, approved_at, effective_until
        FROM public.settings_versions
        WHERE id = $1::uuid
      `,
      [settingsVersionId],
    );
    return rows[0] ?? null;
  }

  async function readSettingsProjectionVersion(category, scopeType, scopeId) {
    const { rows } = await client.query(
      `
        SELECT settings_version_id
        FROM public.settings
        WHERE category = $1
          AND scope_type = $2
          AND scope_hash = $3::uuid
        LIMIT 1
      `,
      [category, scopeType, scopeId ?? NIL_UUID],
    );
    return rows[0]?.settings_version_id ?? null;
  }

  async function readManualReviewTask(taskId) {
    const { rows } = await client.query(
      `
        SELECT status, resolution_outcome, resolution_notes, resolved_by, resolved_at
        FROM public.manual_review_tasks
        WHERE id = $1::uuid
      `,
      [taskId],
    );
    return rows[0] ?? null;
  }

  async function readDomainEvent(domainEventId) {
    const { rows } = await client.query(
      `
        SELECT id, organization_id, event_type, resource_type, resource_id, workflow_run_id, correlation_id
        FROM public.domain_events
        WHERE id = $1::uuid
      `,
      [domainEventId],
    );
    return rows[0] ?? null;
  }

  async function assertReviewerCanResolveManualReview(organizationId, reviewerUserId) {
    await setTenantAuthContext(organizationId, reviewerUserId);
    const {
      rows: [capabilityRow],
    } = await client.query(
      `
        SELECT
          public.user_has_resource_capability_v1(
            'manual_review_tasks',
            'write',
            'tenant',
            $1::uuid
          ) AS allowed,
          public.user_capability_eval_v1(
            'manual_review.resolve',
            'tenant',
            $1::uuid
          ) AS eval
      `,
      [organizationId],
    );
    expect(capabilityRow?.allowed).toBe(true);
    expect(capabilityRow?.eval?.allowed).toBe(true);
    expect(capabilityRow?.eval?.reason).toBe('allowed');
  }

  async function prepareSettingsApprovalRequest({
    category,
    scopeType,
    scopeId,
    baselineValue,
    organizationId,
    requesterUserId,
    requestSql,
    requestParams,
  }) {
    await setServiceContext(organizationId, requesterUserId);
    const {
      rows: [baselineClockRow],
    } = await client.query(
      `SELECT (clock_timestamp() - interval '5 minutes') AS approved_at`,
    );
    const baselineVersionId = await applySetting(client, {
      category,
      scopeType,
      scopeId,
      value: baselineValue,
      version: 1,
      schemaVersion: 1,
      approvedAt: baselineClockRow?.approved_at ?? new Date(Date.now() - 300_000).toISOString(),
      changeReason: 'baseline-seed',
    });

    await client.query(
      `
        UPDATE public.settings_category_registry
        SET allowed_scopes = $2::jsonb,
            request_capability = COALESCE(request_capability, NULL),
            description = COALESCE(description, $3)
        WHERE category = $1
      `,
      [
        category,
        JSON.stringify([scopeType]),
        `Workflow approval lifecycle category (${category}).`,
      ],
    );

    await assertSettingsApprovalDomainEventPolicy(organizationId);

    await setTenantAuthContext(organizationId, requesterUserId);

    const {
      rows: [requestRow],
    } = await client.query(requestSql, requestParams);

    expect(requestRow.settings_version_id).toBeTruthy();
    expect(requestRow.domain_event_id).toBeTruthy();

    await setServiceContext(organizationId, requesterUserId);
    const emittedDomainEvent = await readDomainEvent(requestRow.domain_event_id);
    expect(emittedDomainEvent).toMatchObject({
      organization_id: organizationId,
      event_type: 'settings_change.requested',
      resource_type: 'settings_version',
      resource_id: requestRow.settings_version_id,
    });

    const workflowRunId = await waitForDomainEventWorkflowRun(client, requestRow.domain_event_id, {
      timeoutMs: 30_000,
      pollIntervalMs: 200,
    });

    expect(workflowRunId).toBeTruthy();
    const workflowDomainEvent = await readDomainEvent(requestRow.domain_event_id);
    expect(workflowDomainEvent?.workflow_run_id).toBe(workflowRunId);

    const reviewTask = await waitForManualReviewTask(
      requestRow.settings_version_id,
      workflowRunId,
    );

    expect(reviewTask.status).toBe('pending');
    expect(reviewTask.metadata?.workflow_run_id).toBe(workflowRunId);

    return {
      baselineVersionId,
      requestRow,
      domainEvent: {
        id: requestRow.domain_event_id,
        workflowRunId,
      },
      reviewTask,
    };
  }

  async function resolveApprovalWorkflow({
    organizationId,
    reviewerUserId,
    reviewTaskId,
    workflowRunId,
    resolutionOutcome,
    resolutionNotes,
  }) {
    await assertReviewerCanResolveManualReview(organizationId, reviewerUserId);
    await client.query(
      `SELECT public.resolve_manual_review_task_v1($1::uuid, $2::text, $3::text)`,
      [reviewTaskId, resolutionOutcome, resolutionNotes],
    );

    await setServiceContext(organizationId, reviewerUserId);
    await client.query(
      `SELECT set_config('platform.now_override', (clock_timestamp() + interval '1 second')::text, true)`,
    );

    return waitForWorkflowRunTerminal(client, workflowRunId, {
      timeoutMs: 30_000,
      pollIntervalMs: 200,
      driveProgress: true,
      progressInput: {
        manual_review_task_id: reviewTaskId,
        resolution_outcome: resolutionOutcome,
      },
    });
  }

  return {
    readManualReviewTask,
    readDomainEvent,
    readResolvedSetting,
    readSettingsProjectionVersion,
    readSettingsVersion,
    prepareSettingsApprovalRequest,
    resolveApprovalWorkflow,
    setServiceContext,
    setTenantAuthContext,
    waitForManualReviewTask,
  };
}

module.exports = {
  createApprovalWorkflowLifecycleHelpers,
  createDbHarness,
};
