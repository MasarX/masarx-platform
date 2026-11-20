const fs = require('fs');
const path = require('path');
const { runInNewContext } = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../scripts/qa/run-load-test.js'), 'utf8');
const projectRoot = path.resolve('load-test-argv-fixture');
const value = 'synthetic $(id) `; space " backslash \\';
const dbUrl = `synthetic-db=${value}`;
const summary = 'tmp/synthetic load; result.json';
const scenarioArgs = [
  '--tag', 'scenario=partition-performance',
  '--summary-export', summary,
  'tests/load/partition-performance.js',
];

async function captureSpawns(mode) {
  const spawnSync = jest.fn(() => ({ status: 0 }));
  const modules = {
    fs: {
      existsSync: (file) => file === path.join(projectRoot, 'tmp', 'xk6', 'k6'),
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
    process: {
      env: {
        LOAD_TEST_DOCKER_MODE: mode,
        DATABASE_URL: 'synthetic-inherited-db',
        LOADTEST_DATABASE_URL: dbUrl,
        SUPABASE_URL: value,
        XK6_SQL_VERSION: value,
      },
      argv: ['node', 'run-load-test.js', `--summary=${summary}`],
      cwd: () => projectRoot,
      platform: 'linux',
      exit: jest.fn(),
    },
  });
  return spawnSync.mock.calls;
}

test('passes load-test settings verbatim as Docker argv with a fixed shell script', async () => {
  const calls = await captureSpawns('require');
  const [, args, options] = calls.find(([command, argv]) => command === 'docker' && argv[0] === 'run');

  expect(options.shell).toBeUndefined();
  expect(args).toEqual([
    'run', '--rm',
    '-e', 'HOME=/tmp',
    '-e', 'XDG_CACHE_HOME=/tmp/.cache',
    '-e', 'GOCACHE=/tmp/.cache/go-build',
    '-e', 'GOMODCACHE=/tmp/.cache/go-mod',
    '-e', `DATABASE_URL=${dbUrl}`,
    '-e', `LOADTEST_DATABASE_URL=${dbUrl}`,
    '-e', `SUPABASE_URL=${value}`,
    '-v', `${projectRoot.replace(/\\/g, '/')}:/work`,
    '-w', '/work',
    '--entrypoint', 'sh', 'grafana/xk6:0.14.0', '-c',
    'xk6 build "$1" --with "$2" --with "$3" --output /tmp/k6 && shift 3 && exec /tmp/k6 run "$@"',
    'load-test',
    'v0.57.0',
    `github.com/grafana/xk6-sql@${value}`,
    'github.com/grafana/xk6-sql-driver-postgres@v0.1.1',
    ...scenarioArgs,
  ]);
});

test('passes load-test settings verbatim as local k6 argv', async () => {
  const calls = await captureSpawns('disable');

  expect(calls).toEqual([[
    path.join(projectRoot, 'tmp', 'xk6', 'k6'),
    ['run', '-e', `SUPABASE_URL=${value}`, '-e', `DATABASE_URL=${dbUrl}`, ...scenarioArgs],
    { stdio: 'pipe', encoding: 'utf8' },
  ]]);
});
