const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  createOrganization,
  createClient,
  createUser,
  createShipment,
  withFixtureAdminContext,
  setServiceContext: setCanonicalServiceContext,
} = require('../helpers/tenant-utils');

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('Task completion effects pipeline', () => {
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

  async function runDomainEventsWorkerOnce() {
    await withFixtureAdminContext(client, async () => {
      await client.query(
        `INSERT INTO cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
         VALUES ('domain_events_worker', 60, 50, true, 'integration ensure worker throttle')
         ON CONFLICT (worker_name)
         DO UPDATE SET enabled = true, interval_seconds = EXCLUDED.interval_seconds, batch_size = EXCLUDED.batch_size`
      );
      await client.query(
        `UPDATE cron_config
            SET last_run_at = now() - interval '5 minutes'
          WHERE worker_name = 'domain_events_worker'`
      );
    });

    await client.query(`SELECT run_domain_events_worker()`);
  }

  async function waitForDomainEventWorkflowRun(domainEventId, maxAttempts = 50) {
    for (let i = 0; i < maxAttempts; i += 1) {
      await runDomainEventsWorkerOnce();
      const { rows } = await withFixtureAdminContext(client, () =>
        client.query(
          `SELECT workflow_run_id
             FROM domain_events
            WHERE id = $1::uuid`,
          [domainEventId]
        )
      );
      const workflowRunId = rows[0]?.workflow_run_id ?? null;
      if (workflowRunId) {
        return workflowRunId;
      }
    }
    return null;
  }

  async function progressWorkflowFully(workflowRunId) {
    let lastResult = null;
    for (let i = 0; i < 50; i += 1) {
      const { rows } = await client.query(`SELECT progress_workflow_run($1::uuid) AS result`, [
        workflowRunId
      ]);
      const result = rows[0]?.result;
      lastResult = result ?? null;
      if (!result?.step_id) break;
      if (result.status === 'failed') break;
    }
    return lastResult;
  }

  async function getGlobalTaskCompletionEffectsPolicy() {
    const vScopeHash = '00000000-0000-0000-0000-000000000000';

    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT cached_value
           FROM settings
          WHERE category = 'task_completion_effects_policy'
            AND scope_type = 'global'
            AND scope_hash = $1::uuid
          LIMIT 1`,
        [vScopeHash]
      )
    );

    return rows[0]?.cached_value;
  }

  async function getGlobalTaskCompletionEffect(taskTypeKey) {
    const policy = await getGlobalTaskCompletionEffectsPolicy();
    const defaults = policy?.defaults ?? {};
    const effect = policy?.task_type_map && policy.task_type_map[taskTypeKey];

    expect(effect).toBeTruthy();
    expect(typeof effect).toBe('object');

    const expectedShipmentStatus = effect.shipment_status ?? null;
    const expectedActionType = effect.action_type ?? defaults.action_type ?? null;
    const expectedActionCategory = effect.action_category ?? defaults.action_category ?? null;

    expect(expectedActionType).toBeTruthy();
    expect(expectedActionCategory).toBeTruthy();

    return { effect, expectedShipmentStatus, expectedActionType, expectedActionCategory };
  }

  async function seedShipmentForTaskEffects(serviceType = 'delivery') {
    const { id: organizationId } = await createOrganization(client, 'Task Completion Effects Org');
    const { id: clientId } = await createClient(client, organizationId, 'Task Completion Effects Client');
    const userId = await createUser(
      client,
      organizationId,
      `task-effects-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, userId);

    const initialStatus = 'pending';
    const { id: shipmentId } = await createShipment(client, {
      organizationId,
      clientId,
      serviceType,
      status: initialStatus
    });

    return { organizationId, clientId, userId, shipmentId, initialStatus };
  }

  async function createTaskForShipment({ organizationId, clientId, shipmentId }, taskTypeKey) {
    const payload = {
      task_type_key: taskTypeKey,
      context: {
        organization_id: organizationId,
        client_id: clientId
      },
      resource_type: 'shipment',
      resource_id: shipmentId,
      idempotency_key: `task-effects-create-${taskTypeKey}-${randomUUID()}`
    };

    const { rows } = await client.query(
      `SELECT task_id, task_event_id, workflow_run_id
         FROM create_task_system_v1($1::jsonb)`,
      [JSON.stringify(payload)]
    );

    const row = rows[0];
    expect(row?.task_id).toBeTruthy();
    return { taskId: row.task_id };
  }

  async function completeTaskAndApplyEffects({ organizationId, shipmentId }, taskTypeKey, taskId) {
    const { rows: transitionRows } = await client.query(
      `SELECT task_event_id
         FROM transition_task_v1(
          $1::uuid,
          'completed',
          NULL,
          '{}'::jsonb,
          $2
        )`,
      [taskId, `task-effects-complete-${taskTypeKey}-${randomUUID()}`]
    );
    const taskEventId = transitionRows[0]?.task_event_id;
    expect(taskEventId).toBeTruthy();

    const { rows: domainEventRows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT id
           FROM domain_events
          WHERE organization_id = $1::uuid
            AND event_type = $2
            AND resource_type = 'shipment'
            AND resource_id = $3::uuid
            AND (payload->>'task_event_id') = $4
          ORDER BY created_at DESC
          LIMIT 1`,
        [organizationId, `task.completed.${taskTypeKey}`, shipmentId, String(taskEventId)]
      )
    );
    const domainEventId = domainEventRows[0]?.id;
    expect(domainEventId).toBeTruthy();

    const workflowRunId = await waitForDomainEventWorkflowRun(domainEventId);
    expect(workflowRunId).toBeTruthy();

    const finalProgress = await progressWorkflowFully(workflowRunId);

    const { rows: workflowRows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT context #>> '{task_effects,shipment_action_id}' AS shipment_action_id
           FROM workflow_runs
          WHERE id = $1::uuid`,
        [workflowRunId]
      )
    );

    return {
      taskEventId,
      workflowRunId,
      shipmentActionId:
        finalProgress?.shipment_action_id ??
        finalProgress?.operation_result?.shipment_action_id ??
        workflowRows[0]?.shipment_action_id ??
        null
    };
  }

  async function getShipmentStatus(shipmentId, clientId) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT status
           FROM shipments
          WHERE id = $1::uuid
            AND client_id = $2::uuid
          LIMIT 1`,
        [shipmentId, clientId]
      )
    );
    return rows[0]?.status ?? null;
  }

  async function findShipmentActionForTaskEvent(shipmentId, taskEventId, shipmentActionId = null) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { rows } = await withFixtureAdminContext(client, () =>
        client.query(
          `SELECT id, action_type, action_category, canonical_status
             FROM shipment_actions
            WHERE shipment_id = $1::uuid
              AND (
                (action_data->>'task_event_id') = $2
                OR ($3::uuid IS NOT NULL AND id = $3::uuid)
              )
            ORDER BY
              CASE
                WHEN (action_data->>'task_event_id') = $2 THEN 0
                ELSE 1
              END,
              created_at DESC
            LIMIT 1`,
          [shipmentId, String(taskEventId), shipmentActionId]
        )
      );

      if (rows[0]) {
        return rows[0];
      }

      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    return null;
  }

  test.each([
    'dispatch_reschedule_delivery',
    'dispatch_reattempt_delivery',
    'dispatch_rto_pickup',
    'dispatch_return_pickup',
    'dispatch_swap_completion',
    'warehouse_receive',
    'warehouse_sort',
    'warehouse_stage',
    'warehouse_load_vehicle',
    'warehouse_exception_hold'
  ])(
    'task completion %s follows task_completion_effects_policy defaults end-to-end',
    async (taskTypeKey) => {
      const seed = await seedShipmentForTaskEffects(
        taskTypeKey === 'dispatch_swap_completion' ? 'swap' : 'delivery'
      );
      const { expectedShipmentStatus, expectedActionType, expectedActionCategory } =
        await getGlobalTaskCompletionEffect(taskTypeKey);

      const { taskId } = await createTaskForShipment(seed, taskTypeKey);

      const { taskEventId, shipmentActionId } = await completeTaskAndApplyEffects(
        seed,
        taskTypeKey,
        taskId
      );

      const shipmentStatus = await getShipmentStatus(seed.shipmentId, seed.clientId);
      expect(shipmentStatus).toBe(expectedShipmentStatus ?? seed.initialStatus);

      const action = await findShipmentActionForTaskEvent(
        seed.shipmentId,
        taskEventId,
        shipmentActionId
      );
      expect(action).toBeTruthy();
      expect(action.action_type).toBe(expectedActionType);
      expect(action.action_category).toBe(expectedActionCategory);
      expect(action.canonical_status ?? null).toBe(expectedShipmentStatus);
    }
  );
});
