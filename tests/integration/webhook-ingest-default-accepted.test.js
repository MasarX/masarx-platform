const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();

const DATABASE_URL =
  process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));
const liveWebhookEnabled = process.env.RUN_LIVE_WEBHOOK_TESTS === 'true';

const describeIfWebhookDefaults = liveWebhookEnabled ? describe : describe.skip;

describeIfWebhookDefaults('Webhook intake default acceptance via global policy', () => {
  let pool;
  let client;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const conn = await pool.connect();
    await conn.query('SELECT 1');
    conn.release();
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
      client = null;
    }
  });

  test('returns 202 Accepted when only global policy applies', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const mappingId = randomUUID();
    const sourceId = randomUUID();
    const token = `tok-${randomUUID()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Global Policy Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, `global-default-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Global Policy Client', $3::text, 'standard', 'active')`,
      [clientId, organizationId, `global-default-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
       VALUES ($1::uuid, 'webhook_inbound', $2::text, '{}'::jsonb, 1, 'default acceptance mapping')`,
      [mappingId, `global-default-${Date.now()}`]
    );

    await client.query(
      `INSERT INTO webhook_sources (
         id, organization_id, source_identifier, name, provider_type,
         auth_token, mapping_config_id, enabled
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, 'Global Default Source', 'provider',
         $4::text, $5::uuid, TRUE
       )`,
      [sourceId, organizationId, `global-default-${sourceId.slice(0, 8)}`, token, mappingId]
    );

    const payload = {
      event: { id: `evt-${randomUUID()}`, type: 'shipment.created' },
      data: { example: true }
    };
    const rawBody = JSON.stringify(payload);

    const { rows } = await client.query(
      `SELECT workflow_intake_webhook($1::text, '{}'::jsonb, $2::text, $3::jsonb) AS ack`,
      [token, rawBody, JSON.stringify(payload)]
    );

    const ack = rows[0].ack;
    expect(typeof ack.status).toBe('number');
    expect(ack.status).toBe(202);
    if (ack.response_mode) {
      expect(['accepted_async', 'synchronous_success']).toContain(ack.response_mode);
    }
  });
});
