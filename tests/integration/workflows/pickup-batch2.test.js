const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { upsertSettings } = require('../../utils/policies');
const {
  createOrganization,
  createClient,
  createSender,
  createUser,
  setFixtureUserPolicyCapabilities,
  setAuthContext,
  withFixtureAdminContext,
  setServiceContext: setCanonicalServiceContext,
} = require('../helpers/tenant-utils');
const {
  createPickupRequest,
  createPickupWave,
  assignPickupWave
} = require('../helpers/pickup-utils');

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('Pickup batch B02 regression pack', () => {
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

  async function setAuthenticatedContext(organizationId, userId) {
    await setAuthContext(client, userId, { organization_id: organizationId });
  }

  async function seedPickupScope(namePrefix, options = {}) {
    const { id: organizationId } = await createOrganization(client, `${namePrefix} Pickup Org`);
    const { id: clientId } = await createClient(client, organizationId, `${namePrefix} Pickup Client`);
    const senderId = await createSender(client, clientId, `${namePrefix} Pickup Sender`, {
      brandName: `${namePrefix} Pickup Sender`
    });
    const userId = await createUser(
      client,
      organizationId,
      `${namePrefix}-${randomUUID().slice(0, 8)}@example.com`,
      {
        accessScopeType: 'tenant',
        provisionRbac: options.provisionRbac ?? false,
        userType: options.userType,
        rbacTemplateKey: options.rbacTemplateKey,
        fullName: `${namePrefix} Pickup User`
      }
    );

    await setServiceContext(organizationId, userId);

    return { organizationId, clientId, senderId, userId };
  }

  async function allowUnassignedPickup(seed) {
    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT public.pickup_policy_default_v1() AS policy`
    ));
    const policy = rows[0]?.policy || {};
    await withFixtureAdminContext(client, (adminClient) => upsertSettings(
      'pickup_policy',
      'tenant',
      seed.organizationId,
      {
        ...policy,
        assignment: {
          ...(policy.assignment || {}),
          require_driver_or_partner: false
        }
      },
      'pickup assignment integration permits unassigned waves',
      adminClient
    ));
  }

  async function readSessionContext() {
    const { rows } = await client.query(
      `SELECT
          current_setting('request.jwt.claims', true) AS claims,
          current_setting('request.jwt.claim.role', true) AS role,
          current_setting('request.jwt.claim.sub', true) AS sub,
          current_setting('app.actor_system', true) AS actor_system`
    );
    return rows[0];
  }

  async function createScopedPickupReader(seed, scopeType) {
    const normalizedScopeType = String(scopeType || '').trim().toLowerCase();
    if (!['client', 'sender'].includes(normalizedScopeType)) {
      throw new Error(`Unsupported pickup reader scope ${scopeType}`);
    }

    const accessScopeId =
      normalizedScopeType === 'client' ? seed.clientId : seed.senderId;
    const userType =
      normalizedScopeType === 'client' ? 'client_admin' : 'sender_user';

    return await createUser(
      client,
      seed.organizationId,
      `${normalizedScopeType}-${randomUUID().slice(0, 8)}@example.com`,
      {
        accessScopeType: normalizedScopeType,
        accessScopeId,
        provisionRbac: false,
        userType,
        fullName: `${normalizedScopeType} pickup reader`
      }
    );
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

  async function getShipmentStatus(shipmentId) {
    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT status
         FROM shipments
        WHERE id = $1::uuid
        LIMIT 1`,
      [shipmentId]
    ));
    return rows[0]?.status ?? null;
  }

  async function getPickupRequestViewRow(shipmentId) {
    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT *
         FROM pickup_requests
        WHERE shipment_id = $1::uuid
        LIMIT 1`,
      [shipmentId]
    ));
    return rows[0] ?? null;
  }

  async function getPickupWaveViewRow(routeRunId) {
    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT *
         FROM pickup_waves
        WHERE route_run_id = $1::uuid
        LIMIT 1`,
      [routeRunId]
    ));
    return rows[0] ?? null;
  }

  async function getPickupFailureViewRow(shipmentId) {
    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT *
         FROM pickup_failures
        WHERE shipment_id = $1::uuid
        LIMIT 1`,
      [shipmentId]
    ));
    return rows[0] ?? null;
  }

  async function getTaskIdForResource(organizationId, resourceType, resourceId, taskTypeKey) {
    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
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
    ));
    return rows[0]?.task_id ?? null;
  }

  async function completeTask(taskId, statusReason, idempotencyKey, payload = {}) {
    const { rows: transitionRows } = await client.query(
      `SELECT task_event_id
         FROM transition_task_v1(
          $1::uuid,
          'completed',
          $2,
          $3::jsonb,
          $4
        )`,
      [taskId, statusReason, JSON.stringify(payload), idempotencyKey]
    );
    const taskEventId = transitionRows[0]?.task_event_id ?? null;
    expect(taskEventId).toBeTruthy();

    const { rows: domainEventRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT id
         FROM domain_events
        WHERE (payload->>'task_event_id') = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [String(taskEventId)]
    ));
    const domainEventId = domainEventRows[0]?.id ?? null;
    expect(domainEventId).toBeTruthy();

    return { taskEventId, domainEventId };
  }

  test('create_pickup_request_v1 is idempotent and projects request data into pickup_requests', async () => {
    const seed = await seedPickupScope('pickup-request');
    const requestIdempotencyKey = `pickup-request-idem-${randomUUID()}`;
    const clientReferenceNumber = `pickup-client-ref-${randomUUID().slice(0, 8)}`;

    const first = await createPickupRequest(client, seed, {
      idempotency_key: requestIdempotencyKey,
      client_reference_number: clientReferenceNumber,
      box_count: 3
    });
    const second = await createPickupRequest(client, seed, {
      idempotency_key: requestIdempotencyKey,
      client_reference_number: clientReferenceNumber,
      box_count: 3
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.shipment_id).toBeTruthy();
    expect(first.shipment_id).toBe(second.shipment_id);
    expect(String(first.tracking_number || '')).toMatch(/^PU/);
    expect(first.origin_address_id).toBeTruthy();
    expect(first.shipment_action_id).toBeTruthy();

    const shipmentStatus = await getShipmentStatus(first.shipment_id);
    expect(shipmentStatus).toBe('pickup_requested');

    const pickupRequest = await getPickupRequestViewRow(first.shipment_id);
    expect(pickupRequest).toBeTruthy();
    expect(pickupRequest.status).toBe('pickup_requested');
    expect(pickupRequest.origin_line1).toBe('12 Warehouse Road');
    expect(pickupRequest.requested_window_start_at).toBeTruthy();
    expect(pickupRequest.requested_window_end_at).toBeTruthy();
    expect(pickupRequest.pickup_request?.requested_by_user_id).toBe(seed.userId);

    const { rows: shipmentCountRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT COUNT(*)::int AS count
         FROM shipments
        WHERE organization_id = $1::uuid
          AND client_id = $2::uuid
          AND service_type = 'pickup'`,
      [seed.organizationId, seed.clientId]
    ));
    expect(shipmentCountRows[0]?.count).toBe(1);
  });

  test('create_pickup_wave_v1 groups pickup shipments and supports internal driver assignment', async () => {
    const seed = await seedPickupScope('pickup-wave-driver');
    const clientReferenceA = `pickup-wave-a-${randomUUID().slice(0, 8)}`;
    const clientReferenceB = `pickup-wave-b-${randomUUID().slice(0, 8)}`;
    const requestA = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-a-${randomUUID()}`,
      client_reference_number: clientReferenceA,
      box_count: 2
    });
    const requestB = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-b-${randomUUID()}`,
      client_reference_number: clientReferenceB,
      box_count: 4
    });

    const waveIdempotencyKey = `pickup-wave-idem-${randomUUID()}`;
    const firstWave = await createPickupWave(client, seed, [requestA.shipment_id, requestB.shipment_id], {
      idempotency_key: waveIdempotencyKey
    });
    const secondWave = await createPickupWave(client, seed, [requestA.shipment_id, requestB.shipment_id], {
      idempotency_key: waveIdempotencyKey
    });

    expect(firstWave.created).toBe(true);
    expect(secondWave.created).toBe(false);
    expect(firstWave.route_run_id).toBeTruthy();
    expect(firstWave.route_run_id).toBe(secondWave.route_run_id);
    expect(Array.isArray(firstWave.stop_ids)).toBe(true);
    expect(firstWave.stop_ids.length).toBe(2);
    expect(firstWave.shipment_count).toBe(2);

    expect(await getShipmentStatus(requestA.shipment_id)).toBe('pickup_scheduled');
    expect(await getShipmentStatus(requestB.shipment_id)).toBe('pickup_scheduled');

    const pickupWave = await getPickupWaveViewRow(firstWave.route_run_id);
    expect(pickupWave).toBeTruthy();
    expect(Number(pickupWave.pickup_stop_count)).toBe(2);
    expect(Number(pickupWave.total_box_count)).toBe(6);
    expect(Array.isArray(pickupWave.shipments)).toBe(true);
    expect(pickupWave.shipments.length).toBe(2);

    const driverUserId = await createUser(
      client,
      seed.organizationId,
      `pickup-driver-${randomUUID().slice(0, 8)}@example.com`,
      {
        accessScopeType: 'tenant',
        userType: 'driver',
        fullName: 'Pickup Driver'
      }
    );
    const vehicleId = randomUUID();
    const assignmentIdempotencyKey = `pickup-assign-driver-${randomUUID()}`;
    await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `INSERT INTO vehicles (id, organization_id, status, is_active)
       VALUES ($1::uuid, $2::uuid, 'active', true)`,
      [vehicleId, seed.organizationId]
    ));

    const sessionContextBeforeAssignment = await readSessionContext();
    const assignment = await assignPickupWave(client, seed, firstWave.route_run_id, {
      driver_user_id: driverUserId,
      vehicle_id: vehicleId,
      idempotency_key: assignmentIdempotencyKey
    });
    expect(await readSessionContext()).toEqual(sessionContextBeforeAssignment);
    const duplicateAssignment = await assignPickupWave(client, seed, firstWave.route_run_id, {
      driver_user_id: driverUserId,
      vehicle_id: vehicleId,
      idempotency_key: assignmentIdempotencyKey
    });

    expect(assignment.created).toBe(true);
    expect(duplicateAssignment.created).toBe(false);
    expect(assignment.assignment_mode).toBe('internal_driver');
    expect(assignment.driver_user_id).toBe(driverUserId);
    expect(assignment.vehicle_id).toBe(vehicleId);

    const { rows: routeRunRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT driver_user_id, vehicle_id, metadata
         FROM route_runs
        WHERE id = $1::uuid
        LIMIT 1`,
      [firstWave.route_run_id]
    ));
    const routeRun = routeRunRows[0];
    expect(routeRun.driver_user_id).toBe(driverUserId);
    expect(routeRun.vehicle_id).toBe(vehicleId);
    expect(routeRun.metadata?.pickup_assignment?.assignment_mode).toBe('internal_driver');

    const pickupWaveAfterAssignment = await getPickupWaveViewRow(firstWave.route_run_id);
    expect(pickupWaveAfterAssignment.pickup_assignment?.assignment_mode).toBe('internal_driver');
    expect(pickupWaveAfterAssignment.pickup_assignment?.driver_user_id).toBe(driverUserId);
    expect(pickupWaveAfterAssignment.pickup_assignment?.vehicle_id).toBe(vehicleId);

    const { rows: canonicalAssignmentRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT
          rra.assignment_mode,
          rra.driver_user_id,
          rra.vehicle_id,
          ev.actor_user_id,
          ev.actor_system,
          ev.idempotency_key
         FROM route_run_assignments rra
         JOIN route_run_assignment_events ev
           ON ev.route_run_assignment_id = rra.id
          AND ev.assignment_version = rra.assignment_version
        WHERE rra.route_run_id = $1::uuid`,
      [firstWave.route_run_id]
    ));
    expect(canonicalAssignmentRows).toEqual([expect.objectContaining({
      assignment_mode: 'internal_driver',
      driver_user_id: driverUserId,
      vehicle_id: vehicleId,
      actor_user_id: seed.userId,
      actor_system: 'public.assign_pickup_wave_v1',
      idempotency_key: assignmentIdempotencyKey
    })]);

    const { rows: assignedTaskRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT t.id, t.assigned_to, t.resource_id
         FROM tasks t
         JOIN task_types tt ON tt.id = t.task_type_id
         JOIN route_stops rs ON rs.id = t.resource_id
        WHERE t.resource_type = 'route_stop'
          AND tt.organization_id = $1::uuid
          AND tt.key = 'route_stop_execute'
          AND rs.route_run_id = $2::uuid
        ORDER BY rs.sequence_order, rs.created_at, rs.id`,
      [seed.organizationId, firstWave.route_run_id]
    ));
    expect(assignedTaskRows).toHaveLength(2);
    assignedTaskRows.forEach((task) => expect(task.assigned_to).toBe(driverUserId));
    const plannedAt = '2026-03-09T09:30:00.000Z';
    await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `UPDATE route_stops
          SET planned_window_start_at = $1::timestamptz
        WHERE id = $2::uuid`,
      [plannedAt, assignedTaskRows[0].resource_id]
    ));

    await setAuthenticatedContext(seed.organizationId, driverUserId);
    const { rows: visibleTaskRows } = await client.query(
      `SELECT public.ui_list_resource_v1('tasks', '{}'::jsonb, 25, 0, NULL) AS payload`
    );
    const { rows: smartTaskRows } = await client.query(
      `SELECT public.ui_list_resource_v1('tasks', '{}'::jsonb, 25, 0,
        '{"key":"smart_order","direction":"asc"}'::jsonb) AS payload`
    );
    const { rows: taskMetricRows } = await client.query(
      `SELECT public.ui_resource_metrics_v1(
        'tasks', '{}'::jsonb, ARRAY['urgency_now','urgency_today','urgency_later']::text[]
      ) AS payload`
    );
    const visibleTasks = visibleTaskRows[0]?.payload?.items || [];
    expect(visibleTasks.map((task) => task?.id)).toEqual(
      expect.arrayContaining(assignedTaskRows.map((task) => task.id))
    );
    const assignedTaskIds = new Set(assignedTaskRows.map((task) => task.id));
    const visibleAssignedTasks = visibleTasks.filter((task) => assignedTaskIds.has(task?.id));
    expect(visibleAssignedTasks.map((task) => task?.stop_kind)).toEqual(['pickup', 'pickup']);
    const { rows: assignedTaskDetailRows } = await client.query(
      `SELECT api.ui_get_resource_v1('tasks', $1::uuid) AS payload`,
      [assignedTaskRows[0].id]
    );
    expect(assignedTaskDetailRows[0]?.payload).toEqual(expect.objectContaining({
      id: assignedTaskRows[0].id,
      stop_kind: 'pickup'
    }));
    const visibleAssignedReferences = visibleTasks
      .filter((task) => assignedTaskIds.has(task?.id))
      .map((task) => task?.reference);
    expect(visibleAssignedReferences).toEqual(
      expect.arrayContaining([clientReferenceA, clientReferenceB])
    );
    expect(new Date(
      visibleTasks.find((task) => task?.id === assignedTaskRows[0].id)?.planned_at
    ).toISOString()).toBe(plannedAt);
    expect(smartTaskRows[0]?.payload?.items).toBeInstanceOf(Array);
    expect(smartTaskRows[0].payload.items.map((task) => task?.id)).toEqual(
      expect.arrayContaining(assignedTaskRows.map((task) => task.id))
    );
    const taskMetrics = taskMetricRows[0]?.payload;
    expect(Number(taskMetrics?.total)).toBeGreaterThanOrEqual(assignedTaskRows.length);
    expect(
      ['urgency_now', 'urgency_today', 'urgency_later']
        .map((key) => Number(taskMetrics?.columns?.[key]?.sum || 0))
        .reduce((total, count) => total + count, 0)
    ).toBe(Number(taskMetrics?.total));

    const taskOnlyReaderId = await createUser(
      client,
      seed.organizationId,
      `pickup-task-reader-${randomUUID().slice(0, 8)}@example.com`,
      {
        accessScopeType: 'tenant',
        provisionRbac: false,
        userType: 'driver',
        fullName: 'Pickup Task Reader'
      }
    );
    await setFixtureUserPolicyCapabilities(
      client,
      seed.organizationId,
      taskOnlyReaderId,
      ['tasks.read']
    );
    await setAuthenticatedContext(seed.organizationId, taskOnlyReaderId);
    const { rows: taskOnlyReaderRows } = await client.query(
      `SELECT public.ui_list_resource_v1('tasks', '{}'::jsonb, 25, 0, NULL) AS payload`
    );
    const taskOnlyReaderTasks = taskOnlyReaderRows[0]?.payload?.items || [];
    const taskOnlyReaderById = new Map(taskOnlyReaderTasks.map((task) => [task?.id, task]));
    assignedTaskRows.forEach((task) => {
      expect(taskOnlyReaderById.has(task.id)).toBe(true);
      expect(taskOnlyReaderById.get(task.id)?.planned_at).toBeNull();
      expect(taskOnlyReaderById.get(task.id)?.stop_kind).toBeNull();
    });
    const { rows: taskOnlyDetailRows } = await client.query(
      `SELECT api.ui_get_resource_v1('tasks', $1::uuid) AS payload`,
      [assignedTaskRows[0].id]
    );
    expect(taskOnlyDetailRows[0]?.payload).toEqual(expect.objectContaining({
      id: assignedTaskRows[0].id,
      stop_kind: null
    }));
  });

  test('unassigned pickup assignment replays without creating canonical ownership', async () => {
    const seed = await seedPickupScope('pickup-wave-unassigned-replay');
    await allowUnassignedPickup(seed);
    const request = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-unassigned-${randomUUID()}`,
      client_reference_number: `pickup-unassigned-${randomUUID().slice(0, 8)}`
    });
    const wave = await createPickupWave(client, seed, [request.shipment_id], {
      idempotency_key: `pickup-wave-unassigned-${randomUUID()}`
    });
    const idempotencyKey = `pickup-assign-unassigned-${randomUUID()}`;

    const first = await assignPickupWave(client, seed, wave.route_run_id, {
      idempotency_key: idempotencyKey
    });
    const replay = await assignPickupWave(client, seed, wave.route_run_id, {
      idempotency_key: idempotencyKey
    });

    expect(first).toEqual(expect.objectContaining({ assignment_mode: 'unassigned', created: true }));
    expect(replay).toEqual(expect.objectContaining({ assignment_mode: 'unassigned', created: false }));
    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT
          (SELECT COUNT(*)::int FROM route_run_assignments WHERE route_run_id = $1::uuid) AS assignment_count,
          (SELECT COUNT(*)::int
             FROM tasks t
             JOIN task_types tt ON tt.id = t.task_type_id
             JOIN route_stops rs ON rs.id = t.resource_id
            WHERE tt.key = 'route_stop_execute'
              AND rs.route_run_id = $1::uuid
              AND t.assigned_to IS NOT NULL) AS assigned_task_count`,
      [wave.route_run_id]
    ));
    expect(rows[0]).toEqual({ assignment_count: 0, assigned_task_count: 0 });
  });

  test('unassigned pickup assignment cannot clear canonical route ownership', async () => {
    const seed = await seedPickupScope('pickup-wave-unassigned-guard');
    await allowUnassignedPickup(seed);
    const request = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-unassigned-guard-${randomUUID()}`,
      client_reference_number: `pickup-unassigned-guard-${randomUUID().slice(0, 8)}`
    });
    const wave = await createPickupWave(client, seed, [request.shipment_id], {
      idempotency_key: `pickup-wave-unassigned-guard-${randomUUID()}`
    });
    const driverUserId = await createUser(
      client,
      seed.organizationId,
      `pickup-unassigned-guard-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver' }
    );
    const vehicleId = randomUUID();
    await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `INSERT INTO vehicles (id, organization_id, status, is_active)
       VALUES ($1::uuid, $2::uuid, 'active', true)`,
      [vehicleId, seed.organizationId]
    ));
    await assignPickupWave(client, seed, wave.route_run_id, {
      driver_user_id: driverUserId,
      vehicle_id: vehicleId,
      idempotency_key: `pickup-assign-owner-${randomUUID()}`
    });

    await client.query('SAVEPOINT unassigned_after_owner');
    await expect(assignPickupWave(client, seed, wave.route_run_id, {
      idempotency_key: `pickup-assign-unassigned-after-owner-${randomUUID()}`
    })).rejects.toThrow(/cannot clear a canonical route assignment/i);
    await client.query('ROLLBACK TO SAVEPOINT unassigned_after_owner');
    await client.query('RELEASE SAVEPOINT unassigned_after_owner');

    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT
          rr.driver_user_id,
          rra.driver_user_id AS canonical_driver_user_id,
          COUNT(*) FILTER (WHERE t.assigned_to = $2::uuid)::int AS assigned_task_count
         FROM route_runs rr
         JOIN route_run_assignments rra ON rra.route_run_id = rr.id
         JOIN route_stops rs ON rs.route_run_id = rr.id
         JOIN tasks t ON t.resource_type = 'route_stop' AND t.resource_id = rs.id
         JOIN task_types tt ON tt.id = t.task_type_id AND tt.key = 'route_stop_execute'
        WHERE rr.id = $1::uuid
        GROUP BY rr.driver_user_id, rra.driver_user_id`,
      [wave.route_run_id, driverUserId]
    ));
    expect(rows).toEqual([{
      driver_user_id: driverUserId,
      canonical_driver_user_id: driverUserId,
      assigned_task_count: 1
    }]);
  });

  test('stale pickup replay cannot overwrite a later canonical reassignment', async () => {
    const seed = await seedPickupScope('pickup-wave-stale-replay');
    const request = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-stale-${randomUUID()}`,
      client_reference_number: `pickup-stale-${randomUUID().slice(0, 8)}`
    });
    const wave = await createPickupWave(client, seed, [request.shipment_id], {
      idempotency_key: `pickup-wave-stale-${randomUUID()}`
    });
    const driverA = await createUser(client, seed.organizationId, `pickup-driver-a-${randomUUID().slice(0, 8)}@example.com`, {
      accessScopeType: 'tenant', userType: 'driver'
    });
    const driverB = await createUser(client, seed.organizationId, `pickup-driver-b-${randomUUID().slice(0, 8)}@example.com`, {
      accessScopeType: 'tenant', userType: 'driver'
    });
    const vehicleId = randomUUID();
    await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `INSERT INTO vehicles (id, organization_id, status, is_active)
       VALUES ($1::uuid, $2::uuid, 'active', true)`,
      [vehicleId, seed.organizationId]
    ));
    const staleKey = `pickup-assign-stale-${randomUUID()}`;
    await assignPickupWave(client, seed, wave.route_run_id, {
      driver_user_id: driverA,
      vehicle_id: vehicleId,
      idempotency_key: staleKey
    });
    await client.query(
      `SELECT * FROM public.assign_route_run_v1($1::jsonb)`,
      [JSON.stringify({
        route_run_id: wave.route_run_id,
        assignment_mode: 'internal_driver',
        driver_user_id: driverB,
        vehicle_id: vehicleId,
        idempotency_key: `pickup-canonical-reassign-${randomUUID()}`,
        actor_user_id: seed.userId,
        actor_system: 'pickup-assignment-integration'
      })]
    );

    await client.query('SAVEPOINT stale_pickup_replay');
    await expect(assignPickupWave(client, seed, wave.route_run_id, {
      driver_user_id: driverA,
      vehicle_id: vehicleId,
      idempotency_key: staleKey
    })).rejects.toThrow(/conflicts with the current canonical route assignment state/i);
    await client.query('ROLLBACK TO SAVEPOINT stale_pickup_replay');
    await client.query('RELEASE SAVEPOINT stale_pickup_replay');

    const { rows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT
          rr.driver_user_id,
          rra.driver_user_id AS canonical_driver_user_id,
          COUNT(*) FILTER (WHERE t.assigned_to = $2::uuid)::int AS reassigned_task_count,
          COUNT(*) FILTER (WHERE t.assigned_to = $3::uuid)::int AS stale_task_count
         FROM route_runs rr
         JOIN route_run_assignments rra ON rra.route_run_id = rr.id
         JOIN route_stops rs ON rs.route_run_id = rr.id
         JOIN tasks t ON t.resource_type = 'route_stop' AND t.resource_id = rs.id
         JOIN task_types tt ON tt.id = t.task_type_id AND tt.key = 'route_stop_execute'
        WHERE rr.id = $1::uuid
        GROUP BY rr.driver_user_id, rra.driver_user_id`,
      [wave.route_run_id, driverB, driverA]
    ));
    expect(rows).toEqual([{
      driver_user_id: driverB,
      canonical_driver_user_id: driverB,
      reassigned_task_count: 1,
      stale_task_count: 0
    }]);
  });

  test('authenticated pickup wave creation can progress inline workflow fanout without service-role errors', async () => {
    const seed = await seedPickupScope('pickup-wave-authenticated', {
      provisionRbac: true,
      userType: 'ops_admin',
      rbacTemplateKey: 'ops_admin'
    });
    const request = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-auth-${randomUUID()}`,
      client_reference_number: `pickup-auth-${randomUUID().slice(0, 8)}`,
      box_count: 2
    });

    await setAuthenticatedContext(seed.organizationId, seed.userId);

    const wave = await createPickupWave(client, seed, [request.shipment_id], {
      idempotency_key: `pickup-wave-auth-${randomUUID()}`
    });

    expect(wave.created).toBe(true);
    expect(wave.route_run_id).toBeTruthy();
    expect(Array.isArray(wave.stop_ids)).toBe(true);
    expect(wave.stop_ids.length).toBe(1);
    expect(await getShipmentStatus(request.shipment_id)).toBe('pickup_scheduled');

    const pickupWave = await getPickupWaveViewRow(wave.route_run_id);
    expect(pickupWave).toBeTruthy();
    expect(Number(pickupWave.pickup_stop_count)).toBe(1);

    const routeStopTaskId = await getTaskIdForResource(
      seed.organizationId,
      'route_stop',
      wave.stop_ids[0],
      'route_stop_execute'
    );
    expect(routeStopTaskId).toBeTruthy();
  });

  test('create_pickup_wave_v1 supports partner assignment without a driver or vehicle', async () => {
    const seed = await seedPickupScope('pickup-wave-partner');
    const request = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-partner-${randomUUID()}`,
      client_reference_number: `pickup-partner-${randomUUID().slice(0, 8)}`,
      box_count: 5
    });

    const wave = await createPickupWave(client, seed, [request.shipment_id], {
      idempotency_key: `pickup-wave-partner-${randomUUID()}`
    });
    const assignmentIdempotencyKey = `pickup-assign-partner-${randomUUID()}`;

    const assignment = await assignPickupWave(client, seed, wave.route_run_id, {
      partner: {
        partner_id: '  partner-001  ',
        partner_name: '   ',
        name: '  Partner One  ',
        capacity_boxes: 20
      },
      idempotency_key: assignmentIdempotencyKey
    });
    const duplicateAssignment = await assignPickupWave(client, seed, wave.route_run_id, {
      partner: {
        partner_id: '  partner-001  ',
        partner_name: '   ',
        name: '  Partner One  ',
        capacity_boxes: 20
      },
      idempotency_key: assignmentIdempotencyKey
    });

    expect(assignment.created).toBe(true);
    expect(duplicateAssignment.created).toBe(false);
    expect(assignment.assignment_mode).toBe('partner');
    expect(assignment.driver_user_id ?? null).toBeNull();
    expect(assignment.vehicle_id ?? null).toBeNull();
    expect(assignment.partner.partner_id).toBe('partner-001');
    expect(assignment.partner.partner_name).toBe('Partner One');
    expect(assignment.partner.capacity_boxes).toBe(20);
    expect(duplicateAssignment.partner.partner_id).toBe('partner-001');
    expect(duplicateAssignment.partner.partner_name).toBe('Partner One');

    const pickupWave = await getPickupWaveViewRow(wave.route_run_id);
    expect(pickupWave.pickup_assignment?.assignment_mode).toBe('partner');
    expect(pickupWave.pickup_assignment?.partner?.partner_id).toBe('partner-001');

    const { rows: partnerAssignmentRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT assignment_mode, driver_user_id, vehicle_id, partner
         FROM route_run_assignments
        WHERE route_run_id = $1::uuid`,
      [wave.route_run_id]
    ));
    expect(partnerAssignmentRows).toEqual([expect.objectContaining({
      assignment_mode: 'partner_fleet',
      driver_user_id: null,
      vehicle_id: null,
      partner: expect.objectContaining({
        partner_id: 'partner-001',
        partner_name: 'Partner One',
        capacity_boxes: 20
      })
    })]);

    const { rows: partnerTaskRows } = await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `SELECT t.assigned_to
         FROM tasks t
         JOIN task_types tt ON tt.id = t.task_type_id
         JOIN route_stops rs ON rs.id = t.resource_id
        WHERE t.resource_type = 'route_stop'
          AND tt.organization_id = $1::uuid
          AND tt.key = 'route_stop_execute'
          AND rs.route_run_id = $2::uuid`,
      [seed.organizationId, wave.route_run_id]
    ));
    expect(partnerTaskRows).toHaveLength(1);
    expect(partnerTaskRows[0].assigned_to).toBeNull();
  });

  test('assign_pickup_wave_v1 atomically hands internal ownership to a partner across repeated assignment epochs', async () => {
    const seed = await seedPickupScope('pickup-wave-partner-handoff', {
      provisionRbac: true,
      userType: 'ops_admin',
      rbacTemplateKey: 'ops_admin'
    });
    const request = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-handoff-${randomUUID()}`,
      client_reference_number: `pickup-handoff-${randomUUID().slice(0, 8)}`,
      box_count: 3
    });
    const wave = await createPickupWave(client, seed, [request.shipment_id], {
      idempotency_key: `pickup-wave-handoff-${randomUUID()}`
    });
    const driverUserId = await createUser(
      client,
      seed.organizationId,
      `pickup-handoff-driver-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver', fullName: 'Pickup Handoff Driver' }
    );
    const vehicleId = randomUUID();
    await withFixtureAdminContext(client, (adminClient) => adminClient.query(
      `INSERT INTO vehicles (id, organization_id, status, is_active)
       VALUES ($1::uuid, $2::uuid, 'active', true)`,
      [vehicleId, seed.organizationId]
    ));

    await setAuthenticatedContext(seed.organizationId, seed.userId);
    await assignPickupWave(client, seed, wave.route_run_id, {
      driver_user_id: driverUserId,
      vehicle_id: vehicleId,
      idempotency_key: `pickup-handoff-internal-${randomUUID()}`
    });

    const partner = { partner_id: 'partner-handoff-1', partner_name: 'Partner Handoff One' };
    await client.query('SAVEPOINT pickup_handoff_missing_reason');
    try {
      await expect(assignPickupWave(client, seed, wave.route_run_id, {
        partner,
        idempotency_key: `pickup-handoff-missing-reason-${randomUUID()}`
      })).rejects.toThrow(/requires reassignment_reason/i);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT pickup_handoff_missing_reason');
      await client.query('RELEASE SAVEPOINT pickup_handoff_missing_reason');
    }

    const limitedUserId = await createUser(
      client,
      seed.organizationId,
      `pickup-fleet-only-${randomUUID().slice(0, 8)}@example.com`,
      {
        accessScopeType: 'tenant',
        rbacTemplateKey: 'fleet_manager',
        fullName: 'Pickup Fleet Only'
      }
    );
    await setFixtureUserPolicyCapabilities(
      client,
      seed.organizationId,
      limitedUserId,
      ['fleet.write']
    );
    await setAuthenticatedContext(seed.organizationId, limitedUserId);
    const { rows: [limitedCapabilities] } = await client.query(
      `SELECT
         public.user_has_permission_v1('fleet.write', $1::uuid) AS has_fleet_write,
         public.user_has_resource_capability_v1(
           'routes',
           'write',
           'tenant',
           $1::uuid
         ) AS has_routes_write`,
      [seed.organizationId]
    );
    expect(limitedCapabilities).toEqual({ has_fleet_write: true, has_routes_write: false });
    await client.query('SAVEPOINT pickup_handoff_no_routes');
    try {
      await expect(assignPickupWave(client, seed, wave.route_run_id, {
        partner,
        reassignment_reason: 'Escalate to partner capacity',
        idempotency_key: `pickup-handoff-no-routes-${randomUUID()}`
      })).rejects.toThrow(/routes\.write capability/i);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT pickup_handoff_no_routes');
      await client.query('RELEASE SAVEPOINT pickup_handoff_no_routes');
    }

    const readAssignmentState = () => withFixtureAdminContext(client, async (adminClient) => {
      const assignment = await adminClient.query(
        `SELECT assignment_mode, assignment_version, driver_user_id, vehicle_id, partner
           FROM route_run_assignments
          WHERE route_run_id = $1::uuid`,
        [wave.route_run_id]
      );
      const tasks = await adminClient.query(
        `SELECT t.id, t.assigned_to, t.version
           FROM tasks t
           JOIN task_types tt ON tt.id = t.task_type_id
           JOIN route_stops rs ON rs.id = t.resource_id
          WHERE tt.organization_id = $1::uuid
            AND tt.key = 'route_stop_execute'
            AND rs.route_run_id = $2::uuid
          ORDER BY t.id`,
        [seed.organizationId, wave.route_run_id]
      );
      const eventCounts = await adminClient.query(
        `SELECT
            (SELECT count(*)::int FROM route_run_assignment_events WHERE route_run_id = $1::uuid) AS route_events,
            (SELECT count(*)::int FROM shipment_actions WHERE shipment_id = $2::uuid AND action_type = 'pickup_wave_assign') AS shipment_actions,
            (SELECT count(*)::int
               FROM task_events te
               JOIN tasks t ON t.id = te.task_id
               JOIN route_stops rs ON rs.id = t.resource_id
              WHERE rs.route_run_id = $1::uuid AND te.event_type = 'unassigned') AS unassign_events`,
        [wave.route_run_id, request.shipment_id]
      );
      const audit = await adminClient.query(
        `SELECT
            ev.actor_user_id AS route_actor_user_id,
            ev.actor_system AS route_actor_system,
            ev.payload #>> '{metadata,reassignment_reason}' AS route_reassignment_reason,
            sa.performed_by_user_id AS shipment_actor_user_id,
            sa.performed_by_system AS shipment_actor_system,
            sa.action_data->>'reassignment_reason' AS shipment_reassignment_reason
           FROM route_run_assignment_events ev
           JOIN shipment_actions sa
             ON sa.shipment_id = $2::uuid
            AND sa.action_type = 'pickup_wave_assign'
            AND sa.action_data->>'idempotency_key' = ev.idempotency_key
          WHERE ev.route_run_id = $1::uuid
          ORDER BY ev.assignment_version DESC
          LIMIT 1`,
        [wave.route_run_id, request.shipment_id]
      );
      return {
        assignment: assignment.rows[0],
        tasks: tasks.rows,
        counts: eventCounts.rows[0],
        audit: audit.rows[0] ?? null
      };
    });

    const deniedState = await readAssignmentState();
    expect(deniedState.assignment.assignment_mode).toBe('internal_driver');
    expect(deniedState.tasks.every((task) => task.assigned_to === driverUserId)).toBe(true);
    expect(deniedState.counts.unassign_events).toBe(0);

    await setAuthenticatedContext(seed.organizationId, seed.userId);
    const firstPartnerKey = `pickup-handoff-partner-1-${randomUUID()}`;
    const firstPartner = await assignPickupWave(client, seed, wave.route_run_id, {
      partner,
      reassignment_reason: 'Escalate to partner capacity',
      idempotency_key: firstPartnerKey
    });
    const firstPartnerReplay = await assignPickupWave(client, seed, wave.route_run_id, {
      partner,
      reassignment_reason: 'Escalate to partner capacity',
      idempotency_key: firstPartnerKey
    });
    expect(firstPartner.assignment_mode).toBe('partner');
    expect(firstPartner.created).toBe(true);
    expect(firstPartnerReplay.created).toBe(false);

    const firstPartnerState = await readAssignmentState();
    expect(firstPartnerState.assignment.assignment_mode).toBe('partner_fleet');
    expect(firstPartnerState.assignment.driver_user_id).toBeNull();
    expect(firstPartnerState.assignment.vehicle_id).toBeNull();
    expect(firstPartnerState.tasks.every((task) => task.assigned_to == null)).toBe(true);
    expect(firstPartnerState.counts.route_events).toBe(2);
    expect(firstPartnerState.counts.shipment_actions).toBe(2);
    expect(firstPartnerState.counts.unassign_events).toBe(1);
    expect(firstPartnerState.audit).toEqual(expect.objectContaining({
      route_actor_user_id: seed.userId,
      route_actor_system: 'public.assign_pickup_wave_v1',
      route_reassignment_reason: 'Escalate to partner capacity',
      shipment_actor_user_id: seed.userId,
      shipment_actor_system: 'public.assign_pickup_wave_v1',
      shipment_reassignment_reason: 'Escalate to partner capacity'
    }));

    await assignPickupWave(client, seed, wave.route_run_id, {
      driver_user_id: driverUserId,
      vehicle_id: vehicleId,
      idempotency_key: `pickup-handoff-internal-2-${randomUUID()}`
    });
    const secondPartner = { partner_id: 'partner-handoff-2', partner_name: 'Partner Handoff Two' };
    const secondPartnerKey = `pickup-handoff-partner-2-${randomUUID()}`;
    await assignPickupWave(client, seed, wave.route_run_id, {
      partner: secondPartner,
      reassignment_reason: 'Second partner capacity handoff',
      idempotency_key: secondPartnerKey
    });
    const secondPartnerState = await readAssignmentState();
    expect(secondPartnerState.assignment.assignment_mode).toBe('partner_fleet');
    expect(secondPartnerState.assignment.partner.partner_id).toBe('partner-handoff-2');
    expect(secondPartnerState.tasks.every((task) => task.assigned_to == null)).toBe(true);
    expect(secondPartnerState.counts.route_events).toBe(4);
    expect(secondPartnerState.counts.shipment_actions).toBe(4);
    expect(secondPartnerState.counts.unassign_events).toBe(2);

    const secondPartnerReplay = await assignPickupWave(client, seed, wave.route_run_id, {
      partner: secondPartner,
      reassignment_reason: 'Second partner capacity handoff',
      idempotency_key: secondPartnerKey
    });
    expect(secondPartnerReplay.created).toBe(false);
    expect(await readAssignmentState()).toEqual(secondPartnerState);
  });

  test('api pickup list RPCs honor tenant, client, and sender scope without server-side DB fallbacks', async () => {
    const seed = await seedPickupScope('pickup-api-scope', {
      provisionRbac: true,
      userType: 'ops_admin',
      rbacTemplateKey: 'ops_admin'
    });
    const secondSenderId = await createSender(client, seed.clientId, 'Pickup API Sender B', {
      brandName: 'Pickup API Sender B'
    });
    const clientScopedUserId = await createUser(
      client,
      seed.organizationId,
      `pickup-client-scope-${randomUUID().slice(0, 8)}@example.com`,
      {
        accessScopeType: 'client',
        accessScopeId: seed.clientId,
        provisionRbac: false,
        userType: 'client_admin',
        fullName: 'Pickup Client Scope User'
      }
    );
    const senderScopedUserId = await createUser(
      client,
      seed.organizationId,
      `pickup-sender-scope-${randomUUID().slice(0, 8)}@example.com`,
      {
        accessScopeType: 'sender',
        accessScopeId: seed.senderId,
        provisionRbac: false,
        userType: 'sender_user',
        fullName: 'Pickup Sender Scope User'
      }
    );

    const requestA = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-scope-a-${randomUUID()}`,
      client_reference_number: `pickup-scope-a-${randomUUID().slice(0, 8)}`,
      box_count: 2
    });
    const requestB = await createPickupRequest(
      client,
      { ...seed, senderId: secondSenderId },
      {
        idempotency_key: `pickup-request-scope-b-${randomUUID()}`,
        client_reference_number: `pickup-scope-b-${randomUUID().slice(0, 8)}`,
        box_count: 4
      }
    );
    const waveA = await createPickupWave(client, seed, [requestA.shipment_id], {
      idempotency_key: `pickup-wave-scope-a-${randomUUID()}`
    });
    const waveB = await createPickupWave(client, seed, [requestB.shipment_id], {
      idempotency_key: `pickup-wave-scope-b-${randomUUID()}`
    });

    async function failPickupStop(routeStopId, failureReason) {
      const routeStopTaskId = await getTaskIdForResource(
        seed.organizationId,
        'route_stop',
        routeStopId,
        'route_stop_execute'
      );
      expect(routeStopTaskId).toBeTruthy();

      const stopCompletion = await completeTask(
        routeStopTaskId,
        failureReason,
        `pickup-stop-scope-${failureReason}-${randomUUID()}`
      );
      const stopWorkflowRunId = await waitForDomainEventWorkflowRun(stopCompletion.domainEventId);
      expect(stopWorkflowRunId).toBeTruthy();
      await progressWorkflowFully(stopWorkflowRunId);
    }

    await failPickupStop(waveA.stop_ids[0], 'quantity_mismatch');
    await failPickupStop(waveB.stop_ids[0], 'sender_unavailable');

    expect(await getShipmentStatus(requestA.shipment_id)).toBe('pickup_failed');
    expect(await getShipmentStatus(requestB.shipment_id)).toBe('pickup_failed');
    expect(await getPickupFailureViewRow(requestA.shipment_id)).toBeTruthy();
    expect(await getPickupFailureViewRow(requestB.shipment_id)).toBeTruthy();

    async function fetchScopedApiPack(userId) {
      await setAuthenticatedContext(seed.organizationId, userId);
      const requestRows = await client.query(
        `SELECT shipment_id, sender_id
           FROM api.pickup_requests_list_v1(NULL, NULL, NULL, 25)
          WHERE shipment_id = ANY($1::uuid[])
          ORDER BY shipment_id`,
        [[requestA.shipment_id, requestB.shipment_id]]
      );
      const waveRows = await client.query(
        `SELECT route_run_id
           FROM api.pickup_waves_list_v1($1::uuid[], NULL, 25)
          ORDER BY route_run_id`,
        [[waveA.route_run_id, waveB.route_run_id]]
      );
      const failureRows = await client.query(
        `SELECT shipment_id, failure_reason
           FROM api.pickup_failures_list_v1($1::uuid[], NULL, NULL, NULL, 25)
          ORDER BY shipment_id`,
        [[requestA.shipment_id, requestB.shipment_id]]
      );
      return {
        requestRows: requestRows.rows,
        waveRows: waveRows.rows,
        failureRows: failureRows.rows
      };
    }

    const tenantScope = await fetchScopedApiPack(seed.userId);
    expect(tenantScope.requestRows).toHaveLength(2);
    expect(tenantScope.waveRows).toHaveLength(2);
    expect(tenantScope.failureRows).toHaveLength(2);

    const clientScope = await fetchScopedApiPack(clientScopedUserId);
    expect(clientScope.requestRows).toHaveLength(2);
    expect(clientScope.waveRows).toHaveLength(2);
    expect(clientScope.failureRows).toHaveLength(2);

    const senderScope = await fetchScopedApiPack(senderScopedUserId);
    expect(senderScope.requestRows).toHaveLength(1);
    expect(senderScope.requestRows[0]?.shipment_id).toBe(requestA.shipment_id);
    expect(senderScope.requestRows[0]?.sender_id).toBe(seed.senderId);
    expect(senderScope.waveRows).toHaveLength(1);
    expect(senderScope.waveRows[0]?.route_run_id).toBe(waveA.route_run_id);
    expect(senderScope.failureRows).toHaveLength(1);
    expect(senderScope.failureRows[0]?.shipment_id).toBe(requestA.shipment_id);
    expect(senderScope.failureRows[0]?.failure_reason).toBe('quantity_mismatch');

    await setAuthenticatedContext(seed.organizationId, senderScopedUserId);
    const broadenedRequestAttempt = await client.query(
      `SELECT shipment_id
         FROM api.pickup_requests_list_v1(NULL, $1::uuid, NULL, 25)
        WHERE shipment_id = $2::uuid`,
      [secondSenderId, requestB.shipment_id]
    );
    expect(broadenedRequestAttempt.rows).toHaveLength(0);
  });

  test.each([
    ['sender_unavailable', 'dispatch_reschedule_pickup', 'pickup_requested'],
    ['quantity_mismatch', 'dispatch_pickup_escalation_review', 'pickup_failed']
  ])(
    'pickup failure %s creates %s follow-up and resolves to %s after follow-up completion',
    async (failureReason, expectedFollowupTaskTypeKey, expectedFinalStatus) => {
      const seed = await seedPickupScope(`pickup-failure-${failureReason}`);
      const request = await createPickupRequest(client, seed, {
        idempotency_key: `pickup-request-failure-${failureReason}-${randomUUID()}`,
        client_reference_number: `pickup-failure-${failureReason}-${randomUUID().slice(0, 8)}`,
        box_count: failureReason === 'quantity_mismatch' ? 4 : 2
      });
      const wave = await createPickupWave(client, seed, [request.shipment_id], {
        idempotency_key: `pickup-wave-failure-${failureReason}-${randomUUID()}`
      });

      const routeStopId = wave.stop_ids[0];
      const routeStopTaskId = await getTaskIdForResource(
        seed.organizationId,
        'route_stop',
        routeStopId,
        'route_stop_execute'
      );
      expect(routeStopTaskId).toBeTruthy();

      const stopCompletion = await completeTask(
        routeStopTaskId,
        failureReason,
        `pickup-stop-${failureReason}-${randomUUID()}`
      );
      const stopWorkflowRunId = await waitForDomainEventWorkflowRun(stopCompletion.domainEventId);
      expect(stopWorkflowRunId).toBeTruthy();
      await progressWorkflowFully(stopWorkflowRunId);

      expect(await getShipmentStatus(request.shipment_id)).toBe('pickup_failed');

      const failureView = await getPickupFailureViewRow(request.shipment_id);
      expect(failureView).toBeTruthy();
      expect(failureView.failure_reason).toBe(failureReason);
      expect(Array.isArray(failureView.followup_tasks)).toBe(true);
      expect(failureView.followup_tasks.length).toBe(1);
      expect(failureView.followup_tasks[0].task_type_key).toBe(expectedFollowupTaskTypeKey);

      const followupTaskId = await getTaskIdForResource(
        seed.organizationId,
        'shipment',
        request.shipment_id,
        expectedFollowupTaskTypeKey
      );
      expect(followupTaskId).toBeTruthy();

      const followupCompletion = await completeTask(
        followupTaskId,
        null,
        `pickup-followup-${failureReason}-${randomUUID()}`,
        { source: 'integration-test' }
      );
      const followupWorkflowRunId = await waitForDomainEventWorkflowRun(followupCompletion.domainEventId);
      expect(followupWorkflowRunId).toBeTruthy();
      await progressWorkflowFully(followupWorkflowRunId);

      expect(await getShipmentStatus(request.shipment_id)).toBe(expectedFinalStatus);
    }
  );

  test('sender-scoped pickup list RPCs return request, wave, and failure rows within the bounded timeout', async () => {
    const seed = await seedPickupScope('pickup-sender-read');
    const senderUserId = await createScopedPickupReader(seed, 'sender');
    const request = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-sender-read-${randomUUID()}`,
      client_reference_number: `pickup-sender-read-${randomUUID().slice(0, 8)}`,
      box_count: 3
    });
    const wave = await createPickupWave(client, seed, [request.shipment_id], {
      idempotency_key: `pickup-wave-sender-read-${randomUUID()}`
    });
    const routeStopId = wave.stop_ids[0];
    const routeStopTaskId = await getTaskIdForResource(
      seed.organizationId,
      'route_stop',
      routeStopId,
      'route_stop_execute'
    );
    expect(routeStopTaskId).toBeTruthy();

    const stopCompletion = await completeTask(
      routeStopTaskId,
      'sender_unavailable',
      `pickup-stop-sender-read-${randomUUID()}`
    );
    const workflowRunId = await waitForDomainEventWorkflowRun(stopCompletion.domainEventId);
    expect(workflowRunId).toBeTruthy();
    await progressWorkflowFully(workflowRunId);

    await setAuthenticatedContext(seed.organizationId, senderUserId);
    await client.query(`SET LOCAL statement_timeout = '3000ms'`);

    const { rows: requestRows } = await client.query(
      `SELECT *
         FROM api.pickup_requests_list_v1($1::uuid, $2::uuid, NULL, 25)`,
      [seed.clientId, seed.senderId]
    );
    expect(Array.isArray(requestRows)).toBe(true);
    expect(requestRows.some((row) => row.shipment_id === request.shipment_id)).toBe(true);

    const { rows: waveRows } = await client.query(
      `SELECT *
         FROM api.pickup_waves_list_v1($1::uuid[], NULL, 25)`,
      [[wave.route_run_id]]
    );
    expect(waveRows).toHaveLength(1);
    expect(waveRows[0]?.route_run_id).toBe(wave.route_run_id);
    expect(Number(waveRows[0]?.pickup_stop_count ?? 0)).toBe(1);
    expect(Array.isArray(waveRows[0]?.shipments)).toBe(true);
    expect(waveRows[0].shipments).toHaveLength(1);
    expect(waveRows[0].shipments[0]?.shipment_id).toBe(request.shipment_id);

    const { rows: failureRows } = await client.query(
      `SELECT *
         FROM api.pickup_failures_list_v1($1::uuid[], $2::uuid, $3::uuid, NULL, 25)`,
      [[request.shipment_id], seed.clientId, seed.senderId]
    );
    expect(failureRows).toHaveLength(1);
    expect(failureRows[0]?.shipment_id).toBe(request.shipment_id);
    expect(failureRows[0]?.failure_reason).toBe('sender_unavailable');
  });

  test.each(['tenant', 'client', 'sender'])('pickup display labels exclude foreign IDs in a mixed %s request', async (scopeType) => {
    const seed = await seedPickupScope(`lookup-${scopeType}`);
    const readerId = scopeType === 'tenant' ? seed.userId : await createScopedPickupReader(seed, scopeType);
    await setServiceContext(seed.organizationId, seed.userId);
    const own = await createPickupRequest(client, seed);
    const ownWave = await createPickupWave(client, seed, [own.shipment_id]);
    const foreign = await seedPickupScope(`lookup-foreign-${scopeType}`);
    const hidden = await createPickupRequest(client, foreign);
    const hiddenWave = await createPickupWave(client, foreign, [hidden.shipment_id]);
    const { id: siblingClientId } = await createClient(client, seed.organizationId, 'Other pickup client in same tenant');
    const siblingSenderId = await createSender(client, siblingClientId, 'Other pickup sender');
    await setServiceContext(seed.organizationId, seed.userId);
    const sibling = await createPickupRequest(client, { ...seed, clientId: siblingClientId, senderId: siblingSenderId });
    const siblingWave = await createPickupWave(client, seed, [sibling.shipment_id]);
    await setAuthenticatedContext(seed.organizationId, readerId);
    const { rows } = await client.query('SELECT api.pickup_relationship_labels_v1($1::uuid[],$2::uuid[]) AS labels',
      [[own.shipment_id, hidden.shipment_id, sibling.shipment_id], [ownWave.route_run_id, hiddenWave.route_run_id, siblingWave.route_run_id]]);
    expect(rows[0].labels[`shipment:${own.shipment_id}`].client_label).toBe(`lookup-${scopeType} Pickup Client`);
    expect(rows[0].labels).toHaveProperty(`route:${ownWave.route_run_id}`);
    expect(rows[0].labels).not.toHaveProperty(`shipment:${hidden.shipment_id}`);
    expect(rows[0].labels).not.toHaveProperty(`route:${hiddenWave.route_run_id}`);
    if (scopeType === 'tenant') {
      expect(rows[0].labels).toHaveProperty(`shipment:${sibling.shipment_id}`);
    } else {
      expect(rows[0].labels).not.toHaveProperty(`shipment:${sibling.shipment_id}`);
      expect(rows[0].labels).not.toHaveProperty(`route:${siblingWave.route_run_id}`);
    }
    await client.query('SAVEPOINT lookup_denial');
    await expect(client.query('SELECT api.pickup_assignment_options_v1($1,100)', [seed.organizationId]))
      .rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK TO SAVEPOINT lookup_denial');
    await expect(client.query('SELECT api.pickup_assignment_options_v1($1,100)', [foreign.organizationId]))
      .rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK TO SAVEPOINT lookup_denial');
  });

  test('pickup assignment choices require fleet authority and expose bounded active display fields only', async () => {
    const seed = await seedPickupScope('lookup-assignment');
    const driverId = await createUser(client, seed.organizationId, `lookup-driver-${randomUUID()}@example.com`,
      { userType: 'driver', fullName: 'Visible pickup driver' });
    await setAuthenticatedContext(seed.organizationId, seed.userId);
    await client.query('SAVEPOINT lookup_denial');
    await expect(client.query('SELECT api.pickup_assignment_options_v1($1,1)', [seed.organizationId]))
      .rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK TO SAVEPOINT lookup_denial');
    await setFixtureUserPolicyCapabilities(client, seed.organizationId, seed.userId, ['fleet.write']);
    await client.query('SAVEPOINT lookup_policy_denial');
    await expect(client.query('SELECT api.pickup_assignment_options_v1($1,1)', [seed.organizationId]))
      .rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK TO SAVEPOINT lookup_policy_denial');
    await client.query('RELEASE SAVEPOINT lookup_policy_denial');
    const fleetReaderId = await createUser(
      client,
      seed.organizationId,
      `lookup-fleet-reader-${randomUUID()}@example.com`,
      { accessScopeType: 'tenant', rbacTemplateKey: 'fleet_manager', fullName: 'Pickup fleet assignment reader' }
    );
    await setAuthenticatedContext(seed.organizationId, fleetReaderId);
    const { rows } = await client.query('SELECT api.pickup_assignment_options_v1($1,1) AS options', [seed.organizationId]);
    expect(rows[0].options.drivers).toEqual([{ value: driverId, label: 'Visible pickup driver' }]);
    for (const options of Object.values(rows[0].options)) {
      expect(options.length).toBeLessThanOrEqual(1);
      for (const option of options) expect(Object.keys(option).sort()).toEqual(['label', 'value']);
    }
  });

  test('client-scoped pickup wave RPC only returns the client-visible shipments for mixed waves', async () => {
    const seed = await seedPickupScope('pickup-client-wave-scope');
    const clientReaderUserId = await createScopedPickupReader(seed, 'client');
    const { id: otherClientId } = await createClient(
      client,
      seed.organizationId,
      'Pickup Wave Other Client'
    );
    const otherSenderId = await createSender(
      client,
      otherClientId,
      'Pickup Wave Other Sender',
      { brandName: 'Pickup Wave Other Sender' }
    );

    const requestA = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-client-wave-a-${randomUUID()}`,
      client_reference_number: `pickup-wave-a-${randomUUID().slice(0, 8)}`,
      box_count: 2
    });
    const requestB = await createPickupRequest(
      client,
      {
        organizationId: seed.organizationId,
        clientId: otherClientId,
        senderId: otherSenderId,
        userId: seed.userId
      },
      {
        idempotency_key: `pickup-client-wave-b-${randomUUID()}`,
        client_reference_number: `pickup-wave-b-${randomUUID().slice(0, 8)}`,
        box_count: 5
      }
    );

    const mixedWave = await createPickupWave(
      client,
      { organizationId: seed.organizationId },
      [requestA.shipment_id, requestB.shipment_id],
      {
        idempotency_key: `pickup-wave-mixed-${randomUUID()}`
      }
    );

    await setAuthenticatedContext(seed.organizationId, clientReaderUserId);
    await client.query(`SET LOCAL statement_timeout = '3000ms'`);

    const { rows } = await client.query(
      `SELECT *
         FROM api.pickup_waves_list_v1($1::uuid[], NULL, 25)`,
      [[mixedWave.route_run_id]]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.route_run_id).toBe(mixedWave.route_run_id);
    expect(Number(rows[0]?.pickup_stop_count ?? 0)).toBe(1);
    expect(Number(rows[0]?.total_box_count ?? 0)).toBe(2);
    expect(Array.isArray(rows[0]?.shipments)).toBe(true);
    expect(rows[0].shipments).toHaveLength(1);
    expect(rows[0].shipments[0]?.shipment_id).toBe(requestA.shipment_id);
    expect(rows[0].shipments[0]?.client_id).toBe(seed.clientId);
  });
});
