const fs = require('fs');
const path = require('path');

describe('legacy worker-plan issue template retirement', () => {
  const templatePath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'ISSUE_TEMPLATE',
    'worker-plan-assignment.yml',
  );

  test('removes the legacy worker-plan assignment issue form', () => {
    expect(fs.existsSync(templatePath)).toBe(false);
  });
});
