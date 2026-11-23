const { spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parse: parseDotenv } = require('dotenv');
const yaml = require('yaml');

const root = resolve(__dirname, '../../..');
const workflow = name => yaml.parse(readFileSync(join(root, '.github/workflows', name), 'utf8'));
const deploy = workflow('deploy.yml');
const deployStep = deploy.jobs.database.steps.find(step => step.id === 'deploy');
const verifier = [...deployStep.run.matchAll(/secrets list[^\n]+\|\n\s+node -e '([\s\S]+?)' 2>\/dev\/null/g)].at(-1);
const probe = workflow('guarded-egress-probe.yml');
const fixture = randomBytes(12).toString('hex');
const [url, username, password] = ['URL', 'USERNAME', 'PASSWORD'].map(suffix => `API_CALLER_GUARDED_EGRESS_PROXY_${suffix}`);
const proxy = { [url]: `https://${fixture}.example.test`, [username]: `user-${fixture}`, [password]: `${fixture}'#=value` };
const edge = {
  LABEL_RENDERER_SIGNING_KEY: 'fixture-signing-key', LABEL_RENDERER_GATEWAY_JWT: 'fixture-gateway-jwt',
  EDGE_ENVIRONMENT: 'dev', EDGE_INTERNAL_CALLER_ROLES: 'edge_api_caller_role',
};
const baseFile = Object.entries(edge).map(([name, value]) => `${name}=${value}\n`).join('');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digests = values => Object.entries(values).map(([name, value]) => ({ name, value: sha256(value) }));

let directory;
let secretFile;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'guarded-egress-test-'));
  secretFile = join(directory, 'edge.env');
  writeFileSync(secretFile, baseFile, { mode: 0o600 });
});
afterEach(() => {
  rmSync(secretFile);
  rmSync(directory, { recursive: true });
});

