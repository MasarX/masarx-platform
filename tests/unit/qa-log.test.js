jest.mock('pg', () => {
  const query = jest.fn();
  const end = jest.fn();
  const on = jest.fn();
  let errorHandler = null;
  on.mockImplementation((event, handler) => {
    if (event === 'error') errorHandler = handler;
  });
  const Pool = jest.fn(() => ({ query, end, on }));
  return {
    Pool,
    __query: query,
    __end: end,
    __on: on,
    __emitPoolError: (err) => {
      if (typeof errorHandler === 'function') errorHandler(err);
    },
    __resetPoolMock: () => {
      errorHandler = null;
      on.mockClear();
      query.mockReset();
      end.mockReset();
    },
  };
});

const { buildQaRunMetadata, createQaLogger } = require('../../scripts/qa/qa-log');
const { __query, __end, __on, __emitPoolError, __resetPoolMock } = require('pg');

describe('qa-log utilities', () => {
  beforeEach(() => {
    __resetPoolMock();
  });

  test('buildQaRunMetadata returns required fields', () => {
    const meta = buildQaRunMetadata();
    expect(meta).toHaveProperty('ciProvider');
    expect(meta).toHaveProperty('metadata');
    expect(meta.metadata).toHaveProperty('node');
  });

  test('createQaLogger disabled returns no-op behavior', async () => {
    const qa = createQaLogger({ disabled: true });
    const runId = await qa.startRun('test-run', {});
    expect(runId).toBeNull();
    await qa.finishRun('passed', {});
    const stepId = await qa.startStep('step', {});
    expect(stepId).toBeNull();
    const inserted = await qa.recordCaseResults('suite', [{ case_key: 'case', status: 'passed' }]);
    expect(inserted).toBe(0);
    await qa.close();
  });

  test('createQaLogger disables on missing qa schema', async () => {
    const err = new Error('schema "qa" does not exist');
    err.code = '3F000';
    __query.mockRejectedValueOnce(err);
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://example';
    const qa = createQaLogger();
    const runId = await qa.startRun('test-run', {});
    expect(runId).toBeNull();
    await qa.finishRun('passed', {});
    expect(__query).toHaveBeenCalledTimes(1);
    await qa.close();
    process.env.DATABASE_URL = previous;
  });

  test('createQaLogger disables on connectivity error after run start', async () => {
    __query
      .mockResolvedValueOnce({ rows: [{ run_id: 'run_123' }] })
      .mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND aws-1-eu-north-1.pooler.supabase.com'), { code: 'ENOTFOUND' }));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://example';
    const qa = createQaLogger();
    const runId = await qa.startRun('test-run', {});
    expect(runId).toBe('run_123');
    await expect(qa.finishRun('failed', {}, 'network')).resolves.toBeUndefined();
    expect(__query).toHaveBeenCalledTimes(2);
    await qa.close();
    process.env.DATABASE_URL = previous;
  });

  test('createQaLogger disables on background pool termination error', async () => {
    __query.mockResolvedValueOnce({ rows: [{ run_id: 'run_123' }] });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://example';
    const qa = createQaLogger();
    expect(__on).toHaveBeenCalledWith('error', expect.any(Function));
    const runId = await qa.startRun('test-run', {});
    expect(runId).toBe('run_123');
    __emitPoolError(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }));
    await expect(qa.finishRun('failed', {}, 'network')).resolves.toBeUndefined();
    expect(__query).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('QA pool background error; disabling QA logging for this run'));
    await qa.close();
    process.env.DATABASE_URL = previous;
    warnSpy.mockRestore();
  });
});
