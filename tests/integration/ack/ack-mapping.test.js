const { Pool } = require('pg');
const crypto = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const { upsertWebhookPolicy } = require('../../utils/policies');
const {
  buildPayload,
  callWorkflowIntake,
  resolveWebhookSourceIdByToken,
} = require('../utils/workflow-intake');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

jest.setTimeout(60000);

const CLIENT_A_TOKEN = 'client-a-ack-token';
const CLIENT_B_TOKEN = 'EXAMPLE_PASSWORD';

const cloneJson = (value) => JSON.parse(JSON.stringify(value ?? {}));

describe('ACK mapping behavior', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('client A mapping returns resource identifiers', async () => {
    const payload = buildPayload();
    const response = await callWorkflowIntake(pool, CLIENT_A_TOKEN, payload);

    expect(response.status).toBe(200);
    expect(response.headers?.['x-client-ack']).toBe('logestechs');
    expect(response.body?.resource_id).toEqual(expect.any(String));
    expect(response.body?.tracking_number).toEqual(expect.any(String));
    expect(response.body?.workflow_run_id).toEqual(expect.any(String));
  });

  test('client B mapping returns correlation payload', async () => {
    const payload = buildPayload();
    const response = await callWorkflowIntake(pool, CLIENT_B_TOKEN, payload);

    expect(response.status).toBe(200);
    expect(response.body?.status).toBe('accepted');
    expect(response.body?.correlation_id).toEqual(expect.any(String));
    expect(response.body?.tracking_summary).toEqual(expect.any(String));
    expect(response.body?.ack_version).toBe('jarad.v1');
  });

  test('templates with whitespace tokens render correctly', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');

    try {
      const sourceId = await resolveWebhookSourceIdByToken(client, CLIENT_A_TOKEN);
      expect(sourceId).toBeTruthy();

      const mappingId = crypto.randomUUID();
      const mappingKey = `client-a-whitespace-${Date.now()}`;
      const mappingConfig = {
        status_code: 200,
        headers: {
          'content-type': 'application/json',
          'x-template': 'whitespace',
        },
        body: {
          tracking_number: '{{  resource.tracking_number  }}',
          workflow_run_id: '{{ workflow_run_id }}',
        },
      };

      await client.query(
        `INSERT INTO mapping_configs (
            id,
            mapping_type,
            mapping_key,
            mapping_config,
            mapping_version,
            notes
          )
         VALUES ($1::uuid, 'webhook_response', $2::text, $3::jsonb, 1, 'ACK whitespace mapping test')
         ON CONFLICT (id) DO UPDATE
           SET mapping_config = EXCLUDED.mapping_config,
               mapping_version = EXCLUDED.mapping_version,
               notes = EXCLUDED.notes,
               updated_at = now()`,
        [mappingId, mappingKey, mappingConfig]
      );

      const { rows } = await client.query(
        `SELECT cached_value
           FROM settings
          WHERE category = 'webhook_ingest_policy'
            AND scope_type = 'source'
            AND scope_id = $1::uuid
          LIMIT 1`,
        [sourceId]
      );
      const currentPolicy = cloneJson(rows[0]?.cached_value || {});
      const updatedPolicy = cloneJson(currentPolicy);
      updatedPolicy.ack = {
        ...(updatedPolicy.ack || {}),
        response_mapping_id: mappingId,
        mode: 'synchronous_success',
        status: 200,
        status_code: 200,
      };
      updatedPolicy.response = {
        ...(updatedPolicy.response || {}),
        response_mapping_id: mappingId,
        mode: 'synchronous_success',
        status_code: 200,
      };

      await upsertWebhookPolicy('source', sourceId, updatedPolicy, 'ack whitespace mapping test', client);

      const payload = buildPayload();
      const response = await callWorkflowIntake(client, CLIENT_A_TOKEN, payload);

      expect(response.status).toBe(200);
      expect(response.headers?.['x-template']).toBe('whitespace');
      expect(response.body?.tracking_number).toEqual(expect.any(String));
      expect(response.body?.workflow_run_id).toEqual(expect.any(String));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
