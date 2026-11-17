const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { DATABASE_URL, setWorkflowEngineContext } = require('../helpers/tenant-utils');

const pool = new Pool({ connectionString: DATABASE_URL });

describe('API call logging observability', () => {
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

  it('persists api_call_log with correlation and projects to observability_events_v', async () => {
    const correlationId = randomUUID();

    const workflowTemplateName = `test-observability-${randomUUID()}`;

    const { rows: templateRows } = await client.query(
      `
        INSERT INTO workflow_templates (
          name,
          scope_type,
          status,
          version
        )
        VALUES (
          $1,
          'global',
          'active',
          1
        )
        RETURNING id, version
      `,
      [workflowTemplateName]
    );
    expect(templateRows).toHaveLength(1);
    const workflowTemplateId = templateRows[0].id;
    const workflowTemplateVersion = templateRows[0].version;

    const { rows: handlerRows } = await client.query(
      `SELECT handler_key FROM operation_handlers ORDER BY handler_key LIMIT 1`
    );
    expect(handlerRows).toHaveLength(1);
    const handlerKey = handlerRows[0].handler_key;

    const { rows: templateStepRows } = await client.query(
      `
        INSERT INTO workflow_template_steps (
          workflow_template_id,
          sequence_order,
          operation_name,
          handler_key,
          handler_version,
          transition_condition
        )
        VALUES (
          $1::uuid,
          1,
          'provider_api',
          $2::text,
          'v1',
          'always'
        )
        RETURNING id, operation_name
      `,
      [workflowTemplateId, handlerKey]
    );
    expect(templateStepRows).toHaveLength(1);
    const workflowTemplateStepId = templateStepRows[0].id;
    const workflowOperationName = templateStepRows[0].operation_name;

    const workflowRunId = randomUUID();
    await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [workflowRunId]);
    const { rows: workflowRunRows } = await client.query(
      `
        INSERT INTO workflow_runs (
          id,
          workflow_template_id,
          workflow_template_version,
          entry_point,
          workflow_status,
          current_step_id,
          context
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::int,
          'worker',
          'in_progress',
          $4::uuid,
          '{}'::jsonb
        )
        RETURNING id
      `,
      [workflowRunId, workflowTemplateId, workflowTemplateVersion, workflowTemplateStepId]
    );
    expect(workflowRunRows).toHaveLength(1);

    await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [workflowRunId]);
    const { rows: stepRows } = await client.query(
      `
        INSERT INTO workflow_run_steps (
          workflow_run_id,
          workflow_template_step_id,
          sequence_order,
          operation_name,
          handler_key,
          max_retries
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          1,
          $3,
          $4,
          3
        )
        RETURNING id
      `,
      [workflowRunId, workflowTemplateStepId, workflowOperationName, handlerKey]
    );
    expect(stepRows).toHaveLength(1);
    const workflowRunStepId = stepRows[0].id;
    await setWorkflowEngineContext(client, { runId: workflowRunId, stepId: workflowRunStepId, local: true });

    const { rows: providerRows } = await client.query(
      'SELECT id, organization_id FROM providers LIMIT 1'
    );
    expect(providerRows.length).toBe(1);
    const providerId = providerRows[0].id;
    const organizationId = providerRows[0].organization_id;

    const { rows: outboundRows } = await client.query(
      `
        INSERT INTO outbound_calls (
          call_type,
          target_type,
          target_id,
          method,
          url,
          status,
          priority,
          retry_count,
          max_retries,
          scheduled_at,
          workflow_run_step_id,
          created_at,
          correlation_id,
          context
        )
        VALUES (
          'provider_api',
          'provider',
          $1::uuid,
          'POST',
          'https://example.com/hook',
          'in_progress',
          100,
          0,
          3,
          now(),
          $2::uuid,
          now(),
          $3::uuid,
          jsonb_build_object('organization_id', $4::uuid)
        )
        RETURNING id
      `,
      [providerId, workflowRunStepId, correlationId, organizationId]
    );

    const jobId = outboundRows[0].id;

    await client.query(
      `
        SELECT log_api_call_event(
          $1::uuid,
          '{"headers":{"x-test":"1"}}'::jsonb,
          '{"headers":{"x-res":"ok"},"body":{"ok":true}}'::jsonb,
          200,
          123,
          NULL
        )
      `,
      [jobId]
    );

    const { rows: logRows } = await client.query(
      `
        SELECT provider_id, response_status, correlation_id
        FROM api_call_log
        WHERE correlation_id = $1::uuid
      `,
      [correlationId]
    );

    expect(logRows).toHaveLength(1);
    expect(logRows[0].provider_id).toBe(providerId);
    expect(logRows[0].response_status).toBe(200);
    expect(logRows[0].correlation_id).toBe(correlationId);

    const { rows: obsRows } = await client.query(
      `
        SELECT event_source, event_type, resource_type, resource_id, status
        FROM observability_events_v
        WHERE correlation_id = $1::uuid
          AND event_source = 'api_call_log'
      `,
      [correlationId]
    );

    expect(obsRows).toHaveLength(1);
    expect(obsRows[0]).toEqual({
      event_source: 'api_call_log',
      event_type: 'provider_api',
      resource_type: 'api_call',
      resource_id: providerId,
      status: 'succeeded'
    });
  });
});
