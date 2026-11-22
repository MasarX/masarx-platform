const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');
const { evaluate, guard, summarize } = require('../../../scripts/deploy/apply-guard.cjs');

const tip = 'a'.repeat(40);
const stale = 'b'.repeat(40);
const devTip = 'c'.repeat(40);
const failedAt = '2026-01-01T00:00:00Z';
const later = '2026-01-01T00:00:01Z';
const marker = 'Record database push attempt';
const legacyStep = 'Apply migrations and deploy registered edge functions';
const inProgress = { id: 43, run_number: 10, status: 'in_progress' };

async function fixture({
  env, newer, newerDev, previous, rerun, markerConclusion = 'success', deployConclusion, history,
} = {}) {
  const decisions = [];
  const get = jest.fn(endpoint => {
    const url = new URL(endpoint, 'https://example.test');
    if (url.pathname === '/git/ref/heads/main') return { object: { sha: tip } };
    if (url.pathname === '/git/ref/heads/dev') return { object: { sha: devTip } };
    if (url.pathname === '/actions/workflows/deploy.yml/runs') {
      const branch = url.searchParams.get('branch');
      expect(['main', 'dev']).toContain(branch);
      if (url.searchParams.has('event')) {
        expect(url.searchParams.get('event')).toBe('push');
        expect(url.searchParams.get('head_sha')).toBe(branch === 'main' ? tip : devTip);
        const replacement = branch === 'main' ? newer : newerDev;
        return { workflow_runs: replacement ? [replacement] : [] };
      }
      const [start, end] = url.searchParams.get('created').split('..');
      expect(Date.parse(end) - Date.parse(start)).toBe(30 * 24 * 60 * 60 * 1000);
      if (history) return { workflow_runs: history.runs[branch] };
      if (branch === 'dev') return { workflow_runs: [] };
      return { workflow_runs: previous ? [{ id: 42, run_attempt: rerun ? 2 : 1 }] : [] };
    }
    if (history && url.pathname in history.jobs) {
      return { jobs: [{ name: 'database', status: 'completed',
        steps: [{ name: marker, conclusion: 'success' }], ...history.jobs[url.pathname] }] };
    }
    if (url.pathname === '/actions/runs/42/attempts/1/jobs') {
      return { jobs: [{
        name: 'database', status: 'completed', conclusion: previous, completed_at: failedAt,
        steps: [
          ...(markerConclusion ? [{ name: marker, conclusion: markerConclusion }] : []),
          ...(deployConclusion ? [{ name: legacyStep, conclusion: deployConclusion }] : []),
        ],
      }] };
    }
    throw new Error('Unexpected endpoint');
  });
  const result = await evaluate(get, {
    GITHUB_SHA: tip, GITHUB_EVENT_NAME: 'push', RUN_NUMBER: '9',
    GITHUB_RUN_ID: rerun ? '42' : '43', GITHUB_RUN_ATTEMPT: rerun ? '2' : '1',
    ...env,
  }, decision => decisions.push(decision));
  return { result, decisions, get };
}

