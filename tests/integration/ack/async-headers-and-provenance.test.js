const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { upsertWebhookPolicy } = require('../../utils/policies');

loadEnv();

describe('Async ACK headers and decision provenance', () => {
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

  test('accepted_async mapping sets Retry-After and decision links settings_resolution_id', async () => {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const mappingId = randomUUID();
    const sourceId = randomUUID();
    const token = `tok-${randomUUID()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Async ACK Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, `async-ack-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Async ACK Client', $3::text, 'standard', 'active')`,
      [clientId, organizationId, `async-ack-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO senders (id, client_id, name, brand_name, status)
       VALUES ($1::uuid, $2::uuid, 'Async ACK Sender', 'Async ACK Sender', 'active')`,
      [senderId, clientId]
    );

    // Ensure an inbound mapping exists (payload transform not needed for this assertion)
    await client.query(
      `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
       VALUES ($1::uuid, 'webhook_inbound', $2::text, '{}'::jsonb, 1, 'async ack inbound mapping')`,
      [mappingId, `async-ack-${Date.now()}`]
    );

    await client.query(
      `INSERT INTO webhook_sources (
         id, organization_id, source_identifier, name, provider_type,
         auth_token, mapping_config_id, sender_id, enabled
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, 'Async ACK Source', 'provider',
         $4::text, $5::uuid, $6::uuid, TRUE
       )`,
      [sourceId, organizationId, `async-ack-${sourceId.slice(0, 8)}`, token, mappingId, senderId]
    );

    // Resolve the async ack mapping id dynamically by key
    const { rows: mapRows } = await client.query(
      `SELECT id FROM mapping_configs
        WHERE mapping_type = 'webhook_response'
          AND mapping_key = 'global::ack_async_v1'
        LIMIT 1`
    );
    expect(mapRows.length).toBe(1);
    const asyncAckMappingId = mapRows[0].id;

    // Upsert source-scoped policy: accepted_async with explicit response mapping
    await upsertWebhookPolicy('source', sourceId, {
      version: 2,
      ack: {
        mode: 'accepted_async',
        status_code: 202,
        response_mapping_id: asyncAckMappingId,
        default_headers: { 'cache-control': 'no-store' }
      },
      response: {
        response_mapping_id: asyncAckMappingId
      },
      validation: { idempotency: { header: 'Idempotency-Key', dedupe_window_seconds: 300 } },
      logging: { decision_point: 'http_response' }
    }, 'async ack mapping with retry-after', client);

    const payload = { event: { id: `evt-${randomUUID()}`, type: 'shipment.created' }, data: { sample: true } };
    const rawBody = JSON.stringify(payload);

    const { rows } = await client.query(
      `SELECT workflow_intake_webhook($1::text, '{}'::jsonb, $2::text, $3::jsonb) AS ack`,
      [token, rawBody, JSON.stringify(payload)]
    );

    const ack = rows[0].ack;
    expect(ack.status).toBe(202);
    // Headers normalized to lower-case keys
    expect(ack.headers).toBeDefined();
    expect(ack.headers['retry-after']).toBeDefined();
    // Mapping defines '30' as string; accept string or numeric
    const retryAfter = ack.headers['retry-after'];
    expect(String(retryAfter)).toBe('30');

    // Decision linkage: http_response_emitted should carry settings_resolution_id
    const { rows: decisionRows } = await client.query(
      `SELECT id, settings_resolution_id
         FROM decision_log
        WHERE resource_type = 'webhook_inbox'
          AND resource_id = $1::uuid
          AND decision_category = 'http_response_emitted'
        ORDER BY timestamp DESC
        LIMIT 1`,
      [ack.webhook_id]
    );
    expect(decisionRows.length).toBe(1);
    const settingsResolutionId = decisionRows[0].settings_resolution_id;
    expect(settingsResolutionId).toBeTruthy();

    // Optional: verify referenced provenance row exists
    const { rows: prov } = await client.query(
      `SELECT category, winning_scope_type
         FROM settings_resolution_log
        WHERE id = $1::uuid
        LIMIT 1`,
      [settingsResolutionId]
    );
    expect(prov.length).toBe(1);
    expect(prov[0].category).toBe('webhook_ingest_policy');
  });
});

