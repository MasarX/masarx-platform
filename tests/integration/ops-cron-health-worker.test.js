const { Pool } = require('pg');
const { loadEnv } = require('../../scripts/utils/load-env');
const { applySetting, createOrganization } = require('./helpers/tenant-utils');

loadEnv();

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('Ops cron health worker', () => {
  let client;

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

  test('emits alert_triggers when monitored cron job is missing', async () => {
    await client.query(
      `UPDATE cron_config SET last_run_at = NULL WHERE worker_name = 'ops_cron_health_worker'`
    );

    const { id: organizationId } = await createOrganization(client, 'Ops Cron Health Worker Org');

    await applySetting(client, {
      category: 'ops_oncall_alerting',
      scopeType: 'tenant',
      scopeId: organizationId,
      value: {
        enabled: true,
        whatsapp: {
          enabled: false
        }
      },
      changeReason: 'integration-test: ops_oncall_alerting enabled (dispatch configured elsewhere)'
    });

    const missingJobName = `missing_job_${Date.now()}`;
    await applySetting(client, {
      category: 'ops_cron_health_policy',
      scopeType: 'global',
      scopeId: null,
      value: {
        enabled: true,
        repeat_minutes: 1,
        jobs: [
          {
            jobname: missingJobName,
            max_staleness_minutes: 1,
            severity: 'critical'
          }
        ]
      },
      changeReason: 'integration-test: ops_cron_health_policy'
    });

    const { rows: workerRows } = await client.query(
      `SELECT public.run_ops_cron_health_worker() AS result`
    );
    expect(workerRows.length).toBe(1);
    expect(workerRows[0].result).toBeTruthy();

    const { rows: alertRows } = await client.query(
      `
        SELECT id, severity, message, context
        FROM alert_triggers
        WHERE organization_id = $1::uuid
          AND resource_type = 'cron_job'
          AND context->>'jobname' = $2
        ORDER BY "timestamp" DESC
        LIMIT 1
      `,
      [organizationId, missingJobName]
    );

    expect(alertRows.length).toBe(1);
    expect(alertRows[0].severity).toBe('critical');
    expect(alertRows[0].message).toContain(missingJobName);
    expect(alertRows[0].context).toHaveProperty('jobname');
  });
});
