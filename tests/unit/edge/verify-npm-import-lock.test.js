const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const verifier = 'scripts/edge/verify-npm-import-lock.js';
const version = '1.2.3';
const packageName = 'fixture-package';
const integrity = `sha512-${createHash('sha512').update(packageName).digest('base64')}`;
const remoteUrl = 'https://fixture.example/dependency.ts';

function runVerifier(requested, denoVersion, denoIntegrity = integrity, files = {}, remote = {}) {
  const root = fs.mkdtempSync(path.join(repoRoot, '.tmp-edge-npm-lock-'));
  try {
    const cli = path.join(root, verifier);
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, verifier), cli);
    const specifier = `npm:${packageName}@${requested}`;
    const inputs = {
      'supabase/config.toml': '# Supabase fixture\n',
      'supabase/functions/test-function/source/dependency.ts': `import '${specifier}';\n`,
      ...files,
    };
    for (const [relativePath, contents] of Object.entries(inputs)) {
      const file = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
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
      remote,
    }));
    return spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('accepts a pin with matching npm and Deno resolutions and integrity', () => {
  const result = runVerifier(version, version, integrity, {
    'supabase/config.toml': '# import_map = "./fixture.json"\n',
    'supabase/functions/test-function/deno.jsonc': '{ // "imports": {}\n "compilerOptions": {},\n}',
    'supabase/functions/test-function/index.ts': [
      '// import "jsr:@fixture/unused";',
      'import "./source/dependency.ts";',
      'import "node:path";',
      `import "${remoteUrl}";`,
    ].join('\n'),
  }, { [remoteUrl]: createHash('sha256').update('fixture module').digest('hex') });
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

test.each([
  ['an import-map range alias', {
    'supabase/functions/api-caller/deno.json': '{"imports": {"sb": "npm:@supabase/supabase-js@^2.45.4"}}',
    'supabase/functions/api-caller/index.ts': 'import "sb";',
  }, 'api-caller/deno.json: imports is forbidden'],
  ['an external importMap', {
    'supabase/functions/test-function/deno.jsonc': '{ /* comment */ "importMap": "./map.json", }',
  }, 'test-function/deno.jsonc: importMap is forbidden'],
  ['import-map scopes', {
    'supabase/functions/test-function/deno.json': '{"scopes": {}}',
  }, 'test-function/deno.json: scopes is forbidden'],
  ['a Supabase import_map', {
    'supabase/config.toml': '[functions."test-function"]\n"import_map" = "./functions/test-function/map.json"\n',
  }, 'supabase/config.toml: import_map is forbidden'],
  ['a JSR import', {
    'supabase/functions/test-function/index.ts': 'import(/* lazy load */ `jsr:@fixture/module@1.2.3`);',
  }, 'test-function/index.ts: JSR imports are forbidden'],
  ['a bare specifier', {
    'supabase/functions/test-function/index.ts': 'export { example } from "fixture-package";',
  }, 'test-function/index.ts: bare or unsupported module specifier'],
  ['an npm range under a nested generated folder', {
    'supabase/functions/test-function/source/generated/nested.ts': `import "npm:${packageName}@^1.2.0";`,
  }, `test-function/source/generated/nested.ts: npm:${packageName}@^1.2.0`],
  ['a computed dynamic import', {
    'supabase/functions/test-function/index.ts': 'const target = "./fixture.ts"; import(target);',
  }, 'test-function/index.ts: module specifiers must be string literals'],
  ['an HTTPS import missing from the remote lock entries', {
    'supabase/functions/test-function/index.ts': `import "${remoteUrl}";`,
  }, 'Edge remote imports are missing from deno.lock'],
])('rejects Edge policy violation %s', (_case, files, reason) => {
  const result = runVerifier(version, version, integrity, files);
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 1,
    stderr: expect.stringContaining(reason),
  });
});
