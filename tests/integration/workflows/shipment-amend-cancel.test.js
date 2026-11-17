const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  applySetting,
  createClient,
  createOrganization,
  createSender,
  createUser,
  withFixtureAdminContext,
  setAuthContext,
} = require('../helpers/tenant-utils');

loadEnv();

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be defined for shipment amend/cancel integration tests');
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

function buildShipmentOperationPolicy(deleteWindowHours = 24) {
  return {
    version: 1,
    modify: {
      allowed_statuses: ['pending'],
      workflow_template_name: 'shipment_modify_v1',
      allowed_fields: [
        'service_type',
        'service_level',
        'special_instructions',
        'cod_amount',
        'client_reference_number',
        'carrier_reference_number',
        'metadata',
        'references',
      ],
    },
    address: {
      allowed_statuses: ['pending'],
      workflow_template_name: 'shipment_update_address_v1',
      default_country_code: 'SA',
    },
    reschedule: {
      allowed_statuses: ['pending'],
      workflow_template_name: 'shipment_reschedule_v1',
    },
    delete: {
      allowed_statuses: ['pending'],
      mode: 'soft_cancel',
      window_hours: deleteWindowHours,
      workflow_template_name: 'shipment_delete_v1',
    },
  };
}

async function withTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await run(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore double-rollback when the test already closed the transaction
    }
    client.release();
  }
}

async function loadWorkflowTemplateIds(client) {
  const templateNames = ['shipment_modify_v1', 'shipment_delete_v1'];
  const templateIds = {};

  for (const templateName of templateNames) {
    const { rows } = await client.query(
      `
        SELECT id
        FROM workflow_templates
        WHERE name = $1::text
        ORDER BY version DESC, updated_at DESC NULLS LAST
        LIMIT 1
      `,
      [templateName],
    );

    if (!rows[0]?.id) {
      throw new Error(`workflow template not found: ${templateName}`);
    }

    templateIds[templateName] = rows[0].id;
  }

  return templateIds;
}

async function seedTenantFixture(client, options = {}) {
  const organization = await createOrganization(
    client,
    options.organizationName || 'Shipment Amend Cancel Org',
  );
  const tenantClient = await createClient(
    client,
    organization.id,
    options.clientName || 'Shipment Amend Cancel Client',
  );
  const senderId = await createSender(
    client,
    tenantClient.id,
    options.senderName || 'Shipment Amend Cancel Sender',
  );
  const userId = await createUser(
    client,
    organization.id,
    options.email || `ops+${Date.now()}@example.com`,
    {
      accessScopeType: 'tenant',
      accessScopeId: null,
      userType: options.userType || 'ops_admin',
      provisionRbac: options.provisionRbac,
    },
  );

  await applySetting(client, {
    category: 'shipment_operation_policy',
    scopeType: 'tenant',
    scopeId: organization.id,
    value: buildShipmentOperationPolicy(options.deleteWindowHours || 24),
    approvedAt: new Date().toISOString(),
  });

  const workflowTemplateIds = await loadWorkflowTemplateIds(client);

  const shipmentId = randomUUID();
  const createdAt = options.createdAt || new Date();
  await client.query(
    `
      INSERT INTO shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        service_type,
        service_level,
        tracking_number,
        status,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        'delivery',
        'standard',
        $5,
        $6,
        $7::timestamptz,
        now()
      )
    `,
    [
      shipmentId,
      organization.id,
      tenantClient.id,
      senderId,
      options.trackingNumber || `UC030-${Date.now()}`,
      options.shipmentStatus || 'pending',
      createdAt.toISOString(),
    ],
  );

  if (options.authenticate !== false) {
    await setAuthContext(client, userId);
  }

  return {
    organizationId: organization.id,
    clientId: tenantClient.id,
    senderId,
    userId,
    shipmentId,
    workflowTemplateIds,
  };
}

async function callShipmentAmendCancel(client, input, options = {}) {
  const schema = options.schema === 'api' ? 'api' : 'public';
  const { rows } = await client.query(
    `SELECT ${schema}.shipment_amend_cancel_v1($1::jsonb) AS result`,
    [JSON.stringify(input)],
  );
  return rows[0]?.result;
}

