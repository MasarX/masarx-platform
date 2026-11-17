const { EventEmitter } = require('events');
const { runIsolatedScheduleWorker } = require('../../integration/helpers/isolated-schedule-worker');

const triggerId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
const snapshotId = '00000003-0000001B-1';
const workerSql = 'SELECT public.run_workflow_schedule_triggers_worker() AS payload';
const cadenceSql = 'SELECT worker_name FROM public.cron_config WHERE worker_name = $1 FOR UPDATE NOWAIT';
const foreignSql = 'SELECT id FROM public.workflow_schedule_triggers WHERE id <> $1::uuid FOR UPDATE NOWAIT';

function harness({ queryHook, connectFailureAt = -1 } = {}) {
  const events = [];
  const clients = ['guard', 'worker'].map((name) => {
    const client = new EventEmitter();
    client.query = jest.fn(async (query) => {
      events.push([name, query.text, query.values]);
      const override = await queryHook?.(name, query, clients);
      if (override !== undefined) return override;
      if (query.text === cadenceSql) {
        return { rows: [{ worker_name: 'workflow_schedule_triggers_worker' }] };
      }
      if (query.text.includes('pg_export_snapshot')) {
        return { rows: [{ snapshot_id: snapshotId }] };
      }
      return { rows: [{ payload: { status: 'completed', items_processed: 1 } }] };
    });
    client.release = jest.fn((destroy) => { events.push([name, 'release', destroy]); });
    return client;
  });
  const connectError = new Error('connection unavailable');
  let index = 0;
  const pool = { connect: jest.fn(async () => {
    const current = index++;
    if (current === connectFailureAt) throw connectError;
    return clients[current];
  }) };
  return { pool, clients, events, connectError };
}

function expectReleased(client, destroy = false) {
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(client.release).toHaveBeenCalledWith(destroy);
  expect(client.listenerCount('error')).toBe(0);
}

test('worker locks cadence before exporting the snapshot, guard imports before locking foreign schedules', async () => {
  const { pool, clients, events } = harness();
  await expect(runIsolatedScheduleWorker(pool, {
    triggerId, forceWorkerName: 'workflow_schedule_triggers_worker',
  })).resolves.toEqual({ status: 'completed', items_processed: 1 });
  const workerQueries = events.filter(([name, sql]) => name === 'worker' && sql !== 'release');
  expect(workerQueries.map(([, sql]) => sql)).toEqual([
    'BEGIN ISOLATION LEVEL REPEATABLE READ',
    "SET LOCAL statement_timeout = '30s'",
    "SET LOCAL lock_timeout = '3s'",
    "SET LOCAL idle_in_transaction_session_timeout = '90s'",
    cadenceSql,
    'SELECT pg_export_snapshot() AS snapshot_id',
    "SELECT set_config('app.force_worker', $1, true)",
    workerSql,
    'COMMIT',
  ]);
  expect(workerQueries[4][2]).toEqual(['workflow_schedule_triggers_worker']);
  expect(workerQueries[6][2]).toEqual(['workflow_schedule_triggers_worker']);
  expect(events).toContainEqual(['guard',
    'SELECT id FROM public.workflow_schedule_triggers WHERE id <> $1::uuid FOR UPDATE NOWAIT',
    [triggerId]]);
  const eventIndex = (name, sql) => events.findIndex((entry) => entry[0] === name && entry[1] === sql);
  expect(eventIndex('worker', cadenceSql)).toBeLessThan(eventIndex('worker', 'SELECT pg_export_snapshot() AS snapshot_id'));
  expect(eventIndex('worker', 'SELECT pg_export_snapshot() AS snapshot_id'))
    .toBeLessThan(eventIndex('guard', 'BEGIN ISOLATION LEVEL REPEATABLE READ'));
  const guardQueries = events.filter(([name, sql]) => name === 'guard' && sql !== 'release');
  expect(guardQueries.slice(0, 2).map(([, sql]) => sql)).toEqual([
    'BEGIN ISOLATION LEVEL REPEATABLE READ', `SET TRANSACTION SNAPSHOT '${snapshotId}'`,
  ]);
  expect(eventIndex('guard', 'SELECT id FROM public.workflow_schedule_triggers WHERE id <> $1::uuid FOR UPDATE NOWAIT'))
    .toBeLessThan(eventIndex('worker', workerSql));
  expect(eventIndex('worker', workerSql)).toBeLessThan(eventIndex('guard', 'SELECT 1'));
  expect(eventIndex('guard', 'SELECT 1')).toBeLessThan(eventIndex('worker', 'COMMIT'));
  expect(eventIndex('worker', 'COMMIT')).toBeLessThan(eventIndex('guard', 'ROLLBACK'));
  expect(events.some(([, sql]) => /^UPDATE|^DELETE|^INSERT/i.test(sql))).toBe(false);
  expect(clients[0].query.mock.calls.filter(([q]) => q.text === 'COMMIT')).toHaveLength(0);
  for (const client of clients) {
    expectReleased(client);
    for (const [query] of client.query.mock.calls) {
      expect(query.query_timeout).toBe(query.text === 'ROLLBACK' ? 5000 : 35000);
    }
  }
});

