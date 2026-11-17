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
const { createRuntimeOutputRedactor } = require('../../../scripts/ops/workspace/docker-runtime/redaction');
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
    delete process.env.MASARX_JEST_CASE_EVIDENCE;
  });

  afterEach(async () => {
    delete process.env.QA_RUN_ID;
    delete process.env.DATABASE_URL;
    delete process.env.QA_SUITE_KEY;
    jest.restoreAllMocks();
    delete process.env.MASARX_JEST_CASE_EVIDENCE;
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

  test('retains oversized aggregate case accounting through the unchanged bounded redactor', async () => {
    process.env.MASARX_JEST_CASE_EVIDENCE = '1';
    delete process.env.QA_RUN_ID;
    const suite = makeTestResult();
    suite.testResults = Array.from({ length: 1000 }, (_, index) => ({
      ...suite.testResults[0], fullName: `case ${index}`, status: index % 2 ? 'passed' : 'pending',
      failureMessages: ['private failure body'.repeat(100)],
    }));
    const results = { testResults: [suite] };
    expect(JSON.stringify(results).length).toBeGreaterThan(65536);
    let output = '';
    const redactor = createRuntimeOutputRedactor({ onText: (text) => { output += text; } });
    jest.spyOn(process.stdout, 'write').mockImplementation((text) => { redactor.write(text); return true; });
    await new QaReporter().onRunComplete(null, results);
    redactor.flush();
    const records = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(1000);
    expect(records.filter((record) => record.status === 'pending')).toHaveLength(500);
    expect(records[999].fullName).toBe('case 999');
    expect(output).not.toContain('private failure body');
    expect(__query).not.toHaveBeenCalled();
  });

  test('redacts case identities before serialization and leaves oversized individual lines fail-closed', async () => {
    process.env.MASARX_JEST_CASE_EVIDENCE = '1';
    const suite = makeTestResult();
    suite.testResults = [
      { ...suite.testResults[0], fullName: 'case sb_secret_privatevalue', status: 'failed' },
      { ...suite.testResults[0], fullName: 'x'.repeat(70000) },
    ];
    let output = '';
    const redactor = createRuntimeOutputRedactor({ onText: (text) => { output += text; } });
    jest.spyOn(process.stdout, 'write').mockImplementation((text) => { redactor.write(text); return true; });
    await new QaReporter().onRunComplete(null, { testResults: [suite] });
    redactor.flush();
    expect(output).not.toContain('privatevalue');
    expect(JSON.parse(output.split('\n')[0])).toMatchObject({ status: 'failed', fullName: '[redacted-case-identity]' });
    expect(output).toContain('[redacted-oversized-runtime-output-line]');
  });

  test('empty JWT markers cannot consume serialized result fields during redaction', async () => {
    process.env.MASARX_JEST_CASE_EVIDENCE = '1';
    const suite = makeTestResult();
    const names = ['bootstrap passes optional marketing read JWT without requiring or replacing it: ', 'plain case', 'password=private-value'];
    suite.testResults = names.map((fullName, index) => ({
      ...suite.testResults[0], fullName, status: index === 0 ? 'failed' : 'passed', duration: 7,
    }));
    let output = '';
    const redactor = createRuntimeOutputRedactor({ onText: text => { output += text; } });
    jest.spyOn(process.stdout, 'write').mockImplementation(text => { redactor.write(text); return true; });
    await new QaReporter().onRunComplete(null, { testResults: [suite] });
    redactor.flush();
    const records = output.trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ fullName: '[redacted-case-identity]', status: 'failed', duration_ms: 7 });
    expect(records[0].case_id).toBe(require('crypto').createHash('sha256')
      .update(JSON.stringify(['tests/unit/sample.test.js', names[0]])).digest('hex'));
    expect(records[1].fullName).toBe('plain case');
    expect(records[2].fullName).toBe('[redacted-case-identity]');
    expect(new Set(records.map(row => row.case_id)).size).toBe(3);
    for (const row of records) expect(row.case_id).toMatch(/^[a-f0-9]{64}$/);
    expect(output).not.toContain('private-value');
  });

  test('cookie and password identities remain valid distinct stable records after recorder redaction', async () => {
    process.env.MASARX_JEST_CASE_EVIDENCE = '1';
    const suite = makeTestResult();
    const names = ['cookie: session=private-one', 'cookie: session=private-two', 'password=private-three'];
    suite.testResults = names.map(fullName => ({ ...suite.testResults[0], fullName }));
    let output = '';
    const redactor = createRuntimeOutputRedactor({ onText: text => { output += text; } });
    jest.spyOn(process.stdout, 'write').mockImplementation(text => { redactor.write(text); return true; });
    const reporter = new QaReporter();
    await reporter.onRunComplete(null, { testResults: [suite] });
    await reporter.onRunComplete(null, { testResults: [suite] });
    redactor.flush();
    const records = output.trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(6);
    expect(new Set(records.slice(0, 3).map(row => row.case_id)).size).toBe(3);
    expect(records.slice(0, 3)).toEqual(records.slice(3));
    for (const row of records) {
      expect(row.fullName).toBe('[redacted-case-identity]');
      expect(row.status).toBe('passed');
      expect(row.case_id).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const name of names) expect(output).not.toContain(name);
    expect(output).not.toContain('private-');
  });

});