async function callShipmentAmendCancelOptions(client, shipmentId, options = {}) {
  const schema = options.schema === 'api' ? 'api' : 'public';
  const { rows } = await client.query(
    `SELECT ${schema}.shipment_amend_cancel_options_v1($1::uuid) AS result`,
    [shipmentId],
  );
  return rows[0]?.result;
}

async function readWorkflowOutcome(client, workflowRunId) {
  const { rows } = await client.query(
    `
      SELECT
        wr.workflow_status,
        wr.workflow_template_id,
        wrs.handler_key,
        wrs.step_status,
        wrs.operation_result,
        COALESCE(
          NULLIF(wrs.operation_result->>'shipment_action_id', '')::uuid,
          NULLIF(wrs.operation_result #>> '{reserve_result,action_id}', '')::uuid
        ) AS shipment_action_id
      FROM workflow_runs wr
      LEFT JOIN LATERAL (
        SELECT handler_key, step_status, operation_result, sequence_order, updated_at
        FROM workflow_run_steps
        WHERE workflow_run_id = wr.id
        ORDER BY sequence_order DESC, updated_at DESC
        LIMIT 1
      ) wrs ON TRUE
      WHERE wr.id = $1::uuid
    `,
    [workflowRunId],
  );
  return rows[0] || null;
}

async function driveWorkflowToTerminal(client, workflowRunId, maxAttempts = 8) {
  let outcome = await readWorkflowOutcome(client, workflowRunId);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (['completed', 'failed', 'blocked', 'cancelled'].includes(outcome?.workflow_status)) {
      return outcome;
    }
    await client.query(
      'SELECT public.progress_workflow_run($1::uuid) AS progress',
      [workflowRunId],
    );
    outcome = await readWorkflowOutcome(client, workflowRunId);
  }
  return outcome;
}

