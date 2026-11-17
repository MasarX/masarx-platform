const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validatePublicKey, verifyPrebuilt } = require('../../../scripts/ops/vercel/validate-build');

const jwt = role => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role })).toString('base64url'),
  'synthetic-signature',
].join('.');

test('accepts only public Supabase key types without exposing rejected values', () => {
  expect(() => validatePublicKey(jwt('anon'))).not.toThrow();
  expect(() => validatePublicKey('sb_publishable_synthetic')).not.toThrow();
  for (const key of ['', 'sb_publishable_', 'sb_secret_synthetic', jwt('service_role'), jwt('authenticated'), 'invalid.jwt.value']) {
    expect(() => validatePublicKey(key)).toThrow(/^NEXT_PUBLIC_SUPABASE_ANON_KEY must be an anon JWT or sb_publishable_ key$/);
  }
});

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuilt-validation-')); });
afterEach(() => {
  expect(path.resolve(root).startsWith(path.join(os.tmpdir(), 'prebuilt-validation-'))).toBe(true);
  fs.rmSync(root, { recursive: true, force: true });
});
function write(file, content = '') {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function config(filePathMap) {
  write('.vercel/output/functions/api/sample.func/.vc-config.json', JSON.stringify({ filePathMap }));
}

test('resolves map values against the deployment root, including hoisted dependencies', () => {
  write('node_modules/synthetic/helper.js');
  config({ 'different/destination.js': 'node_modules/synthetic/helper.js' });
  expect(verifyPrebuilt(root)).toEqual({ functions: 1, files: 1 });
});

test('checks every function and bounds missing-file diagnostics to five paths', () => {
  write('present.js');
  config({ present: 'present.js' });
  const missing = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`dest-${i}`, `missing-${i}.js`]));
  write('.vercel/output/functions/other.func/.vc-config.json', JSON.stringify({ filePathMap: missing }));
  expect(() => verifyPrebuilt(root)).toThrow('Missing prebuilt files (first 5):\nmissing-0.js\nmissing-1.js\nmissing-2.js\nmissing-3.js\nmissing-4.js');
  try { verifyPrebuilt(root); } catch (error) { expect(error.message).not.toContain('missing-5.js'); }
});

test('follows function aliases without traversing bundled dependency directories', () => {
  write('present.js');
  config({ present: 'present.js' });
  const functions = path.join(root, '.vercel/output/functions');
  fs.symlinkSync(path.join(functions, 'api/sample.func'), path.join(functions, 'alias.func'), 'junction');
  expect(verifyPrebuilt(root)).toEqual({ functions: 2, files: 1 });
});

test('fails closed on absent output, empty maps, directories and escaping sources', () => {
  expect(() => verifyPrebuilt(root)).toThrow('Prebuilt functions directory is missing');
  config({});
  expect(() => verifyPrebuilt(root)).toThrow('No prebuilt file maps found');
  config({ invalid: '../outside.js' });
  expect(() => verifyPrebuilt(root)).toThrow('Prebuilt file map escapes the deployment root');
  fs.mkdirSync(path.join(root, 'directory'));
  config({ directory: 'directory' });
  expect(() => verifyPrebuilt(root)).toThrow('Missing prebuilt files');
});
