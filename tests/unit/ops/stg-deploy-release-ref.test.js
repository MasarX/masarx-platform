const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { guard } = require('../../../scripts/deploy/apply-guard.cjs');

const sha = 'a'.repeat(40);
const tip = 'b'.repeat(40);
const tagSha = 'c'.repeat(40);
const tag = 'v1.2.3-rc.4';
const mergeGroup = {
  event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-1-fixture', head_sha: sha, check_suite_id: 11,
};
const mainPush = { ...mergeGroup, event: 'push', head_branch: 'main' };
const gate = {
  id: 20, name: 'ci-gate', head_sha: sha, app: { slug: 'github-actions' }, check_suite: { id: 11 },
  status: 'completed', conclusion: 'success',
};
const devDeploy = {
  id: 30, run_number: 3, run_attempt: 2, head_sha: sha, head_branch: 'main', event: 'push',
  status: 'completed', conclusion: 'success',
};
const olderDevDeploy = { ...devDeploy, id: 29, run_number: 2, run_attempt: 1 };
const diagnosticDispatch = { ...devDeploy, id: 31, run_number: 4, run_attempt: 1, event: 'workflow_dispatch' };
const database = {
  name: 'database', status: 'completed', conclusion: 'success',
  steps: [{ name: 'Record database push attempt', conclusion: 'success' }],
};

let dir;
let env;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-release-ref-'));
  env = {
    GITHUB_API_URL: 'https://example.test',
    GITHUB_REPOSITORY: 'example/repo',
    GITHUB_REF: 'refs/tags/' + tag,
    GITHUB_WORKFLOW_REF: 'example/repo/.github/workflows/deploy-stg.yml@refs/tags/' + tag,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_SHA: sha,
    DEPLOY_ENV: 'stg',
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
  };
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-02-01T00:00:00Z'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function githubFetch({
  ref = { type: 'tag', sha: tagSha },
  target = { type: 'commit', sha },
  comparison = 'ahead',
  ciRuns = [mergeGroup],
  checks = [gate],
  devRuns = [olderDevDeploy, devDeploy],
  latestDatabase = database,
} = {}) {
  return jest.fn(async input => {
    const { pathname, searchParams } = new URL(input);
    const endpoint = pathname.slice('/repos/example/repo'.length);
    switch (endpoint) {
      case '/git/ref/heads/main': return Response.json({ object: { sha: tip } });
      case '/git/ref/tags/' + tag: return Response.json({ object: ref });
      case '/git/tags/' + tagSha: return Response.json({ object: target });
      case '/compare/' + sha + '...' + tip: return Response.json({ status: comparison });
      case '/actions/workflows/public-ci.yml/runs':
        expect(searchParams.get('head_sha')).toBe(sha);
        return Response.json({ workflow_runs: ciRuns });
      case '/commits/' + sha + '/check-runs':
        expect(searchParams.get('check_name')).toBe('ci-gate');
        expect(searchParams.get('filter')).toBe('all');
        return Response.json({ check_runs: checks });
      case '/actions/workflows/deploy.yml/runs':
        expect(searchParams.get('branch')).toBe('main');
        expect(searchParams.get('head_sha')).toBe(sha);
        return Response.json({ workflow_runs: devRuns });
      case '/actions/runs/30/attempts/2/jobs': return Response.json({ jobs: [latestDatabase] });
      case '/actions/runs/29/attempts/1/jobs': return Response.json({ jobs: [database] });
      case '/actions/runs/31/attempts/1/jobs':
        return Response.json({ jobs: [{ ...database, conclusion: 'skipped', steps: [] }] });
      case '/actions/workflows/deploy-stg.yml/runs':
        expect(searchParams.has('created')).toBe(true);
        expect(searchParams.has('branch')).toBe(false);
        return Response.json({ workflow_runs: [] });
      default: throw new Error('Unexpected endpoint: ' + endpoint);
    }
  });
}

const gateRequired = 'release commit needs a successful ci-gate from main push or main merge queue CI';

