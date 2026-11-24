const { needsHostedDatabaseInit } = require('../../../scripts/ci-hosted/stack-diagnostics.cjs');
const { rewrite } = require('../../../scripts/ci-hosted/docker-images.cjs');

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
const container = 'supabase_db_synthetic';
const database = { role: 'database', image: 'supabase/postgres', digest: `sha256:${'a'.repeat(64)}` };

test.each([
  ['the hosted from-zero build', { ...hosted, GITHUB_JOB: 'database-build' }, true],
  ['a hosted pgTAP shard', { ...hosted, GITHUB_JOB: 'database-pgtap', PGTAP_SHARD: '2/6' }, true],
  ['an unrelated hosted job', { ...hosted, GITHUB_JOB: 'lint' }, false],
  ['a build without the hosted runner marker', { GITHUB_ACTIONS: 'true', GITHUB_JOB: 'database-build' }, false],
  ['a local invocation', { ...hosted, GITHUB_ACTIONS: 'false', GITHUB_JOB: 'database-build' }, false],
])('scopes database init for %s', (_label, env, expected) => {
  expect(needsHostedDatabaseInit(env)).toBe(expected);
});

test('rejects non-ASCII structural keys while preserving Unicode values for database init', () => {
  const route = `/v1.51/containers/create?name=${container}`;
  const config = { Image: `${database.image}:17`, HostConfig: {}, Labels: { label: 'caf\u00e9' } };
  const create = body => rewrite('POST', route, Buffer.from(JSON.stringify(body)), [database], container);

  expect(() => create({ ...config, 'm\u00e9tadata': true })).toThrow('Invalid Docker HostConfig for database init');
  expect(() => create({ ...config, HostConfig: { 'm\u00e9tadata': true } })).toThrow('Invalid Docker HostConfig for database init');
  expect(JSON.parse(create(config).body)).toMatchObject({ HostConfig: { Init: true }, Labels: config.Labels });
});
