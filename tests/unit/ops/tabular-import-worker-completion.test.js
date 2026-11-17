const fs = jest.requireActual('node:fs');
const path = jest.requireActual('node:path');
const vm = jest.requireActual('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../../scripts/workers/tabular-import-worker.js'), 'utf8');
const terminal = ['completed', 'completed_with_errors', 'failed'];
const errorRows = (run) => run.rows.filter((row) => ['skip', 'block', 'failed'].includes(row.action)
  || ['skipped', 'blocked', 'failed'].includes(row.execution_status));

function makeRun(id, count, skipped = 0) {
  return {
    id, organization_id: 'organization', resource_key: 'recipients', task_id: `task-${id}`,
    status: 'queued', task_status: 'open', total_rows: count + skipped,
    created_count: 0, updated_count: 0, failed_count: 0, blocked_count: 0, skipped_count: skipped,
    summary: { headers: ['External ID'] },
    rows: Array.from({ length: count + skipped }, (_, index) => ({
      row_number: index + 1, action: index < count ? 'create' : 'skip',
      execution_status: index < count ? 'queued' : 'skipped',
      original_row: { 'External ID': `record-${index}` },
      reason_codes: index < count ? [] : ['existing_record'],
      reason_messages: index < count ? [] : ['Record already exists.'],
    })),
  };
}

