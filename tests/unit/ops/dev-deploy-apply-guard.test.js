const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');
const { evaluate, guard, summarize } = require('../../../scripts/deploy/apply-guard.cjs');

const tip = 'a'.repeat(40);
const stale = 'b'.repeat(40);
const failedAt = '2026-01-01T00:00:00Z';
const later = '2026-01-01T00:00:01Z';
const marker = 'Record database push attempt';
const legacyStep = 'Apply migrations and deploy registered edge functions';
const inProgress = { id: 43, run_number: 10, status: 'in_progress' };

async function fixture({ env, newer, previous, rerun, markerConclusion = 'success', deployConclusion } = {}) {
  const decisions = [];
  const get = jest.fn(endpoint => {
    const url = new URL(endpoint, 'https://example.test');
    if (url.pathname === '/git/ref/heads/main') return { object: { sha: tip } };
    if (url.pathname === '/actions/workflows/deploy.yml/runs') {
      expect(url.searchParams.get('branch')).toBe('main');
      if (url.searchParams.has('event')) {
        expect(url.searchParams.get('event')).toBe('push');
        expect(url.searchParams.get('head_sha')).toBe(tip);
        return { workflow_runs: newer ? [newer] : [] };
      }
      return { workflow_runs: previous ? [{ id: 42, run_attempt: rerun ? 2 : 1 }] : [] };
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
  ['superseded by in-progress push', { env: { GITHUB_SHA: stale }, newer: inProgress },
    'superseded', 'G1: superseded by ' + tip],
  ['superseded by successful push', {
    env: { GITHUB_SHA: stale }, newer: { ...inProgress, status: 'completed', conclusion: 'success' },
  }, 'superseded', 'G1: superseded by ' + tip],
  ['replacement was cancelled', {
    env: { GITHUB_SHA: stale }, newer: { ...inProgress, status: 'completed', conclusion: 'cancelled' },
  }, 'refused', `G1: superseding run 43 for ${tip} was cancelled; dispatch expected_sha=${tip}`],
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
  if (expected === 'superseded') expect(get).toHaveBeenCalledTimes(2);
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
  const pushes = steps.filter(step => step.run?.includes('"$cli" db push'));
  expect(pushes.length).toBeGreaterThan(0);
  for (const step of pushes) {
    expect(steps.indexOf(step)).toBeGreaterThan(guard);
    expect(step.if).toContain("steps.apply_guard.outputs.superseded == 'false'");
  }
  expect(pushes[0].run).toMatch(/trap 'rm -f "\$deploy_temp\/edge\.env"\n[\s\S]+?apply-guard\.cjs summarize[^\n]+\|\|/);
  expect(outputs.superseded).toContain('steps.apply_guard.outputs.superseded');
  expect(concurrency).toEqual({ group: 'deploy-dev-database', 'cancel-in-progress': false });
  for (const app of ['console', 'portal', 'landing', 'ingress']) {
    expect(jobs[app].if).toContain("needs.database.outputs.superseded != 'true'");
  }
});
