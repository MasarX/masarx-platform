const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

describe('lint:npm-scripts', () => {
  test('package.json scripts reference existing entrypoints', () => {
    const script = path.join(repoRoot, 'scripts', 'tooling', 'lint-npm-scripts.js');
    const res = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
    const output = `${res.stdout || ''}\n${res.stderr || ''}`;
    expect(res.status).toBe(0);
    expect(output).toContain('[lint:npm-scripts] OK');
  });
});

