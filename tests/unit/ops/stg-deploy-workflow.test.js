const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('yaml');
const { evaluate } = require('../../../scripts/deploy/apply-guard.cjs');

const root = resolve(__dirname, '../../..');
const workflow = parse(readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8'));
const { database, summary } = workflow.jobs;
const preflight = database.steps.find(step => step.id === 'egress_preflight');
const deploy = database.steps.find(step => step.id === 'deploy');
const refGuard = summary.steps[0].run;

test('reuses deploy jobs with a target environment and the release evidence permission', () => {
  expect(workflow.on.workflow_call.inputs).toEqual({
    environment: { type: 'string', required: true },
    mode: { type: 'string', default: 'deploy' },
    expected_sha: { type: 'string' },
  });
  expect(database.permissions.checks).toBe('read');
  for (const name of ['database', 'console', 'portal', 'landing', 'ingress']) {
    const job = workflow.jobs[name];
    expect(job.environment).toBe(workflow.env.DEPLOY_ENV);
    expect(job.concurrency).toEqual({
      group: `deploy-${workflow.env.DEPLOY_ENV}-${name}`,
      'cancel-in-progress': false,
    });
    expect(job.steps[0].run.startsWith(refGuard)).toBe(true);
    expect(job.steps[0].env.CONFIGURED).toContain("env.DEPLOY_ENV == 'dev' || vars.DEPLOY_TARGET_ENV == env.DEPLOY_ENV");
  }
});

test.each([
  ['dev', 'refs/heads/main', 0],
  ['dev', 'refs/tags/v0.2.0-rc.1', 1],
  ['stg', 'refs/tags/v0.2.0-rc.1', 0],
  ['stg', 'refs/tags/v10.21.32-rc.40', 0],
  ['stg', 'refs/heads/main', 1],
  ['stg', 'refs/heads/v0.2.0-rc.1', 1],
  ['stg', 'refs/tags/v00.2.0-rc.1', 1],
  ['stg', 'refs/tags/v0.2.0-rc.01', 1],
  ['stg', 'refs/tags/v0.2.0-rc.1-extra', 1],
  ['stg', 'refs/tags/v0.2.0', 1],
  ['prod', 'refs/tags/v0.2.0-rc.1', 1],
])('deploy ref admission for %s and %s exits %i', (environment, ref, status) => {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', refGuard], {
    env: { ...process.env, DEPLOY_ENV: environment, GITHUB_REF: ref, STG_RELEASE_REF_PATTERN: workflow.env.STG_RELEASE_REF_PATTERN },
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
});

test('staging must pass guarded egress preflight before database mutations', () => {
  const frozenLock = database.steps.find(step => step.id === 'edge_lock');
  expect(database.steps.indexOf(frozenLock)).toBeLessThan(database.steps.indexOf(preflight));
  expect(database.steps.indexOf(preflight)).toBeLessThan(database.steps.indexOf(deploy));
  expect(preflight.if).toBe("env.DEPLOY_ENV == 'stg' && steps.edge_lock.outcome == 'success'");
  expect(preflight.run).toContain('set -euo pipefail');
  expect(preflight.run).toMatch(/secrets list[^\n]+--output json[^\n]*\|\n\s+node scripts\/deploy\/guarded-egress\.cjs/);
  expect(deploy.if).toContain("(env.DEPLOY_ENV == 'dev' || steps.egress_preflight.outcome == 'success')");
  expect(deploy.run).toContain('"$cli" db push --linked');
});

test.each([true, false])('staging reads back caller roles without an environment marker when roles match=%s', matches => {
  const readBack = deploy.run.match(/tee "\$deploy_temp\/edge-secret-metadata\.json" \|\n\s+node -e '([\s\S]+?)' 2>\/dev\/null/);
  const names = ['LABEL_RENDERER_SIGNING_KEY', 'LABEL_RENDERER_GATEWAY_JWT', 'EDGE_INTERNAL_CALLER_ROLES'];
  const local = names.map(name => `${name}=fixture`).join('\n');
  const listed = names.map(name => ({
    name,
    value: createHash('sha256').update(name === 'EDGE_INTERNAL_CALLER_ROLES' && !matches ? 'stale' : 'fixture').digest('hex'),
  }));
  const read = file => file === 0 ? JSON.stringify(listed) : local;
  const dependencies = name => name === 'node:fs' ? { readFileSync: read } : { createHash };
  const runtime = { env: { DEPLOY_ENV: 'stg', EDGE_SECRET_FILE: 'fixture.env' }, exit: jest.fn() };

  new Function('require', 'process', readBack[1])(dependencies, runtime);
  expect(runtime.exit.mock.calls).toEqual(matches ? [] : [[1]]);
});

test.each([undefined, ''])('a tag dispatch with expected_sha=%j refuses before release evidence lookup', async expectedSha => {
  const sha = 'a'.repeat(40);
  const annotation = 'b'.repeat(40);
  const tag = 'v0.2.0-rc.1';
  const tagPath = '/git/ref/tags/' + tag;
  const annotationPath = '/git/tags/' + annotation;
  const get = jest.fn(async path => ({
    '/git/ref/heads/main': { object: { sha } },
    [tagPath]: { object: { type: 'tag', sha: annotation } },
    [annotationPath]: { object: { type: 'commit', sha } },
  })[path]);
  const record = jest.fn();
  const env = { GITHUB_REF: 'refs/tags/' + tag, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: sha, EXPECTED_SHA: expectedSha };

  await expect(evaluate(get, env, record)).resolves.toBe('refused');
  expect(record).toHaveBeenLastCalledWith('G3: expected_sha is required for a tag dispatch');
  expect(get.mock.calls.flat()).toEqual(['/git/ref/heads/main', tagPath, annotationPath]);
});