test.each([[], [{ worker_name: 'other' }],
  [{ worker_name: 'workflow_schedule_triggers_worker' }, { worker_name: 'workflow_schedule_triggers_worker' }]].map(rows => [rows]))(
  'rejects missing, foreign or ambiguous cadence identity: %j', async rows => {
    const { pool, clients, events } = harness({
      queryHook: (_name, query) => query.text === cadenceSql ? { rows } : undefined,
    });
    await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toThrow('cadence identity is invalid');
    expect(clients[0].query).not.toHaveBeenCalled();
    expect(events.some(([, sql]) => sql.includes('pg_export_snapshot') || sql === workerSql)).toBe(false);
    clients.forEach(client => expectReleased(client));
  },
);

test.each(['40001', '57014'])('cadence failure %s fails closed without retry', async code => {
  const failure = Object.assign(new Error('cadence conflict'), { code });
  const { pool, clients, events } = harness({
    queryHook: (_name, query) => { if (query.text === cadenceSql) throw failure; },
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  expect(events.filter(([, sql]) => sql === cadenceSql)).toHaveLength(1);
  expect(events).toContainEqual(['worker', 'ROLLBACK', undefined]);
  expect(clients[0].query).not.toHaveBeenCalled();
  clients.forEach(client => expectReleased(client));
});

test.each([cadenceSql, foreignSql])('returns isolation-busy only after complete lock-admission cleanup: %s', async sql => {
  const failure = Object.assign(new Error('lock unavailable'), { code: '55P03' });
  const { pool, clients, events } = harness({
    queryHook: (_name, query) => { if (query.text === sql) throw failure; },
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId }))
    .resolves.toEqual({ status: 'throttled', reason: 'isolation_busy' });
  expect(pool.connect).toHaveBeenCalledTimes(2);
  expect(events.filter(([, text]) => text === sql)).toHaveLength(1);
  expect(events.some(([, text]) => text === workerSql || text === 'COMMIT')).toBe(false);
  const begun = ['worker', 'guard'].filter(name =>
    events.some(([who, text]) => who === name && text.startsWith('BEGIN')));
  expect(events.filter(([, text]) => text === 'ROLLBACK').map(([who]) => who)).toEqual(begun);
  for (const name of begun) {
    expect(events.findIndex(([who, text]) => who === name && text === 'ROLLBACK'))
      .toBeLessThan(events.findIndex(([who, text]) => who === name && text === 'release'));
  }
  clients.forEach(client => expectReleased(client));
});

test.each([
  ['worker', workerSql], ['worker', 'COMMIT'],
  ['worker', 'SELECT pg_export_snapshot() AS snapshot_id'],
  ['guard', `SET TRANSACTION SNAPSHOT '${snapshotId}'`], ['guard', 'SELECT 1'],
])('does not turn another SQL lock error into admission retry: %s %s', async (name, sql) => {
  const failure = Object.assign(new Error('not an admission conflict'), { code: '55P03' });
  const { pool, clients } = harness({
    queryHook: (who, query) => { if (who === name && query.text === sql) throw failure; },
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  clients.forEach(client => expectReleased(client));
});

test.each(['worker', 'guard'])('an admission conflict with failed %s rollback stays fatal', async name => {
  const failure = Object.assign(new Error('lock unavailable'), { code: '55P03' });
  const cleanupFailure = new Error('rollback failed');
  const { pool, clients, events } = harness({
    queryHook: (who, query) => {
      if (query.text === foreignSql) throw failure;
      if (who === name && query.text === 'ROLLBACK') throw cleanupFailure;
    },
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  expect(failure.cleanupErrors).toContain(cleanupFailure);
  expect(events.some(([, text]) => text === workerSql)).toBe(false);
  expectReleased(clients[0], name === 'guard');
  expectReleased(clients[1], name === 'worker');
});

test('an admission conflict with failed release stays fatal and cleans the other connection', async () => {
  const failure = Object.assign(new Error('lock unavailable'), { code: '55P03' });
  const releaseFailure = new Error('release failed');
  const { pool, clients, events } = harness({
    queryHook: (_name, query) => { if (query.text === foreignSql) throw failure; },
  });
  clients[1].release.mockImplementation(() => { throw releaseFailure; });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  expect(failure.cleanupErrors).toContain(releaseFailure);
  expect(events.some(([, text]) => text === workerSql)).toBe(false);
  expectReleased(clients[0]);
  expect(clients[1].listenerCount('error')).toBe(0);
});

test.each(['worker', 'guard'])('a %s disconnect during admission rollback stays fatal', async name => {
  const failure = Object.assign(new Error('lock unavailable'), { code: '55P03' });
  const cleanupFailure = new Error('connection terminated during rollback');
  const { pool, clients } = harness({
    queryHook: (who, query, ownedClients) => {
      if (query.text === foreignSql) throw failure;
      if (who === name && query.text === 'ROLLBACK') {
        ownedClients[name === 'guard' ? 0 : 1].emit('error', cleanupFailure);
      }
    },
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  expect(failure.cleanupErrors).toContain(cleanupFailure);
  expectReleased(clients[0], name === 'guard');
  expectReleased(clients[1], name === 'worker');
});

test('a disconnect during admission release cannot grant a retry', async () => {
  const failure = Object.assign(new Error('lock unavailable'), { code: '55P03' });
  const { pool, clients } = harness({
    queryHook: (_name, query) => { if (query.text === foreignSql) throw failure; },
  });
  clients[1].release.mockImplementation(() => {
    clients[1].emit('error', new Error('connection terminated during release'));
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  expectReleased(clients[0]);
  expect(clients[1].release).toHaveBeenCalledTimes(1);
  expect(clients[1].listenerCount('error')).toBe(0);
});

test.each([null, '', undefined])('requires a target before acquiring clients: %s', async (id) => {
  const { pool } = harness();
  await expect(runIsolatedScheduleWorker(pool, { triggerId: id })).rejects.toThrow('identity is required');
  expect(pool.connect).not.toHaveBeenCalled();
});

test.each([0, 1])('releases only acquired clients when acquisition %i fails', async (connectFailureAt) => {
  const { pool, clients, connectError } = harness({ connectFailureAt });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(connectError);
  if (connectFailureAt === 1) expectReleased(clients[0]);
  else expect(clients[0].release).not.toHaveBeenCalled();
  expect(clients[1].release).not.toHaveBeenCalled();
  expect(clients[0].query).not.toHaveBeenCalled();
});

test.each([[], [{ snapshot_id: '' }], [{ snapshot_id: "x'; COMMIT; --" }],
  [{ snapshot_id: snapshotId }, { snapshot_id: snapshotId }]].map((rows) => [rows]))(
  'rejects missing, malformed or ambiguous snapshot readback: %j', async (rows) => {
    const { pool, clients } = harness({
      queryHook: (_name, query) => query.text.includes('pg_export_snapshot') ? { rows } : undefined,
    });
    await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toThrow('snapshot identity is invalid');
    expect(clients[0].query).not.toHaveBeenCalled();
    clients.forEach((client) => expectReleased(client));
  },
);

test.each([
  ['guard', 'BEGIN ISOLATION LEVEL REPEATABLE READ'],
  ['guard', "SET LOCAL statement_timeout = '30s'"],
  ['guard', 'SELECT id FROM public.workflow_schedule_triggers WHERE id <> $1::uuid FOR UPDATE NOWAIT'],
  ['worker', cadenceSql],
  ['worker', 'SELECT pg_export_snapshot() AS snapshot_id'],
  ['worker', 'BEGIN ISOLATION LEVEL REPEATABLE READ'],
  ['guard', `SET TRANSACTION SNAPSHOT '${snapshotId}'`],
  ['worker', "SET LOCAL lock_timeout = '3s'"],
  ['worker', workerSql],
  ['guard', 'SELECT 1'],
  ['worker', 'COMMIT'],
])('rolls back and releases on %s query failure: %s', async (name, sql) => {
  const failure = Object.assign(new Error('query cancelled'), { code: '57014' });
  const { pool, clients, events } = harness({
    queryHook: (actualName, query) => {
      if (actualName === name && query.text === sql) throw failure;
    },
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  const started = ['worker', 'guard'].filter(name =>
    events.some(([who, text]) => who === name && text.startsWith('BEGIN')));
  const rollbackOrder = events.filter(([, text]) => text === 'ROLLBACK').map(([who]) => who);
  expect(rollbackOrder).toEqual(started);
  clients.forEach((client) => expectReleased(client));
});

test('guard disconnect during worker execution prevents commit and destroys that connection', async () => {
  const failure = new Error('guard connection terminated');
  const { pool, clients, events } = harness({
    queryHook: (name, query, ownedClients) => {
      if (name === 'worker' && query.text === workerSql) ownedClients[0].emit('error', failure);
    },
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  expect(events.some(([name, text]) => name === 'worker' && text === 'COMMIT')).toBe(false);
  expectReleased(clients[0], true);
  expectReleased(clients[1]);
});

test('worker disconnect after execution prevents commit and destroys that connection', async () => {
  const failure = new Error('worker connection terminated');
  const { pool, clients, events } = harness({
    queryHook: (name, query, ownedClients) => {
      if (name === 'guard' && query.text === 'SELECT 1') ownedClients[1].emit('error', failure);
    },
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  expect(events.some(([name, text]) => name === 'worker' && text === 'COMMIT')).toBe(false);
  expectReleased(clients[0]);
  expectReleased(clients[1], true);
});

test('rollback failure preserves cancellation, destroys the worker and still releases its guard', async () => {
  const failure = new Error('worker cancelled');
  const cleanupFailure = new Error('rollback timed out');
  const { pool, clients, events } = harness({
    queryHook: (name, query) => {
      if (name === 'worker' && query.text === workerSql) throw failure;
      if (name === 'worker' && query.text === 'ROLLBACK') throw cleanupFailure;
    },
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  expect(failure.cleanupErrors).toContain(cleanupFailure);
  expectReleased(clients[1], true);
  expectReleased(clients[0]);
  expect(events.findIndex(([who, sql]) => who === 'worker' && sql === 'release'))
    .toBeLessThan(events.findIndex(([who, sql]) => who === 'guard' && sql === 'ROLLBACK'));
});

test('reports guard cleanup failure even after a successful worker commit', async () => {
  const failure = new Error('guard rollback timed out');
  const { pool, clients } = harness({
    queryHook: (name, query) => { if (name === 'guard' && query.text === 'ROLLBACK') throw failure; },
  });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  expectReleased(clients[0], true);
  expectReleased(clients[1]);
});

test('a release error does not skip the other client cleanup or replace the primary error', async () => {
  const failure = new Error('worker failed');
  const releaseFailure = new Error('release failed');
  const { pool, clients } = harness({
    queryHook: (name, query) => { if (name === 'worker' && query.text === workerSql) throw failure; },
  });
  clients[1].release.mockImplementation(() => { throw releaseFailure; });
  await expect(runIsolatedScheduleWorker(pool, { triggerId })).rejects.toBe(failure);
  expect(failure.cleanupErrors).toContain(releaseFailure);
  expectReleased(clients[0]);
  expect(clients[1].listenerCount('error')).toBe(0);
});
