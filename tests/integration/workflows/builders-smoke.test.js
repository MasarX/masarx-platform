const { Pool } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { skipIfMissing } = require('../../utils/test-env');
const { buildOrg, buildClient, buildShipment, buildLabel } = require('../../fixtures/builders/entities');

loadEnv();
const missing = skipIfMissing(['DATABASE_URL'], 'builders smoke');
if (missing) {
  // eslint-disable-next-line jest/no-disabled-tests
  test.skip('Skipping builders smoke due to missing env', () => {});
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('builders smoke', () => {
  let client;
  beforeAll(async () => {
    client = await pool.connect();
  });
  afterAll(async () => {
    client.release();
    await pool.end();
  });
  beforeEach(async () => { await client.query('BEGIN'); });
  afterEach(async () => { await client.query('ROLLBACK'); });

  test('creates org/client/shipment/label and reads them back', async () => {
    const { id: orgId } = await buildOrg(client);
    const { id: clientId } = await buildClient(client, orgId);
    const { id: shipmentId } = await buildShipment(client, { organizationId: orgId, clientId, serviceType: 'delivery' });
    const { id: labelId } = await buildLabel(client, { shipmentId });

    const { rows: shipments } = await client.query('SELECT id FROM shipments WHERE id = $1::uuid', [shipmentId]);
    const { rows: labels } = await client.query('SELECT id FROM labels WHERE id = $1::uuid', [labelId]);
    expect(shipments).toHaveLength(1);
    expect(labels).toHaveLength(1);
  });
});

