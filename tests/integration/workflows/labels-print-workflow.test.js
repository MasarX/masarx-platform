const { Pool } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

test('the active label print workflow starts with a registered execute handler', async () => {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required for the label print workflow contract');

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10000, query_timeout: 10000 });
  try {
    const { rows } = await pool.query(
      `SELECT step.sequence_order
         FROM public.workflow_templates AS template
         JOIN public.workflow_template_steps AS step ON step.workflow_template_id = template.id
         JOIN public.operation_handlers AS handler
           ON handler.handler_key = step.handler_key AND handler.handler_version = step.handler_version
        WHERE template.name = 'labels_print_workflow_v2'
          AND template.status = 'active'
          AND step.enabled
          AND handler.is_active
          AND handler.handler_key = 'label_print_execute'
          AND to_regprocedure(format('%I.%I%s', handler.handler_schema, handler.handler_name, handler.handler_signature)) IS NOT NULL`,
    );
    expect(rows.map(({ sequence_order }) => Number(sequence_order))).toEqual([1]);
  } finally {
    await pool.end();
  }
});
