const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('structure lint ignores evidence paperwork while requiring a tracked lockfile', () => {
  const root = path.resolve(__dirname, '../../..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-structure-'));
  try {
    for (const relative of ['scripts/tooling/check-structure.js', 'config/lint/structure-rules.json']) {
      const target = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, relative), target);
    }
    for (const relative of [
      'docs/ops/evidence/2026-10-10/artifact/result.json',
      'docs/ops/evidence/2026-10-10/artifact.zip',
      'docs/ops/evidence/20261010/result.json',
      'package-lock.json',
    ]) {
      const target = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{}\n');
    }
    for (const args of [['init', '--quiet'], ['add', '.']]) {
      const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8', windowsHide: true });
      expect({ status: result.status, error: result.error }).toEqual({ status: 0, error: undefined });
    }
    const lint = () => spawnSync(process.execPath, ['scripts/tooling/check-structure.js'], {
      cwd: fixture,
      encoding: 'utf8',
      windowsHide: true,
    });
    const accepted = lint();
    expect({ status: accepted.status, stderr: accepted.stderr }).toEqual({ status: 0, stderr: '' });

    fs.unlinkSync(path.join(fixture, 'package-lock.json'));
    const rejected = lint();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('package-lock.json must exist and be tracked');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
