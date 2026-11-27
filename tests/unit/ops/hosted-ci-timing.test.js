const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');

const dir = path.resolve(__dirname, '../../../.github/actions/ci-timing');
const action = yaml.parse(fs.readFileSync(path.join(dir, 'action.yml'), 'utf8'));
const workflow = yaml.parse(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/public-ci.yml'), 'utf8'));

test('the timing action registers an always-running post and the Jest workflow marks each phase', () => {
  expect(action.runs).toEqual(expect.objectContaining({
    main: 'timing.cjs', post: 'timing.cjs', 'post-if': 'always()',
  }));
  const steps = workflow.jobs.unit.steps.filter(step => step.uses === './.github/actions/ci-timing');
  expect(steps.map(step => step.with.phase)).toEqual([
    'prepare', 'setup-node', 'npm-cache-restore', 'install', 'workload', 'reporting',
  ]);
  expect(steps.find(step => step.with.phase === 'install').with['npm-cache']).toEqual(
    expect.stringContaining('steps.restore_npm.outputs.cache-hit'),
  );
});

test.each([
  ['hit', 'database-build', 'backend.json', null],
  ['miss', 'database-pgtap', 'pgtap.json', 3.25],
])('records cache %s and stage timings through the %s post action', (cache, job, report, testSeconds) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-timing-test-'));
  const summary = path.join(temp, 'summary.md');
  try {
    fs.mkdirSync(path.join(temp, 'ci-reports'));
    fs.writeFileSync(path.join(temp, 'ci-reports', report), JSON.stringify({ stages: [
      { name: 'npm-install', durationMs: 500 },
      { name: 'stack-start', durationMs: 725 },
      { name: 'image-pulls', durationMs: 1250 },
      { name: 'migrations', durationMs: 2500 },
      ...(testSeconds === null ? [] : [{ name: 'pgtap:1/6', durationMs: 3250 }]),
    ] }));
    const run = (file, time, phase = '', state = '') => {
      const stateFile = path.join(temp, String(time));
      const result = spawnSync(process.execPath, [
        '-e', 'Date.now = () => Number(process.argv[1]); require(process.argv[2]);',
        String(time), path.join(dir, file),
      ], {
        env: { ...process.env, RUNNER_TEMP: temp, GITHUB_WORKSPACE: temp, GITHUB_STATE: stateFile,
          GITHUB_STEP_SUMMARY: summary, GITHUB_JOB: job, STATE_timing: state, INPUT_PHASE: phase,
          'INPUT_NPM-CACHE': phase === 'install' ? cache : 'NOT_RUN' },
        encoding: 'utf8', timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('unavailable');
      return stateFile;
    };
    const phases = [
      ['prepare', 1000], ['setup-node', 3000], ['npm-cache-restore', 4000],
      ['install', 6000], ['workload', 10000], ['reporting', 18000],
    ];
    const states = phases.map(([phase, time]) => fs.readFileSync(run(action.runs.main, time, phase), 'utf8'));
    expect(states).toEqual(['timing=publish\n', ...Array(5).fill('timing=ignore\n')]);
    run(action.runs.post, 19250, '', states.at(-1).trim().split('=')[1]);
    expect(fs.existsSync(summary)).toBe(false);
    run(action.runs.post, 20000, '', states[0].trim().split('=')[1]);
    const lines = fs.readFileSync(summary, 'utf8').split('\n');
    expect(lines.filter(line => line === '### CI timing')).toHaveLength(1);
    expect(JSON.parse(lines[3])).toEqual({
      job,
      setup_seconds: { prepare: 2, 'setup-node': 1, 'npm-cache-restore': 2, install: 4,
        'npm-install': 0.5, 'stack-start': 0.725 },
      npm_cache: cache,
      image_pull_seconds: 1.25,
      replay_seconds: 2.5,
      test_seconds: testSeconds,
      workload_seconds: 8,
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
