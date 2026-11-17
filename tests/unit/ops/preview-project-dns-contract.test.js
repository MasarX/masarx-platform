const fs = require('fs');
const path = require('path');

describe('preview-project DNS contract', () => {
  test('preview readiness probes stay pooler-only on reuse and recovery paths', () => {
    const file = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'scripts',
      'ops',
      'workspace',
      'preview-project.js',
    );
    const body = fs.readFileSync(file, 'utf8');

    const matches = body.match(/includeDirectHost:\s*false/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
