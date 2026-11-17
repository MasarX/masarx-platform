const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { resolvePrimaryFixtureOrgClientSender } = require('./helpers/integration-fixtures');

loadEnv();

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL must be defined for manual review lifecycle tests');

const maxPool = Number(process.env.TEST_DB_POOL_MAX || '4');
const pool = new Pool({ connectionString: DATABASE_URL, max: maxPool });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchOne = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
};

const progressRun = async (runId, payload = {}) => {
  const { rows } = await pool.query(
    'select progress_workflow_run($1::uuid, $2::jsonb) as result',
    [runId, JSON.stringify(payload)]
  );
  return rows[0]?.result || null;
};

const sleepUntilNextRun = async (result, fallbackMs = 200) => {
  if (!result?.next_run_at) {
    await sleep(fallbackMs);
    return;
  }

  const delayMs = Math.max(50, new Date(result.next_run_at).getTime() - Date.now());
  await sleep(Math.min(delayMs, 1000));
};

describe('Manual Review Lifecycle via Engine', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('enqueue -> assign -> resolve with decisions', async () => {
    const fixtureScope = await resolvePrimaryFixtureOrgClientSender(pool);
    expect(fixtureScope).toBeTruthy();

    const shipment = await fetchOne(
      `
        INSERT INTO shipments (
          organization_id,
          client_id,
          sender_id,
          service_type,
          tracking_number,
          box_count,
          status,
          created_at,
          updated_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'delivery',
          $4::text,
          1,
          'pending',
          now(),
          now()
        )
        RETURNING id, organization_id, client_id
      `,
      [
        fixtureScope.organization_id,
        fixtureScope.client_id,
        fixtureScope.sender_id,
        `MR-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
      ]
    );
    expect(shipment).toBeTruthy();

    const userId = randomUUID();
    await pool.query(
      `insert into users (id, organization_id, email, full_name, user_type, status, created_at)
       values ($1::uuid, $2::uuid, $3, 'Test Assignee', 'ops_admin', 'active', now())
       on conflict (id) do nothing`,
      [userId, shipment.organization_id, `assignee+${userId.slice(0, 8)}@example.com`]
    );

    const tpl = await fetchOne("select id from workflow_templates where name = 'manual_review_v1' limit 1");
    expect(tpl).toBeTruthy();

    const idempotencyKey = randomUUID();
    const runStart = await pool.query(
      'select start_workflow_run($1::uuid, $2::jsonb) as run_id',
      [
        tpl.id,
        JSON.stringify({
          organization_id: shipment.organization_id,
          client_id: shipment.client_id,
          shipment_id: shipment.id,
          resource_type: 'manual_review_test',
          resource_id: idempotencyKey,
          idempotency_key: idempotencyKey,
          payload: {
            organization_id: shipment.organization_id,
            client_id: shipment.client_id,
            shipment_id: shipment.id,
            resource_type: 'shipment',
            resource_id: shipment.id,
            task_type: 'geocoding'
          }
        })
      ]
    );
    const runId = runStart.rows[0]?.run_id;
    expect(runId).toBeTruthy();

    let manualReviewTaskId = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const taskRow = await fetchOne(
        `select id
           from manual_review_tasks
          where metadata->>'workflow_run_id' = $1::text
          order by created_at desc limit 1`,
        [runId]
      );
      if (taskRow?.id) {
        manualReviewTaskId = taskRow.id;
        break;
      }

      const progress = await progressRun(runId, {});
      await sleepUntilNextRun(progress);
    }
    expect(manualReviewTaskId).toBeTruthy();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const progress = await progressRun(runId, {
        manual_review_task_id: manualReviewTaskId,
        assigned_to: userId
      });
      const assignedTask = await fetchOne(
        `select status, assigned_to
           from manual_review_tasks
          where id = $1`,
        [manualReviewTaskId]
      );
      if (assignedTask?.status === 'assigned' && assignedTask.assigned_to === userId) {
        break;
      }

      await sleepUntilNextRun(progress);
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const progress = await progressRun(runId, {
        manual_review_task_id: manualReviewTaskId,
        resolution_notes: 'auto-resolved by test'
      });
      const resolvedTask = await fetchOne(
        `select status, resolution_notes
           from manual_review_tasks
          where id = $1`,
        [manualReviewTaskId]
      );
      if (resolvedTask?.status === 'resolved' && resolvedTask.resolution_notes === 'auto-resolved by test') {
        break;
      }

      await sleepUntilNextRun(progress);
    }

    const task = await fetchOne(
      `select id, status, assigned_to, resolution_notes
         from manual_review_tasks
        where id = $1`,
      [manualReviewTaskId]
    );
    expect(task).toBeTruthy();
    expect(task.status).toBe('resolved');
    expect(task.assigned_to).toBe(userId);
    expect(task.resolution_notes).toBe('auto-resolved by test');

    const finalizeProgress = await progressRun(runId, {});
    expect(finalizeProgress?.status).toBe('completed');

    await pool.query('delete from manual_review_tasks where id = $1', [manualReviewTaskId]);
    await pool.query('delete from users where id = $1', [userId]);
    await pool.query('delete from shipments where id = $1', [shipment.id]);
  });
});
