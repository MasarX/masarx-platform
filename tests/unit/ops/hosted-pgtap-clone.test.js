const { cloneHostedDatabases } = require('../../../scripts/ci-hosted/backend.cjs');
const { rewrite } = require('../../../scripts/ci-hosted/docker-images.cjs');

test('hosted pgTAP creates worker clones using WAL_LOG', async () => {
  const admin = jest.fn()
    .mockResolvedValueOnce(JSON.stringify({ owner: 'fixture_owner', limit: -1, explicitAcl: false }))
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce('t')
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce('[]')
    .mockResolvedValueOnce('');
  await cloneHostedDatabases(admin, ['pgtap_worker_1'], []);
  expect(admin).toHaveBeenNthCalledWith(4,
    'CREATE DATABASE pgtap_worker_1 TEMPLATE postgres STRATEGY WAL_LOG OWNER fixture_owner CONNECTION LIMIT -1');
});

test('the hosted shard Postgres startup logs connections and identifies backends', () => {
  const pins = [{ image: 'example/database', digest: `sha256:${'a'.repeat(64)}` }];
  const container = 'supabase_db_hosted-fixture';
  const postgres = 'docker-entrypoint.sh postgres -D /etc/postgresql';
  const script = ["cat <<'EOF' >> /etc/postgresql/postgresql.conf && \\", postgres, '# fixture', 'EOF'].join('\n');
  const body = Buffer.from(JSON.stringify({ Image: 'example/database:fixture', Entrypoint: ['sh', '-c', script] }));
  const create = (name, request = body) => JSON.parse(rewrite('POST', `/v1.51/containers/create?name=${name}`, request, pins, container).body);
  const [shell, option, configured] = create(container).Entrypoint;
  expect([shell, option]).toEqual(['sh', '-c']);
  expect(configured).toContain(`${postgres} -c log_connections=on -c log_disconnections=on`);
  expect(configured).toMatch(/-c 'log_line_prefix=[^']*%p[^']*%u[^']*%d[^']*%a[^']*'\n/);
  expect(configured).toContain('\n# fixture\nEOF');
  expect(create('supabase_db_other').Entrypoint[2]).toBe(script);
  const unknownStartup = Buffer.from(JSON.stringify({ Image: 'example/database:fixture', Entrypoint: ['postgres'] }));
  expect(() => create(container, unknownStartup)).toThrow('Unrecognized hosted Postgres startup command');
});