function harness(runs, once = true) {
  const locks = new Set();
  const events = [];
  const state = { runs, noProgress: false, cancel: false, processError: false, uploadError: false };
  const snapshot = (run) => ({ ...run, rows: run.rows.slice(0, 25).map((row) => ({ ...row })) });
  const rpc = jest.fn(async (name, args) => {
    events.push(name);
    if (name === 'register_artifact_v1') return { data: { artifact_id: 'error-artifact' }, error: null };
    if (name === 'ui_create_mapping_operation_report_v1') return { data: { id: 'fallback-report' }, error: null };
    if (name === 'claim_next_tabular_import_task_v1') {
      const run = runs.find((item) => ['open', 'queued'].includes(item.task_status) && ['queued', 'processing'].includes(item.status));
      if (!run) return { data: null, error: null };
      run.task_status = 'in_progress';
      run.status = 'processing';
      return { data: { run_id: run.id, task_id: run.task_id }, error: null };
    }
    if (name !== 'process_tabular_import_run_v1') throw new Error(`Unexpected RPC ${name}`);
    if (state.processError) return { data: null, error: { message: 'Processor unavailable' } };
    const run = runs.find((item) => item.id === args.p_run_id);
    if (state.cancel) {
      run.status = 'canceled';
      run.task_status = 'canceled';
      run.rows.filter((row) => row.execution_status === 'queued').forEach((row) => { row.execution_status = 'canceled'; });
    } else if (!state.noProgress && !terminal.includes(run.status)) {
      run.rows.filter((row) => row.action === 'create' && row.execution_status === 'queued')
        .slice(0, args.p_batch_size || 200).forEach((row) => { row.execution_status = 'succeeded'; });
      run.created_count = run.rows.filter((row) => row.execution_status === 'succeeded').length;
      run.status = run.rows.some((row) => row.execution_status === 'queued')
        ? 'processing' : run.skipped_count ? 'completed_with_errors' : 'completed';
      if (terminal.includes(run.status)) {
        run.task_status = 'completed';
        run.report_id = `report-${run.id}`;
      }
    }
    return { data: snapshot(run), error: null };
  });
  const upload = jest.fn(async () => ({ error: state.uploadError ? { message: 'Upload unavailable' } : null }));
  const links = [];
  const queries = [];
  function pgClient() {
    let locked;
    return {
      connect: jest.fn(), end: jest.fn(),
      query: jest.fn(async (sql, values = []) => {
        queries.push({ sql, values });
        if (sql === 'BEGIN' || sql.includes('select set_config')) return { rows: [] };
        if (sql === 'COMMIT' || sql === 'ROLLBACK') { locks.delete(locked); locked = null; return { rows: [] }; }
        if (sql.includes('select r.*')) {
          expect(sql).toContain('for update of r skip locked');
          expect(sql).toContain('limit 1');
          const run = runs.find((item) => !locks.has(item.id) && terminal.includes(item.status)
            && (values[0] ? item.id === values[0] : !item.error_artifact_id && errorRows(item).length));
          if (!run) return { rows: [] };
          locked = run.id;
          locks.add(locked);
          return { rows: [{ ...run }] };
        }
        if (sql.includes('select row_number')) return { rows: errorRows(runs.find((run) => run.id === values[0])) };
        if (sql.includes('tabular_import_execution_next_steps_v1')) return { rows: [{ next_steps: values[2] || values[3] || values[4] ? ['Download the annotated error export.'] : [] }] };
        if (sql.includes('insert into public.artifact_links')) { links.push(values); return { rows: [] }; }
        if (sql.includes('update public.mapping_operation_reports')) return { rows: [] };
        if (sql.includes('update public.tabular_import_runs')) {
          const run = runs.find((item) => item.id === values[0]);
          run.report_id = values[1] || run.report_id;
          run.error_artifact_id = values[2] || run.error_artifact_id;
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL ${sql}`);
      }),
    };
  }
  const trace = jest.fn();
  const worker = vm.runInNewContext(`${source.slice(0, source.indexOf('\nmain().catch'))}\n({ main, processClaim, finalizeRun });`, {
    require: (name) => {
      if (name === 'pg') return { Client: function () { return pgClient(); } };
      if (name === '@supabase/supabase-js') return { createClient: () => ({ rpc, storage: { from: () => ({ upload }) } }) };
      if (name === '../utils/load-env') return { loadEnv() {} };
      if (name === '../utils/trace-context') return { resolveExecutionContext: () => ({ correlationId: 'correlation' }), buildTraceHeaders: () => ({}), emitTraceWithContext: trace };
      throw new Error(`Unexpected dependency ${name}`);
    },
    process: { env: { SUPABASE_URL: 'https://example.test', SUPABASE_SECRET_KEY: 'synthetic', DATABASE_URL: 'synthetic' }, argv: ['node', 'worker', ...(once ? ['--once'] : [])], pid: 1 },
    Buffer, console, setTimeout,
  });
  return { worker, state, rpc, upload, links, queries, events, trace, pgClient };
}

test('one owned claim drains 501 rows across canonical snapshots without a remaining property', async () => {
  const run = makeRun('large', 501);
  const h = harness([run]);
  const kickoff = await h.rpc('process_tabular_import_run_v1', { p_run_id: run.id, p_batch_size: 100 });
  expect(kickoff.data).not.toHaveProperty('remaining');
  expect(run.created_count).toBe(100);
  await h.worker.main();
  expect(run.created_count).toBe(501);
  expect(run.rows.every((row) => row.execution_status === 'succeeded')).toBe(true);
  expect(run.status).toBe('completed');
  expect(run.task_status).toBe('completed');
  expect(h.rpc.mock.calls.filter(([name]) => name === 'process_tabular_import_run_v1')).toHaveLength(4);
  expect(h.rpc.mock.calls.filter(([name]) => name === 'claim_next_tabular_import_task_v1')).toHaveLength(1);
});

test('a small skipped-row kickoff gets its export on the idle path without processing again', async () => {
  const run = makeRun('small', 1, 1);
  const h = harness([run]);
  await h.rpc('process_tabular_import_run_v1', { p_run_id: run.id, p_batch_size: 100 });
  expect(run.status).toBe('completed_with_errors');
  const reportId = run.report_id;
  await h.worker.main();
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(h.upload.mock.calls[0][1].toString()).toContain('record-1,2,skipped,existing_record,Record already exists.');
  expect(h.links).toEqual([['organization', 'error-artifact', run.id, expect.any(String)]]);
  expect(run.error_artifact_id).toBe('error-artifact');
  expect(run.report_id).toBe(reportId);
  expect(h.rpc.mock.calls.filter(([name]) => name === 'process_tabular_import_run_v1')).toHaveLength(1);
  await h.worker.main();
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(h.links).toHaveLength(1);
});

test('concurrent and repeated finalizers upload and link one export after rechecking the locked run', async () => {
  const run = makeRun('race', 0, 1);
  const h = harness([run]);
  await h.rpc('process_tabular_import_run_v1', { p_run_id: run.id, p_batch_size: 100 });
  const results = await Promise.all([
    h.worker.finalizeRun({ runId: run.id, pgClient: h.pgClient() }),
    h.worker.finalizeRun({ runId: run.id, pgClient: h.pgClient() }),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await h.worker.finalizeRun({ runId: run.id, pgClient: h.pgClient() });
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(h.links).toHaveLength(1);
});

test('queued work takes priority and an idle once invocation finalizes at most one terminal run', async () => {
  const first = makeRun('first', 0, 1);
  const second = makeRun('second', 0, 1);
  const queued = makeRun('queued', 1);
  const h = harness([first, second, queued]);
  for (const run of [first, second]) await h.rpc('process_tabular_import_run_v1', { p_run_id: run.id, p_batch_size: 100 });
  await h.worker.main();
  expect(queued.status).toBe('completed');
  expect(h.upload).not.toHaveBeenCalled();
  await h.worker.main();
  expect(first.error_artifact_id).toBe('error-artifact');
  expect(second.error_artifact_id).toBeUndefined();
  expect(h.upload).toHaveBeenCalledTimes(1);
});

test('cancellation stops the owned loop without finalizer mutations', async () => {
  const run = makeRun('canceled', 501);
  const h = harness([run]);
  const invoke = h.rpc.getMockImplementation();
  let batches = 0;
  h.rpc.mockImplementation((name, args) => {
    if (name === 'process_tabular_import_run_v1' && ++batches === 2) h.state.cancel = true;
    return invoke(name, args);
  });
  await h.worker.main();
  expect(run.status).toBe('canceled');
  expect(run.created_count).toBe(200);
  expect(h.rpc.mock.calls.filter(([name]) => name === 'process_tabular_import_run_v1')).toHaveLength(2);
  expect(h.upload).not.toHaveBeenCalled();
  expect(h.queries.some(({ sql }) => sql.includes('update public.'))).toBe(false);
});

test.each(['noProgress', 'processError'])('%s exits without a busy loop or an incomplete report', async (failure) => {
  const run = makeRun('stalled', 501);
  const h = harness([run]);
  h.state[failure] = true;
  await h.worker.main();
  expect(h.rpc.mock.calls.filter(([name]) => name === 'process_tabular_import_run_v1')).toHaveLength(failure === 'noProgress' ? 2 : 1);
  expect(run.task_status).toBe('in_progress');
  expect(run.report_id).toBeUndefined();
  expect(h.trace).toHaveBeenCalledWith(expect.anything(), 'error', expect.objectContaining({ event: 'tabular_import.failed' }));
});

test('failed finalization rolls back its lock and can be retried without a duplicate link', async () => {
  const run = makeRun('retry', 0, 1);
  const h = harness([run]);
  await h.rpc('process_tabular_import_run_v1', { p_run_id: run.id, p_batch_size: 100 });
  h.state.uploadError = true;
  await expect(h.worker.finalizeRun({ runId: run.id, pgClient: h.pgClient() })).rejects.toThrow('Upload unavailable');
  expect(h.queries.at(-1).sql).toBe('ROLLBACK');
  h.state.uploadError = false;
  await h.worker.finalizeRun({ runId: run.id, pgClient: h.pgClient() });
  expect(h.links).toHaveLength(1);
});

test('idle daemon logs an export failure, waits one poll, and retries without exiting', async () => {
  jest.useFakeTimers();
  try {
    const run = makeRun('idle-retry', 0, 1);
    const h = harness([run], false);
    await h.rpc('process_tabular_import_run_v1', { p_run_id: run.id, p_batch_size: 100 });
    h.state.uploadError = true;
    const failed = new Promise((resolve) => h.trace.mockImplementation((_ctx, _level, event) => {
      if (event.event === 'tabular_import.finalize_failed') resolve();
    }));
    const shutdown = new Error('Test shutdown after successful retry');
    const invoke = h.rpc.getMockImplementation();
    h.rpc.mockImplementation((name, args) => {
      if (name === 'claim_next_tabular_import_task_v1' && run.error_artifact_id) throw shutdown;
      return invoke(name, args);
    });
    let settled = false;
    const running = h.worker.main();
    running.then(() => { settled = true; }, () => { settled = true; });
    await failed;
    expect(settled).toBe(false);
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.links).toHaveLength(0);
    expect(h.queries.at(-1).sql).toBe('ROLLBACK');
    expect(jest.getTimerCount()).toBe(1);

    h.state.uploadError = false;
    const stopped = expect(running).rejects.toBe(shutdown);
    await jest.advanceTimersByTimeAsync(2999);
    expect(h.upload).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await stopped;
    expect(h.upload).toHaveBeenCalledTimes(2);
    expect(h.links).toHaveLength(1);
    expect(run.error_artifact_id).toBe('error-artifact');
    expect(h.trace).toHaveBeenCalledWith(expect.anything(), 'error', expect.objectContaining({
      event: 'tabular_import.finalize_failed', error_message: 'Upload unavailable',
    }));
  } finally {
    jest.useRealTimers();
  }
});

test('idle once logs an export failure and returns after its single bounded attempt', async () => {
  const run = makeRun('idle-once', 0, 1);
  const h = harness([run]);
  await h.rpc('process_tabular_import_run_v1', { p_run_id: run.id, p_batch_size: 100 });
  h.state.uploadError = true;
  await expect(h.worker.main()).resolves.toBeUndefined();
  expect(h.upload).toHaveBeenCalledTimes(1);
  expect(h.links).toHaveLength(0);
  expect(h.trace).toHaveBeenCalledWith(expect.anything(), 'error', expect.objectContaining({ event: 'tabular_import.finalize_failed' }));
});