test.each([
  ['normal', {}, 'allow', 'G2: no previous apply found'],
  ['stale with no replacement', { env: { GITHUB_SHA: stale } }, 'allow', 'G1: no superseding push'],
  ['stale dev push superseded by dev tip', {
    env: { GITHUB_SHA: stale, GITHUB_REF: 'refs/heads/dev' }, newerDev: inProgress,
  }, 'superseded', 'G1: superseded by ' + devTip],
  ['main push superseded by a newer push to the dev tip', { newerDev: inProgress },
    'superseded', 'G1: superseded by ' + devTip],
  ['superseded by in-progress push', { env: { GITHUB_SHA: stale }, newer: inProgress },
    'superseded', 'G1: superseded by ' + tip],
  ['superseded by successful push', {
    env: { GITHUB_SHA: stale }, newer: { ...inProgress, status: 'completed', conclusion: 'success' },
  }, 'superseded', 'G1: superseded by ' + tip],
  ['replacement was cancelled', {
    env: { GITHUB_SHA: stale }, newer: { ...inProgress, status: 'completed', conclusion: 'cancelled' },
  }, 'refused', `G1: superseding run 43 for ${tip} was cancelled; dispatch expected_sha=${tip}`],
  ['dev replacement was cancelled', {
    newerDev: { ...inProgress, status: 'completed', conclusion: 'cancelled' },
  }, 'refused', `G1: superseding run 43 for ${devTip} was cancelled; promote dev to main, then dispatch expected_sha=${tip}`],
  ['red with an older re-arm', { previous: 'failure', env: { DEV_DB_REARMED_AT: '2025-12-31T00:00:00Z' } },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['red with an equal re-arm', { previous: 'failure', env: { DEV_DB_REARMED_AT: failedAt } },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['red re-armed', { previous: 'failure', env: { DEV_DB_REARMED_AT: later } }, 'allow', 'G2: re-armed after run 42'],
  ['red with a future re-arm', { previous: 'failure', env: { DEV_DB_REARMED_AT: '9999-12-31T00:00:00Z' } },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['red with non-ISO re-arm', { previous: 'failure', env: { DEV_DB_REARMED_AT: '2026-01-02' } },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['cancelled after apply attempt', { previous: 'cancelled' },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['timed out after apply attempt', { previous: 'timed_out' },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['interrupted with no recorded marker', {
    previous: 'cancelled', markerConclusion: 'skipped', deployConclusion: 'cancelled',
  }, 'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['cancelled between a successful deploy step and the marker', {
    previous: 'cancelled', markerConclusion: 'skipped', deployConclusion: 'success',
  }, 'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['legacy apply failed', { previous: 'failure', markerConclusion: null, deployConclusion: 'failure' },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['legacy apply timed out', { previous: 'timed_out', markerConclusion: null, deployConclusion: 'timed_out' },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['legacy apply succeeded', { previous: 'success', markerConclusion: null, deployConclusion: 'success' },
    'allow', 'G2: previous apply at run 42 concluded success'],
  ['earlier attempt of the same run failed', { previous: 'failure', rerun: true },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['previous success', { previous: 'success' }, 'allow', 'G2: previous apply at run 42 concluded success'],
  ['failure without apply', { previous: 'failure', markerConclusion: 'skipped' }, 'allow', 'G2: no previous apply found'],
  ['dispatch expected SHA mismatch', { env: { GITHUB_EVENT_NAME: 'workflow_dispatch', EXPECTED_SHA: stale } },
    'refused', 'G3: expected_sha must equal both the main tip and github.sha'],
  ['dispatch run SHA mismatch', { env: { GITHUB_EVENT_NAME: 'workflow_dispatch', EXPECTED_SHA: tip, GITHUB_SHA: stale } },
    'refused', 'G3: expected_sha must equal both the main tip and github.sha'],
  ['dispatch SHA match', { env: { GITHUB_EVENT_NAME: 'workflow_dispatch', EXPECTED_SHA: tip } },
    'allow', 'G3: dispatch SHA matched'],
  ['missing re-arm variable', { previous: 'failure' }, 'refused', 'G2: previous apply failed at run 42; re-arm required'],
])('%s', async (_label, options, expected, decision) => {
  const { result, decisions, get } = await fixture(options);
  expect(result).toBe(expected);
  expect(decisions).toContain(decision);
  if (expected === 'superseded') {
    expect(get.mock.calls.every(([endpoint]) => !endpoint.includes('created='))).toBe(true);
  }
});

test.each(['main', 'dev'])('a later failed rerun on %s takes precedence over a newer successful dispatch', async branch => {
  const dispatch = { id: 43, run_attempt: 1 };
  const push = { id: 42, run_attempt: 2 };
  const runs = branch === 'main' ? { main: [dispatch, push], dev: [] } : { main: [dispatch], dev: [push] };
  const { result, decisions, get } = await fixture({
    env: { GITHUB_RUN_ID: '44', DEV_DB_REARMED_AT: '2026-01-01T00:01:00Z' },
    history: { runs, jobs: {
      '/actions/runs/43/attempts/1/jobs': { conclusion: 'success', completed_at: '2026-01-01T00:02:00Z' },
      '/actions/runs/42/attempts/2/jobs': { conclusion: 'failure', completed_at: '2026-01-01T00:03:00Z' },
      '/actions/runs/42/attempts/1/jobs': { conclusion: 'failure', completed_at: failedAt },
    } },
  });
  expect(result).toBe('refused');
  expect(decisions).toContain('G2: previous apply failed at run 42; re-arm required');
  expect(get).toHaveBeenCalledWith(expect.stringContaining('/actions/runs/43/attempts/1/jobs'));
  expect(get).toHaveBeenCalledWith(expect.stringContaining('/actions/runs/42/attempts/1/jobs'));
});

test.each([
  ['success ties failure', { conclusion: 'failure', completed_at: later }, 'refused',
    'G2: previous apply failed at run 42; re-arm required'],
  ['success follows failure', { conclusion: 'failure', completed_at: failedAt }, 'allow',
    'G2: previous apply at run 41 concluded success'],
  ['steps omitted', { conclusion: 'failure', completed_at: later, steps: undefined }, 'allow',
    'G2: previous apply at run 41 concluded success'],
  ['steps is not an array', { conclusion: 'failure', completed_at: later, steps: {} }, 'allow',
    'G2: previous apply at run 41 concluded success'],
])('%s', async (_label, failedJob, expected, decision) => {
  const { result, decisions } = await fixture({ history: {
    runs: { main: [{ id: 42, run_attempt: 1 }, { id: 41, run_attempt: 1 }], dev: [] },
    jobs: {
      '/actions/runs/42/attempts/1/jobs': failedJob,
      '/actions/runs/41/attempts/1/jobs': { conclusion: 'success', completed_at: later },
    },
  } });
  expect(result).toBe(expected);
  expect(decisions).toContain(decision);
});

test('refuses when the GitHub result cap prevents a complete history scan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-guard-'));
  const env = {
    GITHUB_EVENT_NAME: 'push', GITHUB_SHA: tip,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), GITHUB_OUTPUT: path.join(dir, 'output'),
  };
  const fetchRequest = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ object: { sha: tip } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ object: { sha: tip } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ total_count: 1000, workflow_runs: [] }) });
  const reportError = jest.spyOn(console, 'error').mockImplementation(() => {});
  const reportDecision = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await expect(guard(env, fetchRequest)).resolves.toBe(1);
    expect(fs.existsSync(env.GITHUB_OUTPUT)).toBe(false);
    const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
    expect(summary).toContain('history scan limit reached');
    expect(summary).not.toContain('no previous apply');
  } finally {
    reportError.mockRestore();
    reportDecision.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.each(['HTTP error', 'network error'])('fails closed on %s without publishing a deployment output', async error => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-guard-'));
  const env = {
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
  };
  const fetchRequest = error === 'HTTP error'
    ? jest.fn().mockResolvedValue({ ok: false, status: 503 })
    : jest.fn().mockRejectedValue(new Error('Connection failed'));
  const reportError = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(guard(env, fetchRequest)).resolves.toBe(1);
    expect(fs.existsSync(env.GITHUB_OUTPUT)).toBe(false);
    expect(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('Guard could not verify GitHub deployment state');
  } finally {
    reportError.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('counts completed migrations across a retry and redacts the project ref', () => {
  const ref = 'abcdefghijklmnopqrst';
  const report = summarize([
    'Applying migration 20260101000000_first.sql...',
    'Applying migration 20260102000000_second.sql...',
    'ERROR: synthetic database error',
    '::warning::Supabase db push failed with SQLSTATE 40P01 while applying 20260102000000_second.sql.',
    'Applying migration 20260102000000_second.sql...',
    'Applying migration 20260103000000_' + ref + '.sql...',
  ].join('\n'), '0', '12', { GITHUB_SHA: tip, SUPABASE_PROJECT_REF: ref });
  expect(report).toContain('Migrations applied: 3');
  expect(report).toContain('First migration: `20260101000000_first.sql`');
  expect(report).toContain('Last migration: Redacted');
  expect(report).toContain('40P01 retries: 1');
  expect(report).toContain('12s');
  expect(report).toContain(tip);
  expect(report).not.toContain(ref);
});

test('holds every database push behind the guard and skips app deploys when superseded', () => {
  const { jobs } = yaml.parse(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/deploy.yml'), 'utf8'));
  const { steps, outputs, concurrency } = jobs.database;
  const guard = steps.findIndex(step => step.id === 'apply_guard');
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(steps[guard].run).toBe('node scripts/deploy/apply-guard.cjs');
  for (const step of steps.filter(step => step.uses || step.id === 'apply_guard')) {
    expect(step.if).toBe("steps.guard.outputs.configured == 'true'");
  }
  const pushes = steps.filter(step => step.run?.includes('"$cli" db push'));
  expect(pushes.length).toBeGreaterThan(0);
  for (const step of pushes) {
    expect(steps.indexOf(step)).toBeGreaterThan(guard);
    expect(step.if).toContain("steps.apply_guard.outcome == 'success'");
    expect(step.if).toContain("steps.apply_guard.outputs.superseded == 'false'");
  }
  expect(pushes[0].run).toMatch(/trap 'rm -f "\$deploy_temp\/edge\.env"\n[\s\S]+?apply-guard\.cjs summarize[^\n]+\|\|/);
  expect(outputs.superseded).toContain('steps.apply_guard.outputs.superseded');
  expect(concurrency).toEqual({ group: 'deploy-dev-database', 'cancel-in-progress': false });
  for (const app of ['console', 'portal', 'landing', 'ingress']) {
    expect(jobs[app].if).toContain("needs.database.outputs.superseded != 'true'");
  }
});
