const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  createOrganization,
  createUser,
  setAuthContext,
  withFixtureAdminContext,
  setServiceContext: setCanonicalServiceContext,
} = require('../helpers/tenant-utils');

loadEnv();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('COD driver shift settlement workflow', () => {
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

  async function progressWorkflowFully(workflowRunId, options = {}) {
    const { initialPayload = null, maxAttempts = 30 } = options;

    for (let i = 0; i < maxAttempts; i += 1) {
      const payload = i === 0 && initialPayload ? initialPayload : {};
      const { rows } = await client.query(
        `SELECT progress_workflow_run($1::uuid, $2::jsonb) AS result`,
        [workflowRunId, JSON.stringify(payload)]
      );
      const result = rows[0]?.result;
      if (!result?.step_id) break;
      if (result.status === 'failed') break;
      if (result.status === 'waiting') break;
    }
  }

  async function getWorkflowTemplateIdByName(name) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT id
           FROM workflow_templates
          WHERE name = $1
          LIMIT 1`,
        [name]
      )
    );
    return rows[0]?.id ?? null;
  }

  async function getWorkflowContext(workflowRunId) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT context
           FROM workflow_runs
          WHERE id = $1::uuid
          LIMIT 1`,
        [workflowRunId]
      )
    );
    return rows[0]?.context ?? null;
  }

  async function getTaskIdForSettlementBatch(organizationId, settlementBatchId, taskTypeKey) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT t.id AS task_id
           FROM tasks t
           JOIN task_types tt
             ON tt.id = t.task_type_id
          WHERE t.organization_id = $1::uuid
            AND t.resource_type = 'settlement_batch'
            AND t.resource_id = $2::uuid
            AND tt.key = $3
          ORDER BY t.created_at DESC
          LIMIT 1`,
        [organizationId, settlementBatchId, taskTypeKey]
      )
    );
    return rows[0]?.task_id ?? null;
  }

  async function transitionTaskCompleted(taskId, idempotencyKey, payload = {}) {
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

  async function openOpsSession(sessionType, branchId, idempotencyKey) {
    const { rows } = await client.query(`SELECT * FROM public.open_ops_session_v1($1::jsonb)`, [
      JSON.stringify({
        session_type: sessionType,
        branch_id: branchId,
        idempotency_key: idempotencyKey
      })
    ]);
    return rows[0]?.ops_session_id ?? null;
  }

  async function createBranch(organizationId) {
    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `INSERT INTO branches (organization_id, code, name, branch_type, metadata)
         VALUES ($1::uuid, $2, $3, $4, '{}'::jsonb)
         RETURNING id`,
        [organizationId, `b-${randomUUID().slice(0, 8)}`, 'Main Branch', 'hub']
      )
    );
    return rows[0]?.id ?? null;
  }

  async function readSettlementBatch(settlementBatchId, organizationId, columns) {
    const allowedColumns = new Set([
      'metadata',
      'status',
      'status, branch_id, subject_type, subject_id',
    ]);
    if (!allowedColumns.has(columns)) {
      throw new Error(`Unsupported settlement batch read projection: ${columns}`);
    }

    const { rows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT ${columns}
           FROM settlement_batches
          WHERE id = $1::uuid
            AND organization_id = $2::uuid
          LIMIT 1`,
        [settlementBatchId, organizationId]
      )
    );
    return rows[0] ?? null;
  }

  async function seedCanonicalCodPaymentCollection({
    organizationId,
    branchId,
    driverUserId,
    codAmount,
    collectedAmount = codAmount,
    paymentMethod = 'cash',
    paymentOutcome = 'collected',
    currency = 'SAR',
  }) {
    const clientId = randomUUID();
    const senderId = randomUUID();
    const vehicleId = randomUUID();
    const shipmentId = randomUUID();

    await withFixtureAdminContext(client, async () => {
      await client.query(
        `INSERT INTO public.clients (id, organization_id, name, slug, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'active')`,
        [
          clientId,
          organizationId,
          `COD Settlement Client ${clientId.slice(0, 8)}`,
          `cod-settlement-client-${clientId.slice(0, 8)}`,
        ]
      );
      await client.query(
        `INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, true, 'active')`,
        [
          senderId,
          clientId,
          `COD Settlement Sender ${senderId.slice(0, 8)}`,
          `COD Settlement Sender ${senderId.slice(0, 8)}`,
        ]
      );
      await client.query(
        `INSERT INTO public.vehicles (id, organization_id, status, is_active)
         VALUES ($1::uuid, $2::uuid, 'active', true)`,
        [vehicleId, organizationId]
      );
      await client.query(
        `INSERT INTO public.shipments (
         id,
         organization_id,
         client_id,
         sender_id,
         service_type,
         tracking_number,
         status,
         box_count,
         cod_amount,
         cod_currency,
         shipment_settings_override,
         metadata
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4::uuid,
         'delivery',
         $5,
         'out_for_delivery',
         1,
         $6::numeric,
         $7,
         '{}'::jsonb,
         $8::jsonb
       )`,
      [
        shipmentId,
        organizationId,
        clientId,
        senderId,
        `CODSETTLE${shipmentId.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
        codAmount,
        currency,
        JSON.stringify({
          source: 'cod-driver-shift-settlement-test',
          cod_amount: codAmount,
          cod_currency: currency,
        }),
        ]
      );
    });

    const { rows: routeRows } = await client.query(
      `SELECT route_run_id, stop_ids
         FROM public.create_route_run_v1($1::jsonb)`,
      [
        JSON.stringify({
          organization_id: organizationId,
          branch_id: branchId,
          driver_user_id: driverUserId,
          vehicle_id: vehicleId,
          idempotency_key: `cod-settlement-route-${randomUUID()}`,
          stops: [
            {
              client_id: clientId,
              shipment_id: shipmentId,
              stop_kind: 'delivery',
              sequence_order: 1,
            },
          ],
        }),
      ]
    );

    const routeRunId = routeRows[0]?.route_run_id ?? null;
    const routeStopId = Array.isArray(routeRows[0]?.stop_ids) ? routeRows[0].stop_ids[0] ?? null : null;
    const expectedAmount = Number(codAmount);
    const normalizedCollectedAmount =
      paymentOutcome === 'refused' ? 0 : Number(collectedAmount);
    const varianceAmount = expectedAmount - normalizedCollectedAmount;
    const discrepancyKind =
      paymentOutcome === 'refused'
        ? 'refused'
        : varianceAmount > 0
          ? 'shortfall'
          : varianceAmount < 0
            ? 'over_collection'
            : 'matched';
    const allowedMethods =
      paymentMethod && paymentOutcome !== 'refused' ? [paymentMethod] : ['cash'];

    const { rows: actionRows } = await withFixtureAdminContext(client, () =>
      client.query(
        `INSERT INTO public.shipment_actions (
         organization_id,
         client_id,
         shipment_id,
         action_type,
         action_category,
         canonical_status,
         performed_by_system,
         action_data,
         timestamp
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'status_change',
         'operational',
         'delivered',
         'integration_test',
         $4::jsonb,
         now()
       )
       RETURNING id`,
      [
        organizationId,
        clientId,
        shipmentId,
        JSON.stringify({
          route_stop_id: routeStopId,
          delivery_completion: {
            completion_kind: 'full',
            payment_collection: {
              required: true,
              outcome: paymentOutcome,
              method: paymentOutcome === 'refused' ? null : paymentMethod,
              expected_amount: expectedAmount,
              collected_amount: normalizedCollectedAmount,
              variance_amount: varianceAmount,
              has_discrepancy: paymentOutcome === 'refused' || varianceAmount !== 0,
              discrepancy_kind: discrepancyKind,
              currency,
              allowed_methods: allowedMethods,
              payment_mode_label: allowedMethods.map((value) => value.toUpperCase()).join(' / '),
              receipt_context: 'settlement test seed',
            },
          },
        }),
        ]
      )
    );

    return {
      actionId: actionRows[0]?.id ?? null,
      clientId,
      routeRunId,
      routeStopId,
      shipmentId,
    };
  }

  test('cod_cash_handover requires ops_session_id (task_ops_session_policy enforcement)', async () => {
    const { id: organizationId } = await createOrganization(client, 'COD Session Policy Org');
    const opsUserId = await createUser(
      client,
      organizationId,
      `cod-session-ops-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );
    const driverUserId = await createUser(
      client,
      organizationId,
      `cod-session-driver-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver' }
    );

    await setServiceContext(organizationId, opsUserId);

    const branchId = await createBranch(organizationId);
    expect(branchId).toBeTruthy();

    await seedCanonicalCodPaymentCollection({
      organizationId,
      branchId,
      driverUserId,
      codAmount: 100,
      collectedAmount: 100,
      paymentMethod: 'cash',
    });

    const templateId = await getWorkflowTemplateIdByName('cod_driver_shift_settlement_v2');
    expect(templateId).toBeTruthy();

    const now = new Date();
    const windowStartAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const windowEndAt = now.toISOString();

    const { rows: runRows } = await client.query(
      `SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id`,
      [
        templateId,
        {
          organization_id: organizationId,
          kind: 'cod',
          scope_type: 'driver_shift',
          branch_id: branchId,
          subject_type: 'driver',
          subject_id: driverUserId,
          window_start_at: windowStartAt,
          window_end_at: windowEndAt
        }
      ]
    );
    const workflowRunId = runRows[0]?.run_id;
    expect(workflowRunId).toBeTruthy();

    // Step 1: create settlement batch
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);
    // Step 2: enqueue driver handover task
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);

    const ctxAfterCreate = await getWorkflowContext(workflowRunId);
    const settlementBatchId = ctxAfterCreate?.settlement_batch_id;
    expect(settlementBatchId).toBeTruthy();
    expect(Number(ctxAfterCreate?.settlement?.expected_amount || 0)).toBe(100);
    expect(Number(ctxAfterCreate?.settlement?.collected_amount || 0)).toBe(100);
    expect(Number(ctxAfterCreate?.settlement?.variance_amount || 0)).toBe(0);
    expect(Number(ctxAfterCreate?.settlement?.payment_collection_summary?.stop_count || 0)).toBe(1);

    const createSummary = await readSettlementBatch(settlementBatchId, organizationId, 'metadata');
    expect(Number(createSummary?.metadata?.expected_amount || 0)).toBe(100);
    expect(Number(createSummary?.metadata?.collected_amount || 0)).toBe(100);
    expect(Number(createSummary?.metadata?.variance_amount || 0)).toBe(0);

    const handoverTaskId = await getTaskIdForSettlementBatch(
      organizationId,
      settlementBatchId,
      'cod_cash_handover'
    );
    expect(handoverTaskId).toBeTruthy();

    await setAuthContext(client, driverUserId);

    await expect(
      client.query(
        `SELECT transition_task_v1(
          $1::uuid,
          'completed',
          NULL,
          $2::jsonb,
          $3
        )`,
        [handoverTaskId, JSON.stringify({ amount: 100 }), `cod-missing-session-${randomUUID()}`]
      )
    ).rejects.toThrow(/requires ops_session_id/i);

    // Ensure the "happy" path still works (separate transaction should test success).
    // NOTE: We do not continue the transaction here since the failure aborts it in PostgreSQL.
    // The passing path is already covered in the main workflow tests.
  });

  test('cod_driver_shift_settlement_v2 completes with zero variance (no manager task) and records paired finance_events', async () => {
    const { id: organizationId } = await createOrganization(client, 'COD Settlement Org');
    const opsUserId = await createUser(
      client,
      organizationId,
      `cod-ops-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );
    const driverUserId = await createUser(
      client,
      organizationId,
      `cod-driver-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver' }
    );
    const cashierUserId = await createUser(
      client,
      organizationId,
      `cod-cashier-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, opsUserId);

    const branchId = await createBranch(organizationId);
    expect(branchId).toBeTruthy();

    const { actionId, routeStopId } = await seedCanonicalCodPaymentCollection({
      organizationId,
      branchId,
      driverUserId,
      codAmount: 100,
      collectedAmount: 100,
      paymentMethod: 'cash',
    });

    const templateId = await getWorkflowTemplateIdByName('cod_driver_shift_settlement_v2');
    expect(templateId).toBeTruthy();

    const now = new Date();
    const windowStartAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const windowEndAt = now.toISOString();

    const { rows: runRows } = await client.query(
      `SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id`,
      [
        templateId,
        {
          organization_id: organizationId,
          kind: 'cod',
          scope_type: 'driver_shift',
          branch_id: branchId,
          subject_type: 'driver',
          subject_id: driverUserId,
          window_start_at: windowStartAt,
          window_end_at: windowEndAt
        }
      ]
    );
    const workflowRunId = runRows[0]?.run_id;
    expect(workflowRunId).toBeTruthy();

    // Step 1: create settlement batch
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);
    // Step 2: enqueue driver handover task
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);

    const ctxAfterCreate = await getWorkflowContext(workflowRunId);
    const settlementBatchId = ctxAfterCreate?.settlement_batch_id;
    expect(settlementBatchId).toBeTruthy();
    expect(Number(ctxAfterCreate?.settlement?.expected_amount || 0)).toBe(100);
    expect(Number(ctxAfterCreate?.settlement?.collected_amount || 0)).toBe(100);
    expect(Number(ctxAfterCreate?.settlement?.variance_amount || 0)).toBe(0);

    const handoverTaskId = await getTaskIdForSettlementBatch(
      organizationId,
      settlementBatchId,
      'cod_cash_handover'
    );
    expect(handoverTaskId).toBeTruthy();

    await setAuthContext(client, driverUserId);
    expect(routeStopId).toBeTruthy();
    expect(actionId).toBeTruthy();
    const { rows: [stop] } = await client.query(
      `SELECT api.resolve_fieldops_stop_detail_v1($1::uuid, 'driver', '{}'::jsonb) AS detail`,
      [routeStopId],
    );
    expect(stop?.detail?.paymentCollection).toMatchObject({
      outcome: 'collected',
      method: 'cash',
      expectedAmount: 100,
      collectedAmount: 100,
      currency: 'SAR',
      source: 'shipment_action',
      shipmentActionId: actionId,
    });
    const driverShiftSessionId = await openOpsSession(
      'driver_shift',
      branchId,
      `cod-driver-shift-${randomUUID()}`
    );
    expect(driverShiftSessionId).toBeTruthy();

    await transitionTaskCompleted(
      handoverTaskId,
      `cod-handover-done-${randomUUID()}`,
      { amount: 80, ops_session_id: driverShiftSessionId }
    );

    await setServiceContext(organizationId, opsUserId);

    // Step 3: wait for driver handover completion
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);
    // Step 4: enqueue cashier count task
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);

    const cashierTaskId = await getTaskIdForSettlementBatch(
      organizationId,
      settlementBatchId,
      'cod_cashier_count'
    );
    expect(cashierTaskId).toBeTruthy();

    await setAuthContext(client, cashierUserId);
    const cashDrawerSessionId = await openOpsSession(
      'branch_cash_drawer',
      branchId,
      `cod-cash-drawer-${randomUUID()}`
    );
    expect(cashDrawerSessionId).toBeTruthy();

    await transitionTaskCompleted(
      cashierTaskId,
      `cod-cashier-count-done-${randomUUID()}`,
      { amount: 100, ops_session_id: cashDrawerSessionId }
    );

    await setServiceContext(organizationId, opsUserId);

    // Step 5: wait for cashier count completion
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);
    // Step 6: variance gate compares canonical settlement.expected_amount against cashier count
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);

    let workflowContext = await getWorkflowContext(workflowRunId);
    expect(Number(workflowContext?.cod_variance?.expected_amount || 0)).toBe(100);
    expect(Number(workflowContext?.cod_variance?.actual_amount || 0)).toBe(100);
    expect(workflowContext?.cod_variance?.requires_manager_approval).toBe(false);

    // Steps 7..11: finance transfer, lock, optional manager approval skip, approve
    await progressWorkflowFully(workflowRunId);

    const batch = await readSettlementBatch(
      settlementBatchId,
      organizationId,
      'status, branch_id, subject_type, subject_id'
    );
    expect(batch?.status).toBe('approved');
    expect(batch?.branch_id).toBe(branchId);
    expect(String(batch?.subject_type || '').toLowerCase()).toBe('driver');
    expect(batch?.subject_id).toBe(driverUserId);

    const managerTaskId = await getTaskIdForSettlementBatch(
      organizationId,
      settlementBatchId,
      'cod_manager_approval'
    );
    expect(managerTaskId).toBeNull();

    const { rows: codPolicyRows } = await client.query(
      `SELECT value
         FROM resolve_cod_policy($1::jsonb)
        LIMIT 1`,
      [
        JSON.stringify({
          organization_id: organizationId,
          resource_id: branchId
        })
      ]
    );
    const expectedCurrency = codPolicyRows[0]?.value?.currency;
    expect(expectedCurrency).toBeTruthy();

    const { rows: financeRows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT id, direction, amount, currency, account_type, account_id
           FROM finance_events
          WHERE organization_id = $1::uuid
            AND event_type = 'cod_handover'
            AND subject_type = 'settlement_batch'
            AND subject_id = $2::uuid
          ORDER BY direction ASC`,
        [organizationId, settlementBatchId]
      )
    );

    expect(financeRows.length).toBe(2);
    expect(financeRows[0]).toMatchObject({
      direction: 'in',
      amount: '100',
      currency: expectedCurrency,
      account_type: 'branch',
      account_id: branchId
    });
    expect(financeRows[1]).toMatchObject({
      direction: 'out',
      amount: '100',
      currency: expectedCurrency,
      account_type: 'driver',
      account_id: driverUserId
    });

    const { rows: membershipRows } = await withFixtureAdminContext(client, () =>
      client.query(
        `SELECT member.finance_event_id
           FROM public.settlement_batch_finance_events member
           JOIN public.finance_events fe
             ON fe.id = member.finance_event_id
            AND fe.organization_id = member.organization_id
            AND fe.occurred_at = member.finance_occurred_at
          WHERE member.organization_id = $1::uuid
            AND member.settlement_batch_id = $2::uuid
          ORDER BY fe.direction`,
        [organizationId, settlementBatchId]
      )
    );
    expect(membershipRows.map((row) => row.finance_event_id))
      .toEqual(financeRows.map((row) => row.id));
  });

  test('cod_driver_shift_settlement_v2 requires manager approval when variance exceeds policy tolerance', async () => {
    const { id: organizationId } = await createOrganization(client, 'COD Settlement Variance Org');
    const opsUserId = await createUser(
      client,
      organizationId,
      `cod-ops-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );
    const driverUserId = await createUser(
      client,
      organizationId,
      `cod-driver-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant', userType: 'driver' }
    );
    const cashierUserId = await createUser(
      client,
      organizationId,
      `cod-cashier-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );
    const managerUserId = await createUser(
      client,
      organizationId,
      `cod-manager-${randomUUID().slice(0, 8)}@example.com`,
      { accessScopeType: 'tenant' }
    );

    await setServiceContext(organizationId, opsUserId);

    const branchId = await createBranch(organizationId);
    expect(branchId).toBeTruthy();

    const templateId = await getWorkflowTemplateIdByName('cod_driver_shift_settlement_v2');
    expect(templateId).toBeTruthy();

    const now = new Date();
    const windowStartAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const windowEndAt = now.toISOString();

    const { rows: runRows } = await client.query(
      `SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id`,
      [
        templateId,
        {
          organization_id: organizationId,
          kind: 'cod',
          scope_type: 'driver_shift',
          branch_id: branchId,
          subject_type: 'driver',
          subject_id: driverUserId,
          window_start_at: windowStartAt,
          window_end_at: windowEndAt
        }
      ]
    );
    const workflowRunId = runRows[0]?.run_id;
    expect(workflowRunId).toBeTruthy();

    // Step 1: create settlement batch
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);
    // Step 2: enqueue driver handover task
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);

    const ctxAfterCreate = await getWorkflowContext(workflowRunId);
    const settlementBatchId = ctxAfterCreate?.settlement_batch_id;
    expect(settlementBatchId).toBeTruthy();

    const handoverTaskId = await getTaskIdForSettlementBatch(
      organizationId,
      settlementBatchId,
      'cod_cash_handover'
    );
    expect(handoverTaskId).toBeTruthy();

    await setAuthContext(client, driverUserId);
    const driverShiftSessionId = await openOpsSession(
      'driver_shift',
      branchId,
      `cod-driver-shift-${randomUUID()}`
    );
    expect(driverShiftSessionId).toBeTruthy();

    await transitionTaskCompleted(
      handoverTaskId,
      `cod-handover-done-${randomUUID()}`,
      { amount: 100, ops_session_id: driverShiftSessionId }
    );

    await setServiceContext(organizationId, opsUserId);

    // Step 3: wait for driver handover completion
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);
    // Step 4: enqueue cashier count task
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);

    const cashierTaskId = await getTaskIdForSettlementBatch(
      organizationId,
      settlementBatchId,
      'cod_cashier_count'
    );
    expect(cashierTaskId).toBeTruthy();

    await setAuthContext(client, cashierUserId);
    const cashDrawerSessionId = await openOpsSession(
      'branch_cash_drawer',
      branchId,
      `cod-cash-drawer-${randomUUID()}`
    );
    expect(cashDrawerSessionId).toBeTruthy();

    // Actual cash counted is less than handover -> triggers manager approval under default settlement_policy.
    await transitionTaskCompleted(
      cashierTaskId,
      `cod-cashier-count-done-${randomUUID()}`,
      { amount: 90, ops_session_id: cashDrawerSessionId }
    );

    await setServiceContext(organizationId, opsUserId);

    // Step 5: wait for cashier completion
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);
    // Step 6: variance gate
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);

    const workflowContext = await getWorkflowContext(workflowRunId);
    expect(Number(workflowContext?.cod_variance?.expected_amount || 0)).toBe(100);
    expect(Number(workflowContext?.cod_variance?.actual_amount || 0)).toBe(90);
    expect(workflowContext?.cod_variance?.requires_manager_approval).toBe(true);

    // Step 7: finance transfer
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);
    // Step 8: lock settlement batch
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);
    // Step 9: enqueue manager approval task (variance requires it)
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);
    // Step 10: wait for manager approval (should block until completed)
    await client.query(`SELECT progress_workflow_run($1::uuid)`, [workflowRunId]);

    const managerTaskId = await getTaskIdForSettlementBatch(
      organizationId,
      settlementBatchId,
      'cod_manager_approval'
    );
    expect(managerTaskId).toBeTruthy();

    const lockedBatch = await readSettlementBatch(settlementBatchId, organizationId, 'status');
    expect(lockedBatch?.status).toBe('locked');

    await setAuthContext(client, managerUserId);
    await transitionTaskCompleted(managerTaskId, `cod-manager-approve-${randomUUID()}`, { approved: true });
    await setServiceContext(organizationId, opsUserId);

    // Step 10 already scheduled itself into polling mode before the manager completed the task.
    // Wake the first pending step explicitly so the engine can re-check the completed task now
    // instead of waiting for the poll interval to elapse.
    await progressWorkflowFully(workflowRunId, {
      initialPayload: {
        source: 'integration_test',
        reason: 'manager_approval_completed'
      }
    });

    const batch = await readSettlementBatch(settlementBatchId, organizationId, 'status');
    expect(batch?.status).toBe('approved');
  });
});
