const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  applySetting,
  createClient,
  createOrganization,
  createSender,
  createUser,
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

function expectWorkflowTemplateReadback(result, fixture, templateName) {
  expect(result?.workflow_status).toBe('completed');
  expect(result?.workflow_template_id).toBe(fixture.workflowTemplateIds[templateName]);
  expect(result?.workflow_template_name).toBe(templateName);
  expect(result?.workflow_template).toBe(templateName);
}

describe('shipment amend/cancel workflow engine contract', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('modify starts and completes through a real workflow run', async () => {
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
      });

      expect(result?.ok).toBe(true);
      expect(result?.workflow_run_id).toBeTruthy();
      expect(result?.shipment_action_id).toBeTruthy();
      expectWorkflowTemplateReadback(result, fixture, 'shipment_modify_v1');
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

      expect(result?.ok).toBe(true);
      expect(result?.workflow_run_id).toBeTruthy();
      expect(result?.shipment_action_id).toBeTruthy();
      expectWorkflowTemplateReadback(result, fixture, 'shipment_delete_v1');

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
      expect(result?.workflow_status).toBe('completed');
      expect(result?.shipment_action_id).toBeTruthy();
    });
  });

  test('duplicate soft-cancel retries return already_processed with the same action id', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client);
      const idempotencyKey = `uc030-idem-${Date.now()}`;

      const first = await callShipmentAmendCancel(client, {
        shipment_id: fixture.shipmentId,
        operation: 'cancel',
        surface: 'console',
        reason: 'Duplicate retry test',
        idempotency_key: idempotencyKey,
      });
      const second = await callShipmentAmendCancel(client, {
        shipment_id: fixture.shipmentId,
        operation: 'cancel',
        surface: 'console',
        reason: 'Duplicate retry test',
        idempotency_key: idempotencyKey,
      });

      expect(first?.ok).toBe(true);
      expect(first?.shipment_action_id).toBeTruthy();
      expect(second?.ok).toBe(true);
      expect(second?.already_processed).toBe(true);
      expect(second?.shipment_action_id).toBe(first?.shipment_action_id);
    });
  });

  test('soft-cancel fails closed when the delete window is expired', async () => {
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
      });

      expect(result?.ok).toBe(false);
      expect(result?.error?.code).toBe('shipment_delete_window_expired');
      expect(result?.workflow_run_id ?? null).toBeNull();
    });
  });

  test('unauthenticated calls are rejected before any workflow starts', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedTenantFixture(client, { authenticate: false });

      await expect(
        callShipmentAmendCancel(client, {
          shipment_id: fixture.shipmentId,
          operation: 'cancel',
          surface: 'console',
        }),
      ).rejects.toThrow('shipment amend/cancel requires authenticated user');
    });
  });
});
