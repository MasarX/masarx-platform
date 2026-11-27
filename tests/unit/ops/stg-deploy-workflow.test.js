const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');
const { evaluate } = require('../../../scripts/deploy/apply-guard.cjs');

const root = resolve(__dirname, '../../..');
const workflow = parse(readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8'));
const { database, summary } = workflow.jobs;
const preflight = database.steps.find(step => step.id === 'egress_preflight');
const deploy = database.steps.find(step => step.id === 'deploy');
const refGuard = summary.steps[0].run;
const deployJobs = ['database', 'console', 'portal', 'landing', 'ingress'];

test('reuses deploy jobs with a target environment and the release evidence permission', () => {
  expect(workflow.on.workflow_call.inputs).toEqual({
    environment: { type: 'string', required: true },
    mode: { type: 'string', default: 'deploy' },
    expected_sha: { type: 'string' },
  });
  expect(database.permissions.checks).toBe('read');
  for (const name of deployJobs) {
    const job = workflow.jobs[name];
    expect(job.environment).toBe(workflow.env.DEPLOY_ENV);
    expect(job.concurrency).toEqual({
      group: `deploy-${workflow.env.DEPLOY_ENV}-${name}`,
      'cancel-in-progress': false,
    });
    expect(job.steps[0].run.startsWith(refGuard)).toBe(true);
    expect(job.env.DEPLOY_TARGET_ENV).toBe('${{ vars.DEPLOY_TARGET_ENV }}');
    expect(Object.keys(job.steps[0].env)).toEqual(['CONFIGURED']);
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

test.each([
  ['dev', 'refs/heads/main', '', 'true', 'true'],
  ['stg', 'refs/tags/v0.2.0-rc.1', '', 'true', 'false'],
  ['stg', 'refs/tags/v0.2.0-rc.1', 'dev', 'true', 'false'],
  ['stg', 'refs/tags/v0.2.0-rc.1', 'stg', 'true', 'true'],
  ['stg', 'refs/tags/v0.2.0-rc.1', 'stg', 'false', 'false'],
])('deploy guard for %s on %s with target %j and credentials %s reports configured=%s',
  (environment, ref, target, credentials, configured) => {
    const directory = mkdtempSync(join(tmpdir(), 'stg-deploy-guard-'));
    try {
      for (const name of deployJobs) {
        const output = join(directory, name);
        const guard = workflow.jobs[name].steps[0];
        const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', guard.run], {
          env: {
            ...process.env,
            CONFIGURED: credentials,
            DEPLOY_ENV: environment,
            DEPLOY_TARGET_ENV: target,
            GITHUB_OUTPUT: output,
            GITHUB_REF: ref,
            STG_RELEASE_REF_PATTERN: workflow.env.STG_RELEASE_REF_PATTERN,
          },
          encoding: 'utf8',
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(readFileSync(output, 'utf8')).toBe(`configured=${configured}\n`);
        expect(result.stdout).toBe(configured === 'false' ? `::notice::${name} skipped: not configured\n` : '');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

test.each(['match', 'mismatch', 'missing digest', 'missing local value'])(
  'staging reads back caller roles without an environment marker when the roles are %s', state => {
    const readBack = deploy.run.match(/tee "\$deploy_temp\/edge-secret-metadata\.json" \|\n\s+node -e '([\s\S]+?)' 2>\/dev\/null/);
    const callerRoles = 'EDGE_INTERNAL_CALLER_ROLES';
    const names = ['LABEL_RENDERER_SIGNING_KEY', 'LABEL_RENDERER_GATEWAY_JWT', callerRoles];
    const local = names.filter(name => state !== 'missing local value' || name !== callerRoles)
      .map(name => `${name}=fixture`).join('\n');
    const listed = names.filter(name => state !== 'missing digest' || name !== callerRoles)
      .map(name => ({
        name,
        value: createHash('sha256').update(name === callerRoles && state === 'mismatch' ? 'stale' : 'fixture').digest('hex'),
      }));
    const read = file => file === 0 ? JSON.stringify(listed) : local;
    const dependencies = name => name === 'node:fs' ? { readFileSync: read } : { createHash };
    const runtime = { env: { DEPLOY_ENV: 'stg', EDGE_SECRET_FILE: 'fixture.env' }, exit: jest.fn() };

    new Function('require', 'process', readBack[1])(dependencies, runtime);
    expect(runtime.exit.mock.calls).toEqual(state === 'match' ? [] : [[1]]);
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
