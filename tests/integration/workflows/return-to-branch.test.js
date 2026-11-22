const { Pool } = require('pg');
const { randomUUID, randomBytes } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  createOrganization,
  createClient,
  createSender,
  createUser,
  createShipment,
  setAuthContext,
  withFixtureAdminContext,
  setServiceContext: setCanonicalServiceContext,
} = require('../helpers/tenant-utils');

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('Return-to-branch intake and visibility', () => {
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

  async function seedBranchInventory(organizationId, suffix) {
    const branchId = randomUUID();
    const locationId = randomUUID();

    await withFixtureAdminContext(client, async () => {
      await client.query(
        `INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'Asia/Riyadh', true)`,
        [branchId, organizationId, `branch-${suffix}`, `Branch ${suffix}`]
      );

      await client.query(
        `INSERT INTO public.warehouse_locations (
         id,
         organization_id,
         branch_id,
         code,
         name,
         location_type,
         is_active
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4,
         $5,
         'stage',
         true
       )`,
        [locationId, organizationId, branchId, `loc-${suffix}`, `Location ${suffix}`]
      );
    });

    return { branchId, locationId };
  }

  async function registerDevice(userId, organizationId) {
    await setAuthContext(client, userId, { organization_id: organizationId });
    const { rows } = await client.query(
      `SELECT device_id
         FROM public.register_user_device_v1($1::jsonb)`,
      [
        JSON.stringify({
          device_platform: 'android',
          device_identifier_sha256: randomBytes(32).toString('hex'),
          device_label: 'return-to-branch-test',
          app_version: '0.1.0',
          os_version: 'test',
          metadata: { source: 'integration.return-to-branch' }
        })
      ]
    );

    await setServiceContext(organizationId, userId);
    return rows[0]?.device_id ?? null;
  }

  async function attachSenderToShipment(shipmentId, senderId) {
    await withFixtureAdminContext(client, () =>
      client.query(
        `UPDATE public.shipments
            SET sender_id = $2::uuid
          WHERE id = $1::uuid`,
        [shipmentId, senderId]
      )
    );
  }

  async function recordReturnToBranchIntake({
    userId,
    organizationId,
    deviceId,
    branchId,
    clientId,
    shipmentId,
    barcode,
    idempotencyKey
  }) {
    await setAuthContext(client, userId, { organization_id: organizationId });
    const { rows } = await client.query(
      `SELECT scan_event_id, created
         FROM public.record_scan_event_v1($1::jsonb)`,
      [
        JSON.stringify({
          idempotency_key: idempotencyKey,
          device_id: deviceId,
          branch_id: branchId,
          client_id: clientId,
          shipment_id: shipmentId,
          scan_type: 'return_to_branch_intake',
          barcode,
          captured_at: new Date().toISOString(),
          metadata: { source: 'integration.return-to-branch' }
        })
      ]
    );

    return rows[0] ?? null;
  }

  async function createTaskForShipment({ organizationId, clientId, shipmentId, userId }, taskTypeKey, metadata = {}) {
    await setServiceContext(organizationId, userId);
    const { rows } = await client.query(
      `SELECT task_id
         FROM public.create_task_system_v1($1::jsonb)`,
      [
        JSON.stringify({
          task_type_key: taskTypeKey,
          context: {
            organization_id: organizationId,
            client_id: clientId
          },
          resource_type: 'shipment',
          resource_id: shipmentId,
          idempotency_key: `return-to-branch-task:${taskTypeKey}:${shipmentId}:${randomUUID()}`,
          metadata
        })
      ]
    );

    return rows[0]?.task_id ?? null;
  }

  test('shipment_return_request_v1 starts shipment_return_v1 from the original shipment policy context', async () => {
    const { id: organizationId } = await createOrganization(client, 'Shipment Return Request UI Org');
    const { id: clientId } = await createClient(client, organizationId, 'Shipment Return Request UI Client');
    const senderId = await createSender(client, clientId, 'Shipment Return Request UI Sender');
    const userId = await createUser(
      client,
      organizationId,
      `shipment-return-request-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin' }
    );
    const originalShipment = await createShipment(client, {
      organizationId,
      clientId,
      status: 'delivered'
    });
    await attachSenderToShipment(originalShipment.id, senderId);

    await setAuthContext(client, userId, {
      organization_id: organizationId,
      access_scope_type: 'tenant',
      access_scope_id: organizationId
    });
    const { rows: resultRows } = await client.query(
      `SELECT public.shipment_return_request_v1($1::jsonb) AS result`,
      [
        JSON.stringify({
          shipment_id: originalShipment.id,
          operation: 'return',
          surface: 'console',
          reason: 'integration return request proof'
        })
      ]
    );
    const result = resultRows[0]?.result ?? null;
    expect(result).toMatchObject({
      ok: true,
      original_shipment_id: originalShipment.id,
      operation: 'return',
      workflow_status: 'completed',
      return_status: 'pending'
    });
    expect(result?.return_shipment_id).toBeTruthy();
    expect(result?.workflow_run_id).toBeTruthy();

    const { rows: shipmentRows } = await client.query(
      `SELECT id,
              service_type,
              status,
              metadata
         FROM public.shipments
        WHERE id = $1::uuid
          AND client_id = $2::uuid
        LIMIT 1`,
      [result.return_shipment_id, clientId]
    );
    expect(shipmentRows).toHaveLength(1);
    expect(shipmentRows[0]).toMatchObject({
      id: result.return_shipment_id,
      service_type: 'pickup',
      status: 'pending'
    });
    expect(shipmentRows[0]?.metadata?.workflow_run_id).toBe(result.workflow_run_id);
    expect(shipmentRows[0]?.metadata?.original_shipment_id).toBe(originalShipment.id);

    const { rows: taskRows } = await client.query(
      `SELECT t.id,
              t.resource_id,
              tt.key AS task_type_key
         FROM public.tasks t
         JOIN public.task_types tt ON tt.id = t.task_type_id
        WHERE t.organization_id = $1::uuid
          AND t.resource_type = 'shipment'
          AND t.resource_id = $2::uuid
          AND tt.key = 'dispatch_return_pickup'
        ORDER BY t.created_at DESC
        LIMIT 1`,
      [organizationId, result.return_shipment_id]
    );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]).toMatchObject({
      resource_id: result.return_shipment_id,
      task_type_key: 'dispatch_return_pickup'
    });
  });

  test('returned-to-branch API projection preserves service authenticated and anon boundaries across tenants', async () => {
    const fixtures = [];
    for (const suffix of ['a', 'b']) {
      const fixture = await withFixtureAdminContext(client, async () => {
        const { id: organizationId } = await createOrganization(client, `Projection ${suffix}`);
        const { id: clientId } = await createClient(client, organizationId, `Projection ${suffix}`);
        const senderId = await createSender(client, clientId, `Projection ${suffix}`);
        const userId = await createUser(client, organizationId, `projection-${randomUUID()}@example.test`,
          { accessScopeType: 'tenant', userType: 'ops_admin' });
        const shipment = await createShipment(client, { organizationId, clientId, status: 'pending' });
        return { organizationId, clientId, senderId, userId, shipment };
      });
      await attachSenderToShipment(fixture.shipment.id, fixture.senderId);
      const { branchId } = await seedBranchInventory(fixture.organizationId, `matrix-${randomUUID()}`);
      const deviceId = await registerDevice(fixture.userId, fixture.organizationId);
      expect(deviceId).toBeTruthy();
      const intake = await recordReturnToBranchIntake({ ...fixture, branchId, deviceId,
        shipmentId: fixture.shipment.id, barcode: fixture.shipment.trackingNumber,
        idempotencyKey: `projection-${randomUUID()}` });
      expect(intake?.created).toBe(true);
      fixtures.push(fixture);
    }
    const readIds = async role => {
      expect((await client.query('SELECT current_user AS role')).rows[0].role).toBe(role);
      return (await client.query('SELECT id FROM api.return_to_branch_shipments_v1')).rows.map(row => row.id);
    };
    await setServiceContext(fixtures[0].organizationId, fixtures[0].userId);
    expect(await readIds('service_role')).toEqual(expect.arrayContaining(fixtures.map(f => f.shipment.id)));
    for (const [index, fixture] of fixtures.entries()) {
      await setAuthContext(client, fixture.userId, { organization_id: fixture.organizationId });
      const ids = await readIds('authenticated');
      expect(ids).toContain(fixture.shipment.id);
      expect(ids).not.toContain(fixtures[1 - index].shipment.id);
    }
    await client.query('SAVEPOINT projection_anon');
    try {
      await client.query('SET LOCAL ROLE anon');
      await client.query("SELECT set_config('request.jwt.claims', '{\"role\":\"anon\"}', true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'anon', true)");
      expect((await client.query('SELECT current_user AS role')).rows[0].role).toBe('anon');
      await expect(client.query('SELECT id FROM api.return_to_branch_shipments_v1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT projection_anon');
      await client.query('RELEASE SAVEPOINT projection_anon');
    }
  });

  test('return_to_branch_intake scan writes inventory, shipment action, metadata, and idempotent view state', async () => {
    const { id: organizationId } = await createOrganization(client, 'Return To Branch Org');
    const { id: clientId } = await createClient(client, organizationId, 'Return To Branch Client');
    const senderId = await createSender(client, clientId, 'Return To Branch Sender');
    const userId = await createUser(
      client,
      organizationId,
      `return-to-branch-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin' }
    );
    const shipment = await createShipment(client, {
      organizationId,
      clientId,
      status: 'pending'
    });
    await attachSenderToShipment(shipment.id, senderId);
    const { branchId, locationId } = await seedBranchInventory(organizationId, 'intake');
    const deviceId = await registerDevice(userId, organizationId);
    expect(deviceId).toBeTruthy();

    await setAuthContext(client, userId, { organization_id: organizationId });
    const { rows: scanPolicyRows } = await client.query(
      `SELECT *
         FROM public.resolve_scan_policy($1::jsonb)`,
      [JSON.stringify({ organization_id: organizationId, user_id: userId, resource_id: branchId })]
    );
    expect(scanPolicyRows[0]?.value?.accepted_scan_types || []).toContain('return_to_branch_intake');

    const idempotencyKey = `return-to-branch-intake:${randomUUID()}`;
    const firstScan = await recordReturnToBranchIntake({
      userId,
      organizationId,
      deviceId,
      branchId,
      clientId,
      shipmentId: shipment.id,
      barcode: shipment.trackingNumber,
      idempotencyKey
    });
    expect(firstScan?.created).toBe(true);
    expect(firstScan?.scan_event_id).toBeTruthy();

    const replayScan = await recordReturnToBranchIntake({
      userId,
      organizationId,
      deviceId,
      branchId,
      clientId,
      shipmentId: shipment.id,
      barcode: shipment.trackingNumber,
      idempotencyKey
    });
    expect(replayScan?.created).toBe(false);
    expect(replayScan?.scan_event_id).toBe(firstScan.scan_event_id);

    const { rows: movementRows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT id, movement_type, quantity, unit, to_location_id, related_scan_event_id
           FROM public.inventory_movements
          WHERE organization_id = $1::uuid
            AND related_scan_event_id = $2::uuid`,
        [organizationId, firstScan.scan_event_id]
      )
    );
    expect(movementRows).toHaveLength(1);
    expect(movementRows[0]?.movement_type).toBe('receive');
    expect(String(movementRows[0]?.to_location_id || '')).toBe(String(locationId));
    expect(Number(movementRows[0]?.quantity || 0)).toBe(1);
    expect(String(movementRows[0]?.unit || '')).toBe('shipment');

    const { rows: actionRows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT id, action_type, action_category, action_data
           FROM public.shipment_actions
          WHERE shipment_id = $1::uuid
            AND organization_id = $2::uuid
            AND client_id = $3::uuid
            AND action_type = 'scan'
            AND (action_data->>'source_scan_event_id') = $4
          ORDER BY created_at DESC
          LIMIT 1`,
        [shipment.id, organizationId, clientId, String(firstScan.scan_event_id)]
      )
    );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]?.action_category).toBe('operational');
    expect(actionRows[0]?.action_data?.scan_type).toBe('return_to_branch_intake');
    expect(actionRows[0]?.action_data?.inventory_location_id).toBe(locationId);

    const { rows: shipmentRows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT metadata
           FROM public.shipments
          WHERE id = $1::uuid
            AND client_id = $2::uuid`,
        [shipment.id, clientId]
      )
    );
    expect(shipmentRows[0]?.metadata?.return_to_branch?.scan_event_id).toBe(firstScan.scan_event_id);
    expect(shipmentRows[0]?.metadata?.return_to_branch?.inventory_movement_id).toBe(movementRows[0].id);
    expect(shipmentRows[0]?.metadata?.return_to_branch?.inventory_location_id).toBe(locationId);

    const { rows: projectionRows } = await client.query(
      `SELECT *
         FROM api.return_to_branch_shipments_v1
        WHERE id = $1::uuid`,
      [shipment.id]
    );
    expect(projectionRows).toHaveLength(1);
    expect(projectionRows[0]?.next_action).toBe('hold');
    expect(projectionRows[0]?.next_action_source).toBe('default_hold');
    expect(projectionRows[0]?.inventory_movement_id).toBe(movementRows[0].id);
    expect(projectionRows[0]?.inventory_location_id).toBe(locationId);
  });

  test('returned-to-branch projection segregates next actions and exposes filtered registry resources', async () => {
    const { id: organizationId } = await createOrganization(client, 'Return Loop Segregation Org');
    const { id: clientId } = await createClient(client, organizationId, 'Return Loop Segregation Client');
    const senderId = await createSender(client, clientId, 'Return Loop Segregation Sender');
    const userId = await createUser(
      client,
      organizationId,
      `return-loop-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'ops_admin' }
    );
    const { branchId } = await seedBranchInventory(organizationId, 'segregation');
    const deviceId = await registerDevice(userId, organizationId);

    const reattemptShipment = await createShipment(client, { organizationId, clientId, status: 'pending' });
    const pickupShipment = await createShipment(client, { organizationId, clientId, status: 'pending' });
    const senderReturnShipment = await createShipment(client, { organizationId, clientId, status: 'pending' });
    const holdShipment = await createShipment(client, { organizationId, clientId, status: 'pending' });
    await attachSenderToShipment(reattemptShipment.id, senderId);
    await attachSenderToShipment(pickupShipment.id, senderId);
    await attachSenderToShipment(senderReturnShipment.id, senderId);
    await attachSenderToShipment(holdShipment.id, senderId);

    for (const shipment of [reattemptShipment, pickupShipment, senderReturnShipment, holdShipment]) {
      const intake = await recordReturnToBranchIntake({
        userId,
        organizationId,
        deviceId,
        branchId,
        clientId,
        shipmentId: shipment.id,
        barcode: shipment.trackingNumber,
        idempotencyKey: `segregation-scan:${shipment.id}`
      });
      expect(intake?.created).toBe(true);
    }

    await createTaskForShipment(
      { organizationId, clientId, shipmentId: reattemptShipment.id, userId },
      'dispatch_reattempt_delivery'
    );

    await withFixtureAdminContext(client, () =>
      client.query(
        `INSERT INTO public.shipment_actions (
         shipment_id,
         organization_id,
         client_id,
         action_type,
         action_category,
         performed_by_system,
         action_data,
         timestamp
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'hold_at_branch',
         'operational',
         'integration.return-to-branch',
         $4::jsonb,
         now()
       )`,
      [
        pickupShipment.id,
        organizationId,
        clientId,
        JSON.stringify({
          source_review_task_id: randomUUID(),
          resolution_action: 'hold_at_branch',
          resolution_notes: 'Customer will collect from branch'
        })
        ]
      )
    );

    await createTaskForShipment(
      { organizationId, clientId, shipmentId: senderReturnShipment.id, userId },
      'dispatch_rto_pickup'
    );

    const evidenceArtifactId = randomUUID();
    await createTaskForShipment(
      { organizationId, clientId, shipmentId: holdShipment.id, userId },
      'dispatch_exception_review',
      {
        dispatch_exception_reason: 'no_answer',
        exception_notes: 'Customer unreachable after branch return',
        evidence_artifact_ids: [evidenceArtifactId],
        allowed_ndr_actions: ['reattempt', 'hold_at_branch']
      }
    );

    await setAuthContext(client, userId, { organization_id: organizationId });
    const { rows: viewRows } = await client.query(
      `SELECT shipment_id, next_action, next_action_source, notes, evidence_artifact_ids
         FROM api.return_to_branch_shipments_v1
        WHERE organization_id = $1::uuid
        ORDER BY shipment_id`,
      [organizationId]
    );
    expect(viewRows).toHaveLength(4);

    const byShipment = new Map(viewRows.map((row) => [String(row.shipment_id), row]));
    expect(byShipment.get(String(reattemptShipment.id))?.next_action).toBe('reattempt');
    expect(byShipment.get(String(reattemptShipment.id))?.next_action_source).toBe('followup_task');

    expect(byShipment.get(String(pickupShipment.id))?.next_action).toBe('customer_pickup');
    expect(byShipment.get(String(pickupShipment.id))?.next_action_source).toBe('shipment_action');

    expect(byShipment.get(String(senderReturnShipment.id))?.next_action).toBe('sender_return');
    expect(byShipment.get(String(senderReturnShipment.id))?.next_action_source).toBe('followup_task');

    expect(byShipment.get(String(holdShipment.id))?.next_action).toBe('hold');
    expect(byShipment.get(String(holdShipment.id))?.next_action_source).toBe('dispatch_exception_review');
    expect(byShipment.get(String(holdShipment.id))?.notes).toBe('Customer unreachable after branch return');
    expect(byShipment.get(String(holdShipment.id))?.evidence_artifact_ids).toEqual([evidenceArtifactId]);

    const { rows: registryRows } = await client.query(
      `SELECT public.ui_read_registry_v1() AS registry`
    );
    const resources = Array.isArray(registryRows[0]?.registry?.resources)
      ? registryRows[0].registry.resources
      : [];
    const byKey = new Map(resources.map((resource) => [String(resource?.key || ''), resource]));

    expect(byKey.has('return_to_branch_shipments')).toBe(true);
    expect(byKey.has('return_to_branch_reattempt')).toBe(true);
    expect(byKey.has('return_to_branch_customer_pickup')).toBe(true);
    expect(byKey.has('return_to_branch_sender_return')).toBe(true);
    expect(byKey.has('return_to_branch_hold')).toBe(true);
    expect(byKey.get('return_to_branch_shipments')?.relation).toBe('api.return_to_branch_shipments_v1');
    expect(byKey.get('return_to_branch_sender_return')?.base_filter?.rules?.[0]?.value).toBe('sender_return');
  });
});
