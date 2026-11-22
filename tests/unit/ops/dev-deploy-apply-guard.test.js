const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const { evaluate, summarize } = require('../../../scripts/deploy/apply-guard.cjs');

const tip = 'a'.repeat(40);
const stale = 'b'.repeat(40);
const failedAt = '2026-01-01T00:00:00Z';
const later = '2026-01-01T00:00:01Z';
const marker = 'Record database push attempt';

async function fixture({ env, newer, previous, markerConclusion = 'success' } = {}) {
  const decisions = [];
  const get = jest.fn(endpoint => {
    const url = new URL(endpoint, 'https://example.test');
    if (url.pathname === '/git/ref/heads/main') return { object: { sha: tip } };
    if (url.pathname === '/actions/workflows/deploy.yml/runs') {
      expect(url.searchParams.get('branch')).toBe('main');
      if (url.searchParams.has('event')) {
        expect(url.searchParams.get('event')).toBe('push');
        expect(url.searchParams.get('head_sha')).toBe(tip);
        return { workflow_runs: newer ? [{ run_number: 10 }] : [] };
      }
      return { workflow_runs: previous ? [{ id: 42, run_attempt: 1 }] : [] };
    }
    if (url.pathname === '/actions/runs/42/attempts/1/jobs') {
      return { jobs: [{
        name: 'database', status: 'completed', conclusion: previous, completed_at: failedAt,
        steps: [{ name: marker, conclusion: markerConclusion }],
      }] };
    }
    throw new Error('Unexpected endpoint');
  });
  const result = await evaluate(get, {
    GITHUB_SHA: tip, GITHUB_EVENT_NAME: 'push', RUN_NUMBER: '9', ...env,
  }, decision => decisions.push(decision));
  return { result, decisions, get };
}

test.each([
  ['normal', {}, 'allow', 'G2: no previous apply found'],
  ['stale with no replacement', { env: { GITHUB_SHA: stale } }, 'allow', 'G1: no superseding push'],
  ['superseded', { env: { GITHUB_SHA: stale }, newer: true }, 'superseded', 'G1: superseded by ' + tip],
  ['red with an older re-arm', { previous: 'failure', env: { DEV_DB_REARMED_AT: '2025-12-31T00:00:00Z' } },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['red with an equal re-arm', { previous: 'failure', env: { DEV_DB_REARMED_AT: failedAt } },
    'refused', 'G2: previous apply failed at run 42; re-arm required'],
  ['red re-armed', { previous: 'failure', env: { DEV_DB_REARMED_AT: later } }, 'allow', 'G2: re-armed after run 42'],
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
  expect(outputs.superseded).toContain('steps.apply_guard.outputs.superseded');
  expect(concurrency).toEqual({ group: 'deploy-dev-database', 'cancel-in-progress': false });
  for (const app of ['console', 'portal', 'landing', 'ingress']) {
    expect(jobs[app].if).toContain("needs.database.outputs.superseded != 'true'");
  }
});
