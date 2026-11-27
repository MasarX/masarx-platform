'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { use_api_bundle_limit_bytes } = require('../../config/edge/functions.json');

const root = resolve(__dirname, '../..');
const script = 'scripts/edge/verify-frozen-lock.cjs';
const workdir = '.edge-frozen';
const packageName = 'qrcode-generator@1.5.2';
assert.equal(process.env.EDGE_FROZEN_WORKDIR, workdir);

for (const scenario of ['clean lock', 'missing npm entry', 'changed integrity hash']) {
  const fixture = mkdtempSync(join(tmpdir(), 'edge-bundle-drift-'));
  const write = (file, content) => {
    const destination = join(fixture, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  write('config/edge/functions.json', JSON.stringify({
    use_api_bundle_limit_bytes,
    functions: [{ name: 'fixture-edge', enabled: true }],
  }));
  write('supabase/functions/fixture-edge/index.ts', `import "npm:${packageName}";\n`);
  const lock = JSON.parse(readFileSync(join(root, 'deno.lock'), 'utf8'));
  if (scenario === 'missing npm entry') delete lock.npm[packageName];
  if (scenario === 'changed integrity hash') {
    lock.npm[packageName].integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
  }
  write('deno.lock', JSON.stringify(lock));
  mkdirSync(join(fixture, dirname(script)), { recursive: true });
  copyFileSync(join(root, script), join(fixture, script));

  const result = spawnSync(process.execPath, [script], {
    cwd: fixture, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
  });
  assert.ifError(result.error);
  const hasManifest = existsSync(join(fixture, workdir, 'SHA256SUMS'));
  if (scenario === 'clean lock') {
    assert.equal(result.status, 0, result.stderr);
    assert(hasManifest);
  } else {
    assert(result.status > 0, `Frozen bundle accepted ${scenario}`);
    assert.match(result.stderr, /^fixture-edge: error:/m);
    assert(result.stderr.includes(packageName), result.stderr);
    assert(!hasManifest, `Frozen bundle emitted a manifest for ${scenario}`);
  }
  console.log(`Frozen Edge bundle fixture passed: ${scenario}.`);
}
