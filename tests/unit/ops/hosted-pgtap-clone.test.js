const { cloneHostedDatabases, configureHostedDatabase } = require('../../../scripts/ci-hosted/backend.cjs');

test('hosted pgTAP creates worker clones using WAL_LOG', async () => {
  const admin = jest.fn()
    .mockResolvedValueOnce(JSON.stringify({ owner: 'fixture_owner', limit: -1, explicitAcl: false }))
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce('t')
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce('[]')
    .mockResolvedValueOnce('');
  await cloneHostedDatabases(admin, ['pgtap_worker_1'], []);
  expect(admin).toHaveBeenNthCalledWith(4,
    'CREATE DATABASE pgtap_worker_1 TEMPLATE postgres STRATEGY WAL_LOG OWNER fixture_owner CONNECTION LIMIT -1');
});

test('the hosted shard sets connection logging with separate SQL commands before reload', async () => {
  const admin = jest.fn().mockResolvedValue('t');
  const db = { query: jest.fn().mockResolvedValue({ rows: [{ setting: 'off', context: 'sighup' }] }) };

  await configureHostedDatabase(admin, db, true);

  expect(admin).toHaveBeenCalledTimes(1);
  expect(admin).toHaveBeenCalledWith(
    "ALTER SYSTEM SET cron.launch_active_jobs = 'off'",
    'ALTER SYSTEM SET log_connections = on',
    'ALTER SYSTEM SET log_disconnections = on',
    expect.stringMatching(/^ALTER SYSTEM SET log_line_prefix = '[^']*%p[^']*%a[^']*%u[^']*%d[^']*'$/),
    'SELECT pg_reload_conf()',
  );
});
