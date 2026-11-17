const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  createOrganization,
  createClient,
  createUser,
  createSender,
  setAuthContext,
} = require('../helpers/tenant-utils');
const {
  createPickupRequest,
  createPickupWave,
} = require('../helpers/pickup-utils');

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('FieldOps pickup execution contract', () => {
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
    await client.query('SET LOCAL ROLE service_role');

    const claims = {
      role: 'service_role',
      sub: userId,
      organization_id: organizationId,
    };

    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ]);
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', String(userId)]);
  }

  async function runDomainEventsWorkerOnce() {
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

    await client.query(`SELECT run_domain_events_worker()`);
  }

  async function waitForDomainEventWorkflowRun(domainEventId, maxAttempts = 50) {
    for (let i = 0; i < maxAttempts; i += 1) {
      await runDomainEventsWorkerOnce();
      const { rows } = await client.query(
        `SELECT workflow_run_id
           FROM domain_events
          WHERE id = $1::uuid`,
        [domainEventId]
      );
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
        workflowRunId,
      ]);
      const result = rows[0]?.result;
      if (!result?.step_id) break;
      if (result.status === 'failed') break;
    }
  }

  async function seedPickupRouteStopTask() {
    const { id: organizationId } = await createOrganization(client, 'FieldOps Pickup Org');
    const { id: clientId } = await createClient(client, organizationId, 'FieldOps Pickup Client');
    const senderId = await createSender(client, clientId, 'FieldOps Pickup Sender', {
      brandName: 'FieldOps Pickup Sender',
    });
    const dispatcherUserId = await createUser(
      client,
      organizationId,
      `fieldops-dispatch-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', provisionRbac: false, fullName: 'FieldOps Dispatcher' }
    );
    const driverUserId = await createUser(
      client,
      organizationId,
      `fieldops-pickup-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver' }
    );

    await setServiceContext(organizationId, dispatcherUserId);

    const pickupRequest = await createPickupRequest(
      client,
      {
        organizationId,
        clientId,
        senderId,
        userId: dispatcherUserId,
      },
      {
        idempotency_key: `fieldops-pickup-request-${randomUUID()}`,
        client_reference_number: `fieldops-pickup-${randomUUID().slice(0, 8)}`,
        box_count: 4,
      }
    );

    const wave = await createPickupWave(
      client,
      {
        organizationId,
      },
      [pickupRequest.shipment_id],
      {
        idempotency_key: `fieldops-pickup-wave-${randomUUID()}`,
      }
    );

    const shipmentId = pickupRequest.shipment_id;
    const routeStopId = wave.stop_ids[0];
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
    const routeStopTaskId = taskRows[0]?.task_id;
    expect(routeStopTaskId).toBeTruthy();

    return {
      organizationId,
      clientId,
      dispatcherUserId,
      userId: driverUserId,
      driverUserId,
      shipmentId,
      routeStopId,
      routeStopTaskId,
    };
  }

  async function executeUiCommand(client, input) {
    await setAuthContext(client, input.userId, { organization_id: input.organizationId });
    const { rows } = await client.query(
      `SELECT public.ui_execute_command_v1(
          $1::text,
          $2::text,
          ARRAY[$3::text],
          $3::text,
          1,
          $4::jsonb
        ) AS payload`,
      [input.actionKey, 'tasks', input.routeStopTaskId, JSON.stringify(input.params)]
    );
    return rows[0]?.payload ?? null;
  }

  async function getTaskRow(taskId) {
    const { rows } = await client.query(
      `SELECT id, status, status_reason, completed_at
         FROM tasks
        WHERE id = $1::uuid
        LIMIT 1`,
      [taskId]
    );
    return rows[0] ?? null;
  }

  async function getLatestTaskEvent(taskId) {
    const { rows } = await client.query(
      `SELECT payload
         FROM task_events
        WHERE task_id = $1::uuid
          AND event_type = 'status_changed'
        ORDER BY task_version DESC, created_at DESC, id DESC
        LIMIT 1`,
      [taskId]
    );
    return rows[0]?.payload ?? null;
  }

  async function getShipmentStatus(shipmentId, clientId) {
    const { rows } = await client.query(
      `SELECT status
         FROM shipments
        WHERE id = $1::uuid
          AND client_id = $2::uuid
        LIMIT 1`,
      [shipmentId, clientId]
    );
    return rows[0]?.status ?? null;
  }

  test('pickup completion captures quantity and handover payload then finalizes the stop', async () => {
    const seed = await seedPickupRouteStopTask();
    const payload = {
      payload: {
        confirmed_quantity: 4,
        handover_contact_name: 'Sara QA',
        handover_notes: 'Handover confirmed at the front desk.',
        receipt_context: 'Dock 7 / receipt 19',
      },
    };

    const result = await executeUiCommand(client, {
      ...seed,
      actionKey: 'tasks.complete',
      params: payload,
    });

    expect(result?.status).toBe('task_transitioned');

    const taskRow = await getTaskRow(seed.routeStopTaskId);
    expect(taskRow?.status).toBe('completed');
    expect(taskRow?.status_reason ?? null).toBeNull();

    const taskEventPayload = await getLatestTaskEvent(seed.routeStopTaskId);
    expect(taskEventPayload?.confirmed_quantity).toBe(4);
    expect(taskEventPayload?.handover_contact_name).toBe('Sara QA');
    expect(taskEventPayload?.handover_notes).toContain('front desk');
    expect(taskEventPayload?.receipt_context).toContain('Dock 7');

    const { rows: domainEventRows } = await client.query(
      `SELECT id
         FROM domain_events
        WHERE organization_id = $1::uuid
          AND event_type = 'task.completed.route_stop_execute'
          AND resource_type = 'route_stop'
          AND resource_id = $2::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      [seed.organizationId, seed.routeStopId]
    );
    const domainEventId = domainEventRows[0]?.id;
    expect(domainEventId).toBeTruthy();

    await setServiceContext(seed.organizationId, seed.dispatcherUserId);
    const workflowRunId = await waitForDomainEventWorkflowRun(domainEventId);
    expect(workflowRunId).toBeTruthy();

    await progressWorkflowFully(workflowRunId);

    const shipmentStatus = await getShipmentStatus(seed.shipmentId, seed.clientId);
    expect(shipmentStatus).toBe('in_transit');
  });

  test('pickup failure uses the completed route-stop bridge and leaves the shipment in pickup_failed', async () => {
    const seed = await seedPickupRouteStopTask();
    const payload = {
      payload: {
        exception_reason: 'pickup_not_ready',
        exception_notes: 'Sender asked to reschedule after inventory reconciliation.',
      },
    };

    const result = await executeUiCommand(client, {
      ...seed,
      actionKey: 'tasks.exception',
      params: payload,
    });

    expect(result?.status).toBe('task_transitioned');

    const taskRow = await getTaskRow(seed.routeStopTaskId);
    expect(taskRow?.status).toBe('completed');
    expect(taskRow?.status_reason).toBe('pickup_not_ready');

    const taskEventPayload = await getLatestTaskEvent(seed.routeStopTaskId);
    expect(taskEventPayload?.exception_reason).toBe('pickup_not_ready');
    expect(taskEventPayload?.status_reason).toBe('pickup_not_ready');

    const { rows: domainEventRows } = await client.query(
      `SELECT id
         FROM domain_events
        WHERE organization_id = $1::uuid
          AND event_type = 'task.completed.route_stop_execute'
          AND resource_type = 'route_stop'
          AND resource_id = $2::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      [seed.organizationId, seed.routeStopId]
    );
    const domainEventId = domainEventRows[0]?.id;
    expect(domainEventId).toBeTruthy();

    await setServiceContext(seed.organizationId, seed.dispatcherUserId);
    const workflowRunId = await waitForDomainEventWorkflowRun(domainEventId);
    expect(workflowRunId).toBeTruthy();

    await progressWorkflowFully(workflowRunId);

    const shipmentStatus = await getShipmentStatus(seed.shipmentId, seed.clientId);
    expect(shipmentStatus).toBe('pickup_failed');
  });
});
