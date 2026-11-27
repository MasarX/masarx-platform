const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const checker = resolve(__dirname, '../../../apps/console-v2/scripts/check-bundle-size.mjs');
let buildRoot;

beforeEach(() => {
  buildRoot = mkdtempSync(join(tmpdir(), 'console-v2-bundle-size-'));
  mkdirSync(join(buildRoot, 'dist', 'assets'), { recursive: true });
});

afterEach(() => rmSync(buildRoot, { recursive: true, force: true }));

function checkChunk(file, bytes) {
  writeFileSync(join(buildRoot, 'dist', 'assets', file), Buffer.alloc(bytes, 32));
  return spawnSync(process.execPath, [checker], {
    cwd: buildRoot,
    encoding: 'utf8',
    env: { ...process.env, VITE_USE_SEED: 'false' },
    windowsHide: true,
  });
}

test.each([
  ['supabase-auth-client-fixture.js', 63_104],
  ['supabase-auth-js-fixture.js', 60 * 1024],
])('accepts %s at its ceiling and rejects one more byte', (file, ceiling) => {
  const atCeiling = checkChunk(file, ceiling);
  expect(atCeiling.status).toBe(0);
  expect(atCeiling.stdout).toContain(`  ${file}: ${ceiling} bytes`);

  const oversized = checkChunk(file, ceiling + 1);
  expect(oversized.status).toBe(1);
  expect(oversized.stderr).toContain(`  ${file}: ${ceiling + 1} bytes > ${ceiling} bytes`);
});
