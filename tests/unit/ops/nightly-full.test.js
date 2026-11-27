'use strict';
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cli, issueForDay, publish, safeLabel, screenIssue } = require('../../../scripts/ci/nightly-report.cjs');
const { configuredExclusions, failedTests, readSuiteReport, validResult, writeResult } = require('../../../scripts/ci/nightly-result.cjs');
const { checkInventory, coverageGaps } = require('../../../scripts/ci/nightly-coverage.cjs');
const { assertPublishedPorts, assertFreshMain, stackEnvironment } = require('../../../scripts/ci/nightly-local.cjs');

const day = '2026-01-01';
const started = day + 'T00:30:00.000Z';
const finished = day + 'T01:00:00.000Z';
const now = new Date(day + 'T06:00:00.000Z');
const sha = 'a'.repeat(40);
const opts = { sha, started, finished };
const failedSuite = { name: 'Jest unit', status: 'red', failed_tests: ['handles empty input'] };
const greenSuite = { name: 'Jest unit', status: 'green', failed_tests: [] };
const exclusion = { name: 'Live provider tests', status: 'out-of-scope', reason: 'Real credentials', covered_by: 'Opt in' };
let root;
let daily;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-suite-test-'));
  daily = path.join(root, day);
  fs.mkdirSync(daily);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('nightly results preserve the valid result shape and explicit exclusions without turning green red', () => {
  const file = path.join(daily, 'result.json');
  const result = writeResult(file, { ...opts, code: '0', suites: [greenSuite, exclusion] });
  expect(result).toEqual({ date: day, sha, status: 'green', started, finished, suites: [greenSuite, exclusion] });
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(result);
  expect(validResult(result)).toBe(true);
  expect(configuredExclusions().length).toBeGreaterThan(0);
  expect(() => configuredExclusions([{ ...exclusion, flags: ['PATH'] }])).toThrow('Invalid nightly exclusions');
  expect(issueForDay(daily, day, now)).toBeNull();
});

test('missing nightly result is reported only after the UTC deadline', () => {
  expect(issueForDay(daily, day, new Date(day + 'T05:59:59.999Z'))).toBeNull();
  expect(issueForDay(daily, day, now)).toMatchObject({
    title: 'Nightly missing on main: ' + day + ' unknown', body: expect.stringContaining('missing at 06:00 UTC'),
  });
});

test('malformed nightly result creates a dry-run issue without quoting its contents', () => {
  fs.writeFileSync(path.join(daily, 'result.json'), '{ private fixture detail');
  const [issue] = cli([daily, '--dry-run'], {}, now);
  expect(issue.title).toBe('Nightly error on main: ' + day + ' unknown');
  expect(issue.body).toContain('could not be validated');
  expect(issue.body).not.toContain('private fixture detail');
});

test('nightly error result includes only bounded failing-suite markers and safe test names', () => {
  writeResult(path.join(daily, 'result.json'), { ...opts, code: '1', suites: [exclusion,
    { ...failedSuite, status: 'error', failed_tests: ['handles empty input', 'PATH=not-public', '/private/file'] }] });
  fs.writeFileSync(path.join(daily, 'nightly.log'), 'unused log output\n'.repeat(10000) +
    '[nightly] green Other suite\n[nightly] error Jest unit\nPATH=not-public\n/private/file\n');
  const issue = issueForDay(daily, day, now);
  expect(issue.title).toBe('Nightly error on main: ' + day + ' aaaaaaaa');
  expect(issue.body).toContain('was error');
  expect(issue.body).toContain('[nightly] error Jest unit');
  expect(issue.body).toContain('handles empty input');
  expect(issue.body).not.toMatch(/Live provider|Other suite|unused log|PATH|private.file/);
});

test('nightly publishing deduplicates exact titles and sends identical content to screening and the App', () => {
  writeResult(path.join(daily, 'result.json'), { ...opts, code: '1', suites: [failedSuite] });
  const issue = issueForDay(daily, day, now);
  const url = 'https://github.com/example/project/issues/1';
  const screen = jest.fn();
  const options = { repo: 'example/project', screen };
  const duplicate = jest.fn().mockReturnValue(JSON.stringify([{ title: issue.title, url }]));
  expect(publish(issue, { ...options, run: duplicate })).toBe(url);
  expect(duplicate).toHaveBeenCalledTimes(1);
  expect(screen).not.toHaveBeenCalled();
  const run = jest.fn().mockReturnValueOnce('[]').mockReturnValueOnce('[]').mockReturnValueOnce(url);
  expect(publish(issue, { ...options, run })).toBe(url);
  expect(screen).toHaveBeenCalledWith(issue);
  expect(JSON.parse(run.mock.calls[2][2])).toEqual({ title: issue.title, labels: issue.labels, body: issue.body });
  const reject = jest.fn().mockReturnValue('[]');
  expect(() => publish(issue, { ...options, run: reject, screen: () => { throw new Error('Rejected'); } })).toThrow('Rejected');
  expect(reject).toHaveBeenCalledTimes(2);
});

