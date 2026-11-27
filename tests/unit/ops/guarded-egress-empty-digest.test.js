const { spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { resolve } = require('node:path');
const { surfaces } = require('../../../config/ci/deploy-surfaces.json');

const root = resolve(__dirname, '../../..');
const proxyNames = ['URL', 'USERNAME', 'PASSWORD'].map(suffix => `API_CALLER_GUARDED_EGRESS_PROXY_${suffix}`);

test.each([1, 3])('rejects read-back when %i registered proxy values hash as empty', emptyCount => {
  const empty = createHash('sha256').digest('hex');
  const listed = proxyNames.map((name, index) => ({
    name,
    value: index < emptyCount ? empty : randomBytes(32).toString('hex'),
  }));

  const result = spawnSync(process.execPath, ['scripts/deploy/guarded-egress.cjs'], {
    cwd: root, encoding: 'utf8', input: JSON.stringify(listed), timeout: 7000, windowsHide: true,
    env: { ...process.env, DEPLOY_ENV: 'dev' },
  });
  if (result.error) throw result.error;
  expect(result).toMatchObject({
    status: 1,
    stdout: '',
    stderr: '::error::Guarded egress secret read-back failed.\n',
  });
});

test('GitHub deploy surfaces exclude the Supabase proxy secret names', () => {
  const allowed = surfaces.flatMap(surface => surface.allowed_secret_keys ?? []);
  for (const name of proxyNames) expect(allowed).not.toContain(name);
});
