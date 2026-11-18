const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const ts = require('typescript');
const {
  readArtifact, publishArtifact, validateBundle, validatePackages, collectNotices, DECLARATIONS,
} = require('../../../scripts/edge/prepare-resource-import-exceljs');
const { buildEdgeRuntimeCacheContract } = require('../../../scripts/edge/verify-npm-import-lock');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const generator = path.resolve(__dirname, '../../../scripts/edge/prepare-resource-import-exceljs.js');
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-import-artifact-test-'));
  fs.mkdirSync(path.join(root, 'supabase/functions/resource-import-studio'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function syntheticArtifact() {
  const packages = ['exceljs', 'uuid'].map(name => ({
    name, version: name === 'exceljs' ? '4.4.0' : '11.1.1', lock_path: `node_modules/${name}`,
    integrity: 'sha512-synthetic-test-integrity', resolved: `https://registry.npmjs.org/${name}/synthetic.tgz`,
  }));
  const lock = { packages: Object.fromEntries(packages.map(entry => [entry.lock_path, entry])) };
  const lockBytes = Buffer.from(JSON.stringify(lock));
  fs.writeFileSync(path.join(root, 'package-lock.json'), lockBytes);
  fs.writeFileSync(path.join(root, 'deno.lock'), JSON.stringify({ remote: {} }));
  fs.writeFileSync(path.join(root, 'supabase/functions/resource-import-studio/index.ts'), 'import { Workbook } from "./_vendor/exceljs.mjs";');
  const files = {
    'exceljs.mjs': Buffer.from('export const Workbook = class {};'),
    'exceljs.d.mts': Buffer.from(DECLARATIONS),
    'exceljs-types.d.ts': Buffer.from('export declare class Workbook {}\nexport interface Worksheet {}'),
    'THIRD-PARTY-NOTICES.txt': Buffer.from('Synthetic upstream notices fixture'),
  };
  const manifest = {
    schema: 'masarx.resource-import-exceljs.v1', package_lock_sha256: sha256(lockBytes),
    generator_sha256: sha256(fs.readFileSync(generator)), esbuild_version: '0.25.0', packages,
    inputs: packages.map(entry => ({ path: entry.lock_path + '/synthetic.js', sha256: sha256('synthetic input') })),
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
  };
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest));
  return { files, packages, lock };
}

test('rejects non-builtin and computed dependencies without adding polyfills', () => {
  for (const source of ['__require(name);', 'require("uuid");', 'import(name);', 'import("npm:uuid@8.3.2");', 'import x from "https://example.invalid/x.js";']) {
    expect(() => validateBundle(Buffer.from(source), { outputs: {} })).toThrow();
  }
  expect(() => validateBundle(Buffer.from('require("node:stream"); import { createRequire } from "node:module";'), { outputs: {} })).not.toThrow();
  expect(() => validateBundle(Buffer.from(''), { outputs: { module: { imports: [{ external: true, path: 'exceljs' }] } } })).toThrow('Unsupported external');
});

test('rejects old UUID, missing package proof, and lock identity differences', () => {
  const { packages, lock } = syntheticArtifact();
  expect(() => validatePackages(packages, lock)).not.toThrow();
  expect(() => validatePackages(packages.filter(entry => entry.name !== 'uuid'), lock)).toThrow('UUID');
  expect(() => validatePackages(packages.map(entry => entry.name === 'uuid' ? { ...entry, version: '8.3.2' } : entry), lock)).toThrow('UUID');
  expect(() => validatePackages(packages, { packages: {} })).toThrow('npm lock');
  const fakeUuid = { ...packages[1], lock_path: 'node_modules/not-uuid' };
  const sameVersionLock = { packages: { ...lock.packages, [fakeUuid.lock_path]: { ...fakeUuid } } };
  expect(() => validatePackages([packages[0], fakeUuid], sameVersionLock)).toThrow('name does not match');
});

test('preserves every included package upstream notice and license metadata without invented terms', () => {
  const { packages } = syntheticArtifact();
  for (const entry of packages) {
    const directory = path.join(root, entry.lock_path);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: entry.name, version: entry.version, license: 'MIT' }));
    fs.writeFileSync(path.join(directory, 'LICENSE'), `Synthetic upstream copyright and terms for ${entry.name}`);
  }
  fs.writeFileSync(path.join(root, packages[1].lock_path, 'NOTICE'), 'Synthetic additional upstream attribution');
  const notices = collectNotices(root, packages).toString();
  for (const entry of packages) expect(notices).toContain(`Synthetic upstream copyright and terms for ${entry.name}`);
  expect(notices).toContain('License metadata: "MIT"');
  expect(notices).toContain('Synthetic additional upstream attribution');
  fs.unlinkSync(path.join(root, packages[0].lock_path, 'LICENSE'));
  expect(() => collectNotices(root, packages)).toThrow('Upstream license/notice text missing');
});

