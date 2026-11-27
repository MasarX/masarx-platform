const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { guard, summarize } = require('../../../scripts/deploy/apply-guard.cjs');

const sha = 'a'.repeat(40);
const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-02-01T00:00:00Z');
const daysAgo = days => new Date(now - days * day).toISOString();
const devEnv = {
  GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: 'example/repo/.github/workflows/deploy.yml@refs/heads/main',
  DEPLOY_ENV: 'dev',
};
const stgEnv = {
  GITHUB_REF: 'refs/tags/v1.0.0-rc.2',
  GITHUB_WORKFLOW_REF: 'example/repo/.github/workflows/deploy-stg.yml@refs/tags/v1.0.0-rc.2',
  DEPLOY_ENV: 'stg',
};

let dir;
let env;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-guard-stg-'));
  env = {
    GITHUB_API_URL: 'https://example.test',
    GITHUB_REPOSITORY: 'example/repo',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: '3',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
  };
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function githubFetch(devConclusion, stgConclusion) {
  const tagSha = 'b'.repeat(40);
  const ciRun = {
    head_sha: sha, event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-1-fixture', check_suite_id: 11,
  };
  const ciGate = {
    id: 12, name: 'ci-gate', head_sha: sha, app: { slug: 'github-actions' }, check_suite: { id: ciRun.check_suite_id },
    status: 'completed', conclusion: 'success',
  };
  const devDeploy = {
    id: 4, run_number: 4, run_attempt: 1, head_branch: 'main', head_sha: sha, event: 'push',
    status: 'completed', conclusion: 'success',
  };
  const history = [
    { id: 1, workflow: 'deploy.yml', branch: 'main', age: 3, name: 'database', conclusion: devConclusion },
    { id: 2, workflow: 'deploy-stg.yml', branch: 'v1.0.0-rc.1', age: 2, name: 'deploy / database', conclusion: stgConclusion },
  ];
  return jest.fn(async input => {
    const { pathname, searchParams } = new URL(input);
    if (pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha } });
    if (pathname.endsWith('/git/ref/tags/v1.0.0-rc.2')) {
      return Response.json({ object: { type: 'tag', sha: tagSha } });
    }
    if (pathname.endsWith('/git/tags/' + tagSha)) return Response.json({ object: { type: 'commit', sha } });
    if (pathname.endsWith('/compare/' + sha + '...' + sha)) return Response.json({ status: 'identical' });
    if (pathname.endsWith('/commits/' + sha + '/check-runs')) return Response.json({ check_runs: [ciGate] });
    if (pathname.endsWith('/actions/workflows/public-ci.yml/runs')) return Response.json({ workflow_runs: [ciRun] });
    if (pathname.endsWith('/actions/workflows/deploy.yml/runs') && searchParams.has('head_sha')) {
      return Response.json({ workflow_runs: [devDeploy] });
    }
    if (pathname.endsWith('/actions/runs/4/attempts/1/jobs')) return Response.json({ jobs: [{
      name: 'database', status: 'completed', conclusion: 'success',
      steps: [{ name: 'Record database push attempt', conclusion: 'success' }],
    }] });
    const workflow = /\/actions\/workflows\/([^/]+)\/runs$/.exec(pathname)?.[1];
    if (workflow) {
      const branch = searchParams.get('branch');
      const [start, end] = searchParams.get('created').split('..').map(Date.parse);
      const runs = history.filter(run => run.workflow === workflow && (!branch || run.branch === branch)
        && now - run.age * day >= start && now - run.age * day <= end);
      return Response.json({ workflow_runs: runs.map(run => ({ id: run.id, run_attempt: 1 })) });
    }
    const id = Number(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/.exec(pathname)?.[1]);
    const run = history.find(row => row.id === id);
    if (!run) throw new Error('Unexpected endpoint');
    return Response.json({ jobs: [{
      name: run.name, status: 'completed', conclusion: run.conclusion, completed_at: daysAgo(run.age),
      steps: [{ name: 'Record database push attempt', conclusion: 'success' }],
    }] });
  });
}

