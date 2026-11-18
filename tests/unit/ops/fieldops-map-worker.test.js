const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareFieldopsMapWorker } = require('../../../scripts/ops/mobile/run-fieldops-expo');
const { filename, companions: [companion] } = require('../../../packages/ui/map-worker-asset.json');
const workerSource = `import { value } from './${companion}'; export default value;`;
let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldops-map-worker-'));
  const pkg = path.join(root, 'node_modules/maplibre-gl');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'maplibre-gl', exports: { './dist/*': './dist/*' } }));
  fs.writeFileSync(path.join(pkg, 'dist', filename), workerSource);
  fs.writeFileSync(path.join(pkg, 'dist', companion), 'export const value = 42;');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
test('publishes installed bytes once and reuses identical generated asset', () => {
  const target = prepareFieldopsMapWorker(root);
  expect(target).toBe(path.join(root, 'public', filename));
  expect(fs.readFileSync(target, 'utf8')).toBe(workerSource);
  const inode = fs.statSync(target).ino;
  expect(prepareFieldopsMapWorker(root)).toBe(target);
  expect(fs.statSync(target).ino).toBe(inode);
  expect(fs.readdirSync(path.join(root, 'public')).sort()).toEqual([filename, companion].sort());
});
test('staged worker resolves and executes its companion module', async () => {
  const { pathToFileURL } = require('url');
  const target = prepareFieldopsMapWorker(root);
  const module = await import(pathToFileURL(target).href);
  expect(module.default).toBe(42);
});
test('preserves a conflicting companion before publishing the worker', () => {
  fs.mkdirSync(path.join(root, 'public'));
  const target = path.join(root, 'public', companion);
  fs.writeFileSync(target, 'unproven companion');
  expect(() => prepareFieldopsMapWorker(root)).toThrow('differs');
  expect(fs.readFileSync(target, 'utf8')).toBe('unproven companion');
  expect(fs.readdirSync(path.join(root, 'public'))).toEqual([companion]);
});
test('preserves differing pre-existing bytes and refuses launch admission', () => {
  fs.mkdirSync(path.join(root, 'public'));
  const target = path.join(root, 'public', filename);
  fs.writeFileSync(target, 'unproven retained bytes');
  expect(() => prepareFieldopsMapWorker(root)).toThrow('differs');
  expect(fs.readFileSync(target, 'utf8')).toBe('unproven retained bytes');
  expect(fs.readdirSync(path.join(root, 'public'))).toEqual([filename]);
});
test('refuses a symlinked public directory without modifying its target', () => {
  const elsewhere = path.join(root, 'retained');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(root, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => prepareFieldopsMapWorker(root)).toThrow('symlink');
  expect(fs.readdirSync(elsewhere)).toEqual([]);
});
test('refuses symlinked asset and preserves target bytes', () => {
  const elsewhere = path.join(root, 'retained.mjs');
  fs.writeFileSync(elsewhere, '/* owned test worker */');
  fs.mkdirSync(path.join(root, 'public'));
  fs.symlinkSync(elsewhere, path.join(root, 'public', filename));
  expect(() => prepareFieldopsMapWorker(root)).toThrow('differs');
  expect(fs.readFileSync(elsewhere, 'utf8')).toBe('/* owned test worker */');
});
test('direct Metro start also stages through the same helper', () => {
  const source = fs.readFileSync(path.resolve('scripts/ops/mobile/start-fieldops-metro.js'), 'utf8');
  expect(source.indexOf('prepareFieldopsMapWorker(context.appRoot);')).toBeGreaterThan(0);
  expect(source.indexOf('prepareFieldopsMapWorker(context.appRoot);')).toBeLessThan(source.indexOf('const child = spawn('));
});
test('identical worker pair reuse performs no file writes', () => {
  const target = prepareFieldopsMapWorker(root);
  const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
    throw new Error('Unexpected write while reusing identical assets');
  });
  try {
    expect(prepareFieldopsMapWorker(root)).toBe(target);
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, 'public', companion), 'utf8')).toBe('export const value = 42;');
  } finally { write.mockRestore(); }
});
