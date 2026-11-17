const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { upsertWebhookPolicy } = require('../../utils/policies');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const seedData = async (client) => {
  await client.query(`
    INSERT INTO organizations (id, name, slug)
    VALUES ('aaaa1000-0000-0000-0000-000000000004', 'Webhook Org', 'webhook-org')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO mapping_configs (
      id,
      mapping_type,
      mapping_key,
      mapping_config,
      mapping_version,
      notes
    )
    VALUES (
      'cccc1000-0000-0000-0000-000000000004',
      'webhook_inbound',
      'webhook-test::default',
      '{}'::jsonb,
      1,
      'Integration test webhook intake mapping'
    )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO webhook_sources (
      id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
    ) VALUES (
      'bbbb1000-0000-0000-0000-000000000004',
      'aaaa1000-0000-0000-0000-000000000004',
      'webhook-test',
      'Webhook Test Source',
      'provider',
      'token-webhook-test',
      'cccc1000-0000-0000-0000-000000000004',
      TRUE
    )
    ON CONFLICT (id) DO NOTHING;

  `);

  const clientId = randomUUID();
  await client.query(`INSERT INTO clients(id,organization_id,name,slug,sla_tier,status)
    VALUES($1::uuid,'aaaa1000-0000-0000-0000-000000000004','Webhook fixture client',$2,'standard','active')`,
    [clientId,`webhook-fixture-${clientId}`]);
  await client.query(`WITH owned_sender AS (
    INSERT INTO senders(client_id,name,status) VALUES($1::uuid,'Workflow fixture sender','active') RETURNING id
  ) UPDATE webhook_sources SET sender_id=(SELECT id FROM owned_sender)
    WHERE id='bbbb1000-0000-0000-0000-000000000004'`, [clientId]);
  const { rows: templates } = await client.query("SELECT id FROM workflow_templates WHERE name='webhook_shipment_create_v1' AND status='active' ORDER BY version DESC,updated_at DESC LIMIT 1");
  expect(templates).toHaveLength(1);
  const policyValue = {
    version: 1,
    response: { mode: 'accepted_async', default_headers: { 'cache-control': 'no-store' } },
    workflow: { template_id: templates[0].id, intent:'shipment.create' },
  };
  await upsertWebhookPolicy('source', 'bbbb1000-0000-0000-0000-000000000004', policyValue, 'Test webhook intake policy', client);
};

describe('workflow_intake_webhook', () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await seedData(client);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  test('returns 401 when token is missing', async () => {
    const { rows } = await client.query(
      'SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS response',
      [null, JSON.stringify({}), '', JSON.stringify({})]
    );
    const response = rows[0].response;
    expect(response.status).toBe(401);
    expect(response.response_outcome).toBe('response_failed');
  });

  test('enqueues workflow run and records http response event', async () => {
    const { rows } = await client.query(
      'SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS response',
      [
        'token-webhook-test',
        JSON.stringify({ 'content-type': 'application/json' }),
        JSON.stringify({
          event: { id: 'evt-workflow-intake-test', type: 'shipment.create' },
          example: 'value'
        }),
        JSON.stringify({
          event: { id: 'evt-workflow-intake-test', type: 'shipment.create' },
          example: 'value'
        })
      ]
    );

    const response = rows[0].response;
    expect(response.status).toBe(202);
    expect(response.response_outcome).toBe('response_sent');
    expect(response.response_mode).toBe('accepted_async');

    const webhookId = response.webhook_id;
    const workflowRunId = response.workflow_run_id;

    expect(webhookId).toBeTruthy();
    expect(workflowRunId).toBeTruthy();

    const inbox = await client.query(
      'SELECT workflow_run_id, processing_status FROM webhook_inbox WHERE id = $1::uuid',
      [webhookId]
    );
    expect(inbox.rows[0].workflow_run_id).toBe(workflowRunId);
    expect(inbox.rows[0].processing_status).toBe('in_progress');

    const responseHistory = await client.query(
      'SELECT http_status_code, response_outcome FROM webhook_response_events WHERE webhook_inbox_id = $1::uuid ORDER BY response_created_at DESC',
      [webhookId]
    );
    if (responseHistory.rows.length > 0) {
      expect(responseHistory.rows[0].http_status_code).toBe(202);
      expect(responseHistory.rows[0].response_outcome).toBe('response_sent');
    }

    const workflow = await client.query(
      'SELECT workflow_status FROM workflow_runs WHERE id = $1::uuid',
      [workflowRunId]
    );
    expect(workflow.rows.length).toBe(1);
  });
});