test.each([
  ['a lightweight tag', {}, { ref: { type: 'commit', sha } }, 'release candidate tag must be annotated'],
  ['a malformed name', { GITHUB_REF: 'refs/tags/v01.2.3-rc.4' }, {}, 'tag must be a numbered release candidate'],
  ['a plain version tag', { GITHUB_REF: 'refs/tags/v1.2.3' }, {}, 'tag must be a numbered release candidate'],
  ['an RC numbered zero', { GITHUB_REF: 'refs/tags/v1.2.3-rc.0' }, {}, 'tag must be a numbered release candidate'],
  ['a tag for another commit', {}, { target: { type: 'commit', sha: tip } }, 'tag must resolve to github.sha'],
  ['a dispatch with a different expected SHA', { GITHUB_EVENT_NAME: 'workflow_dispatch', EXPECTED_SHA: tip },
    {}, 'expected_sha must equal github.sha'],
  ['a commit outside main', {}, { comparison: 'diverged' }, 'release commit is not on main'],
  ['no ci-gate', {}, { checks: [] }, gateRequired],
  ['a ci-gate from a pull request only', {}, { ciRuns: [{ ...mergeGroup, event: 'pull_request' }] }, gateRequired],
  ['a ci-gate from the wrong merge queue', {}, {
    ciRuns: [{ ...mergeGroup, head_branch: 'gh-readonly-queue/dev/pr-1-fixture' }],
  }, gateRequired],
  ['a newer failed ci-gate', {}, { checks: [gate, { ...gate, id: 21, conclusion: 'failure' }] }, gateRequired],
  ['no DEV deploy', {}, { devRuns: [] }, 'no DEV deploy found for the release commit'],
  ['a superseded DEV deploy after an older success', {}, {
    latestDatabase: { ...database, steps: [{ ...database.steps[0], conclusion: 'skipped' }] },
  }, 'latest DEV deploy has no successful database push attempt marker'],
  ['a failed DEV database job after an older success', {}, {
    latestDatabase: { ...database, conclusion: 'failure' },
  }, 'latest DEV deploy did not succeed'],
  ['a failed DEV workflow with a successful database job', {}, {
    devRuns: [olderDevDeploy, { ...devDeploy, conclusion: 'failure' }],
  }, 'latest DEV deploy did not succeed'],
])('the staging release guard refuses %s', async (_name, inputs, fixtures, reason) => {
  const fetchRequest = githubFetch(fixtures);
  await expect(guard({ ...env, ...inputs }, fetchRequest)).resolves.toBe(1);
  expect(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('- G3: ' + reason);
  expect(fs.existsSync(env.GITHUB_OUTPUT)).toBe(false);
  expect(fetchRequest.mock.calls.some(([url]) => url.includes('/workflows/deploy-stg.yml/'))).toBe(false);
});

test.each([
  ['tag push with merge-group CI', {}, mergeGroup, 'G3: expected_sha was not supplied'],
  ['tag dispatch with main-push CI', { GITHUB_EVENT_NAME: 'workflow_dispatch', EXPECTED_SHA: sha }, mainPush,
    'G3: expected_sha matched github.sha'],
])('the staging release guard admits a verified %s', async (_name, inputs, ciRun, dispatchDecision) => {
  const fetchRequest = githubFetch({ ciRuns: [ciRun], devRuns: [olderDevDeploy, diagnosticDispatch, devDeploy] });
  await expect(guard({ ...env, ...inputs }, fetchRequest)).resolves.toBe(0);
  expect(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('superseded=false\n');
  expect(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toBe([
    '## STG database guard', '',
    '- G1: not applicable to tag refs',
    '- G3: release candidate tag name matched',
    '- G3: release candidate tag is annotated',
    '- G3: release candidate tag resolves to github.sha',
    '- ' + dispatchDecision,
    '- G3: release commit is on main',
    '- G3: ci-gate passed from main push or main merge queue CI (check 20)',
    '- G3: latest DEV deploy applied the database (run 30, attempt 2)',
    '- G2: no previous apply found',
    '',
  ].join('\n'));
  expect(fetchRequest.mock.calls.some(([url]) => url.includes('/runs/29/'))).toBe(false);
});
