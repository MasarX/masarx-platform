// Test-only: isolate the real SKIP LOCKED worker without changing foreign schedules.
async function runIsolatedScheduleWorker(pool, { triggerId, forceWorkerName = null } = {}) {
  if (typeof triggerId !== 'string' || !triggerId.trim()) {
    throw new Error('an isolated schedule trigger identity is required');
  }

  const states = [];
  let failure;
  let payload;
  let acquiringLock = false;
  let isolationBusy = false;
  const query = (state, text, values) => state.client.query({
    text, values, query_timeout: 35000,
  });

  try {
    // Acquire both clients before holding locks; the caller's pool has a bounded connect timeout.
    for (let index = 0; index < 2; index += 1) {
      const client = await pool.connect();
      const state = { client, begun: false, error: null };
      state.onError = (error) => { state.error ||= error; };
      client.on('error', state.onError);
      states.push(state);
    }
    const [guard, worker] = states;
    worker.begun = true;
    await query(worker, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
    await query(worker, "SET LOCAL statement_timeout = '30s'");
    await query(worker, "SET LOCAL lock_timeout = '3s'");
    await query(worker, "SET LOCAL idle_in_transaction_session_timeout = '90s'");
    // The worker must own its cadence lock before exporting its stable snapshot.
    const workerName = 'workflow_schedule_triggers_worker';
    acquiringLock = true;
    const cadence = await query(worker,
      'SELECT worker_name FROM public.cron_config WHERE worker_name = $1 FOR UPDATE NOWAIT',
      [workerName]);
    acquiringLock = false;
    if (cadence.rows?.length !== 1 || cadence.rows[0]?.worker_name !== workerName) {
      throw new Error('schedule worker cadence identity is invalid');
    }
    const { rows } = await query(worker, 'SELECT pg_export_snapshot() AS snapshot_id');
    const snapshotId = rows?.length === 1 ? rows[0]?.snapshot_id : null;
    if (typeof snapshotId !== 'string' || !/^[0-9a-f]+-[0-9a-f]+-[0-9]+$/i.test(snapshotId)) {
      throw new Error('schedule isolation snapshot identity is invalid');
    }

    guard.begun = true;
    await query(guard, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
    // PostgreSQL requires import before the first query in the importing transaction.
    await query(guard, `SET TRANSACTION SNAPSHOT '${snapshotId}'`);
    await query(guard, "SET LOCAL statement_timeout = '30s'");
    await query(guard, "SET LOCAL lock_timeout = '3s'");
    await query(guard, "SET LOCAL idle_in_transaction_session_timeout = '90s'");
    // Include disabled/future rows too; the shared snapshot excludes later inserts.
    acquiringLock = true;
    await query(guard,
      'SELECT id FROM public.workflow_schedule_triggers WHERE id <> $1::uuid FOR UPDATE NOWAIT',
      [triggerId]);
    acquiringLock = false;
    if (forceWorkerName) {
      await query(worker, "SELECT set_config('app.force_worker', $1, true)", [forceWorkerName]);
    }
    const result = await query(worker,
      'SELECT public.run_workflow_schedule_triggers_worker() AS payload');
    // Lost guard locks could have admitted foreign rows during the worker statement.
    // Prove the same guard survived before committing any of that statement's writes.
    if (guard.error) throw guard.error;
    await query(guard, 'SELECT 1');
    if (guard.error) throw guard.error;
    if (worker.error) throw worker.error;
    await query(worker, 'COMMIT');
    worker.begun = false;
    payload = result.rows[0]?.payload ?? {};
  } catch (error) {
    failure = error;
    isolationBusy = acquiringLock && error?.code === '55P03';
  } finally {
    // Roll back the worker before releasing its guard; never pool a failed cleanup connection.
    for (const state of states.reverse()) {
      let cleanupError = state.error;
      if (state.begun) {
        try {
          await state.client.query({ text: 'ROLLBACK', query_timeout: 5000 });
        } catch (error) {
          cleanupError ||= error;
        }
      }
      cleanupError ||= state.error;
      if (cleanupError) {
        isolationBusy = false;
        if (failure && cleanupError !== failure) {
          (failure.cleanupErrors ||= []).push(cleanupError);
        }
        failure ||= cleanupError;
      }
      try {
        state.client.release(Boolean(cleanupError));
      } catch (error) {
        isolationBusy = false;
        if (failure) (failure.cleanupErrors ||= []).push(error);
        failure ||= error;
      } finally {
        state.client.removeListener('error', state.onError);
      }
    }
  }
  // Let the caller's bounded admission loop reacquire both clients and a fresh snapshot.
  // Never retry a dispatched worker, another SQL failure, or incomplete cleanup.
  if (isolationBusy && states.every(state => !state.error)) {
    return { status: 'throttled', reason: 'isolation_busy' };
  }
  if (failure) throw failure;
  return payload;
}

module.exports = { runIsolatedScheduleWorker };