test('nightly privacy checker receives the exact body and requires a completed clean receipt', () => {
  const issue = { title: 'Nightly red on main: ' + day + ' aaaaaaaa', sha, body: 'Safe test label' };
  const run = (cmd, args) => {
    if (cmd === 'git') return args[0] === 'config' ? '' : sha;
    const [id, base, head, branch, title, file] = args[1].split('|');
    expect([base, head, branch, title]).toEqual([sha, sha, 'main', issue.title]);
    expect(fs.readFileSync(file, 'utf8')).toBe(issue.body);
    return id + ': 2026-01-01T06:00:00Z END PR-' + id + ' try1 rc=0 hits=0 elapsed=0 COMPLETE';
  };
  expect(() => screenIssue(issue, { NIGHTLY_DENY_CHECK: 'deny.sh' }, run)).not.toThrow();
  expect(() => screenIssue(issue, { NIGHTLY_DENY_CHECK: 'deny.sh' },
    (cmd, args) => cmd === 'git' ? args[0] === 'config' ? '' : sha : 'No receipt')).toThrow('privacy receipt is missing');
});

test('nightly result reads failed browser test names from nested suites', () => {
  const file = path.join(daily, 'browser.json');
  fs.writeFileSync(file, JSON.stringify({ suites: [{ suites: [{ specs: [
    { title: 'opens a shipment', tests: [{ status: 'unexpected' }] },
    { title: 'loads a list', tests: [{ status: 'expected' }] },
  ] }] }] }));
  expect(failedTests(file)).toEqual(['opens a shipment']);
});

test('nightly inventory rejects a new gate, test command and browser configuration until declared', () => {
  expect(coverageGaps(['RUN_NEW_E2E', 'test:new', 'playwright.new.config.ts'], '', []))
    .toEqual(['RUN_NEW_E2E', 'test:new', 'playwright.new.config.ts']);
  expect(checkInventory()).toEqual([]);
});

test('nightly status counts Jest skips and rejects unexplained skips or missing results', () => {
  const file = path.join(daily, 'jest.json');
  fs.writeFileSync(file, JSON.stringify({ skipped: 2, suites: [
    { file: 'tests/integration/one.test.js', tests: [{ status: 'pending', fullName: 'one' }] },
    { file: 'tests/integration/two.test.js', tests: [{ status: 'pending', fullName: 'two' }, { status: 'failed', fullName: 'three' }] },
  ] }));
  expect(readSuiteReport(file, [{ files: ['tests/integration/one.test.js'] }]))
    .toEqual({ failedTests: ['three'], skipped: 2, unexplained: 1 });
  expect(() => readSuiteReport(path.join(daily, 'absent.json'))).toThrow();
  expect(failedTests(file)).toEqual(['three']);
  fs.writeFileSync(file, JSON.stringify([{ file: 'one.sql', status: 'passed' }, { file: 'two.sql', status: 'failed' }]));
  expect(failedTests(file)).toEqual(['two.sql']);
});

test('nightly browser skips are counted from the Playwright report and fail closed if unnamed', () => {
  const file = path.join(daily, 'browser.json');
  fs.writeFileSync(file, JSON.stringify({ stats: { skipped: 2 }, suites: [
    { file: 'one.spec.ts', specs: [{ title: 'one', tests: [{ status: 'skipped' }] }] },
  ] }));
  expect(readSuiteReport(file, [{ files: ['one.spec.ts'] }])).toMatchObject({ skipped: 2, unexplained: 1 });
});

