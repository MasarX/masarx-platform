const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withHostedCloneWorkersPaused, cloneHostedDatabases } = require('../../../scripts/ci-hosted/backend.cjs');
const { captureDatabaseLog } = require('../../../scripts/ci-hosted/stack-diagnostics.cjs');

test('restores hosted pgTAP workers and logging after a failed WAL clone', async () => {
  const commands = [];
  let pending = '8/warning';
  let active = pending;
  const admin = async (...sql) => {
    if (sql[0].includes("current_setting('max_worker_processes')")) {
      commands.push(`settings: ${active}`);
      return active;
    }
    if (sql[0].includes('json_build_object')) return '{"owner":"postgres","limit":-1,"explicitAcl":false}';
    if (sql[0].includes('pg_terminate_backend')) {
      commands.push('drain template sessions');
      return '';
    }
    commands.push(...sql);
    if (sql[0].includes('SET max_worker_processes')) pending = sql[0].includes('RESET') ? '8/warning' : '0/debug2';
    if (sql[0].startsWith('CREATE DATABASE')) throw new Error('synthetic WAL clone failure');
    return '';
  };
  const restart = async restoring => { commands.push(restoring ? 'restart to restore' : 'restart for clone'); active = pending; };
  await expect(withHostedCloneWorkersPaused(admin, restart, () => cloneHostedDatabases(admin, ['pgtap_worker_1'], [])))
    .rejects.toThrow('synthetic WAL clone failure');
  expect(commands).toEqual([
    'settings: 8/warning',
    'ALTER SYSTEM SET max_worker_processes = 0',
    "ALTER SYSTEM SET log_min_messages = 'debug2'",
    'restart for clone',
    'settings: 0/debug2',
    'ALTER DATABASE postgres ALLOW_CONNECTIONS false',
    'drain template sessions',
    'CREATE DATABASE pgtap_worker_1 TEMPLATE postgres STRATEGY WAL_LOG OWNER postgres CONNECTION LIMIT -1',
    'ALTER DATABASE postgres ALLOW_CONNECTIONS true',
    'ALTER SYSTEM RESET max_worker_processes',
    'ALTER SYSTEM RESET log_min_messages',
    'restart to restore',
    'settings: 8/warning',
  ]);
  expect(active).toBe('8/warning');
});

test('refuses to start a hosted pgTAP clone if the postmaster still permits workers', async () => {
  const admin = jest.fn().mockResolvedValue('8/warning');
  const restart = jest.fn();
  const clone = jest.fn();
  await expect(withHostedCloneWorkersPaused(admin, restart, clone)).rejects.toThrow('did not enter the isolated clone configuration');
  expect(clone).not.toHaveBeenCalled();
  expect(restart).toHaveBeenCalledTimes(2);
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
