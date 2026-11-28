const fs = require('fs');
const path = require('path');
const { disableHostedWalInitZero, withHostedCloneServices } = require('../../../scripts/ci-hosted/backend.cjs');

const project = 'fixture';
const storage = `supabase_storage_${project}`;
const auth = `supabase_auth_${project}`;
const database = `supabase_db_${project}`;
const names = [database, storage, auth].join('\n');
const env = {};

test('disposable hosted shards skip WAL segment preallocation on the server', async () => {
  const admin = jest.fn().mockResolvedValue('t');
  await disableHostedWalInitZero(admin);
  expect(admin).toHaveBeenCalledTimes(1);
  expect(admin).toHaveBeenCalledWith('ALTER SYSTEM SET wal_init_zero = off', 'SELECT pg_reload_conf()');

  await expect(disableHostedWalInitZero(jest.fn().mockResolvedValue('f'))).rejects.toThrow('Could not reload WAL segment setup');

  // Only the disposable pgTAP shard turns it off, before the reload that pauses pg_cron.
  const source = fs.readFileSync(path.join(__dirname, '../../../scripts/ci-hosted/backend.cjs'), 'utf8');
  expect(source).toMatch(/if \(disposableShard\) await disableHostedWalInitZero\(stackAdmin\);\n\s*await timed\('cron-pause'/);
});

test('stops services concurrently within the shard budget and restarts them after a failed clone', async () => {
  const summary = { stages: [] };
  const checked = jest.fn().mockResolvedValueOnce(names).mockResolvedValue('');
  let finishStop;
  checked.mockImplementationOnce(() => new Promise(resolve => { finishStop = resolve; }));
  const cloneError = new Error('Synthetic worker clone timed out');
  const clone = jest.fn().mockRejectedValue(cloneError);
  const pending = withHostedCloneServices({ checked, env, project, summary, remaining: () => 6000 }, clone);
  const outputOptions = { quiet: true, printQuietFailure: false };

  await Promise.resolve();
  const stopCalls = checked.mock.calls.slice(1);
  const earlyCloneCalls = clone.mock.calls.length;
  finishStop('');
  await expect(pending).rejects.toBe(cloneError);
  expect(earlyCloneCalls).toBe(0);
  expect(stopCalls).toEqual([
    ['docker', ['stop', '--time', '1', storage], env, 6000, outputOptions],
    ['docker', ['stop', '--time', '1', auth], env, 6000, outputOptions],
  ]);
  expect(checked.mock.calls.slice(3)).toEqual([
    ['docker', ['start', storage], env, 15000, outputOptions],
    ['docker', ['start', auth], env, 15000, outputOptions],
  ]);
  expect(summary.stages.map(stage => stage.name)).toEqual([
    'database-clone-stop:supabase_storage',
    'database-clone-stop:supabase_auth',
    'database-clone-start:supabase_storage',
    'database-clone-start:supabase_auth',
  ]);
});

test.each(['stop', 'start'])('reports the timed-out service during %s without raw Docker output', async (step) => {
  const privateDetail = 'Synthetic daemon location';
  const timeout = Object.assign(new Error(privateDetail), { failure: { timeout: true, output: privateDetail } });
  const checked = jest.fn(async (_command, args) => {
    if (args[0] === 'ps') return names;
    if (args[0] === step && args.at(-1) === auth) throw timeout;
    return '';
  });
  const clone = jest.fn();
  const summary = { stages: [] };

  const error = await withHostedCloneServices({ checked, env, project, summary }, clone).catch(error => error);
  expect(error.message).toBe(`Docker ${step} timed out for supabase_auth`);
  expect(error.failure).toEqual({ timeout: true });
  expect(error.cause).toBeUndefined();
  expect(summary.stages).toContainEqual(expect.objectContaining({ name: `database-clone-${step}:supabase_auth`, status: 'failed' }));
  expect(clone).toHaveBeenCalledTimes(step === 'stop' ? 0 : 1);
  expect(checked.mock.calls.filter(([, args]) => args[0] === 'start')).toHaveLength(step === 'stop' ? 0 : 2);
});
