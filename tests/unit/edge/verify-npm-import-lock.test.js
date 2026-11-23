const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const verifier = 'scripts/edge/verify-npm-import-lock.js';
const version = '1.2.3';
const packageName = 'fixture-package';
const integrity = `sha512-${createHash('sha512').update(packageName).digest('base64')}`;
const remoteUrl = 'https://fixture.example/dependency.ts';

function runVerifier(requested, denoVersion, denoIntegrity = integrity, files = {}, remote = {}, link) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-npm-lock-'));
  try {
    const cli = path.join(root, verifier);
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, verifier), cli);
    const vendorHelper = 'scripts/edge/prepare-resource-import-exceljs.js';
    fs.copyFileSync(path.join(repoRoot, vendorHelper), path.join(root, vendorHelper));
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
    if (link) {
      fs.symlinkSync(path.join(root, 'supabase/outside'), path.join(root, link),
        process.platform === 'win32' ? 'junction' : 'dir');
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
    return spawnSync(process.execPath, [cli], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') },
      windowsHide: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('accepts a pin with matching npm and Deno resolutions and integrity', () => {
  const result = runVerifier(version, version, integrity, {
    'supabase/config.toml': '# import_map = "./fixture.json"\n[functions.test-function]\nentrypoint = "functions/test-function/index.ts"\n',
    'supabase/functions/test-function/deno.jsonc': '{ // "imports": {}\n "deploy": {"verify_jwt": true},\n}',
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

test.each([
  ['a function fallback import map', {
    'supabase/functions/test-function/IMPORT_MAP.JSON': '{}',
  }, 'test-function/IMPORT_MAP.JSON: import_map.json is forbidden'],
  ['the shared fallback import map', {
    'supabase/functions/import_map.json': '{}',
  }, 'import_map.json: import_map.json is forbidden'],
  ['an import map inside the checked vendor directory', {
    'supabase/functions/resource-import-studio/_vendor/import_map.json': '{}',
  }, 'resource-import-studio/_vendor/import_map.json: import_map.json is forbidden'],
  ['a remote Supabase import_map', {
    'supabase/config.toml': '[remotes.fixture.functions.test-function]\nimport_map = "./map.json"\n',
  }, 'supabase/config.toml: import_map is forbidden'],
  ['an out-of-tree entrypoint', {
    'supabase/config.toml': '[functions.test-function]\nentrypoint = "functions-other/index.ts"\n',
    'supabase/functions-other/index.ts': 'export {};',
  }, 'supabase/config.toml: entrypoint must resolve inside supabase/functions'],
  ['an out-of-tree relative import', {
    'supabase/functions/test-function/index.ts': 'import "../../outside/index.ts";',
    'supabase/outside/index.ts': 'export {};',
  }, 'test-function/index.ts: relative import must resolve inside supabase/functions'],
  ['an encoded out-of-tree relative import', {
    'supabase/functions/test-function/index.ts': 'export * from "./%2e%2e/%2e%2e/outside/index.ts";',
    'supabase/outside/index.ts': 'export {};',
  }, 'test-function/index.ts: relative import must resolve inside supabase/functions'],
  ['a directory link', {
    'supabase/outside/index.ts': 'export {};',
  }, 'test-function/linked: symlinks and reparse points are forbidden', 'supabase/functions/test-function/linked'],
  ['an unapproved Deno workspace key', {
    'supabase/functions/test-function/deno.json': '{"workspace": []}',
  }, 'test-function/deno.json: workspace is forbidden'],
  ['an unapproved Deno prototype key', {
    'supabase/functions/test-function/deno.jsonc': '{"__proto__": {}}',
  }, 'test-function/deno.jsonc: __proto__ is forbidden'],
  ['an npm range under an unlisted vendor folder', {
    'supabase/functions/test-function/_vendor/index.ts': `import "npm:${packageName}@^1.2.0";`,
  }, `test-function/_vendor/index.ts: npm:${packageName}@^1.2.0`],
])('rejects review regression %s', (_case, files, reason, link = undefined) => {
  const result = runVerifier(version, version, integrity, files, {}, link);
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 1,
    stderr: expect.stringContaining(reason),
  });
});