describe('shipment amend/cancel workflow engine contract', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('address capture persists code and coordinates and verifies already-processed readback', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client);
      const input = { shipment_id: fixture.shipmentId, operation: 'address', surface: 'console',
        address: { line1: 'King Road', city: 'Riyadh', country: 'SA',
          shortNationalAddress: 'rrrd2929', coordinates: { latitude: 24.7136, longitude: 46.6753 } } };
      const result = await callShipmentAmendCancel(client, input, { schema: 'api' });
      expect(result.ok).toBe(true);
      expect(result.workflow_status).toBe('completed');
      expect(result.destination_address_capture).toMatchObject({
        status: 'verified', sa_short_code: 'RRRD2929',
        coordinates: { latitude: 24.7136, longitude: 46.6753 },
      });
      const replay = await callShipmentAmendCancel(client, input, { schema: 'api' });
      expect(replay.already_processed).toBe(true);
      expect(replay.destination_address_capture).toEqual(result.destination_address_capture);
      // Only this transaction's real workflow is changed to exercise replay lifecycle states.
      await withFixtureAdminContext(client, () => client.query("UPDATE public.workflow_runs SET workflow_status='pending' WHERE id=$1::uuid", [result.workflow_run_id]));
      const pending = await callShipmentAmendCancel(client, input, { schema: 'api' });
      expect(pending.workflow_status).toBe('pending');
      expect(pending.destination_address_capture).toEqual({ status: 'pending' });
      await withFixtureAdminContext(client, () => client.query("UPDATE public.workflow_runs SET workflow_status='failed' WHERE id=$1::uuid", [result.workflow_run_id]));
      const failed = await callShipmentAmendCancel(client, input, { schema: 'api' });
      expect(failed.ok).toBe(false);
      expect(failed.workflow_status).toBe('failed');
      expect(failed.destination_address_capture).toBeUndefined();
    });
  });

  test.each([
    { latitude: 24 }, { longitude: 46 },
    { latitude: 'NaN', longitude: 46 }, { latitude: 'Infinity', longitude: 46 },
    { latitude: 91, longitude: 46 }, { latitude: 24, longitude: 181 },
  ])('address mutation rejects malformed coordinate pair %#', async (coordinates) => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client);
      await expect(callShipmentAmendCancel(client, {
        shipment_id: fixture.shipmentId, operation: 'address', surface: 'console',
        address: { line1: 'King Road', city: 'Riyadh', country: 'SA', coordinates },
      }, { schema: 'api' })).rejects.toThrow(/address coordinates/);
    });
  });

  test('address capture rejects cross-tenant mutation', async () => {
    await withTransaction(async (client) => {
      const foreign = await seedTenantFixture(client, { authenticate: false });
      await seedTenantFixture(client);
      await expect(callShipmentAmendCancel(client, {
        shipment_id: foreign.shipmentId, operation: 'address', surface: 'console',
        address: { line1: 'Foreign', city: 'Riyadh', country: 'SA', sa_short_code: 'RRRD2929' },
      }, { schema: 'api' })).rejects.toThrow();
    });
  });

  test.each(['public', 'api'])('modify starts and completes through a real workflow run (%s)', async (schema) => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client);

      const result = await callShipmentAmendCancel(client, {
        shipment_id: fixture.shipmentId,
        operation: 'modify',
        surface: 'console',
        changes: {
          service_level: 'express',
          special_instructions: 'Workflow-engine modify test',
        },
      }, { schema });

      await client.query('RESET ROLE');

      expect(result?.ok).toBe(true);
      expect(result?.workflow_run_id).toBeTruthy();
      expect(result?.workflow_status).toBe('completed');
      expect(result?.shipment_action_id).toBeTruthy();

      const { rows: runRows } = await client.query(
        `
          SELECT workflow_status, workflow_template_id
          FROM workflow_runs
          WHERE id = $1::uuid
        `,
        [result.workflow_run_id],
      );
      expect(runRows[0]?.workflow_status).toBe('completed');
      expect(runRows[0]?.workflow_template_id).toBe(fixture.workflowTemplateIds.shipment_modify_v1);
    });
  });

  test('soft-cancel completes through shipment_delete_v1 and records audit actor source', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client);

      const result = await callShipmentAmendCancel(client, {
        shipment_id: fixture.shipmentId,
        operation: 'cancel',
        surface: 'console',
        reason: 'Customer requested cancellation',
      });

      await client.query('RESET ROLE');

      expect(result?.ok).toBe(true);
      expect(result?.workflow_status).toBe('completed');
      expect(result?.shipment_action_id).toBeTruthy();

      const { rows: runRows } = await client.query(
        `
          SELECT workflow_status, workflow_template_id
          FROM workflow_runs
          WHERE id = $1::uuid
        `,
        [result.workflow_run_id],
      );
      expect(runRows[0]?.workflow_status).toBe('completed');
      expect(runRows[0]?.workflow_template_id).toBe(fixture.workflowTemplateIds.shipment_delete_v1);

      const { rows: stepRows } = await client.query(
        `
          SELECT handler_key, step_status
          FROM workflow_run_steps
          WHERE workflow_run_id = $1::uuid
          ORDER BY sequence_order DESC
          LIMIT 1
        `,
        [result.workflow_run_id],
      );
      expect(stepRows[0]?.handler_key).toBe('shipment_delete');
      expect(stepRows[0]?.step_status).toBe('completed');

      const { rows: shipmentRows } = await client.query(
        'SELECT status FROM shipments WHERE id = $1::uuid',
        [fixture.shipmentId],
      );
      expect(shipmentRows[0]?.status).toBe('cancelled');

      const { rows: actionRows } = await client.query(
        `
          SELECT
            performed_by_system,
            notes,
            action_data->>'idempotency_key' AS action_data_idempotency_key,
            action_data #>> '{audit_actor,source}' AS audit_actor_source,
            action_data #>> '{audit_actor,surface}' AS audit_actor_surface
          FROM shipment_actions
          WHERE id = $1::uuid
        `,
        [result.shipment_action_id],
      );
      expect(actionRows[0]?.performed_by_system).toBe('console.shipment_amend_cancel');
      expect(actionRows[0]?.notes).toBe('Customer requested cancellation');
      expect(actionRows[0]?.action_data_idempotency_key).toBeTruthy();
      expect(actionRows[0]?.audit_actor_source).toBe('console.shipment_amend_cancel');
      expect(actionRows[0]?.audit_actor_surface).toBe('console');
    });
  });

  test('api wrappers expose hosted ui contract for shipment amend/cancel options and actions', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client);

      const options = await callShipmentAmendCancelOptions(client, fixture.shipmentId, {
        schema: 'api',
      });
      expect(options?.operations?.cancel?.allowed).toBe(true);
      expect(options?.current_values?.tracking_number).toBeTruthy();

      const result = await callShipmentAmendCancel(
        client,
        {
          shipment_id: fixture.shipmentId,
          operation: 'cancel',
          surface: 'portal',
          reason: 'Hosted UI wrapper contract test',
        },
        { schema: 'api' },
      );

      expect(result?.ok).toBe(true);
      expect(result?.workflow_run_id).toBeTruthy();
      expect(['pending', 'in_progress', 'completed']).toContain(result?.workflow_status);

      await client.query('RESET ROLE');

      const outcome = result?.workflow_status === 'completed'
        ? await readWorkflowOutcome(client, result.workflow_run_id)
        : await driveWorkflowToTerminal(client, result.workflow_run_id);
      const shipmentActionId = result?.shipment_action_id || outcome?.shipment_action_id;

      expect(outcome?.workflow_status).toBe('completed');
      expect(outcome?.workflow_template_id).toBe(fixture.workflowTemplateIds.shipment_delete_v1);
      expect(outcome?.handler_key).toBe('shipment_delete');
      expect(outcome?.step_status).toBe('completed');
      expect(shipmentActionId).toBeTruthy();

      const { rows: shipmentRows } = await client.query(
        'SELECT status FROM shipments WHERE id = $1::uuid',
        [fixture.shipmentId],
      );
      expect(shipmentRows[0]?.status).toBe('cancelled');

      const { rows: actionRows } = await client.query(
        `
          SELECT
            performed_by_system,
            action_data #>> '{audit_actor,source}' AS audit_actor_source,
            action_data #>> '{audit_actor,surface}' AS audit_actor_surface
          FROM shipment_actions
          WHERE id = $1::uuid
        `,
        [shipmentActionId],
      );
      expect(actionRows[0]?.performed_by_system).toBe('portal.shipment_amend_cancel');
      expect(actionRows[0]?.audit_actor_source).toBe('portal.shipment_amend_cancel');
      expect(actionRows[0]?.audit_actor_surface).toBe('portal');
    });
  });

  test.each(['public', 'api'])('duplicate soft-cancel retries return already_processed with the same action id (%s)', async (schema) => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client);
      const idempotencyKey = `uc030-idem-${Date.now()}`;

      const first = await callShipmentAmendCancel(client, {
        shipment_id: fixture.shipmentId,
        operation: 'cancel',
        surface: 'console',
        reason: 'Duplicate retry test',
        idempotency_key: idempotencyKey,
      }, { schema });
      const second = await callShipmentAmendCancel(client, {
        shipment_id: fixture.shipmentId,
        operation: 'cancel',
        surface: 'console',
        reason: 'Duplicate retry test',
        idempotency_key: idempotencyKey,
      }, { schema });

      expect(first?.ok).toBe(true);
      expect(first?.shipment_action_id).toBeTruthy();
      expect(second?.ok).toBe(true);
      expect(second?.already_processed).toBe(true);
      expect(second?.shipment_action_id).toBe(first?.shipment_action_id);
    });
  });

  test.each(['public', 'api'])('soft-cancel fails closed when the delete window is expired (%s)', async (schema) => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client, {
        deleteWindowHours: 1,
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });

      const result = await callShipmentAmendCancel(client, {
        shipment_id: fixture.shipmentId,
        operation: 'cancel',
        surface: 'console',
        reason: 'Window expiry test',
      }, { schema });

      expect(result?.ok).toBe(false);
      expect(result?.error?.code).toBe('shipment_delete_window_expired');
      expect(result?.workflow_run_id ?? null).toBeNull();
    });
  });

  test.each(['public', 'api'])('unauthenticated calls are rejected before any workflow starts (%s)', async (schema) => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client, { authenticate: false });

      await expect(
        callShipmentAmendCancel(client, {
          shipment_id: fixture.shipmentId,
          operation: 'cancel',
          surface: 'console',
        }, { schema }),
      ).rejects.toThrow('shipment amend/cancel requires authenticated user');
    });
  });
});
