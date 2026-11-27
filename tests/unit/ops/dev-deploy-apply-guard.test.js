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
const latest = '2026-01-01T00:00:02Z';
const marker = 'Record database push attempt';
const legacyStep = 'Apply migrations and deploy registered edge functions';
const inProgress = { id: 43, run_number: 10, status: 'in_progress' };

async function fixture({
  env, newer, previous, rerun, markerConclusion = 'success', deployConclusion, history,
} = {}) {
  const decisions = [];
  const get = jest.fn(endpoint => {
    const url = new URL(endpoint, 'https://example.test');
    if (url.pathname === '/git/ref/heads/main') return { object: { sha: tip } };
    if (url.pathname === '/actions/workflows/deploy.yml/runs') {
      const branch = url.searchParams.get('branch');
      expect(['main', 'dev']).toContain(branch);
      if (url.searchParams.has('event')) {
        expect(branch).toBe('main');
        expect(url.searchParams.get('event')).toBe('push');
        expect(url.searchParams.get('head_sha')).toBe(tip);
        return { workflow_runs: newer ? [newer] : [] };
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
  ['steps omitted', { conclusion: 'failure', completed_at: latest, steps: undefined }, 'refused',
    'G2: previous apply failed at run 42; re-arm required'],
  ['steps is not an array', { conclusion: 'failure', completed_at: latest, steps: {} }, 'refused',
    'G2: previous apply failed at run 42; re-arm required'],
  ['malformed steps on a successful job', { conclusion: 'success', completed_at: latest, steps: {} }, 'allow',
    'G2: previous apply at run 42 concluded success'],
  ['empty steps on a failed job', { conclusion: 'failure', completed_at: latest, steps: [] }, 'allow',
    'G2: previous apply at run 41 concluded success'],
  ['malformed steps on a failed job after re-arm', { conclusion: 'failure', completed_at: latest, steps: {} }, 'allow',
    'G2: re-armed after run 42', { DEV_DB_REARMED_AT: '2026-01-01T00:00:03Z' }],
])('%s', async (_label, job, expected, decision, env = {}) => {
  const { result, decisions } = await fixture({ env, history: {
    runs: { main: [{ id: 41, run_attempt: 1 }, { id: 42, run_attempt: 1 }], dev: [] },
    jobs: {
      '/actions/runs/42/attempts/1/jobs': job,
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

test.each([
  ['at the main tip', tip, []],
  ['behind the main tip without a newer run', stale, []],
  ['behind the main tip with a newer run', stale, [inProgress]],
])('ignores a newer dev push when the main push is %s', async (_label, sha, replacements) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-guard-'));
  const env = {
    GITHUB_API_URL: 'https://example.test', GITHUB_REPOSITORY: 'example/repo',
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, RUN_NUMBER: '9',
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), GITHUB_OUTPUT: path.join(dir, 'output'),
  };
  const newerDev = { ...inProgress, id: 44, run_number: 11, run_attempt: 1, head_sha: devTip, head_branch: 'dev' };
  const fetchRequest = jest.fn(async input => {
    const { pathname, searchParams } = new URL(input);
    if (pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: tip } });
    if (pathname.endsWith('/git/ref/heads/dev')) return Response.json({ object: { sha: devTip } });
    if (pathname.endsWith('/actions/workflows/deploy.yml/runs')) {
      if (searchParams.get('branch') === 'dev') {
        const runs = [newerDev];
        if (searchParams.has('created')) runs.push({ id: 42, run_attempt: 1 });
        return Response.json({ workflow_runs: runs });
      }
      return Response.json({ workflow_runs: searchParams.has('event') ? replacements : [] });
    }
    if (pathname.endsWith('/actions/runs/44/attempts/1/jobs')) {
      return Response.json({ jobs: [{ name: 'database', status: 'in_progress' }] });
    }
    if (pathname.endsWith('/actions/runs/42/attempts/1/jobs')) {
      return Response.json({ jobs: [{
        name: 'database', status: 'completed', conclusion: 'success', completed_at: failedAt,
        steps: [{ name: marker, conclusion: 'success' }],
      }] });
    }
    throw new Error('Unexpected endpoint');
  });
  const reportDecision = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const superseded = replacements.length > 0;
    await expect(guard(env, fetchRequest)).resolves.toBe(0);
    expect(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe(`superseded=${superseded}\n`);
    const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
    const requests = fetchRequest.mock.calls.map(([url]) => new URL(url));
    expect(requests.filter(({ pathname }) => pathname.includes('/git/ref/heads/')).map(({ pathname }) => pathname))
      .toEqual(['/repos/example/repo/git/ref/heads/main']);
    const branchQueries = requests.map(({ searchParams }) => searchParams).filter(params => params.has('branch'));
    if (sha !== tip) {
      const mainQuery = branchQueries.shift();
      expect(mainQuery.get('branch')).toBe('main');
      expect(mainQuery.get('event')).toBe('push');
      expect(mainQuery.get('head_sha')).toBe(tip);
    }
    if (superseded) {
      expect(summary).toContain(`G1: superseded by ${tip}`);
      expect(summary).not.toContain('G2:');
      expect(branchQueries).toEqual([]);
    } else {
      expect(summary).toContain('G1: no superseding push');
      expect(summary).toContain('G2: previous apply at run 42 concluded success');
      expect(branchQueries.map(params => params.get('branch'))).toEqual(['main', 'dev']);
      expect(branchQueries.every(params => params.has('created'))).toBe(true);
    }
  } finally {
    reportDecision.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fails closed on invalid JSON without publishing the response body or query', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-guard-'));
  const env = {
    GITHUB_API_URL: 'https://example.test', GITHUB_REPOSITORY: 'example/repo',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: tip, EXPECTED_SHA: tip,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), GITHUB_OUTPUT: path.join(dir, 'output'),
  };
  const body = 'unexpected response content';
  const fetchRequest = jest.fn()
    .mockResolvedValueOnce(Response.json({ object: { sha: tip } }))
    .mockResolvedValueOnce(new Response(body));
  const reportError = jest.spyOn(console, 'error').mockImplementation(() => {});
  const reportDecision = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await expect(guard(env, fetchRequest)).resolves.toBe(1);
    expect(fs.existsSync(env.GITHUB_OUTPUT)).toBe(false);
    expect(fetchRequest.mock.calls[1][0]).toContain('?branch=main&created=');
    const message = 'Guard could not verify GitHub deployment state: invalid JSON from /actions/workflows/deploy.yml/runs';
    const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
    expect(summary).toContain(`- ${message}\n`);
    expect(summary).not.toContain(body);
    expect(reportError.mock.calls).toEqual([[`::error::${message}`]]);
  } finally {
    reportError.mockRestore();
    reportDecision.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ['HTTP error', new Response(null, { status: 500 }), 'GitHub API returned HTTP 500 for /git/ref/heads/main'],
  ['missing main ref', new Response(null, { status: 404 }), 'GitHub API returned HTTP 404 for /git/ref/heads/main'],
  ['malformed main SHA', Response.json({ object: { sha: [tip] } }), 'Invalid main tip'],
  ['network error', null, 'Connection failed for [redacted]'],
])('fails closed on %s without publishing a deployment output', async (_label, response, detail) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-guard-'));
  const env = {
    GH_TOKEN: ['example', 'value'].join('-'),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: tip,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
  };
  const fetchRequest = jest.fn();
  if (response) fetchRequest.mockResolvedValueOnce(response);
  else fetchRequest.mockRejectedValueOnce(new Error('Connection failed for ' + env.GH_TOKEN));
  const reportError = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(guard(env, fetchRequest)).resolves.toBe(1);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(env.GITHUB_OUTPUT)).toBe(false);
    const message = `Guard could not verify GitHub deployment state: ${detail}`;
    expect(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toBe(`## DEV database guard\n\n- ${message}\n`);
    expect(reportError).toHaveBeenCalledWith(`::error::${message}`);
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
