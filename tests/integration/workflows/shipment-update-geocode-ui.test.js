const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  createClient,
  createOrganization,
  createSender,
  createUser,
  setAuthContext,
} = require('../helpers/tenant-utils');

loadEnv();

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be defined for shipment update geocode UI integration tests');
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

async function withTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await run(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore double rollback
    }
    client.release();
  }
}

async function insertAddress(client, organizationId, clientId, label = 'UC223 Address') {
  const addressId = randomUUID();
  await client.query(
    `INSERT INTO addresses (
        id,
        organization_id,
        client_id,
        raw_input,
        city,
        province,
        country,
        validation_status
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4,
        'Riyadh',
        'Riyadh',
        'SA',
        'pending'
      )`,
    [addressId, organizationId, clientId, label]
  );
  return addressId;
}

async function seedShipmentFixture(client, options = {}) {
  const organization = await createOrganization(
    client,
    options.organizationName || 'UC223 Shipment Geocode Org'
  );
  const tenantClient = await createClient(
    client,
    organization.id,
    options.clientName || 'UC223 Shipment Geocode Client'
  );
  const senderId = await createSender(
    client,
    tenantClient.id,
    options.senderName || 'UC223 Shipment Geocode Sender'
  );
  const userId = await createUser(
    client,
    organization.id,
    options.email || `uc223+${Date.now()}@example.com`,
    {
      accessScopeType: 'tenant',
      userType: options.userType || 'ops_admin',
    }
  );
  const addressId = await insertAddress(
    client,
    organization.id,
    tenantClient.id,
    options.addressLabel || 'UC223 Destination Address'
  );
  const shipmentId = randomUUID();
  const trackingNumber =
    options.trackingNumber || `UC223-${shipmentId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;

  await client.query(
    `INSERT INTO shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        service_type,
        tracking_number,
        status,
        box_count,
        destination_address_id,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        'delivery',
        $5,
        'pending',
        1,
        $6::uuid,
        '{}'::jsonb,
        now(),
        now()
      )`,
    [
      shipmentId,
      organization.id,
      tenantClient.id,
      senderId,
      trackingNumber,
      addressId,
    ]
  );

  return {
    organizationId: organization.id,
    clientId: tenantClient.id,
    senderId,
    userId,
    shipmentId,
    addressId,
    trackingNumber,
  };
}

async function executeShipmentUpdateGeocode(client, shipmentId) {
  const { rows } = await client.query(
    `SELECT api.ui_execute_shipment_update_geocode_v1(
        'shipments.update_geocode',
        'shipments',
        ARRAY[$1::text],
        $1::text,
        1,
        '{}'::jsonb
      ) AS result`,
    [shipmentId]
  );
  return rows[0]?.result;
}

describe('shipment update geocode UI command contract', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('starts the canonical workflow-engine run for one visible shipment', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedShipmentFixture(client);

      await setAuthContext(client, fixture.userId);
      const result = await executeShipmentUpdateGeocode(client, fixture.shipmentId);

      expect(result?.status).toBe('completed');
      expect(result?.workflow_run_id).toBeTruthy();
      expect(result?.count).toBe(1);
      expect(result?.items?.[0]?.shipment_id).toBe(fixture.shipmentId);
      expect(result?.items?.[0]?.address_id).toBe(fixture.addressId);
      expect(result?.items?.[0]?.shipment_action_id).toBeTruthy();

      await client.query('RESET ROLE');

      const { rows: workflowRows } = await client.query(
        `SELECT wt.name, wr.workflow_status
           FROM workflow_runs wr
           JOIN workflow_templates wt ON wt.id = wr.workflow_template_id
          WHERE wr.id = $1::uuid`,
        [result.workflow_run_id]
      );
      expect(workflowRows[0]).toEqual({
        name: 'shipment_update_geocode_v1',
        workflow_status: 'completed',
      });

      const { rows: actionRows } = await client.query(
        `SELECT
            action_type,
            performed_by_system,
            action_data->>'workflow_run_id' AS geocode_workflow_run_id
           FROM shipment_actions
          WHERE id = $1::uuid`,
        [result.items[0].shipment_action_id]
      );
      expect(actionRows[0]?.action_type).toBe('geocode_request');
      expect(actionRows[0]?.performed_by_system).toBe(
        'workflow_handlers.execute_shipment_update_geocode_v1'
      );
      expect(actionRows[0]?.geocode_workflow_run_id).toBeTruthy();
    });
  });

  test('rejects unauthenticated callers before any workflow starts', async () => {
    await withTransaction(async (client) => {
      const fixture = await seedShipmentFixture(client, {
        organizationName: 'UC223 Unauth Org',
        clientName: 'UC223 Unauth Client',
        senderName: 'UC223 Unauth Sender',
      });

      await expect(
        executeShipmentUpdateGeocode(client, fixture.shipmentId)
      ).rejects.toThrow('ui_execute_shipment_update_geocode_v1 requires authenticated user');
    });
  });

  test('fails closed when the selected shipment is outside the caller visibility scope', async () => {
    await withTransaction(async (client) => {
      const allowedFixture = await seedShipmentFixture(client, {
        organizationName: 'UC223 Visible Org',
        clientName: 'UC223 Visible Client',
        senderName: 'UC223 Visible Sender',
      });
      const hiddenFixture = await seedShipmentFixture(client, {
        organizationName: 'UC223 Hidden Org',
        clientName: 'UC223 Hidden Client',
        senderName: 'UC223 Hidden Sender',
      });

      await setAuthContext(client, allowedFixture.userId);

      await expect(
        executeShipmentUpdateGeocode(client, hiddenFixture.shipmentId)
      ).rejects.toThrow(/is not visible in resource shipments/i);
    });
  });
});
