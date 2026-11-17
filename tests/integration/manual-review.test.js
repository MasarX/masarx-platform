const { Pool } = require('pg');
const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL must be defined for manual review tests');

const pool = new Pool({ connectionString: DATABASE_URL });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchOne = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
};

const waitForDecision = async (resourceType, resourceId, timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await fetchOne(
      `select decision_outcome
         from decision_log
        where resource_type = $1 and resource_id = $2
        order by timestamp desc limit 1`,
      [resourceType, resourceId]
    );
    if (row) return row;
    await sleep(200);
  }
  return null;
};

describe('Manual Review via Engine', () => {
  afterAll(async () => {
    await pool.end();
  });

  const ensureTestShipment = async () => {
    const existing = await fetchOne(
      'select id, organization_id, client_id from shipments order by created_at desc limit 1'
    );
    if (existing) return existing;

    const fallbackClient = await fetchOne(
      'select id as client_id, organization_id from clients order by created_at limit 1'
    );
    if (!fallbackClient) {
      throw new Error('No clients available to seed test shipment for manual review');
    }

    const tracking = `MRTEST-${Date.now().toString(36).toUpperCase()}`;
    const { rows } = await pool.query(
      `insert into shipments (
         organization_id,
         client_id,
         service_type,
         tracking_number,
         status,
         box_count,
         created_at,
         updated_at
       )
       values (
         $1::uuid,
         $2::uuid,
         'delivery',
         $3::text,
         'pending',
         1,
         now(),
         now()
       )
       returning id, organization_id, client_id`,
      [fallbackClient.organization_id, fallbackClient.client_id, tracking]
    );
    return rows[0];
  };

  test('enqueue manual review creates domain event, workflow run, task, and decision log', async () => {
    const shipment = await ensureTestShipment();

    const { rows } = await pool.query(
      `select enqueue_domain_event(
         $1::uuid,
         'manual_review.requested',
         'shipment',
         $2::uuid,
         jsonb_build_object(
           'organization_id',$1::uuid,
           'client_id',$3::uuid,
           'resource_type','shipment',
           'resource_id',$2::uuid,
           'task_type','geocoding',
           'reason','test_reason'
         ),
         NULL
       ) as domain_event_id`,
      [shipment.organization_id, shipment.id, shipment.client_id]
    );
    const domainEventId = rows[0].domain_event_id;
    expect(domainEventId).toBeTruthy();

    // Ensure our event is picked up even if backlog exists.
    await pool.query(
      "update domain_events set created_at = now() - interval '100 years', updated_at = now() where id = $1",
      [domainEventId]
    );

    await pool.query(
      "update cron_config set last_run_at = now() - interval '5 minutes' where worker_name = 'domain_events_worker'"
    );
    await pool.query('select run_domain_events_worker();');

    const run = await fetchOne(
      `select d.workflow_run_id from domain_events d where d.id = $1`,
      [domainEventId]
    );
    expect(run).toBeTruthy();

    const dispatchDecision = await waitForDecision('domain_event', domainEventId, 8000);
    expect(dispatchDecision).toBeTruthy();
    await pool.query('delete from domain_events where id = $1', [domainEventId]);
  });
});
