const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));

const pool = new Pool({ connectionString: DATABASE_URL });

const slug = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('Outbound call_type is dynamic (no hardcoding)', () => {
  let client;

  beforeAll(async () => {
    const c = await pool.connect();
    await c.query('SELECT 1');
    c.release();
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

  it('uses operation_templates.call_type for outbound_calls', async () => {
    // 1) Org + Provider
    const orgSlug = slug('org');
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations (name, slug)
       VALUES ($1, $2)
       RETURNING id`,
      ['CallType Org', orgSlug]
    );
    const organizationId = orgRows[0].id;

    const { rows: providerRows } = await client.query(
      `INSERT INTO providers (organization_id, name, provider_type, enabled, priority_rank, health_status)
       VALUES ($1, $2, $3, true, 10, 'healthy')
       RETURNING id`,
      [organizationId, slug('provider'), 'comms']
    );
    const providerId = providerRows[0].id;

    // 2) Minimal mapping_config to satisfy FK from operation_templates
    const { rows: mapRows } = await client.query(
      `INSERT INTO mapping_configs (mapping_type, mapping_key, mapping_config)
       VALUES ('provider_response', $1, '{}')
       RETURNING id`,
      [slug('op')]
    );
    const mappingConfigId = mapRows[0].id;

    // 3) Operation template with explicit call_type
    const opName = slug('send_message');
    const { rows: opRows } = await client.query(
      `INSERT INTO operation_templates (
         provider_id, operation_name, method, url_template,
         headers_template, body_template, request_mappings, mapping_config_id,
         timeout_seconds, idempotency_key_template, call_type,
         handler_key, handler_version
       )
       VALUES (
         $1, $2, 'POST', 'https://example.test/send', '{}', '{}', '{}', $3,
         30, NULL, 'comms_whatsapp',
         'outbound_http', 'v1'
       )
       RETURNING id`,
      [providerId, opName, mappingConfigId]
    );
    const operationTemplateId = opRows[0].id;

    // 4) Workflow template + step (handler: outbound_http) referencing the operation template via metadata
    const { rows: wfRows } = await client.query(
      `INSERT INTO workflow_templates (
         name, description, version, status, notes, scope_type, scope_id
       )
       VALUES ($1, 'test', 1, 'active', 'call_type test', 'tenant', $2)
       RETURNING id`,
      [slug('wf'), organizationId]
    );
    const workflowTemplateId = wfRows[0].id;

    await client.query(
      `INSERT INTO workflow_template_steps (
         workflow_template_id, sequence_order, operation_name,
         transition_condition, condition_jsonlogic, next_operation_name,
         next_operation_priority, next_operation_delay_seconds,
         manual_action_required, metadata, enabled, handler_key, handler_version
       )
       VALUES ($1, 1, $2, 'always', NULL, NULL, NULL, NULL, false,
               jsonb_build_object('operation_template_id', $3::uuid), true, 'outbound_http', 'v1')`,
      [workflowTemplateId, opName, operationTemplateId]
    );

    // 5) Start workflow run and progress first step
    const { rows: runRows } = await client.query(
      `SELECT start_workflow_run($1, $2) AS id`,
      [workflowTemplateId, { organization_id: organizationId }]
    );
    const runId = runRows[0].id;

    await client.query(`SELECT progress_workflow_run($1)`, [runId]);

    // 6) Assert outbound_calls row exists with call_type driven by operation_templates.call_type
    const { rows: ocRows } = await client.query(
      `SELECT call_type
         FROM outbound_calls
        WHERE (context->>'workflow_run_id')::uuid = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [runId]
    );

    expect(ocRows.length).toBe(1);
    expect(ocRows[0].call_type).toBe('comms_whatsapp');
  }, 30000);
});
