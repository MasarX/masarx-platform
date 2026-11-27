const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('the CI review verdict self-check passes with synthetic PRs and Git trees', () => {
  const helper = path.resolve(__dirname, '../../../scripts/ci-hosted/review-verdict.cjs');
  const output = execFileSync(process.execPath, [helper, '--self-check'], { encoding: 'utf8' });
  expect(output.trim()).toBe('Review verdict self-checks passed');
});
