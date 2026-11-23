const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const jwt = require('../../../scripts/ops/workspace/edge-db-jwt');

const root = path.resolve(__dirname, '../../..');
const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8'));
const { run: command } = workflow.jobs.database.steps.find(step => step.id === 'deploy');
const mintScript = command.match(/node <<'RENDERER_MINT' 2>\/dev\/null\n([\s\S]+?)\nRENDERER_MINT/)[1];
const verifyScript = [...command.matchAll(/secrets list[^\n]+\|\n\s+node -e '([\s\S]+?)' 2>\/dev\/null/g)].at(-1)[1];
const signingKey = 'LABEL_RENDERER_SIGNING_KEY';
const gatewayKey = 'LABEL_RENDERER_GATEWAY_JWT';
const secretFile = 'fixture.env';
const projectSecret = crypto.randomBytes(32).toString('hex');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function run(script, { secret = projectSecret, local = '', listed = [] } = {}) {
  const appendFileSync = jest.fn();
  const readFileSync = jest.fn(file => file === 0 ? JSON.stringify(listed) : local);
  const aborted = new Error('script exited');
  const runtime = { env: { SUPABASE_JWT_SECRET: secret, EDGE_SECRET_FILE: secretFile }, exit: jest.fn(() => { throw aborted; }) };
  const console = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  const deps = { 'node:crypto': crypto, 'node:fs': { appendFileSync, readFileSync }, './scripts/ops/workspace/edge-db-jwt': jwt };
  try {
    new Function('require', 'process', 'console', script)(name => deps[name], runtime, console);
  } catch (error) {
    if (error !== aborted) throw error;
  }
  expect(console.error).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  return { appendFileSync, log: console.log, exitCode: runtime.exit.mock.calls[0]?.[0] ?? 0 };
}

test('executes the renderer mint heredoc and masks both credentials before writing', () => {
  const { appendFileSync, log, exitCode } = run(mintScript);
  expect(exitCode).toBe(0);
  expect(appendFileSync).toHaveBeenCalledTimes(1);
  const [file, contents, options] = appendFileSync.mock.calls[0];
  expect(file).toBe(secretFile);
  expect(options).toEqual({ mode: 0o600 });
  const expected = crypto.createHmac('sha256', projectSecret).update('masarx-renderer-sign-v1').digest('hex');
  const token = contents.match(/^LABEL_RENDERER_GATEWAY_JWT=(.+)$/m)[1];
  expect(contents).toBe(`${signingKey}=${expected}\n${gatewayKey}=${token}\n`);
  expect(jwt.isJwtSignedWithSecret(token, projectSecret)).toBe(true);
  expect(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).role).toBe('edge_renderer_gateway_role');
  expect(log.mock.calls).toEqual([[`::add-mask::${expected}`], [`::add-mask::${token}`]]);
  expect(log.mock.invocationCallOrder[1]).toBeLessThan(appendFileSync.mock.invocationCallOrder[0]);
});

test('fails before writing when the project JWT secret is missing', () => {
  const { appendFileSync, log, exitCode } = run(mintScript, { secret: '' });
  expect(exitCode).toBe(1);
  expect(appendFileSync).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

const values = { [signingKey]: crypto.randomBytes(32).toString('hex'), [gatewayKey]: crypto.randomBytes(32).toString('hex') };
const entries = Object.entries(values);
const toEnv = pairs => pairs.map(([name, value]) => `${name}=${value}\n`).join('');
const listedDigests = entries.map(([name, value]) => ({ name, value: digest(value) }));

test('verifies when both renderer digests match', () => {
  const { log, exitCode } = run(verifyScript, { local: toEnv(entries), listed: listedDigests });
  expect(exitCode).toBe(0);
  expect(log).not.toHaveBeenCalled();
});

test.each([
  [signingKey, 'mismatch'], [gatewayKey, 'mismatch'],
  [signingKey, 'missing digest'], [gatewayKey, 'missing digest'],
  [signingKey, 'missing local value'], [gatewayKey, 'missing local value'],
])('rejects %s on %s', (name, condition) => {
  const local = toEnv(entries.filter(([key]) => key !== name || condition !== 'missing local value'));
  const listed = listedDigests.filter(row => row.name !== name || condition !== 'missing digest')
    .map(row => row.name === name && condition === 'mismatch' ? { ...row, value: '0'.repeat(64) } : row);
  const { log, exitCode } = run(verifyScript, { local, listed });
  expect(exitCode).toBe(1);
  expect(log).not.toHaveBeenCalled();
});

test('the deploy step gates the function upload on both digest verifiers', () => {
  const markers = ["node <<'RENDERER_MINT'", 'secrets set', 'Marketing token verification failed.',
    'Renderer credential digest verification failed.', 'functions deploy'];
  const positions = markers.map(marker => command.indexOf(marker));
  expect(positions[0]).toBeGreaterThan(-1);
  for (let index = 1; index < positions.length; index++) expect(positions[index]).toBeGreaterThan(positions[index - 1]);
  expect(command).toMatch(/RENDERER_MINT\nthen\n\s*echo '[^']+'\n\s*exit 1\nfi/);
  expect(command).toMatch(/2>\/dev\/null; then\n\s*echo '::error::Renderer credential digest verification failed\.'\n\s*exit 1\nfi/);
  expect(command).toContain('set -euo pipefail');
});
