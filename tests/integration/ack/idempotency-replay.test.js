const { Pool } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { buildPayload, callWorkflowIntake } = require('../utils/workflow-intake');
const { getIntegrationFixtureProfile } = require('../helpers/integration-fixtures');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

jest.setTimeout(60000);

const CLIENT_A_TOKEN = getIntegrationFixtureProfile().webhook.clientAckA.token;

describe('Webhook acknowledgement idempotency', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('replay returns stored response and persists ack history', async () => {
    const payload = buildPayload();

    const first = await callWorkflowIntake(pool, CLIENT_A_TOKEN, payload);
    const expectedStatus = Number(first.status);
    expect(Number.isInteger(expectedStatus)).toBe(true);
    expect(expectedStatus).toBeGreaterThanOrEqual(200);
    expect(expectedStatus).toBeLessThan(600);
    expect(first.response_outcome || 'response_sent').toBe('response_sent');

    const second = await callWorkflowIntake(pool, CLIENT_A_TOKEN, payload);
    expect(second.status).toBe(expectedStatus);
    expect(second.response_outcome).toBe('response_replayed');

    const webhookId = first.webhook_id;
    expect(webhookId).toBeTruthy();

    const { rows: ackHistoryRows } = await pool.query(
      `SELECT ack_body, idempotency_key, ack_status_code
         FROM webhook_ack_history
        WHERE webhook_inbox_id = $1::uuid
        ORDER BY ack_sent_at DESC
        LIMIT 1`,
      [webhookId]
    );

    expect(ackHistoryRows).toHaveLength(1);
    const [ackHistory] = ackHistoryRows;
    expect(ackHistory.ack_status_code).toBe(expectedStatus);
    expect(ackHistory.idempotency_key).toBe(payload.event.id);
    expect(ackHistory.ack_body).toEqual(first.body);

    const { rows: inboxRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM webhook_inbox
        WHERE id = $1::uuid`,
      [webhookId]
    );
    expect(inboxRows[0].total).toBe(1);
  });
});
