const { createHash, randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const yaml = require('yaml');
const { buildEdgeDbJwtBundle } = require('../../../scripts/ops/workspace/edge-db-jwt');

const workflow = yaml.parse(readFileSync(resolve(__dirname, '../../../.github/workflows/deploy.yml'), 'utf8'));
const { run } = workflow.jobs.database.steps.find(step => step.id === 'deploy');
const name = 'EDGE_INTERNAL_CALLER_ROLES';
const expectedRoles = ['edge_api_gateway_role', 'edge_webhook_role', 'edge_api_caller_role'];
const digest = value => createHash('sha256').update(value).digest('hex');

const mint = run.match(/node <<'NODE'\n([\s\S]+?)\nNODE/);
const readBack = [...run.matchAll(/if ! "\$cli" secrets list[^\n]+\|\n\s+node -e '([\s\S]+?)' 2>\/dev\/null; then\n[^\n]+\n\s+exit 1\nfi/g)].at(-1);

function getWrittenRoles() {
  const writeFileSync = jest.fn();
  const deps = {
    'node:fs': { writeFileSync },
    './scripts/ops/workspace/edge-db-jwt': { buildEdgeDbJwtBundle },
  };
  const runtime = { env: { EDGE_SECRET_FILE: 'fixture.env', SUPABASE_JWT_SECRET: randomBytes(32).toString('hex') } };
  new Function('require', 'process', 'console', mint[1])(key => deps[key], runtime, { log: jest.fn() });
  const [[file, local]] = writeFileSync.mock.calls;
  expect(file).toBe(runtime.env.EDGE_SECRET_FILE);
  return local.match(/^EDGE_INTERNAL_CALLER_ROLES=(.+)$/m)?.[1].split(',');
}

test('DEV writes exactly the reviewed api-caller roles to the Edge secret file', () => {
  expect(getWrittenRoles()).toEqual(expectedRoles);
});

test('DEV excludes public JWT roles from the api-caller allowlist', () => {
  const roles = getWrittenRoles();
  expect(roles).not.toContain('anon');
  expect(roles).not.toContain('authenticated');
});

test.each([
  ['matches', digest(expectedRoles.join(',')), false],
  ['differs', digest('edge_api_caller_role'), true],
  ['is missing', undefined, true],
])('DEV checks the api-caller role digest before function deploy when it %s', (_state, remoteDigest, fails) => {
  expect(readBack.index).toBeGreaterThan(run.indexOf('"$cli" secrets set'));
  expect(readBack.index).toBeLessThan(run.indexOf('"$cli" functions deploy'));

  const entries = [
    ['LABEL_RENDERER_SIGNING_KEY', 'fixture-signing-key'],
    ['LABEL_RENDERER_GATEWAY_JWT', 'fixture-gateway-token'],
    ['EDGE_ENVIRONMENT', 'dev'],
  ];
  const listed = entries.map(([key, value]) => ({ name: key, value: digest(value) }));
  if (remoteDigest !== undefined) listed.push({ name, value: remoteDigest });
  const local = [...entries, [name, expectedRoles.join(',')]].map(pair => pair.join('=')).join('\n');
  const deps = {
    'node:crypto': { createHash },
    'node:fs': { readFileSync: file => file === 0 ? JSON.stringify(listed) : local },
  };
  const runtime = { env: { DEPLOY_ENV: 'dev', EDGE_SECRET_FILE: 'fixture.env' }, exit: jest.fn() };
  new Function('require', 'process', readBack[1])(key => deps[key], runtime);
  expect(runtime.exit.mock.calls).toEqual(fails ? [[1]] : []);
});
