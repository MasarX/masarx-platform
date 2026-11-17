const { Pool } = require('pg');
const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must be defined for idempotency tests');

// CI often runs multiple workflows concurrently against the same shared DB.
// Keep connection usage bounded to avoid pooler "max clients reached" flake.
const maxPool = Number(process.env.TEST_DB_POOL_MAX || '4');
const pool = new Pool({ connectionString: DATABASE_URL, max: maxPool });

describe('Workflow start idempotency', () => {
  afterAll(async () => { await pool.end(); });

  test('starting same template+context concurrently yields single run', async () => {
    const { rows: tplRows } = await pool.query(
      `SELECT id FROM workflow_templates WHERE name = 'manual_review_v1' LIMIT 1`
    );
    expect(tplRows).toHaveLength(1);
    const templateId = tplRows[0].id;

    // Stable idempotency key to collide on the same logical run
    const idem = 'idem-' + Date.now();
    const ctx = {
      organization_id: '00000000-0000-0000-0000-000000000000',
      resource_type: 'idempotency_test',
      resource_id: idem,
      idempotency_key: idem,
    };

    // Launch N concurrent starts (bounded by pool max to avoid exhausting pooler session mode).
    const concurrency = Math.min(8, maxPool);
    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        pool.query('SELECT start_workflow_run($1::uuid, $2::jsonb) AS run_id', [
          templateId,
          JSON.stringify(ctx),
        ])
      )
    );

    const runIds = results.map((r) => r.rows[0].run_id);
    // All calls should resolve to the same run id (or at worst a single unique value)
    const unique = Array.from(new Set(runIds));
    expect(unique).toHaveLength(1);

    // Verify only one workflow_run row exists for the idempotency key
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt
         FROM workflow_runs
        WHERE idempotency_key = $1`,
      [idem]
    );
    expect(countRows[0].cnt).toBe(1);
  });
});
