const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cloneHostedDatabases, withHostedCloneIsolation } = require('../../../scripts/ci-hosted/backend.cjs');
const { captureDatabaseLog } = require('../../../scripts/ci-hosted/stack-diagnostics.cjs');

const worker = 'pgtap_worker_1';
const logReset = 'ALTER SYSTEM RESET log_min_messages';
const reload = 'SELECT pg_reload_conf()';
const showLogging = 'SHOW log_min_messages';
const reopen = 'ALTER DATABASE postgres ALLOW_CONNECTIONS true';
const restoreRole = 'ALTER ROLE postgres CONNECTION LIMIT 7';
const readLimit = "SELECT rolconnlimit FROM pg_roles WHERE rolname = 'postgres'";

function cloneFixture({ rolsuper = false, cloneError, reopenError, restoredLimit = '7' } = {}) {
  const admin = jest.fn(async (sql, next) => {
    if (sql.includes('FROM pg_roles CROSS JOIN pg_settings')) {
      return JSON.stringify({ rolconnlimit: 7, rolsuper, logLevel: 'warning', restoreLogging: logReset });
    }
    if (sql.includes('FROM pg_database WHERE')) return JSON.stringify({ owner: 'postgres', limit: -1, explicitAcl: false });
    if (sql.includes('pg_terminate_backend') || next === reload) return 't';
    if (sql === showLogging) return 'debug2';
    if (sql.includes('FROM pg_db_role_setting')) return '[]';
    if (sql.startsWith('CREATE DATABASE') && cloneError) throw cloneError;
    return '';
  });
  const restore = jest.fn(async (sql, next) => {
    if (sql === reopen && reopenError) throw reopenError;
    if (next === readLimit) return restoredLimit;
    if (next === reload) return 't';
    if (sql === showLogging) return 'warning';
    return '';
  });
  const created = [];
  const clone = () => withHostedCloneIsolation(admin, restore, restoreTemplate =>
    cloneHostedDatabases(admin, [worker], created, restoreTemplate));
  return { admin, restore, created, clone };
}

const restoreCalls = [[reopen], [restoreRole, readLimit], [logReset, reload], [showLogging]];

test('rejects new postgres probe connections before closing and cloning the template', async () => {
  const { admin, restore, created, clone } = cloneFixture();
  await clone();
  expect(admin.mock.calls).toEqual([
    [expect.stringContaining('FROM pg_roles CROSS JOIN pg_settings')],
    ['ALTER ROLE postgres CONNECTION LIMIT 0'],
    ["ALTER SYSTEM SET log_min_messages = 'debug2'", reload],
    [showLogging],
    [expect.stringContaining('FROM pg_database WHERE')],
    ['ALTER DATABASE postgres ALLOW_CONNECTIONS false'],
    [expect.stringContaining('pg_terminate_backend')],
    [`CREATE DATABASE ${worker} TEMPLATE postgres STRATEGY WAL_LOG OWNER postgres CONNECTION LIMIT -1`],
    [expect.stringContaining('FROM pg_db_role_setting')],
  ]);
  expect(created).toEqual([worker]);
  expect(restore.mock.calls).toEqual(restoreCalls);
  expect(restore.mock.invocationCallOrder[0]).toBeGreaterThan(admin.mock.invocationCallOrder.at(-1));
});

test('restores the template and postgres role after a failed hosted WAL clone', async () => {
  const cloneError = new Error('synthetic WAL clone failure');
  const { restore, created, clone } = cloneFixture({ cloneError });
  await expect(clone()).rejects.toBe(cloneError);
  expect(created).toEqual([]);
  expect(restore.mock.calls).toEqual(restoreCalls);
});

test('keeps the hosted clone error when verification finds an unrestored role limit', async () => {
  const cloneError = new Error('synthetic WAL clone failure');
  const { restore, clone } = cloneFixture({ cloneError, restoredLimit: '0' });
  await expect(clone()).rejects.toBe(cloneError);
  expect(cloneError.restoreError.message).toMatch(/did not restore the postgres role connection limit/);
  expect(restore.mock.calls).toEqual(restoreCalls);
});

test('preserves the hosted clone error and finishes cleanup when reopening the template fails', async () => {
  const cloneError = new Error('synthetic WAL clone failure');
  const reopenError = new Error('synthetic template reopen failure');
  const { restore, clone } = cloneFixture({ cloneError, reopenError });
  await expect(clone()).rejects.toBe(cloneError);
  expect(cloneError.restoreError).toBe(reopenError);
  expect(restore.mock.calls).toEqual(restoreCalls);
});

test('fails an otherwise successful hosted clone if the postgres role limit was not restored', async () => {
  const { clone } = cloneFixture({ restoredLimit: '0' });
  await expect(clone()).rejects.toThrow('did not restore the postgres role connection limit');
});

test('refuses a hosted clone when the postgres role can bypass its connection limit', async () => {
  const { admin, restore, clone } = cloneFixture({ rolsuper: true });
  await expect(clone()).rejects.toThrow('the postgres role is a superuser');
  expect(admin.mock.calls).toEqual([[expect.stringContaining('FROM pg_roles')]]);
  expect(restore).not.toHaveBeenCalled();
});

test('keeps hosted pgTAP cloning free of database restarts and worker-setting changes', () => {
  const source = fs.readFileSync(require.resolve('../../../scripts/ci-hosted/backend.cjs'), 'utf8');
  expect(source).not.toMatch(/\['restart'|max_worker_processes|until pg_isready/);
  expect(source).toMatch(/name !== `supabase_db_\$\{project\}`/);
  expect(source).toMatch(/await withHostedCloneIsolation\(cloneAdmin, restoreAdmin, async restoreTemplate => \{\s+await cloneHostedDatabases\(cloneAdmin, databases, created, restoreTemplate\)/);
});

test('writes uncapped redacted hosted pgTAP logs to the one-day artifact path', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgtap-crash-'));
  const logFile = path.join(temp, 'ci-reports', 'postgres-server.log');
  fs.mkdirSync(path.dirname(logFile));
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', PGTAP_SHARD: '2/6',
    GITHUB_OUTPUT: path.join(temp, 'github-output') };
  const fixture = ['fixture', 'pg', 'password'].join('-');
  const uri = `postgresql://example:${fixture}@localhost/example`;
  const raw = `early startup\n${'test log line\n'.repeat(20001)}${uri}\npassword='${fixture}'\n`;
  const execute = jest.fn().mockResolvedValueOnce(raw).mockResolvedValueOnce('123 456 2\n');
  const printed = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await captureDatabaseLog({ project: 'synthetic', env, logFile, execute });
    expect(execute.mock.calls[0].slice(0, 2)).toEqual(['docker', ['logs', '--timestamps', 'supabase_db_synthetic']]);
    expect(fs.readFileSync(logFile, 'utf8')).toBe(raw.replace(uri, '[REDACTED_CONNECTION]').replace(`'${fixture}'`, '[REDACTED]'));
    expect(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('postgres_log=true\n');
    expect(printed.mock.calls.flat().join('\n')).not.toContain(fixture);
    expect(printed.mock.calls.flat().join('\n')).toContain('Postgres health probe (start ns, end ns, exit code) 123 456 2');
    const workflow = fs.readFileSync('.github/workflows/public-ci.yml', 'utf8').replace(/\r\n/g, '\n');
    const job = workflow.split('\n  database-pgtap:\n')[1].split('\n  database:\n')[0];
    expect(job).toMatch(/path: ci-reports\/postgres-server\.log\n +if-no-files-found: ignore\n +retention-days: 1/);
  } finally {
    printed.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
