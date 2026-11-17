const fs = require('fs');
const path = require('path');

describe('preview-project recovery contract', () => {
  test('recreated preview recovery uses a single auth-lag helper per recreate attempt', () => {
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
    const blockStart = body.indexOf('if (projectWasRecreated) {');
    const blockEnd = body.indexOf('const previewJwtSeed', blockStart);

    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEnd).toBeGreaterThan(blockStart);

    const recreatedBlock = body.slice(blockStart, blockEnd);
    const helperCalls = recreatedBlock.match(/waitForPoolerUsableWithAuthLagRecovery\(/g) || [];

    expect(helperCalls).toHaveLength(1);
    expect(recreatedBlock).not.toContain("label: 'pooler after recreate',");
  });
});