test('nightly accepts only explicit IPv4 loopback bindings and the fresh public main checkout', () => {
  expect(() => assertPublishedPorts([{ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] }])).not.toThrow();
  expect(() => assertPublishedPorts([{ '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '54322' }] }])).toThrow();
  expect(() => assertPublishedPorts([{}, {}])).toThrow();
  const query = jest.fn().mockReturnValueOnce('https://github.com/example/project.git').mockReturnValueOnce('')
    .mockReturnValueOnce('').mockReturnValueOnce(sha + '\trefs/heads/main\n');
  expect(() => assertFreshMain(sha, 'https://github.com/example/project.git', query)).not.toThrow();
  const stale = jest.fn().mockReturnValueOnce('https://github.com/example/project.git').mockReturnValueOnce('')
    .mockReturnValueOnce('').mockReturnValueOnce('b'.repeat(40) + '\trefs/heads/main\n');
  expect(() => assertFreshMain(sha, 'https://github.com/example/project.git', stale)).toThrow(/main/);
});

test('nightly public labels handle Unicode, SQL filenames, denied keywords and exact length limits', () => {
  expect(safeLabel('A'.repeat(120))).toBe('A'.repeat(120));
  expect(safeLabel('A'.repeat(121))).toBeNull();
  expect(safeLabel('سجل.sql')).toBe('سجل.sql');
  expect(safeLabel('A'.repeat(117) + '.sql')).toBeNull();
  expect(safeLabel('secret key')).toBeNull();
});

test('nightly report includes gaps between delivered dates and ignores future folders', () => {
  fs.mkdirSync(path.join(root, '2026-01-04'));
  const dates = cli([root, '--dry-run'], {}, new Date('2026-01-03T06:00:00.000Z')).map(issue => issue.date);
  expect(dates).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
});

test('nightly privacy screening fails closed when Git cannot fetch or prove report ancestry', () => {
  const issue = { title: 'Nightly red on main', sha, body: 'Safe scope' };
  const fetchFailure = jest.fn((command, args) => {
    if (args.includes('fetch')) throw new Error('fetch failed');
    return '';
  });
  expect(() => screenIssue(issue, { GITHUB_REPOSITORY: 'example/project' }, fetchFailure)).toThrow('fetch failed');
  expect(fetchFailure.mock.calls[1][1]).toContain('fetch');
  const orphan = jest.fn((command, args) => {
    if (args.includes('--is-ancestor')) throw new Error('outside main');
    return args[0] === 'config' ? '' : sha;
  });
  expect(() => screenIssue(issue, { GITHUB_REPOSITORY: 'example/project' }, orphan)).toThrow('outside main');
  expect(orphan.mock.calls.every(([command]) => command === 'git')).toBe(true);
});

test('nightly publication comments on the active issue for the same suite failure', () => {
  writeResult(path.join(daily, 'result.json'), { ...opts, code: '1', suites: [failedSuite] });
  const issue = issueForDay(daily, day, now);
  const existing = { number: 1, title: 'Nightly red on main: 2025-12-31 bbbbbbbb',
    body: issue.body, url: 'public issue' };
  const lists = [[], [existing]].map(value => JSON.stringify(value));
  const screen = jest.fn();
  const run = jest.fn().mockReturnValueOnce(lists[0]).mockReturnValueOnce(lists[1])
    .mockReturnValueOnce('[]').mockReturnValueOnce('');
  expect(publish(issue, { repo: 'example/project', screen, run })).toBe(existing.url);
  expect(run.mock.calls[3][1]).toContain('repos/example/project/issues/1/comments');
  expect(JSON.parse(run.mock.calls[3][2]).body).toBe(screen.mock.calls[0][0].body);
  const duplicate = jest.fn().mockReturnValueOnce(lists[0]).mockReturnValueOnce(lists[1])
    .mockReturnValueOnce(JSON.stringify([[{ body: issue.body }]]));
  expect(publish(issue, { repo: 'example/project', screen, run: duplicate })).toBe(existing.url);
  expect(duplicate).toHaveBeenCalledTimes(3);
  expect(screen).toHaveBeenCalledTimes(1);
});

test('nightly result properties reject identity drift and green summaries with failed suites', () => {
  for (let index = 1; index <= 128; index++) {
    const commit = createHash('sha1').update(String(index)).digest('hex');
    const result = { date: day, sha: commit, status: 'green', started, finished, suites: [greenSuite] };
    if (!validResult(result) || validResult({ ...result, sha: commit + '\n' })
        || validResult({ ...result, suites: [failedSuite] })) throw new Error('Nightly result property failed');
  }
});

test('nightly Supabase binding admits only local service addresses and no DSN query overrides', () => {
  const status = { DB_URL: 'postgresql://fixture@127.0.0.1:54322/postgres', API_URL: 'http://127.0.0.1:54321',
    ANON_KEY: 'fixture-anon', SERVICE_ROLE_KEY: 'fixture-service' };
  expect(stackEnvironment(status)).toMatchObject({ DATABASE_URL: status.DB_URL, NEXT_PUBLIC_SUPABASE_URL: status.API_URL });
  expect(() => stackEnvironment({ ...status, DB_URL: status.DB_URL + '?host=example.org' })).toThrow();
  expect(() => stackEnvironment({ ...status, API_URL: 'https://example.org' })).toThrow();
});

test('nightly TERM still writes an error result after an earlier failing suite', () => {
  const run = runNightlyShell('kill -TERM "$PPID"');
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(143);
  const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  expect(validResult(result)).toBe(true);
  expect(result.status).toBe('error');
  expect(result.suites).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Jest unit', status: 'red' }),
    expect.objectContaining({ name: 'Nightly interrupted', status: 'error' }),
  ]));
});

