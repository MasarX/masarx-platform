const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test.each([
  ['absent root remains strict by default', 'absent', [], 1],
  ['absent root is optional only with the explicit flag', 'absent', ['--if-present'], 0],
  ['a present root without canonical shared files fails', 'partial', ['--if-present'], 1],
  ['full checkout synchronizes normally', 'full', [], 0],
  ['full checkout also synchronizes with the unit flag', 'full', ['--if-present'], 0],
])('shared preparation: %s', (_label, state, args, status) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-shared-preflight-'));
  try {
    const script = path.join(root, 'scripts', 'edge', 'sync-shared.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../../scripts/edge/sync-shared.js'), script);
    fs.copyFileSync(path.resolve(__dirname, '../../../scripts/edge/shared-layout.cjs'), path.join(path.dirname(script), 'shared-layout.cjs'));
    const functions = path.join(root, 'supabase', 'functions');
    if (state !== 'absent') fs.mkdirSync(functions, { recursive: true });
    if (state === 'full') {
      fs.mkdirSync(path.join(functions, '_shared'));
      fs.writeFileSync(path.join(functions, '_shared', 'mod.mjs'), 'export const value = 1;\n');
      fs.mkdirSync(path.join(functions, 'fixture', '_shared'), { recursive: true });
      fs.writeFileSync(path.join(functions, 'fixture', '_shared', 'stale'), 'obsolete');
    }
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root, encoding: 'utf8', timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    if (status === 1) expect(result.stderr).toContain('Source folder supabase/functions/_shared not found.');
    if (state === 'absent') expect(fs.existsSync(functions)).toBe(false);
    if (state === 'full') {
      expect(fs.readFileSync(path.join(functions, 'fixture', '_shared', 'mod.mjs'), 'utf8'))
        .toBe(fs.readFileSync(path.join(functions, '_shared', 'mod.mjs'), 'utf8'));
      expect(fs.existsSync(path.join(functions, 'fixture', '_shared', 'stale'))).toBe(false);
      expect(result.stdout).toContain('Completed.');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
