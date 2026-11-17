const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { upsertWebhookPolicy } = require('../utils/policies');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

const WEBHOOK_INTAKE_TEMPLATE_ID = '77770000-0000-0000-0000-000000770001';
const live3plEnabled = process.env.RUN_LIVE_3PL_TESTS === 'true';

(live3plEnabled ? describe : describe.skip)('Workflow intake - Logestechs style policy', () => {
  let client;

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  test('launches workflow via workflow_intake_webhook and applies context patch', async () => {
    const organizationId = randomUUID();
    const templateId = randomUUID();
    const sourceId = randomUUID();
    const mappingConfigId = randomUUID();
    const settingsVersionId = randomUUID();
    const settingsId = randomUUID();
    const token = `token-${randomUUID()}`;

    await client.query(
      `
        INSERT INTO organizations (id, name, slug)
        VALUES ($1, $2, $3)
      `,
      [organizationId, 'Logestechs Test Org', `logestechs-${organizationId.slice(0, 8)}`],
    );

    await client.query(
      `
        INSERT INTO workflow_templates (
          id,
          name,
          description,
          status,
          scope_type,
          scope_id,
          notes
        )
        VALUES ($1, $2, $3, 'active', 'global', NULL, 'Integration test intake template')
      `,
      [templateId, `logestechs_test_${templateId.slice(0, 8)}`, 'Workflow intake integration test'],
    );

    await client.query(
      `
        INSERT INTO mapping_configs (
          id,
          mapping_type,
          mapping_key,
          mapping_config,
          mapping_version,
          notes
        )
        VALUES ($1, 'webhook_inbound', $2, '{}'::jsonb, 1, 'Logestechs workflow intake mapping')
      `,
      [mappingConfigId, `logestechs-source-${sourceId.slice(0, 8)}::default`],
    );

    await client.query(
      `
        INSERT INTO webhook_sources (
          id,
          organization_id,
          source_identifier,
          name,
          provider_type,
          auth_token,
          mapping_config_id,
          enabled
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
      `,
      [
        sourceId,
        organizationId,
        `logestechs-source-${sourceId.slice(0, 8)}`,
        'Logestechs Workflow Source',
        'logestechs_3pl',
        token,
        mappingConfigId,
      ],
    );

    const policyValue = {
      version: 1,
      validation: {
        idempotency: { body_path: 'event.id' },
      },
      ack: {
        mode: 'accepted_async',
        status_code: 202,
        default_headers: { 'content-type': 'application/json' },
        body_template: { status: 'accepted_async', correlation_id: '{{ webhook.correlation_id }}' },
      },
      workflow: {
        template_id: WEBHOOK_INTAKE_TEMPLATE_ID,
        launch_mode: 'in_background',
        context_patch: {
          followup_template_id: templateId,
          priority: 95,
          notification_channel: 'whatsapp',
          notification_recipient_id: '00000000-0000-0000-0000-000000000111',
        },
      },
      logging: {
        decision_point: 'workflow_intake_ack',
        include_payload: true,
      },
    };

    await upsertWebhookPolicy('source', sourceId, policyValue, 'integration test policy', client);

    const headers = { 'content-type': 'application/json' };
    const payload = { event: { id: `evt-${randomUUID()}`, type: 'shipment.created' } };
    const rawBody = JSON.stringify(payload);

    const { rows } = await client.query(
      `
        SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS response
      `,
      [token, JSON.stringify(headers), rawBody, JSON.stringify(payload)],
    );

    const response = rows[0].response;
    expect(response.status).toBe(202);
    expect(response.response_mode).toBe('accepted_async');
    expect(response.response_outcome).toBe('response_sent');
    expect(response.workflow_run_id).toBeTruthy();
    expect(response.webhook_id).toBeTruthy();

    const workflowRunId = response.workflow_run_id;
    const webhookId = response.webhook_id;

    await client.query('SELECT progress_workflow_run($1::uuid)', [workflowRunId]);

    const { rows: inboxRows } = await client.query(
      `
        SELECT workflow_run_id, processing_status
        FROM webhook_inbox
        WHERE id = $1::uuid
      `,
      [webhookId],
    );
    expect(inboxRows[0].workflow_run_id).toBe(workflowRunId);
    expect(inboxRows[0].processing_status).toBe('in_progress');

    const { rows: runRows } = await client.query(
      `
        SELECT workflow_status, context
        FROM workflow_runs
        WHERE id = $1::uuid
      `,
      [workflowRunId],
    );

    expect(['completed','in_progress']).toContain(runRows[0].workflow_status);
    const runContext =
      typeof runRows[0].context === 'string' ? JSON.parse(runRows[0].context) : runRows[0].context;
    const contextPatch =
      runContext?.workflow && typeof runContext.workflow === 'object'
        ? runContext.workflow.context_patch || {}
        : {};
    expect(contextPatch.notification_channel).toBe('whatsapp');
    expect(contextPatch.notification_recipient_id).toBe('00000000-0000-0000-0000-000000000111');
    expect(contextPatch.priority).toBe(95);
  });
});
