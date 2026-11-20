const fs = require('fs');
const path = require('path');
const { runInNewContext } = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../scripts/qa/run-load-test.js'), 'utf8');
const projectRoot = path.resolve('load-test-argv-fixture');
const special = '$(id) `; space " backslash \\';
const dbUrl = `synthetic-db=${special}`;
const settings = {
  DATABASE_URL: 'synthetic-inherited-db',
  LOADTEST_DATABASE_URL: dbUrl,
  SUPABASE_URL: `synthetic-url ${special}`,
  SUPABASE_SERVICE_ROLE_KEY: `synthetic-role ${special}`,
  PARTITION_DURATION: '2s',
  XK6_SQL_VERSION: `synthetic-version ${special}`,
};
const summary = 'tmp/synthetic load; result.json';
const scenarioArgs = [
  '--tag', 'scenario=partition-performance',
  '--summary-export', summary,
  'tests/load/partition-performance.js',
];
const localK6 = path.join(projectRoot, 'tmp', 'xk6', 'k6');
const localCall = [
  localK6,
  [
    'run',
    '-e', `SUPABASE_URL=${settings.SUPABASE_URL}`,
    '-e', `SUPABASE_SERVICE_ROLE_KEY=${settings.SUPABASE_SERVICE_ROLE_KEY}`,
    '-e', `PARTITION_DURATION=${settings.PARTITION_DURATION}`,
    '-e', `DATABASE_URL=${dbUrl}`,
    ...scenarioArgs,
  ],
  { stdio: 'pipe', encoding: 'utf8' },
];

async function captureSpawns(mode, { info = { status: 0 }, run = { status: 0 } } = {}) {
  const spawnSync = jest.fn((command, [subcommand]) => {
    if (command === 'docker') return subcommand === 'info' ? info : run;
    return { status: 0 };
  });
  const exit = jest.fn();
  const warn = jest.fn();
  const modules = {
    fs: {
      existsSync: (file) => file === localK6,
      mkdirSync: jest.fn(),
      writeFileSync: jest.fn(),
      appendFileSync: jest.fn(),
    },
    path,
    child_process: { spawnSync },
    dotenv: {},
    './qa-log': { createQaLogger: () => ({ recordCaseResults: jest.fn(), close: jest.fn() }) },
  };

  await runInNewContext(source, {
    require: (name) => modules[name],
    console: { log: jest.fn(), error: jest.fn(), warn },
    process: {
      env: mode ? { ...settings, LOAD_TEST_DOCKER_MODE: mode } : { ...settings },
      argv: ['node', 'run-load-test.js', `--summary=${summary}`],
      cwd: () => projectRoot,
      platform: 'linux',
      exit,
    },
  });
  return { calls: spawnSync.mock.calls, exits: exit.mock.calls, warnings: warn.mock.calls };
}

test('passes Docker env names in argv and values verbatim in the child environment', async () => {
  const { calls, exits } = await captureSpawns('require');
  const [, args, options] = calls.find(([command, argv]) => command === 'docker' && argv[0] === 'run');

  expect(exits).toStrictEqual([[0]]);
  expect(options).toEqual({
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 600000,
    env: {
      ...settings,
      DATABASE_URL: dbUrl,
      LOAD_TEST_DOCKER_MODE: 'require',
      DOCKER_CONFIG: path.join(projectRoot, 'tmp', 'docker-authless'),
    },
  });
  expect(args).toEqual([
    'run', '--rm',
    '-e', 'HOME=/tmp',
    '-e', 'XDG_CACHE_HOME=/tmp/.cache',
    '-e', 'GOCACHE=/tmp/.cache/go-build',
    '-e', 'GOMODCACHE=/tmp/.cache/go-mod',
    '-e', 'DATABASE_URL',
    '-e', 'LOADTEST_DATABASE_URL',
    '-e', 'SUPABASE_URL',
    '-e', 'SUPABASE_SERVICE_ROLE_KEY',
    '-e', 'PARTITION_DURATION',
    '-v', `${projectRoot.replace(/\\/g, '/')}:/work`,
    '-w', '/work',
    '--entrypoint', 'sh', 'grafana/xk6:0.14.0', '-c',
    'xk6 build "$1" --with "$2" --with "$3" --output /tmp/k6 && shift 3 && exec /tmp/k6 run "$@"',
    'load-test',
    'v0.57.0',
    `github.com/grafana/xk6-sql@${settings.XK6_SQL_VERSION}`,
    'github.com/grafana/xk6-sql-driver-postgres@v0.1.1',
    ...scenarioArgs,
  ]);
});

test('passes load-test settings verbatim as local k6 argv', async () => {
  const { calls, exits, warnings } = await captureSpawns('disable');

  expect(calls).toEqual([localCall]);
  expect(exits).toStrictEqual([[0]]);
  expect(warnings).toStrictEqual([
    ['[load-test] Docker usage disabled by policy; using local xk6 fallback.'],
  ]);
});

test.each([
  ['require', { status: 42 }, 42],
  ['require', { status: 99 }, 99],
  ['prefer', { status: 99 }, 99],
  ['prefer', { status: null, error: { code: 'ETIMEDOUT' } }, 1],
  ['require', { status: 0, error: { code: 'ENOBUFS', message: 'spawnSync docker ENOBUFS' } }, 1],
])('mode %s returns the Docker failure %j as exit %i', async (mode, run, code) => {
  const { calls, exits } = await captureSpawns(mode, { run });

  expect(calls.map(([command, [subcommand]]) => [command, subcommand])).toStrictEqual([
    ['docker', 'info'],
    ['docker', 'run'],
  ]);
  expect(exits).toStrictEqual([[code]]);
});

test.each([
  ['binary', { status: null, error: { code: 'ENOENT', message: 'spawnSync docker ENOENT' } }],
  ['daemon', { status: 1, stderr: 'synthetic daemon unavailable' }],
])('auto mode runs local k6 when the Docker %s is unavailable', async (_service, info) => {
  const { calls, exits } = await captureSpawns(undefined, { info });

  expect(calls).toEqual([
    ['docker', ['info'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10000,
      env: { ...settings, DOCKER_CONFIG: path.join(projectRoot, 'tmp', 'docker-authless') },
    }],
    localCall,
  ]);
  expect(exits).toStrictEqual([[0]]);
});
