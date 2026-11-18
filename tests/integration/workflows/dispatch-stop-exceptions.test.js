const { Pool } = require('pg');
const { randomUUID, randomBytes } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  createOrganization,
  createClient,
  createUser,
  createShipment,
  setAuthContext,
  applySetting,
  withFixtureAdminContext,
  setServiceContext: setCanonicalServiceContext,
} = require('../helpers/tenant-utils');

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('Dispatch stop exceptions pipeline', () => {
  let client;

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  async function setServiceContext(organizationId, userId) {
    await setCanonicalServiceContext(client, userId, organizationId);
  }

  async function seedDeliveryStopTask() {
    const { id: organizationId } = await createOrganization(client, 'Dispatch Exceptions Org');
    const { id: clientId } = await createClient(client, organizationId, 'Dispatch Exceptions Client');
    const userId = await createUser(
      client,
      organizationId,
      `dispatch-ex-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver', rbacTemplateKey: 'driver' }
    );
    const opsOwnerId = await createUser(
      client,
      organizationId,
      `dispatch-ops-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin' }
    );

    await setServiceContext(organizationId, userId);

    const { id: shipmentId } = await createShipment(client, {
      organizationId,
      clientId,
      serviceType: 'delivery',
      status: 'pending'
    });

    const { rows: templateRows } = await client.query(
      `SELECT id
         FROM workflow_templates
        WHERE name = 'dispatch_route_run_v1'
        LIMIT 1`
    );
    const routeRunTemplateId = templateRows[0]?.id;
    if (!routeRunTemplateId) {
      throw new Error('dispatch_route_run_v1 template not found');
    }

    const { rows: runRows } = await client.query(
      `SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id`,
      [
        routeRunTemplateId,
        {
          organization_id: organizationId,
          stops: [
            {
              client_id: clientId,
              shipment_id: shipmentId,
              stop_kind: 'delivery',
              sequence_order: 1
            }
          ]
        }
      ]
    );
    const routeRunWorkflowId = runRows[0]?.run_id;
    expect(routeRunWorkflowId).toBeTruthy();

    // Step 1: create route_run + route_stops
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [routeRunWorkflowId]);
    // Step 2: enqueue stop task(s)
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [routeRunWorkflowId]);

    const { rows: stopRows } = await client.query(
      `SELECT id
         FROM route_stops
        WHERE organization_id = $1::uuid
          AND shipment_id = $2::uuid
          AND client_id = $3::uuid
        LIMIT 1`,
      [organizationId, shipmentId, clientId]
    );
    const routeStopId = stopRows[0]?.id;
    expect(routeStopId).toBeTruthy();

    const { rows: taskRows } = await client.query(
      `SELECT t.id AS task_id
         FROM tasks t
         JOIN task_types tt
           ON tt.id = t.task_type_id
        WHERE t.organization_id = $1::uuid
          AND t.resource_type = 'route_stop'
          AND t.resource_id = $2::uuid
          AND tt.key = 'route_stop_execute'
        LIMIT 1`,
      [organizationId, routeStopId]
    );
    const stopTaskId = taskRows[0]?.task_id;
    expect(stopTaskId).toBeTruthy();

    return { organizationId, clientId, userId, opsOwnerId, shipmentId, routeStopId, stopTaskId };
  }

  async function runDomainEventsWorkerOnce() {
    await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `INSERT INTO cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
       VALUES ('domain_events_worker', 60, 50, true, 'integration ensure worker throttle')
       ON CONFLICT (worker_name)
       DO UPDATE SET enabled = true, interval_seconds = EXCLUDED.interval_seconds, batch_size = EXCLUDED.batch_size`
    ));
    await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `UPDATE cron_config
          SET last_run_at = now() - interval '5 minutes'
        WHERE worker_name = 'domain_events_worker'`
    ));

    await client.query(`SELECT run_domain_events_worker()`);
  }

  async function waitForDomainEventWorkflowRun(domainEventId, maxAttempts = 50) {
    for (let i = 0; i < maxAttempts; i += 1) {
      await runDomainEventsWorkerOnce();
      const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
        `SELECT workflow_run_id
           FROM domain_events
          WHERE id = $1::uuid`,
        [domainEventId]
      ));
      const workflowRunId = rows[0]?.workflow_run_id ?? null;
      if (workflowRunId) {
        return workflowRunId;
      }
    }
    return null;
  }

  async function progressWorkflowFully(workflowRunId) {
    for (let i = 0; i < 50; i += 1) {
      const { rows } = await client.query(`SELECT progress_workflow_run($1::uuid) AS result`, [
        workflowRunId
      ]);
      const result = rows[0]?.result;
      if (!result?.step_id) break;
      if (result.status === 'failed') break;
    }
  }

  async function forceWorkflowStepDue(workflowRunId) {
    await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `UPDATE workflow_run_steps
          SET run_at = now() - interval '1 second',
              updated_at = now()
        WHERE workflow_run_id = $1::uuid
          AND step_status = 'pending'`,
      [workflowRunId]
    ));
  }

  async function getGlobalDispatchStopPolicy() {
    const vScopeHash = '00000000-0000-0000-0000-000000000000';

    const { rows } = await client.query(
      `SELECT cached_value
         FROM settings
        WHERE category = 'dispatch_stop_policy'
          AND scope_type = 'global'
          AND scope_hash = $1::uuid
        LIMIT 1`,
      [vScopeHash]
    );

    return rows[0]?.cached_value;
  }

  async function getGlobalDeliveryOutcomeMapping(outcomeReason) {
    const policy = await getGlobalDispatchStopPolicy();
    const outcome =
      policy?.stop_kind_map?.delivery?.outcome_map && policy.stop_kind_map.delivery.outcome_map[outcomeReason];

    expect(outcome).toBeTruthy();
    expect(typeof outcome).toBe('object');
    return outcome;
  }

  async function getGlobalTaskCompletionEffectsPolicy() {
    const vScopeHash = '00000000-0000-0000-0000-000000000000';

    const { rows } = await client.query(
      `SELECT cached_value
         FROM settings
        WHERE category = 'task_completion_effects_policy'
          AND scope_type = 'global'
          AND scope_hash = $1::uuid
        LIMIT 1`,
      [vScopeHash]
    );

    return rows[0]?.cached_value;
  }

  async function getGlobalTaskCompletionEffect(taskTypeKey) {
    const policy = await getGlobalTaskCompletionEffectsPolicy();
    const effect = policy?.task_type_map && policy.task_type_map[taskTypeKey];

    expect(effect).toBeTruthy();
    expect(typeof effect).toBe('object');
    return effect;
  }

  function mergeDeepJson(base, patch) {
    if (Array.isArray(patch)) {
      return patch.map((value) => (value && typeof value === 'object' && !Array.isArray(value) ? mergeDeepJson({}, value) : value));
    }

    if (!patch || typeof patch !== 'object') {
      return patch;
    }

    const output = Array.isArray(base) ? [...base] : { ...(base || {}) };
    for (const [key, value] of Object.entries(patch)) {
      const current = output[key];
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        current &&
        typeof current === 'object' &&
        !Array.isArray(current)
      ) {
        output[key] = mergeDeepJson(current, value);
      } else if (Array.isArray(value)) {
        output[key] = value.map((entry) =>
          entry && typeof entry === 'object' && !Array.isArray(entry) ? mergeDeepJson({}, entry) : entry
        );
      } else {
        output[key] = value;
      }
    }

    return output;
  }

  async function getGlobalNdrPolicy() {
    const vScopeHash = '00000000-0000-0000-0000-000000000000';
    const { rows } = await client.query(
      `SELECT cached_value
         FROM settings
        WHERE category = 'ndr_policy'
          AND scope_type = 'global'
          AND scope_hash = $1::uuid
        LIMIT 1`,
      [vScopeHash]
    );

    return rows[0]?.cached_value ?? null;
  }

  async function applyClientScopedNdrPolicyOverride(clientId, patch) {
    const globalPolicy = await getGlobalNdrPolicy();
    expect(globalPolicy).toBeTruthy();

    const override = mergeDeepJson(globalPolicy, patch);

    await applySetting(client, {
      category: 'ndr_policy',
      scopeType: 'client',
      scopeId: clientId,
      value: override,
      approvedAt: new Date().toISOString()
    });

    return override;
  }

  async function getManualReviewTaskRow(manualReviewTaskId) {
    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT id, status, reason, metadata, resolution_outcome, resolution_notes, resolved_by
         FROM manual_review_tasks
        WHERE id = $1::uuid
        LIMIT 1`,
      [manualReviewTaskId]
    ));
    return rows[0] ?? null;
  }

  async function executeDispatchExceptionResolution(reviewTaskId, resolutionAction, resolutionNotes, seed) {
    await setAuthContext(client, seed.opsOwnerId, {
      organization_id: seed.organizationId
    });

    const { rows } = await client.query(
      `SELECT api.ui_execute_dispatch_exception_resolution_v1(
         $1,
         $2,
         $3::text[],
         $4,
         $5,
         $6::jsonb
       ) AS result`,
      [
        'dispatch_exception_review.complete',
        'dispatch_exception_review',
        [String(reviewTaskId)],
        String(reviewTaskId),
        1,
        JSON.stringify({
          resolution_action: resolutionAction,
          resolution_notes: resolutionNotes
        })
      ]
    );

    return rows[0]?.result ?? null;
  }

  async function countTasksForResource(organizationId, resourceType, resourceId, taskTypeKey) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM tasks t
         JOIN task_types tt
           ON tt.id = t.task_type_id
        WHERE t.organization_id = $1::uuid
          AND t.resource_type = $2
          AND t.resource_id = $3::uuid
          AND tt.key = $4`,
      [organizationId, resourceType, resourceId, taskTypeKey]
    );
    return rows[0]?.count ?? 0;
  }

  async function getTaskIdForResource(organizationId, resourceType, resourceId, taskTypeKey) {
    const { rows } = await client.query(
      `SELECT t.id AS task_id
         FROM tasks t
         JOIN task_types tt
           ON tt.id = t.task_type_id
        WHERE t.organization_id = $1::uuid
          AND t.resource_type = $2
          AND t.resource_id = $3::uuid
          AND tt.key = $4
        ORDER BY t.created_at DESC
        LIMIT 1`,
      [organizationId, resourceType, resourceId, taskTypeKey]
    );
    return rows[0]?.task_id ?? null;
  }

  async function getTaskSnapshotForResource(organizationId, resourceType, resourceId, taskTypeKey) {
    const { rows } = await client.query(
      `SELECT
         t.id AS task_id,
         t.status,
         t.queue_key,
         t.assigned_to,
         t.assigned_at,
         t.sla_minutes,
         t.sla_due_at,
         t.created_at
         FROM tasks t
         JOIN task_types tt
           ON tt.id = t.task_type_id
        WHERE t.organization_id = $1::uuid
          AND t.resource_type = $2
          AND t.resource_id = $3::uuid
          AND tt.key = $4
        ORDER BY t.created_at DESC
        LIMIT 1`,
      [organizationId, resourceType, resourceId, taskTypeKey]
    );
    return rows[0] ?? null;
  }

  async function countTaskEvents(taskId, eventType) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM task_events
        WHERE task_id = $1::uuid
          AND event_type = $2`,
      [taskId, eventType]
    );
    return rows[0]?.count ?? 0;
  }

  async function countTaskTransitionsToStatus(taskId, toStatus) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM task_events
        WHERE task_id = $1::uuid
          AND event_type = 'status_changed'
          AND to_status = $2`,
      [taskId, toStatus]
    );
    return rows[0]?.count ?? 0;
  }

  async function getTaskRow(taskId) {
    const { rows } = await client.query(
      `SELECT
         id,
         status,
         status_reason,
         assigned_to,
         assigned_at,
         sla_due_at,
         sla_breached_at,
         metadata
        FROM tasks
       WHERE id = $1::uuid
       LIMIT 1`,
      [taskId]
    );
    return rows[0] ?? null;
  }

  async function registerMobileArtifact({ organizationId, userId, taskId, artifactKind = 'photo' }) {
    const extension = artifactKind === 'signature' ? 'svg' : 'jpg';
    const mimeType = artifactKind === 'signature' ? 'image/svg+xml' : 'image/jpeg';

    await setAuthContext(client, userId, { organization_id: organizationId });
    const { rows } = await client.query(
      `SELECT artifact_id, created
         FROM public.register_mobile_artifact_v1($1::jsonb)`,
      [
        JSON.stringify({
          organization_id: organizationId,
          storage_bucket: 'fieldops-evidence',
          storage_key: `${organizationId}/${taskId}/${artifactKind}-${randomBytes(6).toString('hex')}.${extension}`,
          mime_type: mimeType,
          size_bytes: artifactKind === 'signature' ? 512 : 2048,
          metadata: {
            artifact_kind: artifactKind,
            source: 'dispatch-stop-exceptions.integration'
          }
        })
      ]
    );

    await setServiceContext(organizationId, userId);
    return rows[0]?.artifact_id ?? null;
  }

  async function getLatestTaskEvent(taskId, eventType) {
    const { rows } = await client.query(
      `SELECT
         actor_user_id,
         payload,
         decision_log_id
        FROM task_events
       WHERE task_id = $1::uuid
         AND event_type = $2
       ORDER BY task_version DESC, created_at DESC, id DESC
       LIMIT 1`,
      [taskId, eventType]
    );
    return rows[0] ?? null;
  }

  function resolveFollowupResourceRef(resourceIdSource, { shipmentId, routeStopId }) {
    const source = String(resourceIdSource || '').toLowerCase();

    if (source === 'shipment') return { resourceType: 'shipment', resourceId: shipmentId };
    if (source === 'route_stop') return { resourceType: 'route_stop', resourceId: routeStopId };

    throw new Error(`Unsupported followup resource_id_source: ${resourceIdSource}`);
  }

  async function completeStopAndFinalize(
    { organizationId, routeStopId, stopTaskId },
    outcomeReason,
    idempotencyKey,
    taskPayload = {}
  ) {
    await client.query(
      `SELECT transition_task_v1(
        $1::uuid,
        'completed',
        $2,
        $3::jsonb,
        $4
      )`,
      [stopTaskId, outcomeReason, JSON.stringify(taskPayload || {}), idempotencyKey]
    );

    const { rows: domainEventRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT id
         FROM domain_events
        WHERE organization_id = $1::uuid
          AND event_type = 'task.completed.route_stop_execute'
          AND resource_type = 'route_stop'
          AND resource_id = $2::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      [organizationId, routeStopId]
    ));
    const domainEventId = domainEventRows[0]?.id;
    expect(domainEventId).toBeTruthy();

    const finalizeWorkflowId = await waitForDomainEventWorkflowRun(domainEventId);
    expect(finalizeWorkflowId).toBeTruthy();

    await progressWorkflowFully(finalizeWorkflowId);

    return { domainEventId, finalizeWorkflowId };
  }

  async function getShipmentStatus(shipmentId, clientId) {
    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT status
         FROM shipments
        WHERE id = $1::uuid
          AND client_id = $2::uuid
        LIMIT 1`,
      [shipmentId, clientId]
    ));
    return rows[0]?.status ?? null;
  }

  test.each([
    'no_answer',
    'customer_refused',
    'address_not_found',
    'address_incorrect',
    'package_lost',
    'business_closed',
    'phone_unreachable',
    'payment_issue',
    'package_damaged',
    'other'
  ])('stop outcome %s follows dispatch_stop_policy defaults end-to-end', async (outcomeReason) => {
    const seed = await seedDeliveryStopTask();
    const outcome = await getGlobalDeliveryOutcomeMapping(outcomeReason);

    await completeStopAndFinalize(
      seed,
      outcomeReason,
      `dispatch-stop-complete-${outcomeReason}-${randomUUID()}`
    );

    const shipmentStatus = await getShipmentStatus(seed.shipmentId, seed.clientId);
    expect(shipmentStatus).toBe(outcome.shipment_status);

    const followups = Array.isArray(outcome.followup_tasks) ? outcome.followup_tasks : [];
    for (const followup of followups) {
      const taskTypeKey = followup?.task_type_key;
      if (!taskTypeKey) continue;

      const { resourceType, resourceId } = resolveFollowupResourceRef(followup.resource_id_source, seed);
      const count = await countTasksForResource(seed.organizationId, resourceType, resourceId, taskTypeKey);
      expect(count).toBe(1);
    }
  });

  test('stop exception follow-up task assigns owner and SLA from task type defaults', async () => {
    const seed = await seedDeliveryStopTask();

    await completeStopAndFinalize(seed, 'no_answer', `dispatch-stop-owner-sla-${randomUUID()}`);

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();
    expect(followup?.assigned_to).toBe(seed.opsOwnerId);
    expect(followup?.assigned_at).toBeTruthy();
    expect(followup?.queue_key).toBe('dispatch');
    expect(Number(followup?.sla_minutes || 0)).toBe(60);
    expect(followup?.sla_due_at).toBeTruthy();
    expect(new Date(followup.sla_due_at).getTime()).toBeGreaterThan(
      new Date(followup.created_at).getTime()
    );
    expect(await countTaskEvents(followup.task_id, 'assigned')).toBe(1);

    const followupTask = await getTaskRow(followup.task_id);
    expect(followupTask?.status_reason).toBe('no_answer');
    expect(followupTask?.metadata?.dispatch_exception_reason).toBe('no_answer');
  });

  test('dispatch exception review task projects shipment_action_id, route_stop_id, service_type, and dispatch_exception_reason after stop finalize', async () => {
    const seed = await seedDeliveryStopTask();

    await completeStopAndFinalize(seed, 'no_answer', `dispatch-stop-lineage-${randomUUID()}`);

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();

    const followupTask = await getTaskRow(followup.task_id);
    expect(followupTask?.status_reason).toBe('no_answer');
    expect(followupTask?.metadata?.route_stop_id).toBe(seed.routeStopId);
    expect(followupTask?.metadata?.service_type).toBe('delivery');
    expect(followupTask?.metadata?.dispatch_exception_reason).toBe('no_answer');
    expect(followupTask?.metadata?.shipment_action_id).toBeTruthy();

    const { rows: shipmentActionRows } = await client.query(
      `SELECT id
         FROM shipment_actions
        WHERE shipment_id = $1::uuid
          AND organization_id = $2::uuid
          AND client_id = $3::uuid
          AND lower(COALESCE(action_data->>'stop_kind', '')) = 'delivery'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [seed.shipmentId, seed.organizationId, seed.clientId]
    );
    expect(shipmentActionRows[0]?.id).toBeTruthy();
    expect(followupTask?.metadata?.shipment_action_id).toBe(shipmentActionRows[0].id);
  });

  test('dispatch exception review task captures notes, evidence, and allowed actions from stop completion payload', async () => {
    const seed = await seedDeliveryStopTask();
    const evidenceArtifactId = await registerMobileArtifact({
      organizationId: seed.organizationId,
      userId: seed.userId,
      taskId: seed.stopTaskId
    });
    expect(evidenceArtifactId).toBeTruthy();

    await completeStopAndFinalize(
      seed,
      'no_answer',
      `dispatch-stop-context-${randomUUID()}`,
      {
        exception_notes: 'Customer unreachable after branch return call.',
        notes: 'Field note fallback should stay secondary to exception_notes.',
        allowed_ndr_actions: ['reattempt', 'hold_at_branch', 'return_to_sender'],
        artifact_ids: [evidenceArtifactId]
      }
    );

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();

    const followupTask = await getTaskRow(followup.task_id);
    expect(followupTask?.metadata?.exception_notes).toBe(
      'Customer unreachable after branch return call.'
    );
    expect(followupTask?.metadata?.evidence_artifact_ids).toEqual([evidenceArtifactId]);
    expect(followupTask?.metadata?.allowed_ndr_actions).toEqual([
      'reattempt',
      'hold_at_branch',
      'return_to_sender'
    ]);
    expect(followupTask?.metadata?.shipment_action_id).toBeTruthy();

    const { rows: linkRows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM public.artifact_links
        WHERE organization_id = $1::uuid
          AND artifact_id = $2::uuid
          AND resource_type = 'shipment_action'
          AND resource_id = $3::uuid`,
      [seed.organizationId, evidenceArtifactId, followupTask.metadata.shipment_action_id]
    );
    expect(linkRows[0]?.count).toBe(1);
  });

  test('api.ui_execute_dispatch_exception_resolution_v1 immediate reattempt completes dispatch_reattempt_delivery and returns shipment to pending', async () => {
    const seed = await seedDeliveryStopTask();

    await completeStopAndFinalize(seed, 'no_answer', `dispatch-stop-reattempt-${randomUUID()}`);

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();

    const result = await executeDispatchExceptionResolution(
      followup.task_id,
      'reattempt',
      'Immediate reattempt from integration coverage',
      seed
    );

    expect(result?.status).toBe('completed');
    expect(result?.count).toBe(1);
    expect(result?.completed_count).toBe(1);
    expect(result?.items?.[0]?.status).toBe('completed');
    expect(result?.items?.[0]?.task_id).toBe(followup.task_id);
    expect(result?.items?.[0]?.preview?.decision_status).toBe('ready');
    expect(result?.items?.[0]?.completion_effects).toBeTruthy();
    expect(result?.items?.[0]?.completion_effects?.workflow_run_id).toBeTruthy();
    expect(result?.items?.[0]?.completion_effects?.operation_result).toBeTruthy();
    expect(result?.items?.[0]?.completion_effects?.operation_result?.shipment_resort?.status).toBe(
      'blocked'
    );
    expect(result?.items?.[0]?.completion_effects?.operation_result?.shipment_resort?.reason).toBeTruthy();

    await setServiceContext(seed.organizationId, seed.userId);
    const reattemptTask = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_reattempt_delivery'
    );
    expect(reattemptTask?.task_id).toBeTruthy();
    expect(reattemptTask?.status).toBe('completed');
    expect(await countTaskTransitionsToStatus(reattemptTask.task_id, 'completed')).toBe(1);

    const reattemptTaskRow = await getTaskRow(reattemptTask.task_id);
    expect(reattemptTaskRow?.metadata?.parent_review_task_id).toBe(followup.task_id);

    const reviewTaskRow = await getTaskRow(followup.task_id);
    expect(reviewTaskRow?.metadata?.resolution_status).toBe('completed');
    expect(reviewTaskRow?.metadata?.resolution_task_id).toBe(reattemptTask.task_id);
    expect(reviewTaskRow?.metadata?.resolution_completion_effects).toBeTruthy();

    const shipmentStatus = await getShipmentStatus(seed.shipmentId, seed.clientId);
    expect(shipmentStatus).toBe('pending');
  });

  test('api.ui_execute_dispatch_exception_resolution_v1 hold_at_branch creates a direct shipment action and completes the review', async () => {
    const seed = await seedDeliveryStopTask();

    await completeStopAndFinalize(
      seed,
      'no_answer',
      `dispatch-stop-hold-at-branch-${randomUUID()}`,
      {
        allowed_ndr_actions: ['reattempt', 'hold_at_branch', 'return_to_sender'],
        exception_notes: 'Customer requested branch pickup after failed stop.'
      }
    );

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();

    const result = await executeDispatchExceptionResolution(
      followup.task_id,
      'hold_at_branch',
      'Move shipment to branch pickup hold',
      seed
    );

    expect(result?.status).toBe('completed');
    expect(result?.completed_count).toBe(1);

    await setServiceContext(seed.organizationId, seed.userId);

    const reviewTaskRow = await getTaskRow(followup.task_id);
    expect(reviewTaskRow?.metadata?.resolution_status).toBe('completed');
    expect(reviewTaskRow?.metadata?.resolution_action).toBe('hold_at_branch');
    expect(reviewTaskRow?.metadata?.resolution_direct_shipment_action_id).toBeTruthy();
    expect(reviewTaskRow?.metadata?.resolution_task_id ?? null).toBeNull();

    const { rows: holdActionRows } = await client.query(
      `SELECT action_type, action_category, action_data
         FROM public.shipment_actions
        WHERE id = $1::uuid
        LIMIT 1`,
      [reviewTaskRow.metadata.resolution_direct_shipment_action_id]
    );
    expect(holdActionRows[0]?.action_type).toBe('hold_at_branch');
    expect(holdActionRows[0]?.action_category).toBe('operational');
    expect(holdActionRows[0]?.action_data?.source_review_task_id).toBe(followup.task_id);
    expect(holdActionRows[0]?.action_data?.resolution_action).toBe('hold_at_branch');
  });

  test('api.ui_execute_dispatch_exception_resolution_v1 return_to_sender creates dispatch_rto_pickup with parent review lineage', async () => {
    const seed = await seedDeliveryStopTask();

    await completeStopAndFinalize(
      seed,
      'no_answer',
      `dispatch-stop-return-to-sender-${randomUUID()}`,
      {
        allowed_ndr_actions: ['reattempt', 'hold_at_branch', 'return_to_sender'],
        exception_notes: 'Escalate to sender return if customer remains unreachable.'
      }
    );

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();

    const result = await executeDispatchExceptionResolution(
      followup.task_id,
      'return_to_sender',
      'Queue sender return pickup',
      seed
    );

    expect(result?.status).toBe('completed');
    expect(result?.completed_count).toBe(1);

    await setServiceContext(seed.organizationId, seed.userId);

    const rtoTask = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_rto_pickup'
    );
    expect(rtoTask?.task_id).toBeTruthy();

    const rtoTaskRow = await getTaskRow(rtoTask.task_id);
    expect(rtoTaskRow?.metadata?.parent_review_task_id).toBe(followup.task_id);
    expect(rtoTaskRow?.metadata?.resolution_action).toBe('return_to_sender');

    const reviewTaskRow = await getTaskRow(followup.task_id);
    expect(reviewTaskRow?.metadata?.resolution_status).toBe('completed');
    expect(reviewTaskRow?.metadata?.resolution_task_id).toBe(rtoTask.task_id);
    expect(reviewTaskRow?.metadata?.resolution_direct_shipment_action_id ?? null).toBeNull();
  });

  test('client-scoped ndr_policy override schedules reattempts and wakes them when the delay elapses', async () => {
    const seed = await seedDeliveryStopTask();

    await completeStopAndFinalize(seed, 'no_answer', `dispatch-stop-scheduled-reattempt-${randomUUID()}`);

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();

    await applyClientScopedNdrPolicyOverride(seed.clientId, {
      action_map: {
        reattempt: {
          schedule_delay_minutes: 30
        }
      }
    });

    const scheduledResult = await executeDispatchExceptionResolution(
      followup.task_id,
      'reattempt',
      'Scheduled reattempt from policy',
      seed
    );

    expect(scheduledResult?.status).toBe('scheduled');
    expect(scheduledResult?.scheduled_count).toBe(1);
    expect(scheduledResult?.items?.[0]?.status).toBe('scheduled');
    expect(scheduledResult?.items?.[0]?.workflow_run_id).toBeTruthy();
    expect(scheduledResult?.items?.[0]?.scheduled_for).toBeTruthy();

    const scheduledReviewTask = await getTaskRow(followup.task_id);
    expect(scheduledReviewTask?.metadata?.resolution_status).toBe('scheduled');
    expect(scheduledReviewTask?.metadata?.resolution_workflow_run_id).toBe(scheduledResult.items[0].workflow_run_id);
    expect(scheduledReviewTask?.metadata?.resolution_scheduled_for).toBeTruthy();

    const { rows: workflowRunRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT workflow_status, context
         FROM workflow_runs
        WHERE id = $1::uuid
        LIMIT 1`,
      [scheduledResult.items[0].workflow_run_id]
    ));
    expect(workflowRunRows[0]?.workflow_status).toBe('pending');
    expect(workflowRunRows[0]?.context?.scheduled_for).toBeTruthy();

    const { rows: workflowStepRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT step_status, run_at, metadata
         FROM workflow_run_steps
        WHERE workflow_run_id = $1::uuid
        ORDER BY sequence_order
        LIMIT 1`,
      [scheduledResult.items[0].workflow_run_id]
    ));
    expect(workflowStepRows[0]?.step_status).toBe('pending');
    expect(new Date(workflowStepRows[0].run_at).getTime()).toBeGreaterThan(
      new Date(followup.created_at).getTime()
    );
    expect(workflowStepRows[0]?.metadata?.scheduled_for).toBeTruthy();

    await forceWorkflowStepDue(scheduledResult.items[0].workflow_run_id);
    await setServiceContext(seed.organizationId, seed.userId);
    await client.query(`SELECT progress_workflow_run($1::uuid, $2::jsonb)`, [
      scheduledResult.items[0].workflow_run_id,
      JSON.stringify({ wake_reason: 'scheduled_dispatch_reattempt' })
    ]);
    await progressWorkflowFully(scheduledResult.items[0].workflow_run_id);

    const reattemptTask = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_reattempt_delivery'
    );
    expect(reattemptTask?.task_id).toBeTruthy();
    expect(reattemptTask?.status).toBe('open');
    expect(await countTaskTransitionsToStatus(reattemptTask.task_id, 'completed')).toBe(0);

    const reattemptTaskRow = await getTaskRow(reattemptTask.task_id);
    expect(reattemptTaskRow?.metadata?.parent_review_task_id).toBe(followup.task_id);

    const reviewTaskRow = await getTaskRow(followup.task_id);
    expect(reviewTaskRow?.metadata?.resolution_status).toBe('completed');
    expect(reviewTaskRow?.metadata?.resolution_task_id).toBe(reattemptTask.task_id);
    expect(reviewTaskRow?.metadata?.resolution_completion_effects).toEqual({});

    const shipmentStatus = await getShipmentStatus(seed.shipmentId, seed.clientId);
    expect(shipmentStatus).toBe('delivery_failed');
  });

  test('client-scoped ndr_policy override blocks reattempts on risk_hold and verification_failed metadata', async () => {
    const riskSeed = await seedDeliveryStopTask();

    await completeStopAndFinalize(riskSeed, 'no_answer', `dispatch-stop-risk-block-${randomUUID()}`);

    const riskFollowup = await getTaskSnapshotForResource(
      riskSeed.organizationId,
      'shipment',
      riskSeed.shipmentId,
      'dispatch_exception_review'
    );
    expect(riskFollowup?.task_id).toBeTruthy();

    await client.query(
      `UPDATE tasks
          SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('risk_hold', TRUE)),
              updated_at = now()
        WHERE id = $1::uuid`,
      [riskFollowup.task_id]
    );

    const { rows: riskPreviewRows } = await client.query(
      `SELECT public.preview_dispatch_exception_resolution_v1($1::uuid, $2::text, $3::jsonb) AS preview`,
      [riskFollowup.task_id, 'reattempt', JSON.stringify({})]
    );
    expect(riskPreviewRows[0]?.preview?.decision_status).toBe('blocked');
    expect(riskPreviewRows[0]?.preview?.blocked_reason).toBe('task_metadata_block:risk_hold');

    const riskResult = await executeDispatchExceptionResolution(
      riskFollowup.task_id,
      'reattempt',
      'Blocked by risk hold metadata',
      riskSeed
    );
    expect(riskResult?.status).toBe('blocked');
    expect(riskResult?.blocked_count).toBe(1);
    expect(riskResult?.items?.[0]?.blocked_reason).toBe('task_metadata_block:risk_hold');
    expect(
      await countTasksForResource(
        riskSeed.organizationId,
        'shipment',
        riskSeed.shipmentId,
        'dispatch_reattempt_delivery'
      )
    ).toBe(0);

    const riskReviewTaskRow = await getTaskRow(riskFollowup.task_id);
    expect(riskReviewTaskRow?.status).toBe('open');
    await setServiceContext(riskSeed.organizationId, riskSeed.userId);

    const verificationSeed = await seedDeliveryStopTask();

    await completeStopAndFinalize(
      verificationSeed,
      'no_answer',
      `dispatch-stop-verification-block-${randomUUID()}`
    );

    const verificationFollowup = await getTaskSnapshotForResource(
      verificationSeed.organizationId,
      'shipment',
      verificationSeed.shipmentId,
      'dispatch_exception_review'
    );
    expect(verificationFollowup?.task_id).toBeTruthy();

    await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `UPDATE shipments
          SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('verification_failed', TRUE)),
              updated_at = now()
        WHERE id = $1::uuid`,
      [verificationSeed.shipmentId]
    ));

    const { rows: verificationPreviewRows } = await client.query(
      `SELECT public.preview_dispatch_exception_resolution_v1($1::uuid, $2::text, $3::jsonb) AS preview`,
      [verificationFollowup.task_id, 'reattempt', JSON.stringify({})]
    );
    expect(verificationPreviewRows[0]?.preview?.decision_status).toBe('blocked');
    expect(verificationPreviewRows[0]?.preview?.blocked_reason).toBe('shipment_metadata_block:verification_failed');

    const verificationResult = await executeDispatchExceptionResolution(
      verificationFollowup.task_id,
      'reattempt',
      'Blocked by verification metadata',
      verificationSeed
    );
    expect(verificationResult?.status).toBe('blocked');
    expect(verificationResult?.blocked_count).toBe(1);
    expect(verificationResult?.items?.[0]?.blocked_reason).toBe(
      'shipment_metadata_block:verification_failed'
    );
    expect(
      await countTasksForResource(
        verificationSeed.organizationId,
        'shipment',
        verificationSeed.shipmentId,
        'dispatch_reattempt_delivery'
      )
    ).toBe(0);
  });

  test('client-scoped ndr_policy override blocks reattempt when max_attempts is reached', async () => {
    const seed = await seedDeliveryStopTask();

    await completeStopAndFinalize(seed, 'no_answer', `dispatch-stop-max-attempts-${randomUUID()}`);

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();

    await setServiceContext(seed.organizationId, seed.userId);
    const { rows: previewRows } = await client.query(
      `SELECT public.preview_dispatch_exception_resolution_v1($1::uuid, $2::text, $3::jsonb) AS preview`,
      [followup.task_id, 'reattempt', JSON.stringify({})]
    );
    expect(previewRows[0]?.preview?.attempt_count).toBeGreaterThanOrEqual(1);

    await applyClientScopedNdrPolicyOverride(seed.clientId, {
      action_map: {
        reattempt: {
          max_attempts: 1
        }
      }
    });

    await setAuthContext(client, seed.opsOwnerId, {
      organization_id: seed.organizationId
    });
    const { rows } = await client.query(
      `SELECT api.ui_execute_dispatch_exception_resolution_v1(
         $1,
         $2,
         $3::text[],
         $4,
         $5,
         $6::jsonb
       ) AS result`,
      [
        'dispatch_exception_review.complete',
        'dispatch_exception_review',
        [String(followup.task_id)],
        String(followup.task_id),
        1,
        JSON.stringify({
          resolution_action: 'reattempt',
          resolution_notes: 'Should be blocked by max attempts'
        })
      ]
    );
    const result = rows[0]?.result ?? null;

    expect(result?.status).toBe('blocked');
    expect(result?.blocked_count).toBe(1);
    expect(result?.items?.[0]?.status).toBe('blocked');
    expect(result?.items?.[0]?.blocked_reason).toBe('max_attempts_reached');
    expect(result?.items?.[0]?.preview?.decision_status).toBe('blocked');
    expect(result?.items?.[0]?.preview?.blocked_reason).toBe('max_attempts_reached');

    await setServiceContext(seed.organizationId, seed.userId);
    const reviewTaskRow = await getTaskRow(followup.task_id);
    expect(reviewTaskRow?.status).toBe('open');
    expect(reviewTaskRow?.metadata?.resolution_status ?? null).toBeNull();
    expect(await countTasksForResource(seed.organizationId, 'shipment', seed.shipmentId, 'dispatch_reattempt_delivery')).toBe(0);
  });

  test('client-scoped ndr_policy override requiring approval returns pending_review and resumes on approved manual review', async () => {
    const seed = await seedDeliveryStopTask();

    await completeStopAndFinalize(seed, 'no_answer', `dispatch-stop-manual-review-${randomUUID()}`);

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();

    await applyClientScopedNdrPolicyOverride(seed.clientId, {
      action_map: {
        reattempt: {
          require_manual_review: true
        }
      }
    });

    const pendingReviewResult = await executeDispatchExceptionResolution(
      followup.task_id,
      'reattempt',
      'Manual approval required before reattempt',
      seed
    );

    expect(pendingReviewResult?.status).toBe('pending_review');
    expect(pendingReviewResult?.pending_review_count).toBe(1);
    expect(pendingReviewResult?.items?.[0]?.status).toBe('pending_review');
    expect(pendingReviewResult?.items?.[0]?.manual_review_task_id).toBeTruthy();
    expect(pendingReviewResult?.items?.[0]?.preview?.decision_status).toBe('manual_review_required');

    const manualReviewTaskId = pendingReviewResult.items[0].manual_review_task_id;
    const manualReviewTask = await getManualReviewTaskRow(manualReviewTaskId);
    expect(manualReviewTask?.status).toBe('pending');
    expect(manualReviewTask?.reason).toBe('Manual approval required before reattempt');
    expect(manualReviewTask?.metadata?.workflow_resume_on_resolve).toBe(true);
    expect(manualReviewTask?.metadata?.dispatch_exception_review_task_id).toBe(followup.task_id);
    expect(manualReviewTask?.metadata?.resolution_action).toBe('reattempt');
    expect(manualReviewTask?.metadata?.workflow_run_id).toBeTruthy();

    await setAuthContext(client, seed.opsOwnerId, {
      organization_id: seed.organizationId
    });
    await client.query(
      `SELECT public.resolve_manual_review_task_v1($1::uuid, $2::text, $3::text)`,
      [manualReviewTaskId, 'approved', 'Approved for dispatch reattempt']
    );
    await setServiceContext(seed.organizationId, seed.userId);
    await progressWorkflowFully(manualReviewTask.metadata.workflow_run_id);

    const resolvedManualReviewTask = await getManualReviewTaskRow(manualReviewTaskId);
    expect(resolvedManualReviewTask?.status).toBe('resolved');
    expect(resolvedManualReviewTask?.resolution_outcome).toBe('approved');
    expect(resolvedManualReviewTask?.resolved_by).toBe(seed.opsOwnerId);

    const reattemptTask = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_reattempt_delivery'
    );
    expect(reattemptTask?.task_id).toBeTruthy();
    expect(reattemptTask?.status).toBe('completed');
    expect(await countTaskTransitionsToStatus(reattemptTask.task_id, 'completed')).toBe(1);

    const reattemptTaskRow = await getTaskRow(reattemptTask.task_id);
    expect(reattemptTaskRow?.metadata?.parent_review_task_id).toBe(followup.task_id);

    const reviewTaskRow = await getTaskRow(followup.task_id);
    expect(reviewTaskRow?.metadata?.resolution_status).toBe('completed');
    expect(reviewTaskRow?.metadata?.resolution_task_id).toBe(reattemptTask.task_id);
    expect(reviewTaskRow?.metadata?.resolution_manual_review_task_id).toBe(manualReviewTaskId);
    expect(reviewTaskRow?.metadata?.resolution_completion_effects).toBeTruthy();

    const shipmentStatus = await getShipmentStatus(seed.shipmentId, seed.clientId);
    expect(shipmentStatus).toBe('pending');
  });

  test('transition_task_v1 idempotency_key prevents duplicate task_events and duplicate domain_events', async () => {
    const { organizationId, routeStopId, stopTaskId, shipmentId, opsOwnerId } =
      await seedDeliveryStopTask();
    const idem = `dispatch-stop-idem-${randomUUID()}`;

    await client.query(
      `SELECT transition_task_v1(
        $1::uuid,
        'completed',
        $2,
        '{}'::jsonb,
        $3
      )`,
      [stopTaskId, 'customer_refused', idem]
    );
    await client.query(
      `SELECT transition_task_v1(
        $1::uuid,
        'completed',
        $2,
        '{}'::jsonb,
        $3
      )`,
      [stopTaskId, 'customer_refused', idem]
    );

    const { rows: eventCountRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT COUNT(*)::int AS count
         FROM domain_events
        WHERE organization_id = $1::uuid
          AND event_type = 'task.completed.route_stop_execute'
          AND resource_type = 'route_stop'
          AND resource_id = $2::uuid`,
      [organizationId, routeStopId]
    ));
    expect(eventCountRows[0]?.count).toBe(1);

    const { rows: eventRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT id
         FROM domain_events
        WHERE organization_id = $1::uuid
          AND event_type = 'task.completed.route_stop_execute'
          AND resource_type = 'route_stop'
          AND resource_id = $2::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      [organizationId, routeStopId]
    ));
    const finalizeWorkflowId = await waitForDomainEventWorkflowRun(eventRows[0]?.id ?? null);
    expect(finalizeWorkflowId).toBeTruthy();

    await progressWorkflowFully(finalizeWorkflowId);

    const outcome = await getGlobalDeliveryOutcomeMapping('customer_refused');
    const followups = Array.isArray(outcome.followup_tasks) ? outcome.followup_tasks : [];
    for (const followup of followups) {
      const taskTypeKey = followup?.task_type_key;
      if (!taskTypeKey) continue;

      const { resourceType, resourceId } = resolveFollowupResourceRef(followup.resource_id_source, {
        shipmentId,
        routeStopId
      });
      const count = await countTasksForResource(organizationId, resourceType, resourceId, taskTypeKey);
      expect(count).toBe(1);

      if (taskTypeKey === 'dispatch_rto_pickup') {
        const task = await getTaskSnapshotForResource(
          organizationId,
          resourceType,
          resourceId,
          taskTypeKey
        );
        expect(task?.assigned_to).toBe(opsOwnerId);
        expect(await countTaskEvents(task.task_id, 'assigned')).toBe(1);
      }
    }
  });

  test('stop exception follow-up completion applies task_completion_effects_policy (address_not_found -> reschedule -> pending)', async () => {
    const seed = await seedDeliveryStopTask();

    const stopOutcome = await getGlobalDeliveryOutcomeMapping('address_not_found');
    const followups = Array.isArray(stopOutcome.followup_tasks) ? stopOutcome.followup_tasks : [];
    const rescheduleFollowup = followups.find(
      (f) => String(f?.task_type_key || '').toLowerCase() === 'dispatch_reschedule_delivery'
    );
    expect(rescheduleFollowup).toBeTruthy();

    await completeStopAndFinalize(seed, 'address_not_found', `dispatch-stop-address-not-found-${randomUUID()}`);

    // After stop finalize, shipment status matches dispatch_stop_policy.
    const afterStopStatus = await getShipmentStatus(seed.shipmentId, seed.clientId);
    expect(afterStopStatus).toBe(stopOutcome.shipment_status);

    // Follow-up task is created (policy-driven; non-stomping).
    const followupRef = resolveFollowupResourceRef(rescheduleFollowup.resource_id_source, seed);
    const followupTaskId = await getTaskIdForResource(
      seed.organizationId,
      followupRef.resourceType,
      followupRef.resourceId,
      'dispatch_reschedule_delivery'
    );
    expect(followupTaskId).toBeTruthy();

    // Completing the follow-up task emits a domain_event and runs task_completion_effects_v1.
    await client.query(
      `SELECT transition_task_v1(
        $1::uuid,
        'completed',
        NULL,
        '{}'::jsonb,
        $2
      )`,
      [followupTaskId, `dispatch-reschedule-idem-${randomUUID()}`]
    );

    const { rows: followupDomainEventRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT id
         FROM domain_events
        WHERE organization_id = $1::uuid
          AND event_type = 'task.completed.dispatch_reschedule_delivery'
          AND resource_type = $2
          AND resource_id = $3::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      [seed.organizationId, followupRef.resourceType, followupRef.resourceId]
    ));
    const followupDomainEventId = followupDomainEventRows[0]?.id;
    expect(followupDomainEventId).toBeTruthy();

    const followupWorkflowId = await waitForDomainEventWorkflowRun(followupDomainEventId);
    expect(followupWorkflowId).toBeTruthy();

    await progressWorkflowFully(followupWorkflowId);

    const completionEffect = await getGlobalTaskCompletionEffect('dispatch_reschedule_delivery');
    const finalStatus = await getShipmentStatus(seed.shipmentId, seed.clientId);
    expect(finalStatus).toBe(completionEffect.shipment_status);
  });

  test('api.ui_execute_task_claim_v1 claims visible unassigned dispatch exception reviews', async () => {
    const seed = await seedDeliveryStopTask();
    const claimantUserId = await createUser(
      client,
      seed.organizationId,
      `dispatch-claim-${randomUUID().slice(0, 8)}@example.com`,
      {
        accessScopeType: 'tenant',
        userType: 'ops_admin',
        rbacTemplateKey: 'ops_admin'
      }
    );

    await completeStopAndFinalize(seed, 'no_answer', `dispatch-stop-claim-${randomUUID()}`);

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();

    await client.query(
      `UPDATE tasks
          SET assigned_to = NULL,
              assigned_at = NULL,
              updated_at = now()
        WHERE id = $1::uuid`,
      [followup.task_id]
    );

    await setAuthContext(client, claimantUserId, { organization_id: seed.organizationId });

    const { rows } = await client.query(
      `SELECT api.ui_execute_task_claim_v1(
         $1::text,
         $2::text,
         ARRAY[$3::text],
         $3::text,
         1,
         $4::jsonb
       ) AS payload`,
      [
        'unassigned_exceptions.claim',
        'unassigned_exceptions',
        String(followup.task_id),
        JSON.stringify({ notes: 'Claim from UC114 integration proof' })
      ]
    );
    const payload = rows[0]?.payload ?? null;

    expect(payload?.status).toBe('task_claimed');
    expect(Number(payload?.claimed_count ?? 0)).toBe(1);
    expect(Number(payload?.already_assigned_count ?? 0)).toBe(0);
    expect(Number(payload?.conflict_count ?? 0)).toBe(0);

    const claimedTask = await getTaskRow(followup.task_id);
    expect(claimedTask?.assigned_to).toBe(claimantUserId);
    expect(claimedTask?.assigned_at).toBeTruthy();

    const latestAssignedEvent = await getLatestTaskEvent(followup.task_id, 'assigned');
    expect(latestAssignedEvent?.actor_user_id).toBe(claimantUserId);
  });

  test('dispatch SLA API projection preserves service authenticated and anon boundaries across tenants', async () => {
    const fixtures = [];
    for (const suffix of ['a', 'b']) {
      const seed = await seedDeliveryStopTask();
      await completeStopAndFinalize(seed, 'no_answer', `projection-${suffix}-${randomUUID()}`);
      const followup = await getTaskSnapshotForResource(seed.organizationId, 'shipment', seed.shipmentId, 'dispatch_exception_review');
      expect(followup?.task_id).toBeTruthy();
      await withFixtureAdminContext(client, adminClient => adminClient.query(
        `UPDATE public.tasks SET sla_due_at = now() - interval '5 minutes', sla_breached_at = now()
          WHERE id = $1::uuid AND organization_id = $2::uuid`,
        [followup.task_id, seed.organizationId]));
      fixtures.push({ ...seed, taskId: followup.task_id });
    }
    expect(fixtures[0].organizationId).not.toBe(fixtures[1].organizationId);
    const readIds = async role => {
      expect((await client.query('SELECT current_user AS role')).rows[0].role).toBe(role);
      return (await client.query('SELECT id FROM api.dispatch_exception_review_sla_breaches_v')).rows.map(row => row.id);
    };
    await setServiceContext(fixtures[0].organizationId, fixtures[0].opsOwnerId);
    expect(await readIds('service_role')).toEqual(expect.arrayContaining(fixtures.map(f => f.taskId)));
    for (const [index, fixture] of fixtures.entries()) {
      await setAuthContext(client, fixture.opsOwnerId, { organization_id: fixture.organizationId });
      const ids = await readIds('authenticated');
      expect(ids).toContain(fixture.taskId);
      expect(ids).not.toContain(fixtures[1 - index].taskId);
    }
    await client.query('SAVEPOINT projection_anon');
    try {
      await client.query('SET LOCAL ROLE anon');
      await client.query("SELECT set_config('request.jwt.claims', '{\"role\":\"anon\"}', true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'anon', true)");
      expect((await client.query('SELECT current_user AS role')).rows[0].role).toBe('anon');
      await expect(client.query('SELECT id FROM api.dispatch_exception_review_sla_breaches_v')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT projection_anon');
      await client.query('RELEASE SAVEPOINT projection_anon');
    }
  });

  test('dispatch exception SLA sweeper stamps breach evidence once', async () => {
    const seed = await seedDeliveryStopTask();

    await completeStopAndFinalize(seed, 'no_answer', `dispatch-stop-sla-breach-${randomUUID()}`);

    const followup = await getTaskSnapshotForResource(
      seed.organizationId,
      'shipment',
      seed.shipmentId,
      'dispatch_exception_review'
    );
    expect(followup?.task_id).toBeTruthy();

    await client.query(
      `UPDATE tasks
          SET sla_due_at = now() + interval '1 day',
              sla_breached_at = NULL,
              updated_at = now()
        WHERE task_type_key = 'dispatch_exception_review'`,
    );

    await client.query(
      `UPDATE tasks
          SET sla_due_at = now() - interval '5 minutes',
              sla_breached_at = NULL,
              updated_at = now()
        WHERE id = $1::uuid`,
      [followup.task_id]
    );

    const { rows: firstSweepRows } = await client.query(
      `SELECT public.ops_sweeper_dispatch_exception_review_sla_breaches($1::jsonb) AS payload`,
      [JSON.stringify({ limit: 10 })]
    );
    const firstSweep = firstSweepRows[0]?.payload ?? null;
    expect(Number(firstSweep?.marked_count ?? 0)).toBe(1);

    const breachedTask = await getTaskRow(followup.task_id);
    expect(breachedTask?.sla_breached_at).toBeTruthy();
    expect(breachedTask?.status_reason).toBe('no_answer');
    expect(breachedTask?.metadata?.dispatch_exception_reason).toBe('no_answer');

    const { rows: breachViewRows } = await client.query(
      `SELECT dispatch_exception_reason
         FROM api.dispatch_exception_review_sla_breaches_v
        WHERE id = $1::uuid
        LIMIT 1`,
      [followup.task_id]
    );
    expect(breachViewRows[0]?.dispatch_exception_reason).toBe('no_answer');

    const breachEvent = await getLatestTaskEvent(followup.task_id, 'sla_breached');
    expect(breachEvent?.decision_log_id).toBeTruthy();

    const { rows: decisionRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT decision_point, decision_outcome
         FROM decision_log
        WHERE id = $1::uuid
        LIMIT 1`,
      [breachEvent.decision_log_id]
    ));
    expect(decisionRows[0]?.decision_point).toBe('sla_breach');
    expect(decisionRows[0]?.decision_outcome).toBe('breached');
    expect(await countTaskEvents(followup.task_id, 'sla_breached')).toBe(1);

    const { rows: secondSweepRows } = await client.query(
      `SELECT public.ops_sweeper_dispatch_exception_review_sla_breaches($1::jsonb) AS payload`,
      [JSON.stringify({ limit: 10 })]
    );
    const secondSweep = secondSweepRows[0]?.payload ?? null;
    expect(Number(secondSweep?.marked_count ?? 0)).toBe(0);
    expect(await countTaskEvents(followup.task_id, 'sla_breached')).toBe(1);
  });
});
