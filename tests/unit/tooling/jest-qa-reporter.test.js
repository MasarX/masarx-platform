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
    __emitPoolError: (error) => {
      if (typeof errorHandler === 'function') errorHandler(error);
    },
    __resetPoolMock: () => {
      errorHandler = null;
      query.mockReset();
      end.mockReset();
      on.mockClear();
    },
  };
});

jest.mock('../../../scripts/utils/load-env', () => ({
  loadEnv: jest.fn(),
}));

const path = require('path');
const QaReporter = require('../../../config/tooling/jest.qa.reporter');
const { __query, __end, __on, __emitPoolError, __resetPoolMock } = require('pg');

function makeTestResult() {
  const startedAt = Date.now();
  return {
    testFilePath: path.join(process.cwd(), 'tests', 'unit', 'sample.test.js'),
    perfStats: { start: startedAt, end: startedAt + 25 },
    testResults: [
      {
        fullName: 'sample suite records case',
        status: 'passed',
        duration: 25,
        title: 'records case',
        ancestorTitles: ['sample suite'],
        failureMessages: [],
      },
    ],
  };
}

describe('jest.qa.reporter', () => {
  beforeEach(() => {
    __resetPoolMock();
    process.env.QA_RUN_ID = 'run_123';
    process.env.DATABASE_URL = 'postgres://example';
    delete process.env.QA_SUITE_KEY;
  });

  afterEach(async () => {
    delete process.env.QA_RUN_ID;
    delete process.env.DATABASE_URL;
    delete process.env.QA_SUITE_KEY;
    jest.restoreAllMocks();
  });

  test('disables QA reporting on connectivity error without failing the suite', async () => {
    const reporter = new QaReporter();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    __query.mockRejectedValueOnce(new Error('Tenant or user not found'));

    await expect(reporter.onTestResult(null, makeTestResult())).resolves.toBeUndefined();

    expect(reporter.enabled).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Disabling QA result reporting'));

    await expect(reporter.onTestResult(null, makeTestResult())).resolves.toBeUndefined();
    expect(__query).toHaveBeenCalledTimes(1);

    await reporter.onRunComplete();
    expect(__end).toHaveBeenCalledTimes(1);
  });

  test('disables QA reporting on background pool error', async () => {
    const reporter = new QaReporter();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    reporter.getPool();
    expect(__on).toHaveBeenCalledWith('error', expect.any(Function));

    __emitPoolError(new Error('terminating connection due to administrator command'));

    await expect(reporter.onTestResult(null, makeTestResult())).resolves.toBeUndefined();
    expect(reporter.enabled).toBe(false);
    expect(__query).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Disabling QA result reporting'));
  });
});
