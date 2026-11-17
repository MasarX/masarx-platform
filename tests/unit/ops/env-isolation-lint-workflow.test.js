const fs = require('fs');
const path = require('path');

describe('env-isolation-lint workflow defaults', () => {
  const workflowFile = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'env-isolation-lint.yml',
  );

  test('uses enforce mode by default (fail-closed)', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');
    expect(body).toContain('name: Environment Isolation Lint');
    expect(body).toContain('default: enforce');
    expect(body).toContain("vars.ENV_ISOLATION_LINT_MODE || 'enforce'");
  });
});
