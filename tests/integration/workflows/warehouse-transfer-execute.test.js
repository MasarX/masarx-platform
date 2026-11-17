const { Pool } = require('pg');
const { randomBytes, randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  createClient,
  createOrganization,
  createShipment,
  createUser,
  setAuthContext,
  withFixtureAdminContext,
  setServiceContext: setCanonicalServiceContext,
} = require('../helpers/tenant-utils');
const {
  createWarehouseTransferManifest,
} = require('../helpers/warehouse-transfer-utils');

loadEnv();

const hasDatabaseUrl = Boolean(String(process.env.DATABASE_URL || '').trim());
const pool = hasDatabaseUrl ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

describeIfDb('Warehouse transfer execute workflow v1', () => {
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

  async function setAuthenticatedTenantContext(organizationId, userId) {
    await setAuthContext(client, userId, {
      organization_id: organizationId,
      access_scope_type: 'tenant',
    });
  }

  async function getWorkflowTemplateId(templateName) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT id
           FROM workflow_templates
          WHERE name = $1
          LIMIT 1`,
        [templateName]
      )
    );

    return rows[0]?.id ?? null;
  }

  async function getTransferWorkflowRuns(transferId) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT wr.id,
              wr.workflow_status,
              wr.context
         FROM workflow_runs wr
        WHERE wr.context->>'warehouse_transfer_id' = $1::text
        ORDER BY wr.created_at DESC`,
        [transferId]
      )
    );

    return rows;
  }

  async function executeWarehouseTransferDispatch(transferId) {
    const { rows } = await client.query(
      `SELECT api.ui_execute_warehouse_transfer_dispatch_v1(
        'warehouse_transfers.dispatch',
        'warehouse_transfers',
        ARRAY[$1::text],
        $1::text,
        1,
        '{}'::jsonb
      ) AS result`,
      [transferId]
    );
    return rows[0]?.result ?? null;
  }

  async function executeWarehouseTransferCheckpoint(actionKey, transferId, params = {}) {
    const { rows } = await client.query(
      `SELECT api.ui_execute_warehouse_transfer_checkpoint_v1(
        $1,
        'warehouse_transfers',
        ARRAY[$2::text],
        $2::text,
        1,
        $3::jsonb
      ) AS result`,
      [actionKey, transferId, JSON.stringify(params)]
    );
    return rows[0]?.result ?? null;
  }

  async function startWorkflowRun(templateId, context) {
    const { rows } = await client.query(`SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id`, [
      templateId,
      JSON.stringify(context)
    ]);
    return rows[0]?.run_id ?? null;
  }

  async function progressOnce(workflowRunId) {
    const { rows } = await client.query(`SELECT progress_workflow_run($1::uuid) AS result`, [
      workflowRunId
    ]);
    return rows[0]?.result ?? null;
  }

  async function forceNextPendingStepToRunNow(workflowRunId) {
    await withFixtureAdminContext(client, () =>
      client.query(
        `
          UPDATE workflow_run_steps
             SET run_at = now() - interval '1 second'
           WHERE id = (
             SELECT id
               FROM workflow_run_steps
              WHERE workflow_run_id = $1::uuid
                AND step_status = 'pending'
              ORDER BY sequence_order
              LIMIT 1
           )
        `,
        [workflowRunId]
      )
    );
  }

  async function progressUntil(workflowRunId, predicate, maxIterations = 40) {
    let last = null;
    for (let i = 0; i < maxIterations; i += 1) {
      last = await progressOnce(workflowRunId);
      if (!last) break;
      if (last.status === 'failed') break;
      if (last.status === 'waiting') {
        await forceNextPendingStepToRunNow(workflowRunId);
        continue;
      }
      if (predicate(last)) break;
    }
    return last;
  }

  async function finishWorkflowRun(workflowRunId, maxIterations = 20) {
    for (let i = 0; i < maxIterations; i += 1) {
      const result = await progressOnce(workflowRunId);
      if (result?.status === 'waiting') {
        await forceNextPendingStepToRunNow(workflowRunId);
      }
      const { rows } = await withFixtureAdminContext(client, () =>
        client.query(
          `SELECT workflow_status
             FROM workflow_runs
            WHERE id = $1::uuid
            LIMIT 1`,
          [workflowRunId]
        )
      );
      if (rows[0]?.workflow_status === 'completed') return 'completed';
      if (rows[0]?.workflow_status === 'failed') return 'failed';
    }
    return null;
  }

  async function getTaskIdByKey(organizationId, transferId, taskTypeKey) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `
          SELECT t.id
          FROM tasks t
          JOIN task_types tt ON tt.id = t.task_type_id
          WHERE t.organization_id = $1::uuid
            AND tt.key = $2
            AND t.resource_type = 'warehouse_transfer'
            AND t.resource_id = $3::uuid
          ORDER BY t.created_at DESC
          LIMIT 1
        `,
        [organizationId, taskTypeKey, transferId]
      )
    );
    return rows[0]?.id ?? null;
  }

  async function getTaskEventCount(taskId) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT COUNT(*)::int AS count
           FROM task_events
          WHERE task_id = $1::uuid`,
        [taskId]
      )
    );
    return rows[0]?.count ?? 0;
  }

  async function getLatestTaskEvent(taskId) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT id,
              to_status AS task_status,
              payload,
              idempotency_key
         FROM task_events
        WHERE task_id = $1::uuid
        ORDER BY task_version DESC
        LIMIT 1`,
        [taskId]
      )
    );
    return rows[0] ?? null;
  }

  async function completeTask(taskId, idempotencyKey, payload = {}) {
    await client.query(
      `SELECT transition_task_v1(
        $1::uuid,
        'completed',
        NULL,
        $2::jsonb,
        $3
      )`,
      [taskId, JSON.stringify(payload), idempotencyKey]
    );
  }

  async function executeWarehouseTransferReconcile(transferId, payload = {}) {
    const { rows } = await client.query(
      `SELECT api.ui_execute_warehouse_transfer_reconcile_v1(
        'warehouse_transfers.reconcile_destination',
        'warehouse_transfers',
        ARRAY[$1::text],
        $1::text,
        1,
        $2::jsonb
      ) AS result`,
      [transferId, JSON.stringify(payload)]
    );
    return rows[0]?.result ?? null;
  }

  async function getWarehouseTransfer(transferId) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT status,
              dispatched_at,
              received_at,
              reconciled_at,
              received_shipment_count,
              damaged_shipment_count,
              missing_shipment_count,
              unmanifested_shipment_count,
              metadata
         FROM warehouse_transfers
        WHERE id = $1::uuid
        LIMIT 1`,
        [transferId]
      )
    );
    return rows[0] ?? null;
  }

  async function getWarehouseTransferById(transferId) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT id,
              transfer_code,
              status,
              from_branch_id,
              to_branch_id,
              dispatched_at,
              received_at
         FROM warehouse_transfers
        WHERE id = $1::uuid
        LIMIT 1`,
        [transferId]
      )
    );
    return rows[0] ?? null;
  }

  async function createHandlingUnit(organizationId, branchId, code) {
    const handlingUnitId = randomUUID();
    await withFixtureAdminContext(client, () =>
      client.query(
        `INSERT INTO handling_units (
        id,
        organization_id,
        branch_id,
        unit_type,
        status,
        code
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'bag',
        'open',
        $4
      )`,
        [handlingUnitId, organizationId, branchId, code]
      )
    );
    return handlingUnitId;
  }

  async function recordWarehouseCheckpoint(params) {
    const { rows } = await client.query(
      `SELECT scan_event_id, created
         FROM public.record_scan_event_v1($1::jsonb)`,
      [JSON.stringify(params)]
    );
    return rows[0] ?? null;
  }

  async function registerUserDevice() {
    const { rows } = await client.query(
      `SELECT device_id
         FROM public.register_user_device_v1($1::jsonb)`,
      [
        JSON.stringify({
          device_platform: 'android',
          device_identifier_sha256: randomBytes(32).toString('hex'),
          device_label: `warehouse-transfer-device-${randomUUID().slice(0, 8)}`,
          app_version: '0.1.0',
          os_version: 'integration',
          metadata: { source: 'warehouse-transfer-execute.test.js' },
        }),
      ]
    );
    return rows[0]?.device_id ?? null;
  }

  async function getScanEvent(scanEventId) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT id,
              scan_type,
              checkpoint_key,
              checkpoint_sequence,
              barcode,
              handling_unit_id,
              warehouse_transfer_id,
              branch_id,
              metadata
         FROM scan_events
        WHERE id = $1::uuid
        LIMIT 1`,
        [scanEventId]
      )
    );
    return rows[0] ?? null;
  }

  async function seedTransferManifest(organizationId, userId, manifestCount = 1) {
    const suffix = randomUUID().slice(0, 8);
    const fromBranchId = randomUUID();
    const toBranchId = randomUUID();
    const { id: clientId } = await createClient(
      client,
      organizationId,
      `Warehouse Transfer Client ${suffix}`
    );
    const shipmentIds = [];

    await withFixtureAdminContext(client, async () => {
      await client.query(
        `INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'UTC', true)`,
        [fromBranchId, organizationId, `from-${suffix}`, `From Branch ${suffix}`]
      );
      await client.query(
        `INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'UTC', true)`,
        [toBranchId, organizationId, `to-${suffix}`, `To Branch ${suffix}`]
      );
    });

    for (let index = 0; index < manifestCount; index += 1) {
      const shipment = await createShipment(client, {
        organizationId,
        clientId,
        trackingNumber: `trk-${suffix}-${index}`,
        status: 'created',
      });
      shipmentIds.push(shipment.id);
    }

    const manifest = await createWarehouseTransferManifest(client, {
      organization_id: organizationId,
      transfer_code: `xfer-${suffix}`,
      from_branch_id: fromBranchId,
      to_branch_id: toBranchId,
      shipment_ids: shipmentIds,
      metadata: {
        source: 'integration.workflow_seed',
      },
    });

    expect(manifest?.status).toBe('transfer_manifest_created');
    expect(manifest?.transfer_id).toBeTruthy();

    return {
      transferId: manifest.transfer_id,
      fromBranchId,
      toBranchId,
    };
  }

  test('happy path captures receive and reconcile summaries without hold or approval tasks', async () => {
    const { id: organizationId } = await createOrganization(client, 'Warehouse Transfer Workflow Happy Org');
    const userId = await createUser(
      client,
      organizationId,
      `warehouse-transfer-happy-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, userId);

    const { transferId, fromBranchId, toBranchId } = await seedTransferManifest(organizationId, userId, 1);

    const templateId = await getWorkflowTemplateId('warehouse_transfer_execute_v1');
    expect(templateId).toBeTruthy();

    const runId = await startWorkflowRun(templateId, {
      organization_id: organizationId,
      warehouse_transfer_id: transferId,
      from_branch_id: fromBranchId,
      to_branch_id: toBranchId
    });
    expect(runId).toBeTruthy();

    await progressUntil(runId, (result) => result.status === 'pending');
    const packTaskId = await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_pack');
    expect(packTaskId).toBeTruthy();
    await completeTask(packTaskId, `warehouse-transfer-pack-${randomUUID()}`);

    await progressUntil(runId, (result) => result.status === 'pending');
    const dispatchTaskId = await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_dispatch');
    expect(dispatchTaskId).toBeTruthy();
    await completeTask(dispatchTaskId, `warehouse-transfer-dispatch-${randomUUID()}`);

    await progressUntil(runId, (result) => result.status === 'pending');
    const afterDispatch = await getWarehouseTransfer(transferId);
    expect(afterDispatch?.status).toBe('in_transit');
    expect(afterDispatch?.dispatched_at).toBeTruthy();

    const receiveTaskId = await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_receive');
    expect(receiveTaskId).toBeTruthy();
    const receiveKey = `warehouse-transfer-receive-${randomUUID()}`;
    const receiveEventCountBefore = await getTaskEventCount(receiveTaskId);
    await completeTask(receiveTaskId, receiveKey, {
      received_shipment_count: 1,
      damaged_shipment_count: 0,
      missing_shipment_count: 0,
      unmanifested_shipment_count: 0,
      notes: 'clean receipt'
    });
    const receiveEventCountAfterFirstComplete = await getTaskEventCount(receiveTaskId);
    await completeTask(receiveTaskId, receiveKey, {
      received_shipment_count: 1,
      damaged_shipment_count: 0,
      missing_shipment_count: 0,
      unmanifested_shipment_count: 0
    });
    expect(receiveEventCountAfterFirstComplete).toBe(receiveEventCountBefore + 1);
    expect(await getTaskEventCount(receiveTaskId)).toBe(receiveEventCountAfterFirstComplete);

    await progressUntil(runId, (result) => result.status === 'pending');

    const afterReceive = await getWarehouseTransfer(transferId);
    expect(afterReceive?.status).toBe('received');
    expect(afterReceive?.received_at).toBeTruthy();
    expect(afterReceive?.received_shipment_count).toBe(1);
    expect(afterReceive?.damaged_shipment_count).toBe(0);
    expect(afterReceive?.missing_shipment_count).toBe(0);
    expect(afterReceive?.unmanifested_shipment_count).toBe(0);
    expect(afterReceive?.metadata?.receive?.expected_manifest_count).toBe(1);
    expect(afterReceive?.metadata?.receive?.has_discrepancy).toBe(false);
    expect(afterReceive?.metadata?.receive?.has_unmanifested_hold).toBe(false);
    expect(await getTaskIdByKey(organizationId, transferId, 'warehouse_exception_hold')).toBeNull();

    await setAuthenticatedTenantContext(organizationId, userId);

    const reconcileTaskId = await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_reconcile');
    expect(reconcileTaskId).toBeTruthy();
    const reconcileResult = await executeWarehouseTransferReconcile(transferId, {
      received_shipment_count: 1,
      damaged_shipment_count: 0,
      missing_shipment_count: 0,
      unmanifested_shipment_count: 0,
      reconcile_notes: 'matched manifest'
    });
    expect(reconcileResult).toMatchObject({
      status: 'reconcile_recorded',
      warehouse_transfer_id: transferId,
      task_id: reconcileTaskId,
      replayed: false,
    });
    expect(reconcileResult?.task_event_id).toBeTruthy();
    expect(reconcileResult?.workflow_run_id).toBeTruthy();

    const reconcileResultRetry = await executeWarehouseTransferReconcile(transferId, {
      received_shipment_count: 1,
      damaged_shipment_count: 0,
      missing_shipment_count: 0,
      unmanifested_shipment_count: 0,
      reconcile_notes: 'matched manifest'
    });
    expect(reconcileResultRetry).toMatchObject({
      status: 'reconcile_recorded_replay',
      task_id: reconcileTaskId,
      replayed: true,
    });
    expect(reconcileResultRetry?.task_event_id).toBe(reconcileResult?.task_event_id);

    const latestReconcileEvent = await getLatestTaskEvent(reconcileTaskId);
    expect(latestReconcileEvent).toMatchObject({
      id: reconcileResult.task_event_id,
      task_status: 'completed',
      idempotency_key: reconcileResult.idempotency_key,
    });
    expect(latestReconcileEvent?.payload).toMatchObject({
      received_shipment_count: 1,
      damaged_shipment_count: 0,
      missing_shipment_count: 0,
      unmanifested_shipment_count: 0,
      reconcile_notes: 'matched manifest',
    });
  });

  test('authenticated reads resolve transfer foundation rows through api schema views', async () => {
    const { id: organizationId } = await createOrganization(client, 'Warehouse Transfer API Contract Org');
    const userId = await createUser(
      client,
      organizationId,
      `warehouse-transfer-api-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );
    const { id: clientId } = await createClient(client, organizationId, 'Warehouse Transfer API Contract Client');

    await setServiceContext(organizationId, userId);

    const fromBranchId = randomUUID();
    const toBranchId = randomUUID();

    await client.query(
      `INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'UTC', true)`,
      [fromBranchId, organizationId, `from-api-${String(fromBranchId).slice(0, 8)}`, 'API From Branch']
    );
    await client.query(
      `INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'UTC', true)`,
      [toBranchId, organizationId, `to-api-${String(toBranchId).slice(0, 8)}`, 'API To Branch']
    );

    const transferId = randomUUID();
    const handlingUnitId = randomUUID();
    const transferItemId = randomUUID();
    const transferCode = `xfer-api-${String(transferId).slice(0, 8)}`;
    const handlingUnitCode = `hu-api-${String(handlingUnitId).slice(0, 8)}`;
    const shipment = await createShipment(client, {
      organizationId,
      clientId,
      trackingNumber: `WTAPI-${randomUUID().slice(0, 8).toUpperCase()}`,
    });

    await client.query(
      `INSERT INTO warehouse_transfers (
        id,
        organization_id,
        from_branch_id,
        to_branch_id,
        status,
        transfer_code,
        created_by_user_id
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        'draft',
        $5,
        $6::uuid
      )`,
      [transferId, organizationId, fromBranchId, toBranchId, transferCode, userId]
    );

    await client.query(
      `INSERT INTO handling_units (
        id,
        organization_id,
        branch_id,
        unit_type,
        status,
        code
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'bag',
        'open',
        $4
      )`,
      [handlingUnitId, organizationId, fromBranchId, handlingUnitCode]
    );

    await client.query(
      `INSERT INTO warehouse_transfer_items (
        id,
        organization_id,
        transfer_id,
        client_id,
        shipment_id,
        added_by_user_id
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::uuid
      )`,
      [transferItemId, organizationId, transferId, clientId, shipment.id, userId]
    );

    await setAuthenticatedTenantContext(organizationId, userId);

    const { rows: apiTransferRows } = await client.query(
      `SELECT id, transfer_code, status
         FROM api.warehouse_transfers
        WHERE id = $1::uuid
        LIMIT 1`,
      [transferId]
    );
    expect(apiTransferRows).toHaveLength(1);
    expect(apiTransferRows[0]).toMatchObject({
      id: transferId,
      transfer_code: transferCode,
      status: 'draft',
    });

    const { rows: apiHandlingUnitRows } = await client.query(
      `SELECT id, code, unit_type, status
         FROM api.handling_units
        WHERE id = $1::uuid
        LIMIT 1`,
      [handlingUnitId]
    );
    expect(apiHandlingUnitRows).toHaveLength(1);
    expect(apiHandlingUnitRows[0]).toMatchObject({
      id: handlingUnitId,
      code: handlingUnitCode,
      unit_type: 'bag',
      status: 'open',
    });

    const { rows: apiTransferItemRows } = await client.query(
      `SELECT id, transfer_id, client_id, shipment_id
         FROM api.warehouse_transfer_items
        WHERE id = $1::uuid
        LIMIT 1`,
      [transferItemId]
    );
    expect(apiTransferItemRows).toHaveLength(1);
    expect(apiTransferItemRows[0]).toMatchObject({
      id: transferItemId,
      transfer_id: transferId,
      client_id: clientId,
      shipment_id: shipment.id,
    });
  });

  test('dedicated transfer dispatch UI executor starts the canonical workflow and wakes the pack step', async () => {
    const { id: organizationId } = await createOrganization(client, 'Warehouse Transfer Dispatch UI Org');
    const userId = await createUser(
      client,
      organizationId,
      `warehouse-transfer-dispatch-ui-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, userId);

    const { transferId, fromBranchId, toBranchId } = await seedTransferManifest(organizationId, userId, 1);

    await setAuthenticatedTenantContext(organizationId, userId);

    const result = await executeWarehouseTransferDispatch(transferId);
    expect(result).toMatchObject({
      status: 'workflow_started',
      warehouse_transfer_id: transferId,
      transfer_status: 'draft',
      started: true,
    });
    expect(result?.workflow_run_id).toBeTruthy();

    const runs = await getTransferWorkflowRuns(transferId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: result.workflow_run_id,
      workflow_status: 'in_progress',
    });
    expect(runs[0].context).toMatchObject({
      organization_id: organizationId,
      warehouse_transfer_id: transferId,
      from_branch_id: fromBranchId,
      to_branch_id: toBranchId,
    });

    const packTaskId = await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_pack');
    expect(packTaskId).toBeTruthy();

    const transfer = await getWarehouseTransfer(transferId);
    expect(transfer?.status).toBe('draft');
    expect(transfer?.dispatched_at).toBeNull();
  });

  test('dedicated transfer checkpoint UI executor records departure and arrival scans against the active workflow tasks', async () => {
    const { id: organizationId } = await createOrganization(client, 'Warehouse Transfer Checkpoint UI Org');
    const userId = await createUser(
      client,
      organizationId,
      `warehouse-transfer-checkpoint-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, userId);

    const { transferId, fromBranchId, toBranchId } = await seedTransferManifest(organizationId, userId, 1);
    const transfer = await getWarehouseTransferById(transferId);
    const handlingUnitCode = `hu-checkpoint-${randomUUID().slice(0, 8)}`;

    await createHandlingUnit(organizationId, fromBranchId, handlingUnitCode);
    await setAuthenticatedTenantContext(organizationId, userId);
    const deviceId = await registerUserDevice();
    expect(deviceId).toBeTruthy();

    const dispatchResult = await executeWarehouseTransferDispatch(transferId);
    expect(dispatchResult?.workflow_run_id).toBeTruthy();

    const packTaskId = await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_pack');
    expect(packTaskId).toBeTruthy();
    await completeTask(packTaskId, `warehouse-transfer-pack-${randomUUID()}`);

    await setServiceContext(organizationId, userId);
    await progressUntil(dispatchResult.workflow_run_id, (result) => result.status === 'pending');
    expect(
      await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_dispatch')
    ).toBeTruthy();
    await setAuthenticatedTenantContext(organizationId, userId);

    const inboundScan = await recordWarehouseCheckpoint({
      idempotency_key: `warehouse-transfer-inbound-${randomUUID()}`,
      scan_type: 'warehouse_checkpoint',
      barcode: handlingUnitCode,
      checkpoint_key: 'inbound',
      handling_unit_code: handlingUnitCode,
      warehouse_transfer_id: transferId,
      device_id: deviceId,
      branch_id: fromBranchId,
      metadata: { source: 'warehouse-transfer-execute.test.js', stage: 'pre-departure' },
    });
    expect(inboundScan?.created).toBe(true);

    const sortScan = await recordWarehouseCheckpoint({
      idempotency_key: `warehouse-transfer-sort-${randomUUID()}`,
      scan_type: 'warehouse_checkpoint',
      barcode: handlingUnitCode,
      checkpoint_key: 'sort',
      handling_unit_code: handlingUnitCode,
      warehouse_transfer_id: transferId,
      device_id: deviceId,
      branch_id: fromBranchId,
      metadata: { source: 'warehouse-transfer-execute.test.js', stage: 'pre-departure' },
    });
    expect(sortScan?.created).toBe(true);

    const departureResult = await executeWarehouseTransferCheckpoint(
      'warehouse_transfers.scan_departure',
      transferId,
      {
        barcode: handlingUnitCode,
        handling_unit_code: handlingUnitCode,
        device_id: deviceId,
        notes: 'Loaded to outbound linehaul',
      }
    );
    expect(departureResult).toMatchObject({
      status: 'task_completed',
      action_key: 'warehouse_transfers.scan_departure',
      phase: 'dispatch',
      checkpoint_key: 'load',
      warehouse_transfer_id: transferId,
      transfer_status: 'in_transit',
    });
    expect(departureResult?.task_id).toBeTruthy();
    expect(departureResult?.task_event_id).toBeTruthy();
    expect(departureResult?.scan_event_id).toBeTruthy();

    await setServiceContext(organizationId, userId);
    const persistedDepartureScan = await getScanEvent(departureResult.scan_event_id);
    expect(persistedDepartureScan).toMatchObject({
      id: departureResult.scan_event_id,
      scan_type: 'warehouse_checkpoint',
      checkpoint_key: 'load',
      checkpoint_sequence: 3,
      barcode: handlingUnitCode,
      warehouse_transfer_id: transferId,
      branch_id: fromBranchId,
    });
    expect(persistedDepartureScan?.metadata?.action_key).toBe(
      'warehouse_transfers.scan_departure'
    );
    expect(persistedDepartureScan?.metadata?.phase).toBe('dispatch');

    const afterDeparture = await getWarehouseTransfer(transferId);
    expect(afterDeparture?.status).toBe('in_transit');
    expect(afterDeparture?.dispatched_at).toBeTruthy();

    await setAuthenticatedTenantContext(organizationId, userId);
    const arrivalResult = await executeWarehouseTransferCheckpoint(
      'warehouse_transfers.scan_arrival',
      transferId,
      {
        barcode: handlingUnitCode,
        handling_unit_code: handlingUnitCode,
        device_id: deviceId,
        notes: 'Unloaded at destination dock',
      }
    );
    expect(arrivalResult).toMatchObject({
      status: 'task_completed',
      action_key: 'warehouse_transfers.scan_arrival',
      phase: 'receive',
      checkpoint_key: 'unload',
      warehouse_transfer_id: transferId,
      transfer_status: 'received',
    });
    expect(arrivalResult?.task_id).toBeTruthy();
    expect(arrivalResult?.task_event_id).toBeTruthy();
    expect(arrivalResult?.scan_event_id).toBeTruthy();

    await setServiceContext(organizationId, userId);
    const persistedArrivalScan = await getScanEvent(arrivalResult.scan_event_id);
    expect(persistedArrivalScan).toMatchObject({
      id: arrivalResult.scan_event_id,
      scan_type: 'warehouse_checkpoint',
      checkpoint_key: 'unload',
      checkpoint_sequence: 4,
      barcode: handlingUnitCode,
      warehouse_transfer_id: transferId,
      branch_id: toBranchId,
    });

    const afterArrival = await getWarehouseTransfer(transferId);
    expect(afterArrival?.status).toBe('received');
    expect(afterArrival?.received_at).toBeTruthy();
    expect(afterArrival?.received_shipment_count).toBe(1);
    expect(afterArrival?.metadata?.receive?.expected_manifest_count).toBe(1);
    expect(afterArrival?.metadata?.receive?.has_discrepancy).toBe(false);
    expect(transfer?.transfer_code).toBeTruthy();
  });

  test('dedicated transfer checkpoint UI executor rejects invalid workflow phase transitions', async () => {
    const { id: organizationId } = await createOrganization(client, 'Warehouse Transfer Checkpoint Invalid Org');
    const userId = await createUser(
      client,
      organizationId,
      `warehouse-transfer-checkpoint-invalid-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, userId);

    const { transferId } = await seedTransferManifest(organizationId, userId, 1);

    await setAuthenticatedTenantContext(organizationId, userId);

    await expect(
      executeWarehouseTransferCheckpoint('warehouse_transfers.scan_arrival', transferId, {
        barcode: `invalid-arrival-${randomUUID().slice(0, 8)}`,
      })
    ).rejects.toThrow('arrival only supports in_transit warehouse_transfers');
  });

  test('dedicated transfer dispatch UI executor reuses the active workflow instead of starting a duplicate run', async () => {
    const { id: organizationId } = await createOrganization(client, 'Warehouse Transfer Dispatch UI Replay Org');
    const userId = await createUser(
      client,
      organizationId,
      `warehouse-transfer-dispatch-replay-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, userId);

    const { transferId } = await seedTransferManifest(organizationId, userId, 1);

    await setAuthenticatedTenantContext(organizationId, userId);

    const firstResult = await executeWarehouseTransferDispatch(transferId);
    const secondResult = await executeWarehouseTransferDispatch(transferId);

    expect(firstResult?.workflow_run_id).toBeTruthy();
    expect(secondResult).toMatchObject({
      status: 'workflow_existing',
      workflow_run_id: firstResult.workflow_run_id,
      warehouse_transfer_id: transferId,
      started: false,
    });

    const runs = await getTransferWorkflowRuns(transferId);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(firstResult.workflow_run_id);
  });

  test('dedicated transfer dispatch UI executor rejects transfers that already left draft status', async () => {
    const { id: organizationId } = await createOrganization(client, 'Warehouse Transfer Dispatch Invalid Status Org');
    const userId = await createUser(
      client,
      organizationId,
      `warehouse-transfer-dispatch-invalid-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, userId);

    const { transferId } = await seedTransferManifest(organizationId, userId, 1);

    await client.query(
      `SELECT *
         FROM public.transition_warehouse_transfer_v1($1::jsonb)`,
      [
        JSON.stringify({
          organization_id: organizationId,
          warehouse_transfer_id: transferId,
          from_status: 'draft',
          to_status: 'in_transit',
          set_dispatched_at: true
        })
      ]
    );

    await setAuthenticatedTenantContext(organizationId, userId);

    await expect(executeWarehouseTransferDispatch(transferId)).rejects.toThrow(
      'only supports draft warehouse_transfers'
    );
  });

  test('dedicated transfer reconcile UI executor rejects transfers that are not yet received', async () => {
    const { id: organizationId } = await createOrganization(client, 'Warehouse Transfer Reconcile Invalid Status Org');
    const userId = await createUser(
      client,
      organizationId,
      `warehouse-transfer-reconcile-invalid-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, userId);

    const { transferId } = await seedTransferManifest(organizationId, userId, 1);

    await setAuthenticatedTenantContext(organizationId, userId);

    await expect(
      executeWarehouseTransferReconcile(transferId, {
        received_shipment_count: 1,
      })
    ).rejects.toThrow('only supports received warehouse_transfers');
  });

  test('unmanifested receive requires hold and reconcile discrepancy requires supervisor approval', async () => {
    const { id: organizationId } = await createOrganization(client, 'Warehouse Transfer Workflow Variance Org');
    const userId = await createUser(
      client,
      organizationId,
      `warehouse-transfer-variance-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, userId);

    const { transferId, fromBranchId, toBranchId } = await seedTransferManifest(organizationId, userId, 1);
    const templateId = await getWorkflowTemplateId('warehouse_transfer_execute_v1');

    const runId = await startWorkflowRun(templateId, {
      organization_id: organizationId,
      warehouse_transfer_id: transferId,
      from_branch_id: fromBranchId,
      to_branch_id: toBranchId
    });

    await progressUntil(runId, (result) => result.status === 'pending');
    await completeTask(
      await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_pack'),
      `warehouse-transfer-pack-${randomUUID()}`
    );

    await progressUntil(runId, (result) => result.status === 'pending');
    await completeTask(
      await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_dispatch'),
      `warehouse-transfer-dispatch-${randomUUID()}`
    );

    await progressUntil(runId, (result) => result.status === 'pending');
    await completeTask(
      await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_receive'),
      `warehouse-transfer-receive-${randomUUID()}`,
      {
        received_shipment_count: 2,
        damaged_shipment_count: 1,
        missing_shipment_count: 0,
        unmanifested_shipment_count: 1,
        notes: 'extra shipment found at dock'
      }
    );

    await progressUntil(runId, (result) => result.status === 'pending');
    const afterReceive = await getWarehouseTransfer(transferId);
    expect(afterReceive?.status).toBe('received');
    expect(afterReceive?.metadata?.receive?.has_unmanifested_hold).toBe(true);

    const holdTaskId = await getTaskIdByKey(organizationId, transferId, 'warehouse_exception_hold');
    expect(holdTaskId).toBeTruthy();
    await completeTask(holdTaskId, `warehouse-transfer-hold-${randomUUID()}`, {
      notes: 'quarantined extra shipment for review'
    });

    await progressUntil(runId, (result) => result.status === 'pending');
    await setAuthenticatedTenantContext(organizationId, userId);

    const reconcileTaskId = await getTaskIdByKey(organizationId, transferId, 'warehouse_transfer_reconcile');
    expect(reconcileTaskId).toBeTruthy();
    const reconcileResult = await executeWarehouseTransferReconcile(transferId, {
      received_shipment_count: 0,
      damaged_shipment_count: 0,
      missing_shipment_count: 1,
      unmanifested_shipment_count: 0,
      reconcile_notes: 'manifest short after recount'
    });
    expect(reconcileResult?.transfer_status).toBe('received');
    expect(reconcileResult?.workflow_run_id).toBeTruthy();
    expect(reconcileResult?.task_event_id).toBeTruthy();

    const latestReconcileEvent = await getLatestTaskEvent(reconcileTaskId);
    expect(latestReconcileEvent).toMatchObject({
      id: reconcileResult.task_event_id,
      task_status: 'completed',
      idempotency_key: reconcileResult.idempotency_key,
    });
    expect(latestReconcileEvent?.payload).toMatchObject({
      received_shipment_count: 0,
      damaged_shipment_count: 0,
      missing_shipment_count: 1,
      unmanifested_shipment_count: 0,
      reconcile_notes: 'manifest short after recount',
    });
  });

  test('transition_warehouse_transfer_v1 rejects receive before in_transit', async () => {
    const { id: organizationId } = await createOrganization(client, 'Warehouse Transfer Workflow Invalid Org');
    const userId = await createUser(
      client,
      organizationId,
      `warehouse-transfer-invalid-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, userId);

    const { transferId } = await seedTransferManifest(organizationId, userId, 1);

    await expect(
      client.query(
        `SELECT *
           FROM public.transition_warehouse_transfer_v1($1::jsonb)`,
        [
          JSON.stringify({
            organization_id: organizationId,
            warehouse_transfer_id: transferId,
            from_status: 'in_transit',
            to_status: 'received',
            set_received_at: true
          })
        ]
      )
    ).rejects.toThrow('from_status mismatch');
  });
});
