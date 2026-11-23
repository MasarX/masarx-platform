const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const yaml = require('yaml');

const root = resolve(__dirname, '../../..');
const workflows = join(root, '.github/workflows');
const readWorkflow = name => readFileSync(join(workflows, name), 'utf8');
const deploy = yaml.parse(readWorkflow('deploy.yml'));
const probe = yaml.parse(readWorkflow('guarded-egress-probe.yml'));

const names = ['URL', 'USERNAME', 'PASSWORD'].map(suffix => `API_CALLER_GUARDED_EGRESS_PROXY_${suffix}`);
const proxy = names.map(name => ({ name, value: randomBytes(32).toString('hex') }));
const renderer = { name: 'LABEL_RENDERER_SIGNING_KEY', value: randomBytes(32).toString('hex') };
const runnerValues = Object.fromEntries(names.map(name => [name, randomBytes(16).toString('hex')]));
const failure = { status: 1, stdout: '', stderr: '::error::Guarded egress secret read-back failed.\n' };

function readMode(environment, input) {
  const result = spawnSync(process.execPath, ['scripts/deploy/guarded-egress.cjs'], {
    cwd: root, encoding: 'utf8', input, timeout: 7000, windowsHide: true,
    env: { ...process.env, ...runnerValues, DEPLOY_ENV: environment },
  });
  if (result.error) throw result.error;
  const { status, stdout, stderr } = result;
  return { status, stdout, stderr };
}

test('no workflow references a guarded egress proxy input', () => {
  for (const name of readdirSync(workflows).filter(name => /\.ya?ml$/i.test(name))) {
    expect(readWorkflow(name)).not.toContain('API_CALLER_GUARDED_EGRESS_');
  }
});

test('function upload is gated on the existing project secret read-back', () => {
  const { run } = deploy.jobs.database.steps.find(step => step.id === 'deploy');
  expect(run).toContain('set -euo pipefail');
  const capture = 'secrets list --project-ref "$SUPABASE_PROJECT_REF" --output json 2>/dev/null | tee "$deploy_temp/edge-secret-metadata.json" |';
  const gate = 'node scripts/deploy/guarded-egress.cjs < "$deploy_temp/edge-secret-metadata.json" | tee -a "$GITHUB_STEP_SUMMARY"';
  expect(run).toContain(capture);
  expect(run).toContain(gate);
  expect(run).toContain('"$cli" functions deploy');
  expect(run.indexOf(capture)).toBeLessThan(run.indexOf(gate));
  expect(run.indexOf(gate)).toBeLessThan(run.indexOf('"$cli" functions deploy'));
  expect(run.match(/\bsecrets list\b/g)).toHaveLength(2);
  expect(run.match(/guarded-egress\.cjs/g)).toHaveLength(1);
});

test.each(['dev', 'stg', 'prod'])('complete project proxy metadata reports only proxy mode in %s', environment => {
  expect(readMode(environment, JSON.stringify([renderer, ...proxy]))).toEqual({
    status: 0, stdout: 'egress_mode=proxy\n', stderr: '',
  });
});

test('no registered proxy names reports only dev_direct in dev despite runner variables', () => {
  expect(readMode('dev', JSON.stringify([renderer]))).toEqual({
    status: 0, stdout: 'egress_mode=dev_direct\n', stderr: '',
  });
});

test.each(['stg', 'prod', ''])('no registered proxy names fails closed outside dev in %j', environment => {
  expect(readMode(environment, JSON.stringify([renderer]))).toEqual(failure);
});

test.each([
  ['only one proxy name', proxy.slice(0, 1)],
  ['only two proxy names', proxy.slice(1)],
  ['an empty digest', [...proxy.slice(0, 2), { name: names[2], value: '' }]],
  ['a blank digest', [...proxy.slice(0, 2), { name: names[2], value: ' ' }]],
  ['a missing digest', [...proxy.slice(0, 2), { name: names[2] }]],
  ['a non-string digest', [...proxy.slice(0, 2), { name: names[2], value: 42 }]],
  ['a duplicate proxy name', [...proxy, proxy[0]]],
  ['a duplicate unrelated name', [renderer, renderer]],
  ['an invalid list entry', [null]],
  ['an invalid list shape', { entries: proxy }],
])('partial or invalid project metadata fails closed for %s', (_label, listed) => {
  expect(readMode('dev', JSON.stringify(listed))).toEqual(failure);
  expect(readMode('stg', JSON.stringify(listed))).toEqual(failure);
});

test('malformed project metadata fails without echoing the input', () => {
  expect(readMode('dev', `${JSON.stringify(proxy)}${runnerValues[names[0]]}`)).toEqual(failure);
});

test('manual guarded egress workflow reports that runtime proof is pending', () => {
  expect(Object.keys(probe.on)).toEqual(['workflow_dispatch']);
  expect(probe.on.workflow_dispatch.inputs.environment.options).toEqual(['dev', 'stg']);
  expect(probe.jobs.probe.if).toContain("github.ref == 'refs/heads/main'");
  expect(probe.jobs.probe.environment).toBe('${{ inputs.environment }}');
  expect(probe.jobs.probe.steps).toEqual([{
    name: 'Report probe status',
    run: 'echo \'egress_probe=not_configured\' | tee -a "$GITHUB_STEP_SUMMARY"',
  }]);
});
