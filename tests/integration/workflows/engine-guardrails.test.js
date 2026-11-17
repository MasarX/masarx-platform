const { Pool } = require('pg');
const { randomUUID } = require('crypto');

describe('workflow guardrails enforcement', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;

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
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('blocks workflow inserts without context and allows guarded inserts with context', async () => {
    const templateId = randomUUID();
    const stepId = randomUUID();
    const runId = randomUUID();
    const runStepId = randomUUID();

    await client.query(
      `
        INSERT INTO workflow_templates (id, name, description, version, status, scope_type)
        VALUES ($1::uuid, $2, 'Guardrails test template', 1, 'active', 'global')
      `,
      [templateId, `guardrails-template-${templateId.slice(0, 8)}`]
    );

    await client.query(
      `
        INSERT INTO workflow_template_steps (
          id,
          workflow_template_id,
          sequence_order,
          operation_name,
          transition_condition,
          handler_key,
          handler_version
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          1,
          'workflow_control',
          'always',
          'workflow_control',
          'v1'
        )
      `,
      [stepId, templateId]
    );

    await client.query('SAVEPOINT guardrails_run_insert');
    await expect(
      client.query(
        `
          INSERT INTO workflow_runs (
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
            'test',
            'pending',
            '{}'::jsonb
          )
        `,
        [runId, templateId]
      )
    ).rejects.toThrow(/workflow guardrails: missing context workflow_run_id/i);
    await client.query('ROLLBACK TO SAVEPOINT guardrails_run_insert');

    await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [runId]);
    await client.query(
      `
        INSERT INTO workflow_runs (
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
          'test',
          'pending',
          '{}'::jsonb
        )
      `,
      [runId, templateId]
    );
    await client.query(`SELECT set_config('app.workflow_run_id', '', true)`);

    await client.query('SAVEPOINT guardrails_step_insert');
    await expect(
      client.query(
        `
          INSERT INTO workflow_run_steps (
            id,
            workflow_run_id,
            workflow_template_step_id,
            sequence_order,
            step_status,
            operation_name,
            handler_key,
            handler_version,
            max_retries
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            1,
            'pending',
            'workflow_control',
            'workflow_control',
            'v1',
            1
          )
        `,
        [runStepId, runId, stepId]
      )
    ).rejects.toThrow(/workflow guardrails: missing context workflow_run_id/i);
    await client.query('ROLLBACK TO SAVEPOINT guardrails_step_insert');

    await client.query(`SELECT set_config('app.workflow_run_id', $1, true)`, [runId]);
    await client.query(
      `
        INSERT INTO workflow_run_steps (
          id,
          workflow_run_id,
          workflow_template_step_id,
          sequence_order,
          step_status,
          operation_name,
            handler_key,
            handler_version,
            max_retries
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          1,
          'pending',
          'workflow_control',
            'workflow_control',
            'v1',
            1
        )
      `,
      [runStepId, runId, stepId]
    );
  });
});
