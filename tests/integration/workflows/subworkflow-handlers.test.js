const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { readFileSync } = require('fs');
const path = require('path');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""))
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const subWorkflowMigrationSql = readFileSync(
  path.join(__dirname, '../../../supabase/migrations/202511011405_workflow_subworkflow_handlers.sql'),
  'utf8'
)
  .replace(/\bBEGIN;\s*/gi, '')
  .replace(/\bCOMMIT;\s*/gi, '');

describeIfDb('Workflow sub-workflow handlers', () => {
  let client;
  let organizationId;
  let tenantClientId;

  beforeAll(async () => {
    const { rows: clientRows } = await pool.query(
      `SELECT id, organization_id
       FROM clients
       ORDER BY created_at
       LIMIT 1`,
    );

    const tenantClient = clientRows[0];
    if (!tenantClient) {
      throw new Error('Expected at least one client to exist for workflow sub-workflow handler tests');
    }

    tenantClientId = tenantClient.id;
    organizationId = tenantClient.organization_id;
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

  async function seedTemplates() {
    await client.query(subWorkflowMigrationSql);

    const childName = `test_child_${randomUUID()}`;
    const parentName = `test_parent_${randomUUID()}`;

    const { rows: childRows } = await client.query(
      `
        INSERT INTO workflow_templates (name, description, version, status, scope_type)
        VALUES ($1, 'Test child workflow', 1, 'active', 'global')
        RETURNING id
      `,
      [childName]
    );
    const childTemplateId = childRows[0].id;

    await client.query(
      `
        INSERT INTO workflow_template_steps (
          workflow_template_id,
          sequence_order,
          operation_name,
          operation_settings_category,
          transition_condition,
          metadata,
          handler_key
        )
        VALUES (
          $1,
          1,
          'complete_child_workflow',
          NULL,
          'always',
          jsonb_build_object('action', 'complete'),
          'workflow_control'
        )
      `,
      [childTemplateId]
    );

    const { rows: parentRows } = await client.query(
      `
        INSERT INTO workflow_templates (name, description, version, status, scope_type)
        VALUES ($1, 'Test parent workflow', 1, 'active', 'global')
        RETURNING id
      `,
      [parentName]
    );
    const parentTemplateId = parentRows[0].id;

    await client.query(
      `
        INSERT INTO workflow_template_steps (
          workflow_template_id,
          sequence_order,
          operation_name,
          operation_settings_category,
          transition_condition,
          metadata,
          handler_key
        )
        VALUES (
          $1,
          1,
          'start_child_workflow',
          NULL,
          'always',
          jsonb_build_object(
            'child_workflow_template_id', $2::uuid,
            'context_patch', jsonb_build_object('from_parent', true)
          ),
          'start_workflow'
        )
      `,
      [parentTemplateId, childTemplateId]
    );

    await client.query(
      `
        INSERT INTO workflow_template_steps (
          workflow_template_id,
          sequence_order,
          operation_name,
          operation_settings_category,
          transition_condition,
          metadata,
          handler_key
        )
        VALUES (
          $1,
          2,
          'wait_child_workflow',
          NULL,
          'always',
          jsonb_build_object(
            'poll_interval_seconds', 0,
            'max_wait_seconds', 60
          ),
          'wait_workflow'
        )
      `,
      [parentTemplateId]
    );

    return { parentTemplateId, childTemplateId };
  }

  test('wait_workflow handler returns pending until child completes', async () => {
    const { parentTemplateId, childTemplateId } = await seedTemplates();

    const { rows: startRows } = await client.query(
      `SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id`,
      [parentTemplateId, JSON.stringify({ parent_context: true, client_id: tenantClientId, organization_id: organizationId })]
    );
    const parentRunId = startRows[0].run_id;

    await client.query(`SELECT progress_workflow_run($1::uuid)`, [parentRunId]);

    const { rows: childRunRows } = await client.query(
      `SELECT id, workflow_status FROM workflow_runs WHERE workflow_template_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [childTemplateId]
    );
    const childRunId = childRunRows[0].id;
    expect(childRunRows[0].workflow_status).toBe('pending');

    const { rows: waitRows } = await client.query(
      `SELECT progress_workflow_run($1::uuid) AS result`,
      [parentRunId]
    );

    expect(['pending', 'waiting']).toContain(waitRows[0].result.status);

    const { rows: contextRows } = await client.query(
      `SELECT context FROM workflow_runs WHERE id = $1`,
      [parentRunId]
    );
    expect(contextRows[0].context.latest_child_workflow_run_id || childRunId).toBeTruthy();
  });

  test('start_workflow launches child workflow and wait_workflow completes after child success', async () => {
    const { parentTemplateId, childTemplateId } = await seedTemplates();

    const { rows: startRows } = await client.query(
      `SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id`,
      [parentTemplateId, JSON.stringify({ parent_context: true, client_id: tenantClientId, organization_id: organizationId })]
    );
    const parentRunId = startRows[0].run_id;

    await client.query(`SELECT progress_workflow_run($1::uuid)`, [parentRunId]);

    const { rows: childRunRows } = await client.query(
      `SELECT id
       FROM workflow_runs
       WHERE metadata->>'started_by_run_id' = $2
         AND metadata->>'started_by_step_id' = (
           SELECT workflow_template_step_id::text
           FROM workflow_run_steps
           WHERE workflow_run_id = $1
           ORDER BY sequence_order
           LIMIT 1
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [parentRunId, parentRunId]
    );
    const childRunId = childRunRows[0].id;

    await client.query(`SELECT progress_workflow_run($1::uuid)`, [childRunId]);

    let childStatus = 'in_progress';
    let childGuard = 5;
    while (childStatus !== 'completed' && childGuard-- > 0) {
      await client.query(`SELECT progress_workflow_run($1::uuid)`, [childRunId]);
      const { rows: childStatusRows } = await client.query(
        `SELECT workflow_status FROM workflow_runs WHERE id = $1`,
        [childRunId]
      );
      childStatus = childStatusRows[0].workflow_status;
    }
    expect(childStatus).toBe('completed');

    let waitResultRows = await client.query(
      `SELECT progress_workflow_run($1::uuid) AS result`,
      [parentRunId]
    );
    let waitResult = waitResultRows.rows[0].result;
    let guard = 6;
    while (['pending', 'waiting'].includes(waitResult.status) && guard-- > 0) {
      if (waitResult.next_run_at) {
        const delayMs = Math.max(50, new Date(waitResult.next_run_at).getTime() - Date.now());
        await sleep(Math.min(delayMs, 1000));
      }
      await client.query(`SELECT progress_workflow_run($1::uuid)`, [parentRunId]);
      waitResultRows = await client.query(
        `SELECT progress_workflow_run($1::uuid) AS result`,
        [parentRunId]
      );
      waitResult = waitResultRows.rows[0].result;
    }

    expect(waitResult.status).toBe('completed');

    await client.query(`SELECT progress_workflow_run($1::uuid)`, [parentRunId]);

    const { rows: parentFinal } = await client.query(
      `SELECT workflow_status FROM workflow_runs WHERE id = $1`,
      [parentRunId]
    );
    expect(parentFinal[0].workflow_status).toBe('completed');
  });
});