test('retains license terms embedded in upstream README but rejects incomplete metadata-only notices', () => {
  const entry = { name: 'isarray', version: '1.0.0', lock_path: 'node_modules/isarray' };
  const directory = path.join(root, entry.lock_path);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: entry.name, version: entry.version, license: 'MIT' }));
  const text = '## License\nCopyright synthetic upstream\nPermission is hereby granted to copy this synthetic fixture.\n';
  fs.writeFileSync(path.join(directory, 'README.md'), text);
  expect(collectNotices(root, [entry]).toString()).toContain(text);
  fs.writeFileSync(path.join(directory, 'README.md'), '## License\nMIT\n');
  expect(() => collectNotices(root, [entry])).toThrow('Upstream license/notice text missing');
});

test('only exact saxes release identity admits byte-pinned upstream license omitted from its tarball', () => {
  const entry = { name: 'saxes', version: '5.0.1', lock_path: 'node_modules/saxes' };
  const directory = path.join(root, entry.lock_path);
  fs.mkdirSync(directory, { recursive: true });
  const metadata = { name: entry.name, version: entry.version, license: 'ISC' };
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata));
  const relative = 'scripts/edge/vendor-notices/saxes-5.0.1-LICENSE';
  const notice = fs.readFileSync(path.resolve(__dirname, '../../..', relative));
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), notice);
  expect(collectNotices(root, [entry]).toString()).toContain(notice.toString());
  fs.appendFileSync(path.join(root, relative), 'tampered');
  expect(() => collectNotices(root, [entry])).toThrow('Pinned upstream saxes notice differs');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ ...metadata, version: '5.0.2' }));
  expect(() => collectNotices(root, [{ ...entry, version: '5.0.2' }])).toThrow('Upstream license/notice text missing');
});

test('publishes a complete synthetic fixture, reuses identical bytes, and preserves differing files', () => {
  const { files } = syntheticArtifact();
  publishArtifact(root, files);
  publishArtifact(root, files);
  expect(readArtifact(root).files['exceljs.mjs']).toBe(sha256(files['exceljs.mjs']));
  expect(() => publishArtifact(root, { ...files, 'exceljs.mjs': Buffer.from('changed') })).toThrow('preserve and reconcile');
  expect(fs.readFileSync(path.join(root, 'supabase/functions/resource-import-studio/_vendor/exceljs.mjs'))).toEqual(files['exceljs.mjs']);
  const notices = path.join(root, 'supabase/functions/resource-import-studio/_vendor/THIRD-PARTY-NOTICES.txt');
  fs.writeFileSync(notices, 'tampered notice');
  expect(() => readArtifact(root)).toThrow('Artifact bytes differ: THIRD-PARTY-NOTICES.txt');
});

test('rejects tampered artifact bytes and stale lock inputs', () => {
  const { files } = syntheticArtifact();
  publishArtifact(root, files);
  const file = path.join(root, 'supabase/functions/resource-import-studio/_vendor/exceljs.mjs');
  fs.writeFileSync(file, 'changed');
  expect(() => readArtifact(root)).toThrow('Artifact bytes differ');
  fs.writeFileSync(file, files['exceljs.mjs']);
  fs.appendFileSync(path.join(root, 'package-lock.json'), '\n');
  expect(() => readArtifact(root)).toThrow('stale');
});

test('generated module declarations resolve Workbook values and Worksheet types', () => {
  const { files } = syntheticArtifact();
  publishArtifact(root, files);
  const entry = path.join(root, 'consumer.mts');
  fs.writeFileSync(entry, 'import { Workbook, type Worksheet } from "./supabase/functions/resource-import-studio/_vendor/exceljs.mjs"; const workbook = new Workbook(); let sheet: Worksheet | undefined;');
  const errors = () => ts.getPreEmitDiagnostics(ts.createProgram([entry], {
    noEmit: true, types: [], target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  })).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  expect(errors().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))).toEqual([]);
  fs.writeFileSync(path.join(root, 'supabase/functions/resource-import-studio/_vendor/exceljs.d.mts'),
    'export { Workbook } from "./exceljs-types.d.ts";\nexport type { Worksheet } from "./exceljs-types.d.ts";');
  expect(errors().some(diagnostic => diagnostic.code === 2846)).toBe(true);
});

test('selected Edge cache contract binds local artifact bytes and fails closed when missing', () => {
  const { files } = syntheticArtifact();
  const options = {
    functionsRoot: path.join(root, 'supabase/functions'), lockPath: path.join(root, 'package-lock.json'),
    denoLockPath: path.join(root, 'deno.lock'), sourceFiles: ['resource-import-studio/index.ts'],
  };
  expect(() => buildEdgeRuntimeCacheContract(options)).toThrow();
  publishArtifact(root, files);
  const contract = buildEdgeRuntimeCacheContract(options);
  expect(contract.npm_roots).toEqual([]);
  expect(contract.vendored_artifacts[0].files['exceljs.mjs']).toBe(sha256(files['exceljs.mjs']));
  expect(contract.contract_sha256).toMatch(/^[a-f0-9]{64}$/);
});