function expectHistory(fetchRequest, workflow, branches, days) {
  const urls = fetchRequest.mock.calls.map(([url]) => new URL(url));
  const history = urls.filter(url => url.searchParams.has('created'));
  const range = [daysAgo(days), daysAgo(0)].map(value => value.replace('.000Z', 'Z')).join('..');
  const endpoint = '/repos/example/repo/actions/workflows/' + workflow + '/runs';
  expect(history.map(({ pathname, searchParams }) => [
    pathname, searchParams.get('branch'), searchParams.get('created'),
  ])).toEqual(branches.map(branch => [endpoint, branch, range]));
}

function summary() {
  return fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
}

test('staging history reads the caller workflow and counts the called database job', async () => {
  const fetchRequest = githubFetch('failure', 'success');
  await expect(guard({ ...env, ...stgEnv }, fetchRequest)).resolves.toBe(0);
  expectHistory(fetchRequest, 'deploy-stg.yml', [null], 30);
  expect(summary()).toContain('## STG database guard\n\n');
  expect(summary()).toContain('G2: previous apply at run 2 concluded success');
  expect(summarize('', '0', '1', { ...env, ...stgEnv })).toMatch(/^## STG database apply\n\n/);
});

test('DEV history ignores staging and retains its exact push output under tag-only settings', async () => {
  const fetchRequest = githubFetch('failure', 'failure');
  await expect(guard({
    ...env, ...devEnv, DEV_DB_REARMED_AT: daysAgo(2), DB_REARMED_AT: daysAgo(4), DB_APPLY_HISTORY_DAYS: '1',
  }, fetchRequest)).resolves.toBe(0);
  expectHistory(fetchRequest, 'deploy.yml', ['main', 'dev'], 30);
  expect(summary()).toBe([
    '## DEV database guard', '', '- G1: no superseding push',
    '- G3: not applicable to push', '- G2: re-armed after run 1', '',
  ].join('\n'));
  expect(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('superseded=false\n');
});

test.each([
  [undefined, 1, 'G2: previous apply failed at run 2; re-arm required'],
  [daysAgo(1), 0, 'G2: re-armed after run 2'],
])('tag re-arm uses DB_REARMED_AT (%s)', async (rearmedAt, status, decision) => {
  await expect(guard({
    ...env, ...stgEnv, DEV_DB_REARMED_AT: daysAgo(1), DB_REARMED_AT: rearmedAt,
  }, githubFetch('success', 'failure'))).resolves.toBe(status);
  expect(summary()).toContain(decision);
});

test('a custom staging history window excludes runs older than the window', async () => {
  const fetchRequest = githubFetch('success', 'failure');
  await expect(guard({
    ...env, ...stgEnv, DB_APPLY_HISTORY_DAYS: '1',
  }, fetchRequest)).resolves.toBe(0);
  expectHistory(fetchRequest, 'deploy-stg.yml', [null], 1);
  expect(summary()).toContain('G2: no previous apply found');
});

test.each(['0', '-2', '2.5', 'invalid', '401', '30000', '99999999', '999999999999999999999'])('refuses invalid history days %s', async days => {
  const fetchRequest = githubFetch('success', 'success');
  await expect(guard({ ...env, ...stgEnv, DB_APPLY_HISTORY_DAYS: days }, fetchRequest)).resolves.toBe(1);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
  expect(summary()).toContain('DB_APPLY_HISTORY_DAYS must be a positive whole number of days');
  expect(fs.existsSync(env.GITHUB_OUTPUT)).toBe(false);
});

test('refuses a malformed workflow ref before querying history', async () => {
  const fetchRequest = githubFetch('success', 'success');
  await expect(guard({ ...env, ...stgEnv, GITHUB_WORKFLOW_REF: 'deploy-stg.yml' }, fetchRequest)).resolves.toBe(1);
  expect(fetchRequest).not.toHaveBeenCalled();
  expect(summary()).toContain('Invalid GITHUB_WORKFLOW_REF');
});
