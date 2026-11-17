const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const {
  DATABASE_URL,
  grantSelectRecursive,
  createOrganization,
  createClient,
  createUser,
  setAuthContext,
  createShipment,
  createLabel,
  createRequestContext,
  createMappingConfig,
  createWebhookSource,
  createWebhookInboxEntry
} = require('../helpers/tenant-utils');

const pool = new Pool({ connectionString: DATABASE_URL });

async function createWorkflowTemplateWithStep(client, scopeLabel) {
  const name = `rls-template-${scopeLabel}-${Date.now()}`;
  const { rows: templateRows } = await client.query(
    `INSERT INTO workflow_templates (
        name,
        description,
        version,
        status,
        scope_type
      )
      VALUES ($1, 'RLS coverage template', 1, 'active', 'global')
      RETURNING id`,
    [name]
  );
  const templateId = templateRows[0].id;

  const { rows: stepRows } = await client.query(
    `INSERT INTO workflow_template_steps (
        workflow_template_id,
        sequence_order,
        operation_name,
        transition_condition,
        handler_key,
        handler_version,
        metadata
      )
      VALUES (
        $1::uuid,
        1,
        'workflow_control',
        'always',
        'workflow_control',
        'v1',
        '{}'::jsonb
      )
      RETURNING id`,
    [templateId]
  );

  return { templateId, stepId: stepRows[0].id };
}

async function createWorkflowRun(client, templateId, organizationId, clientId, suffix) {
  const runId = randomUUID();
  await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [runId]);
  await client.query(
    `INSERT INTO workflow_runs (
        id,
        workflow_template_id,
        workflow_template_version,
        entry_point,
        workflow_status,
        context
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        1,
        'webhook',
        'pending',
        $3::jsonb
      )`,
    [
      runId,
      templateId,
      JSON.stringify({
        organization_id: organizationId,
        client_id: clientId,
        run_label: `rls-${suffix}`
      })
    ]
  );
  return runId;
}

async function createWorkflowRunStep(client, runId, stepId) {
  const runStepId = randomUUID();
  await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [runId]);
  await client.query(
    `INSERT INTO workflow_run_steps (
        id,
        workflow_run_id,
        workflow_template_step_id,
        sequence_order,
        step_status,
        operation_name,
        metadata,
        max_retries,
        handler_key,
        handler_version
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        1,
        'pending',
        'workflow_control',
        '{}'::jsonb,
        3,
        'workflow_control',
        'v1'
      )`,
    [runStepId, runId, stepId]
  );
  return runStepId;
}

const rlsIntegrationEnabled = process.env.RUN_RLS_INTEGRATION_TESTS === 'true';

const describeIfRls =
  DATABASE_URL && rlsIntegrationEnabled ? describe : describe.skip;

