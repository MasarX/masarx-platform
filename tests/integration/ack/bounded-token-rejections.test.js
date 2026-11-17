const { Pool } = require('pg');
const { randomUUID } = require('crypto');

// Admitted disposable backend only. No default server, silent skip, or persisted fixtures.
const CATEGORY = 'webhook_auth_rejection_logging_policy';
const LOCK_KEY = 'masarx.webhook-token-rejection-log';
const QUERY_TIMEOUT_MS = 7000;
let pool;
let poolError;
const query = (client, text, values) => client.query({ text, values, query_timeout: QUERY_TIMEOUT_MS });

async function withRollbackClients(isolations, run) {
  const states = [];
  let failure;
  let value;
  try {
    if (poolError) throw poolError;
    // Preconnect both sessions before acquiring any transaction/advisory locks.
    for (const isolation of isolations) {
      if (!['READ COMMITTED', 'REPEATABLE READ'].includes(isolation)) throw new Error('Invalid test isolation');
      const client = await pool.connect();
      const state = { client, begun: false, error: null, isolation };
      state.onError = error => { state.error ||= error; };
      client.on('error', state.onError);
      states.push(state);
    }
    for (const state of states) {
      state.begun = true;
      await query(state.client, 'BEGIN ISOLATION LEVEL ' + state.isolation);
      await query(state.client, "SET LOCAL statement_timeout = '5s'");
      await query(state.client, "SET LOCAL lock_timeout = '500ms'");
      await query(state.client, "SET LOCAL idle_in_transaction_session_timeout = '45s'");
      await query(state.client, "SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
    }
    value = await run(states.map(state => state.client));
    for (const state of states) if (state.error) throw state.error;
    if (poolError) throw poolError;
  } catch (error) {
    failure = error;
  } finally {
    // Roll back worker before guard; never pool failed cleanup state.
    for (const state of states.reverse()) {
      let cleanupError = state.error;
      if (state.begun) {
        try { await state.client.query({ text: 'ROLLBACK', query_timeout: 5000 }); }
        catch (error) { cleanupError ||= error; }
      }
      if (cleanupError) {
        if (failure && cleanupError !== failure) (failure.cleanupErrors ||= []).push(cleanupError);
        failure ||= cleanupError;
      }
      try { state.client.release(Boolean(cleanupError)); }
      catch (error) {
        if (failure) (failure.cleanupErrors ||= []).push(error);
        failure ||= error;
      } finally { state.client.removeListener('error', state.onError); }
    }
  }
  if (failure) throw failure;
  return value;
}

async function setOwnedPolicy(client, { maxRecords = 1, windowSeconds = 3 } = {}) {
  await query(client, 'SELECT public.upsert_settings_value_v1(' +
    "$1, public.get_root_scope_type_key_v1(), NULL, $2::jsonb, 1, 'Rollback-only R08 isolation fixture')",
  [CATEGORY, { enabled: true, max_records: maxRecords, window_seconds: windowSeconds, max_token_bytes: 4096 }]);
}
async function rejection(client, correlationId) {
  const result = await query(client,
    'SELECT public.record_webhook_token_rejection_bounded_v1($1::text, NULL, $2::uuid) AS result',
    ['r08-owned-' + correlationId, correlationId]);
  return result.rows[0].result;
}
async function policySnapshot(client) {
  const { rows } = await query(client,
    'SELECT public.resolve_settings($1, public.get_root_scope_type_key_v1(), NULL) AS value', [CATEGORY]);
  return rows[0].value;
}
async function assertRolledBack(correlations, originalPolicy) {
  const { rows } = await query(pool,
    'SELECT count(*)::int AS count FROM public.intake_auth_rejections WHERE correlation_id = ANY($1::uuid[])', [correlations]);
  expect(rows[0].count).toBe(0);
  expect(await policySnapshot(pool)).toEqual(originalPolicy);
}

describe('R08 rollback-only rejection logging concurrency and expiry', () => {
  beforeAll(() => {
    const connectionString = String(process.env.DATABASE_URL || '').trim();
    if (!connectionString) throw new Error('R08_DATABASE_REQUIRED: provide the admitted disposable DATABASE_URL; this suite cannot be skipped');
    pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000, statement_timeout: 5000 });
    pool.on('error', error => { poolError ||= error; });
  });
  afterAll(async () => { if (pool) await pool.end(); });

  test('READ COMMITTED returns budget_busy while the other connected session retains its lock', async () => {
    const correlationId = randomUUID();
    const originalPolicy = await policySnapshot(pool);
    await withRollbackClients(['READ COMMITTED', 'READ COMMITTED'], async ([guard, worker]) => {
      await setOwnedPolicy(worker);
      const { rows } = await query(guard,
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired, txid_current()::text AS transaction_id', [LOCK_KEY]);
      expect(rows[0].acquired).toBe(true); // Never wait for a foreign owner.
      const guardTransaction = rows[0].transaction_id;
      expect(await rejection(worker, correlationId)).toEqual({ status: 'suppressed', reason: 'budget_busy' });
      const held = await query(worker, 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', [LOCK_KEY]);
      expect(held.rows[0].acquired).toBe(false);
      const alive = await query(guard, 'SELECT txid_current()::text AS transaction_id');
      expect(alive.rows[0].transaction_id).toBe(guardTransaction);
      const recorded = await query(worker, 'SELECT count(*)::int AS count FROM public.intake_auth_rejections WHERE correlation_id=$1', [correlationId]);
      expect(recorded.rows[0].count).toBe(0);
    });
    await assertRolledBack([correlationId], originalPolicy);
  }, 45000);

  test('REPEATABLE READ returns snapshot_isolation without acquiring the logging lock or writing', async () => {
    const correlationId = randomUUID();
    const originalPolicy = await policySnapshot(pool);
    await withRollbackClients(['READ COMMITTED', 'REPEATABLE READ'], async ([observer, worker]) => {
      expect(await rejection(worker, correlationId)).toEqual({ status: 'suppressed', reason: 'snapshot_isolation' });
      const lock = await query(observer, 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', [LOCK_KEY]);
      expect(lock.rows[0].acquired).toBe(true);
      const recorded = await query(worker, 'SELECT count(*)::int AS count FROM public.intake_auth_rejections WHERE correlation_id=$1', [correlationId]);
      expect(recorded.rows[0].count).toBe(0);
    });
    await assertRolledBack([correlationId], originalPolicy);
  }, 45000);

  test('own uncommitted rejection exhausts the window, then DB-clock expiry admits a record without deletion', async () => {
    const occupiedId = randomUUID();
    const suppressedId = randomUUID();
    const admittedId = randomUUID();
    const originalPolicy = await policySnapshot(pool);
    await withRollbackClients(['READ COMMITTED', 'READ COMMITTED'], async ([observer, worker]) => {
      const windowSeconds = 3;
      await setOwnedPolicy(worker, { windowSeconds });
      const baseline = await query(worker, 'SELECT count(*)::int AS count FROM public.intake_auth_rejections ' +
        "WHERE service='webhook_receiver' AND occurred_at >= clock_timestamp()-make_interval(secs => $1::int)", [windowSeconds]);
      expect(baseline.rows[0].count).toBe(0); // Fail on foreign activity; never delete it.
      const { rows } = await query(worker, 'INSERT INTO public.intake_auth_rejections(' +
        'service, surface, credential_kind, failure_code, http_status, correlation_id) ' +
        "VALUES ('webhook_receiver','webhook_receiver','source_token','r08_owned_budget_fixture',401,$1::uuid) " +
        'RETURNING occurred_at::text AS occurred_at', [occupiedId]);
      const occupiedAt = rows[0].occurred_at; // Preserve database timestamp precision.
      expect(await rejection(worker, suppressedId)).toEqual({ status: 'suppressed', reason: 'budget_exhausted' });
      const invisible = await query(observer,
        'SELECT count(*)::int AS count FROM public.intake_auth_rejections WHERE correlation_id=$1', [occupiedId]);
      expect(invisible.rows[0].count).toBe(0);
      // Cross the real server clock boundary in the same uncommitted transaction.
      await query(worker, 'SELECT pg_sleep_until($1::timestamptz + make_interval(secs => $2::double precision))',
        [occupiedAt, windowSeconds + 0.05]);
      const expired = await query(worker,
        'SELECT clock_timestamp() > $1::timestamptz + make_interval(secs => $2::int) AS expired', [occupiedAt, windowSeconds]);
      expect(expired.rows[0].expired).toBe(true);
      expect(await rejection(worker, admittedId)).toMatchObject({ status: 'recorded', correlation_id: admittedId });
      const retained = await query(worker, 'SELECT correlation_id::text FROM public.intake_auth_rejections ' +
        'WHERE correlation_id = ANY($1::uuid[]) ORDER BY correlation_id::text', [[occupiedId, suppressedId, admittedId]]);
      expect(retained.rows.map(row => row.correlation_id)).toEqual([occupiedId, admittedId].sort());
    });
    await assertRolledBack([occupiedId, suppressedId, admittedId], originalPolicy);
  }, 45000);
});
