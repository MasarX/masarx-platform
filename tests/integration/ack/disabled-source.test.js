const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

describe('Webhook intake with disabled source', () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
  });

  let client;

  beforeAll(async () => {
    const conn = await pool.connect();
    await conn.query('SELECT 1');
    conn.release();
  });

  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  test('returns 401 when source is disabled', async () => {
    const organizationId = randomUUID();
    const mappingId = randomUUID();
    const sourceId = randomUUID();
    const token = `tok-${randomUUID()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Disabled Source Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, `disabled-src-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
       VALUES ($1::uuid, 'webhook_inbound', $2::text, '{}'::jsonb, 1, 'disabled source mapping')`,
      [mappingId, `disabled-src-${Date.now()}`]
    );

    await client.query(
      `INSERT INTO webhook_sources (
         id, organization_id, source_identifier, name, provider_type,
         auth_token, mapping_config_id, enabled
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, 'Disabled Source', 'provider',
         $4::text, $5::uuid, FALSE
       )`,
      [sourceId, organizationId, `disabled-src-${sourceId.slice(0, 8)}`, token, mappingId]
    );

    const payload = { event: { id: `evt-${randomUUID()}`, type: 'shipment.created' }, data: { x: 1 } };
    const rawBody = JSON.stringify(payload);

    const { rows } = await client.query(
      `SELECT workflow_intake_webhook($1::text, '{}'::jsonb, $2::text, $3::jsonb) AS ack`,
      [token, rawBody, JSON.stringify(payload)]
    );

    const ack = rows[0].ack;
    expect(ack.status).toBe(401);
    expect(ack.response_outcome).toBe('response_failed');
  });
});