function runNode(args, env, input) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', input, timeout: 7000, windowsHide: true,
    env: { ...process.env, [url]: '', [username]: '', [password]: '', EDGE_SECRET_FILE: secretFile, ...env },
  });
  if (result.error) throw result.error;
  const values = [...Object.values(proxy), ...Object.keys(proxy).map(name => env[name]).filter(Boolean)];
  if (values.some(value => `${result.stdout}${result.stderr}`.includes(value))) {
    throw new Error('Guarded egress emitted a proxy setting.');
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function write(environment, values = {}, command = 'append') {
  return runNode(['scripts/deploy/guarded-egress.cjs', command], { DEPLOY_ENV: environment, ...values });
}

function readBack(mode, listed) {
  return runNode(['-e', verifier[1]], { DEPLOY_ENV: 'dev', EDGE_GUARDED_EGRESS_MODE: mode }, JSON.stringify(listed));
}

test('guarded deploy maps masked environment secrets and verifies them before any function upload', () => {
  expect(deploy.jobs.database.environment).toBe('dev');
  for (const name of Object.keys(proxy)) {
    expect(deployStep.env[name]).toBe(`\${{ inputs.mode != 'dry-run' && secrets.${name} || '' }}`);
  }
  const positions = ['guarded-egress.cjs append', 'egress_mode=missing', ' db push', 'secrets set', 'verifyProxyDigests',
    'egress_mode=%s', 'functions deploy'].map(marker => deployStep.run.indexOf(marker));
  expect(positions[0]).toBeGreaterThan(0);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test.each(['dev', 'stg', 'prod'])('guarded deploy writes the complete proxy tuple for %s without logging values', environment => {
  expect(write(environment, proxy)).toEqual({ status: 0, stdout: 'proxy\n', stderr: '' });
  const contents = parseDotenv(readFileSync(secretFile, 'utf8'));
  expect(Object.keys(contents)).toEqual([...Object.keys(edge), ...Object.keys(proxy)]);
  expect(Object.entries({ ...edge, ...proxy }).every(([name, value]) => contents[name] === value)).toBe(true);
});

test.each(['stg', 'prod', 'future', ''])('guarded deploy refuses an empty tuple in non-dev lane %j', environment => {
  expect(write(environment)).toEqual({ status: 1, stdout: '', stderr: '' });
  expect(readFileSync(secretFile, 'utf8')).toBe(baseFile);
});

test.each(Object.keys(proxy))('guarded deploy refuses a partial tuple with %s missing in dev and stg', missing => {
  for (const environment of ['dev', 'stg']) {
    expect(write(environment, { ...proxy, [missing]: '' })).toEqual({ status: 1, stdout: '', stderr: '' });
  }
  expect(readFileSync(secretFile, 'utf8')).toBe(baseFile);
});

test('guarded deploy rejects multiline input before writing any proxy secret', () => {
  expect(write('dev', { ...proxy, [password]: `${fixture}\nEDGE_ENVIRONMENT=dev` }))
    .toEqual({ status: 1, stdout: '', stderr: '' });
  expect(readFileSync(secretFile, 'utf8')).toBe(baseFile);
});

test('guarded deploy reports dev_direct only for an empty tuple and verifies remote absence', () => {
  expect(write('dev')).toEqual({ status: 0, stdout: 'dev_direct\n', stderr: '' });
  expect(readFileSync(secretFile, 'utf8')).toBe(baseFile);
  expect(readBack('dev_direct', digests(edge))).toEqual({ status: 0, stdout: '', stderr: '' });
  expect(readBack('dev_direct', digests({ ...edge, [username]: proxy[username] }))).toEqual({
    status: 1, stdout: '::error::Guarded egress secret read-back failed.\n', stderr: '',
  });
});

test('guarded deploy checks all proxy digests and refuses missing, wrong and duplicate entries', () => {
  expect(write('dev', proxy).status).toBe(0);
  const listed = digests({ ...edge, ...proxy });
  expect(readBack('proxy', listed)).toEqual({ status: 0, stdout: '', stderr: '' });
  for (const name of Object.keys(proxy)) {
    for (const broken of [
      listed.filter(entry => entry.name !== name),
      listed.map(entry => entry.name === name ? { ...entry, value: sha256('other') } : entry),
      [...listed, listed.find(entry => entry.name === name)],
    ]) {
      expect(readBack('proxy', broken)).toEqual({
        status: 1, stdout: '::error::Guarded egress secret read-back failed.\n', stderr: '',
      });
    }
  }
});

test('guarded proxy proof is manual, main-only and bound to the selected dev or stg environment', () => {
  expect(Object.keys(probe.on)).toEqual(['workflow_dispatch']);
  expect(probe.on.workflow_dispatch.inputs.environment.options).toEqual(['dev', 'stg']);
  expect(probe.jobs.probe.if).toContain("github.ref == 'refs/heads/main'");
  expect(probe.jobs.probe.environment).toBe('${{ inputs.environment }}');
  const step = probe.jobs.probe.steps.at(-1);
  expect(step.env.DEPLOY_ENV).toBe(probe.jobs.probe.environment);
  for (const name of Object.keys(proxy)) expect(step.env[name]).toBe(`\${{ secrets.${name} }}`);
  expect(step.run).toContain('node scripts/deploy/guarded-egress.cjs probe');
});

test('guarded proxy proof skips network checks only for dev_direct and emits fixed output', () => {
  expect(write('dev', {}, 'probe')).toEqual({ status: 0, stdout: 'egress_mode=dev_direct\n', stderr: '' });
  expect(write('stg', {}, 'probe')).toEqual({ status: 1, stdout: 'egress_mode=missing\n', stderr: '' });
  expect(write('stg', { ...proxy, API_CALLER_GUARDED_EGRESS_PROOF_SHA: '' }, 'probe')).toEqual({
    status: 1, stdout: 'egress_mode=proxy\n', stderr: '::error::Guarded egress configuration or verification failed.\n',
  });
});
