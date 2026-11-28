const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('yaml');

const root = resolve(__dirname, '../../..');
const read = file => readFileSync(resolve(root, file), 'utf8');

test('cloud qualification entry points are retired and the hosted pgTAP runner is still wired', () => {
  const { scripts } = JSON.parse(read('package.json'));
  expect(scripts['test:pgtap:cloud']).toBeUndefined();
  expect(scripts['verify:cloud:e2e-gate']).toBeUndefined();
  expect(scripts['test:pgtap']).toBe('node scripts/tests/run-pgtap-cloud.js');
  expect(scripts['test:pgtap:local']).toBe(scripts['test:pgtap']);

  const { jobs } = parse(read('.github/workflows/public-ci.yml'));
  expect(jobs['database-pgtap'].steps).toContainEqual(expect.objectContaining({
    run: 'node scripts/ci-hosted/backend.cjs',
  }));
  expect(jobs['ci-gate'].needs).toContain('database-pgtap');
});
