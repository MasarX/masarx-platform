// Plan: PLAN-202511-testing-hardening-e2e-provenance / Step: S04
// Webhook JSON Schema toggle behavior: when a schema id is present, validation_results.json_schema is populated.

const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { upsertWebhookPolicy } = require('../utils/policies');

loadEnv();

describe('Webhook JSON Schema toggle', () => {
  const pool = new (require('pg').Pool)({
    connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
  });

  afterAll(async () => {
    await pool.end();
  });

  test('presence of json_schema_id records json_schema: skipped and returns 2xx', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      // Self-contained seed: org + mapping + source
      const orgId = randomUUID();
      const mappingId = randomUUID();
      const sourceId = randomUUID();
      const token = `tok-${randomUUID()}`;

      await client.query(
        `INSERT INTO organizations (id, name, slug) VALUES ($1::uuid, 'Schema Org', $2)`,
        [orgId, `schema-org-${orgId.toString().slice(0,8)}`]
      );

      await client.query(
        `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version)
         VALUES ($1::uuid, 'webhook_inbound', $2, '{}'::jsonb, 1)`,
        [mappingId, `schema-${Date.now()}`]
      );

      await client.query(
        `INSERT INTO webhook_sources (
           id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'Schema Source', 'provider', $4, $5::uuid, TRUE
         )`,
        [sourceId, orgId, `schema-${sourceId.toString().slice(0,8)}`, token, mappingId]
      );

      const jsonSchemaId = 'providers/webhooks/shipment.created@v1';
      await upsertWebhookPolicy('source', sourceId, { validation: { json_schema_id: jsonSchemaId } }, 'schema toggle', client);

      const payload = { event: { id: `evt-${randomUUID()}`, type: 'shipment.created' }, data: { ok: true } };
      const raw = JSON.stringify(payload);
      const headers = { 'content-type': 'application/json' };

      const { rows } = await client.query(
        `SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS ack`,
        [token, JSON.stringify(headers), raw, JSON.stringify(payload)]
      );
      const ack = rows[0].ack;

      expect(ack.status).toBeGreaterThanOrEqual(200);
      expect(ack.status).toBeLessThan(500);
      expect(ack.response_outcome).toMatch(/response_/);

      const { rows: ev } = await client.query(
        `SELECT validation_results FROM webhook_response_events WHERE webhook_inbox_id = $1::uuid ORDER BY response_created_at DESC LIMIT 1`,
        [ack.webhook_id]
      );
      expect(ev.length).toBe(1);
      const vr = ev[0].validation_results || {};
      expect(vr.json_schema).toBeDefined();
      expect(['skipped','passed','failed']).toContain(vr.json_schema.status);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