test('nightly shell preserves later suite results after a test failure and records a missing prerequisite', () => {
  const run = runNightlyShell(':');
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(1);
  const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  expect(validResult(result)).toBe(true);
  expect(result.status).toBe('error');
  expect(result.suites).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Jest unit', status: 'red' }),
    expect.objectContaining({ name: 'pgTAP shard 1 of 2', status: 'green' }),
    expect.objectContaining({ name: 'pgTAP shard 2 of 2', status: 'green' }),
    expect.objectContaining({ name: 'Start local Supabase', status: 'error' }),
    expect.objectContaining({ name: 'Landing E2E', status: 'green' }),
  ]));
});

function runNightlyShell(signal) {
  const bash = process.platform === 'win32'
    ? path.resolve(execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0],
      '../../bin/bash.exe')
    : 'bash';
  fs.mkdirSync(path.join(root, 'bin'));
  for (const file of ['config/ci/nightly-out-of-scope.json', 'scripts/ci/nightly-full.sh',
    'scripts/ci/nightly-suites.sh', 'scripts/ci/nightly-result.cjs']) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../..', file), destination);
  }
  const command = (name, source) => {
    fs.writeFileSync(path.join(root, 'bin', name), '#!/usr/bin/env bash\n' + source + '\n', { mode: 0o700 });
  };
  command('git', 'case "$*" in\n  "rev-parse --show-toplevel") pwd ;;\n  "rev-parse HEAD") echo ' + sha + ' ;;\nesac');
  const realNode = JSON.stringify(process.execPath.replaceAll('\\', '/'));
  command('node', [
    'case "$*" in',
    '  "scripts/ci/nightly-result.cjs record "*)',
    '    printf \'{"name":"%s","status":"%s","failed_tests":[],"skipped":0}\\n\' "$4" "$5" >> "$3"; echo "$5" ;;',
    '  "scripts/ci/nightly-result.cjs "*|"-p new Date().toISOString()") exec ' + realNode + ' "$@" ;;',
    '  "-p require("*) echo 2 ;;',
    '  "scripts/ci-hosted/backend.cjs")',
    '    if [ -n "$PGTAP_SHARD" ]; then echo "[]" > ci-reports/pgtap-files.json',
    '    else echo "{}" > ci-reports/backend.json; fi ;;',
    '  "scripts/ci-hosted/jest.cjs unit") exit 7 ;;',
    'esac',
  ].join('\n'));
  command('npm', '[ -z "${NIGHTLY_PRIVATE_FIXTURE+x}" ] && [ "$HOME" = "$NIGHTLY_JOB/home" ] || exit 1\n' +
    'case "$*" in\n' +
    '  *test:ui:fieldops*) ' + signal + ' ;;\n' +
    '  *"playwright.landing.config.cjs --forbid-only --retries=0 --reporter=list,json") : ;;\n' +
    '  *playwright.landing.config.cjs*) exit 2 ;;\n' +
    'esac\nexit 0');
  command('docker', 'case "$1" in info) echo name=rootless ;; esac');
  command('setsid', 'exit 0');
  command('supabase', 'exit 1');
  return spawnSync(bash, ['-c', 'export PATH="$PWD/bin:$PATH"; bash scripts/ci/nightly-full.sh'], {
    cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, NIGHTLY_PRIVATE_FIXTURE: 'discarded' },
  });
}
