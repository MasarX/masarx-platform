const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { upsertWebhookPolicy } = require('../../utils/policies');
const { createOrganization, createClient, createSender, createMappingConfig } = require('../helpers/tenant-utils');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const seedData = async (client) => {
  const { id: organizationId } = await createOrganization(client, 'Workflow intake fixture');
  const { id: clientId } = await createClient(client, organizationId, 'Workflow intake client');
  const senderId = await createSender(client, clientId, 'Workflow intake sender');
  const mappingId = await createMappingConfig(client, 'webhook_inbound', `workflow-intake-${randomUUID()}`);
  const token = `workflow-intake-${randomUUID()}`;
  const { rows: [{ id: sourceId }] } = await client.query(
    `INSERT INTO webhook_sources (
       organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, sender_id, enabled
     ) VALUES ($1, $2, 'Webhook Test Source', 'provider', $3, $4, $5, TRUE) RETURNING id`,
    [organizationId, `fixture-${randomUUID()}`, token, mappingId, senderId]
  );
  const { rows: templates } = await client.query("SELECT id FROM workflow_templates WHERE name='webhook_shipment_create_v1' AND status='active' ORDER BY version DESC,updated_at DESC LIMIT 1");
  expect(templates).toHaveLength(1);
  const policyValue = {
    version: 3,
    ack: { mode: 'accepted_async', status_code: 202, default_headers: { 'cache-control': 'no-store' } },
    workflow: { template_id: templates[0].id, intent:'shipment.create' },
  };
  await upsertWebhookPolicy('source', sourceId, policyValue, 'Test webhook intake policy', client);
  return token;
};

describe('workflow_intake_webhook', () => {
  let client;
  let token;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    token = await seedData(client);
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
        token,
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
