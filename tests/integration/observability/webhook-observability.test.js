const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { DATABASE_URL } = require('../helpers/tenant-utils');

const pool = new Pool({ connectionString: DATABASE_URL });

describe('Webhook receiver observability projection', () => {
  let client;

  beforeAll(async () => {
    const conn = await pool.connect();
    await conn.query('SELECT 1');
    conn.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('projects webhook_response_events into observability_events_v with correlation', async () => {
    const correlationId = randomUUID();
    const decisionId = randomUUID();
    const webhookInboxId = randomUUID();

    const { rows: orgRows } = await client.query('SELECT id FROM organizations LIMIT 1');
    expect(orgRows.length).toBe(1);
    const organizationId = orgRows[0].id;

    await client.query(
      `
        INSERT INTO decision_log (
          id,
          organization_id,
          decision_category,
          resource_type,
          resource_id,
          decision_point,
          decision_outcome,
          decision_inputs,
          decision_reason,
          performed_by_system,
          correlation_id,
          timestamp
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          'http_response_emitted',
          'webhook_inbox',
          $3::uuid,
          'webhook_ack',
          'succeeded',
          '{}'::jsonb,
          'observability projection test',
          'webhook-receiver',
          $4::uuid,
          now()
        )
      `,
      [decisionId, organizationId, webhookInboxId, correlationId]
    );

    const { rows: obsRows } = await client.query(
      `
        SELECT event_source, event_type, resource_type, resource_id, status, correlation_id
          FROM observability_events_v
         WHERE event_source = 'webhook_http_response'
           AND resource_id = $1::uuid
         ORDER BY event_time DESC
         LIMIT 1
      `,
      [webhookInboxId]
    );

    expect(obsRows).toHaveLength(1);
    expect(obsRows[0]).toEqual({
      event_source: 'webhook_http_response',
      event_type: 'http_response_emitted',
      resource_type: 'webhook_inbox',
      resource_id: webhookInboxId,
      status: 'succeeded',
      correlation_id: correlationId
    });
  });
});