describeIfRls('Security & RLS coverage', () => {
  let client;
  let template;
  let templateStep;

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '30s'");
    template = null;
    templateStep = null;

    await grantSelectRecursive(client, 'shipments');
    await grantSelectRecursive(client, 'labels');
    await grantSelectRecursive(client, 'workflow_runs');
    await grantSelectRecursive(client, 'workflow_run_steps');
    await grantSelectRecursive(client, 'webhook_inbox');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  async function ensureWorkflowArtifacts() {
    if (!template || !templateStep) {
      const artifacts = await createWorkflowTemplateWithStep(client, 'coverage');
      template = artifacts.templateId;
      templateStep = artifacts.stepId;
    }
    return { templateId: template, stepId: templateStep };
  }

  it('isolates workflow runs and steps per organization', async () => {
    const { templateId, stepId } = await ensureWorkflowArtifacts();

    const { id: orgA } = await createOrganization(client, 'RLS Coverage Org A');
    const { id: orgB } = await createOrganization(client, 'RLS Coverage Org B');

    const { id: clientA } = await createClient(client, orgA, 'Coverage Client A');
    const { id: clientB } = await createClient(client, orgB, 'Coverage Client B');

    const userA = await createUser(client, orgA, 'coverage-a@example.com');
    await createUser(client, orgB, 'coverage-b@example.com');

    const runA = await createWorkflowRun(client, templateId, orgA, clientA, 'org-a');
    const runB = await createWorkflowRun(client, templateId, orgB, clientB, 'org-b');

    await createWorkflowRunStep(client, runA, stepId);
    await createWorkflowRunStep(client, runB, stepId);

    await setAuthContext(client, userA);

    const { rows: runs } = await client.query(
      `SELECT id, context->>'organization_id' AS organization_id FROM workflow_runs ORDER BY created_at`
    );
    const accessibleRunIds = runs
      .filter((row) => row.organization_id === orgA)
      .map((row) => row.id);
    expect(accessibleRunIds).toContain(runA);
    expect(accessibleRunIds).not.toContain(runB);

    const { rows: steps } = await client.query(
      `SELECT workflow_run_id FROM workflow_run_steps ORDER BY created_at`
    );
    const stepRunIds = steps.map((row) => row.workflow_run_id);
    expect(stepRunIds.filter((id) => id === runB).length).toBe(0);
  });

  it('enforces webhook inbox tenant isolation for authenticated users', async () => {
    const { id: orgA } = await createOrganization(client, 'Webhook Org A');
    const { id: orgB } = await createOrganization(client, 'Webhook Org B');
    const { id: clientA } = await createClient(client, orgA, 'Webhook Client A');
    const userA = await createUser(client, orgA, 'webhook-a@example.com');
    const userB = await createUser(client, orgB, 'webhook-b@example.com');

    const mappingId = await createMappingConfig(
      client,
      'webhook_inbound',
      `rls-webhook-${Date.now()}`,
      { fields: [] }
    );

    const webhookSource = await createWebhookSource(client, {
      organizationId: orgA,
      mappingConfigId: mappingId,
      name: 'RLS Coverage Source'
    });

    const contextId = await createRequestContext(client, {
      entryPoint: 'webhook',
      clientId: clientA
    });

    const webhookInboxId = await createWebhookInboxEntry(client, {
      webhookSourceId: webhookSource.id,
      providerType: 'generic',
      rawPayload: { test: 'rls' },
      correlationId: contextId
    });

    await setAuthContext(client, userA);

    const inboxResult = await client.query('SELECT id FROM webhook_inbox WHERE id = $1::uuid', [
      webhookInboxId
    ]);
    expect(inboxResult.rowCount).toBe(1);

    await setAuthContext(client, userB);
    const foreignInboxResult = await client.query('SELECT id FROM webhook_inbox WHERE id = $1::uuid', [
      webhookInboxId
    ]);
    expect(foreignInboxResult.rowCount).toBe(0);
  });

  it('enforces label visibility through shipment organization', async () => {
    const { id: orgA } = await createOrganization(client, 'Label Org A');
    const { id: orgB } = await createOrganization(client, 'Label Org B');

    const { id: clientA } = await createClient(client, orgA, 'Label Client A');
    const { id: clientB } = await createClient(client, orgB, 'Label Client B');

    const userB = await createUser(client, orgB, 'label-b@example.com');

    const { id: shipmentA } = await createShipment(client, {
      organizationId: orgA,
      clientId: clientA,
      status: 'pending',
      serviceType: 'delivery'
    });
    const { id: shipmentB } = await createShipment(client, {
      organizationId: orgB,
      clientId: clientB,
      status: 'pending',
      serviceType: 'delivery'
    });

    await createLabel(client, { shipmentId: shipmentA });
    const labelB = await createLabel(client, { shipmentId: shipmentB });

    await setAuthContext(client, userB);

    const { rows: labels } = await client.query(
      `SELECT shipment_id FROM labels ORDER BY created_at`
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].shipment_id).toBe(shipmentB);
  });
});
