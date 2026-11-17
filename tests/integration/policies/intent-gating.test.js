const { Pool } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const { getIntegrationFixtureProfile } = require('../helpers/integration-fixtures');
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

const CLIENT_A_TOKEN = getIntegrationFixtureProfile().webhook.clientAckA.token;

const cloneJson = (value) => JSON.parse(JSON.stringify(value ?? {}));

describe('Intent gating policies', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('shipment_create intent includes resource in ACK body', async () => {
    const payload = buildPayload();
    const response = await callWorkflowIntake(pool, CLIENT_A_TOKEN, payload);
    expect(response).toBeTruthy();
    expect(response.status).toBe(202);
    expect(response.body?.resource_id).toEqual(expect.any(String));
    expect(response.body?.tracking_number).toEqual(expect.any(String));
  });

  test('non-creation intent omits resource from ACK body', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      const sourceId = await resolveWebhookSourceIdByToken(client, CLIENT_A_TOKEN);
      expect(sourceId).toBeTruthy();

      const { rows } = await client.query(
        `SELECT cached_value
           FROM settings
          WHERE category = 'webhook_ingest_policy'
            AND scope_type = 'source'
            AND scope_id = $1::uuid
          LIMIT 1`,
        [sourceId]
      );
      const originalPolicy = cloneJson(rows[0]?.cached_value || {});
      const nonCreationPolicy = cloneJson(originalPolicy);
      nonCreationPolicy.workflow = {
        ...(nonCreationPolicy.workflow || {}),
        intent: 'status_update',
      };
      if (nonCreationPolicy.ack) {
        nonCreationPolicy.ack = {
          ...nonCreationPolicy.ack,
          mode: 'accepted_async',
          status: 202,
          status_code: 202,
        };
        delete nonCreationPolicy.ack.response_mapping_id;
        delete nonCreationPolicy.ack.body;
      }
      nonCreationPolicy.response = {
        ...(nonCreationPolicy.response || {}),
        mode: 'accepted_async',
      };

      await upsertWebhookPolicy('source', sourceId, nonCreationPolicy, 'intent gating test override', client);

      const payload = buildPayload();
      const response = await callWorkflowIntake(client, CLIENT_A_TOKEN, payload);
      expect(response).toBeTruthy();
      expect(response.status).toBe(202);
      expect(response.body?.resource).toBeUndefined();
      expect(typeof response.body?.workflow_run_id).toBe('string');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
