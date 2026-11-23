const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const verifier = 'scripts/edge/verify-npm-import-lock.js';
const version = '1.2.3';
const packageName = 'fixture-package';
const integrity = `sha512-${createHash('sha512').update(packageName).digest('base64')}`;

function runVerifier(requested, denoVersion, denoIntegrity = integrity) {
  const root = fs.mkdtempSync(path.join(repoRoot, '.tmp-edge-npm-lock-'));
  try {
    const cli = path.join(root, verifier);
    const entrypoint = path.join(root, 'supabase/functions/test-function/source/dependency.ts');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, verifier), cli);
    const specifier = `npm:${packageName}@${requested}`;
    fs.writeFileSync(entrypoint, `import '${specifier}';\n`);
    const registry = ['registry', 'npmjs', 'org'].join('.');
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
      packages: { [`node_modules/${packageName}`]: {
        version, integrity, resolved: `https://${registry}/${packageName}/-/${packageName}-${version}.tgz`,
      } },
    }));
    fs.writeFileSync(path.join(root, 'deno.lock'), JSON.stringify({
      version: '5',
      specifiers: denoVersion ? { [specifier]: denoVersion } : {},
      npm: denoVersion ? { [`${packageName}@${denoVersion}`]: { integrity: denoIntegrity } } : {},
    }));
    return spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('accepts a pin with matching npm and Deno resolutions and integrity', () => {
  const result = runVerifier(version, version);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('1 imports across 1 packages');
});

test.each([
  ['range import', '^1.2.0', version, 'are not pinned to package-lock.json', integrity],
  ['npm pin drift', '1.2.2', '1.2.2', 'are not pinned to package-lock.json', integrity],
  ['missing Deno pin', version, undefined, 'missing from deno.lock', integrity],
  ['Deno resolution drift', version, '1.2.2', 'are not pinned to package-lock.json', integrity],
  ['Deno integrity drift', version, version, 'lack matching registry integrity',
    `sha512-${createHash('sha512').update('different bytes').digest('base64')}`],
])('rejects %s', (_case, requested, denoVersion, reason, denoIntegrity) => {
  const result = runVerifier(requested, denoVersion, denoIntegrity);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(reason);
  expect(result.stderr).toContain(`test-function/source/dependency.ts: npm:${packageName}@${requested}`);
});
