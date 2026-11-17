const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  createOrganization,
  createClient,
  createSender,
  createUser
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
    await client.query('SET LOCAL ROLE service_role');
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({
        role: 'service_role',
        sub: userId,
        organization_id: organizationId
      })
    ]);
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', String(userId)]);
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.role', 'service_role']);
  }

  async function setAuthenticatedContext(organizationId, userId) {
    await client.query('SET LOCAL ROLE authenticated');
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({
        role: 'authenticated',
        sub: userId,
        organization_id: organizationId
      })
    ]);
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', String(userId)]);
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.role', 'authenticated']);
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
        workflowRunId
      ]);
      const result = rows[0]?.result;
      if (!result?.step_id) break;
      if (result.status === 'failed') break;
    }
  }

  async function getShipmentStatus(shipmentId) {
    const { rows } = await client.query(
      `SELECT status
         FROM shipments
        WHERE id = $1::uuid
        LIMIT 1`,
      [shipmentId]
    );
    return rows[0]?.status ?? null;
  }

  async function getPickupRequestViewRow(shipmentId) {
    const { rows } = await client.query(
      `SELECT *
         FROM pickup_requests
        WHERE shipment_id = $1::uuid
        LIMIT 1`,
      [shipmentId]
    );
    return rows[0] ?? null;
  }

  async function getPickupWaveViewRow(routeRunId) {
    const { rows } = await client.query(
      `SELECT *
         FROM pickup_waves
        WHERE route_run_id = $1::uuid
        LIMIT 1`,
      [routeRunId]
    );
    return rows[0] ?? null;
  }

  async function getPickupFailureViewRow(shipmentId) {
    const { rows } = await client.query(
      `SELECT *
         FROM pickup_failures
        WHERE shipment_id = $1::uuid
        LIMIT 1`,
      [shipmentId]
    );
    return rows[0] ?? null;
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

    const { rows: domainEventRows } = await client.query(
      `SELECT id
         FROM domain_events
        WHERE (payload->>'task_event_id') = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [String(taskEventId)]
    );
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

    const { rows: shipmentCountRows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM shipments
        WHERE organization_id = $1::uuid
          AND client_id = $2::uuid
          AND service_type = 'pickup'`,
      [seed.organizationId, seed.clientId]
    );
    expect(shipmentCountRows[0]?.count).toBe(1);
  });

  test('create_pickup_wave_v1 groups pickup shipments and supports internal driver assignment', async () => {
    const seed = await seedPickupScope('pickup-wave-driver');
    const requestA = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-a-${randomUUID()}`,
      client_reference_number: `pickup-wave-a-${randomUUID().slice(0, 8)}`,
      box_count: 2
    });
    const requestB = await createPickupRequest(client, seed, {
      idempotency_key: `pickup-request-b-${randomUUID()}`,
      client_reference_number: `pickup-wave-b-${randomUUID().slice(0, 8)}`,
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
        provisionRbac: false,
        fullName: 'Pickup Driver'
      }
    );
    const vehicleId = randomUUID();
    const assignmentIdempotencyKey = `pickup-assign-driver-${randomUUID()}`;
    await client.query(
      `INSERT INTO vehicles (id, organization_id, status, is_active)
       VALUES ($1::uuid, $2::uuid, 'active', true)`,
      [vehicleId, seed.organizationId]
    );

    const assignment = await assignPickupWave(client, seed, firstWave.route_run_id, {
      driver_user_id: driverUserId,
      vehicle_id: vehicleId,
      idempotency_key: assignmentIdempotencyKey
    });
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

    const { rows: routeRunRows } = await client.query(
      `SELECT driver_user_id, vehicle_id, metadata
         FROM route_runs
        WHERE id = $1::uuid
        LIMIT 1`,
      [firstWave.route_run_id]
    );
    const routeRun = routeRunRows[0];
    expect(routeRun.driver_user_id).toBe(driverUserId);
    expect(routeRun.vehicle_id).toBe(vehicleId);
    expect(routeRun.metadata?.pickup_assignment?.assignment_mode).toBe('internal_driver');

    const pickupWaveAfterAssignment = await getPickupWaveViewRow(firstWave.route_run_id);
    expect(pickupWaveAfterAssignment.pickup_assignment?.assignment_mode).toBe('internal_driver');
    expect(pickupWaveAfterAssignment.pickup_assignment?.driver_user_id).toBe(driverUserId);
    expect(pickupWaveAfterAssignment.pickup_assignment?.vehicle_id).toBe(vehicleId);
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
        partner_id: 'partner-001',
        partner_name: 'Partner One',
        capacity_boxes: 20
      },
      idempotency_key: assignmentIdempotencyKey
    });
    const duplicateAssignment = await assignPickupWave(client, seed, wave.route_run_id, {
      partner: {
        partner_id: 'partner-001',
        partner_name: 'Partner One',
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

    const pickupWave = await getPickupWaveViewRow(wave.route_run_id);
    expect(pickupWave.pickup_assignment?.assignment_mode).toBe('partner');
    expect(pickupWave.pickup_assignment?.partner?.partner_id).toBe('partner-001');
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
