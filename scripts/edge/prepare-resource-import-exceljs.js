#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const semver = require('semver');
const ts = require('typescript');

const DIRECTORY = 'supabase/functions/resource-import-studio/_vendor';
const FILES = ['exceljs.mjs', 'exceljs.d.mts', 'exceljs-types.d.ts', 'THIRD-PARTY-NOTICES.txt'];
const DECLARATIONS = 'export { Workbook } from "./exceljs-types.js";\nexport type { Worksheet } from "./exceljs-types.js";\n';
const BUILTINS = new Set(['assert', 'buffer', 'crypto', 'events', 'fs', 'module', 'os', 'path', 'process', 'stream', 'string_decoder', 'util']);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isBuiltin = value => typeof value === 'string' && BUILTINS.has(value.replace(/^node:/, ''));

function readRegular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artifact input is not a regular file: ${file}`);
  return fs.readFileSync(file);
}

function validateBundle(bytes, metafile) {
  for (const output of Object.values(metafile.outputs)) {
    for (const entry of output.imports) {
      if (entry.external && !isBuiltin(entry.path)) throw new Error(`Unsupported external dependency: ${entry.path}`);
    }
  }
  const source = ts.createSourceFile('exceljs.mjs', bytes.toString(), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw new Error('Generated ExcelJS module is not valid JavaScript');
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && (!ts.isStringLiteralLike(node.moduleSpecifier) || !isBuiltin(node.moduleSpecifier.text))) {
      throw new Error('Unsupported module import in ExcelJS artifact');
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && /^(?:__)?require\d*$/.test(node.expression.text)))) {
      const argument = node.arguments[0];
      if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument) || !isBuiltin(argument.text)) {
        throw new Error('Unresolved dynamic or non-builtin dependency in ExcelJS artifact');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function validatePackages(packages, lock) {
  if (!Array.isArray(packages) || !packages.length) throw new Error('Artifact has no bundled package proof');
  const uuids = packages.filter(entry => entry.name === 'uuid');
  if (!uuids.length || uuids.some(entry => entry.version !== '11.1.1')) throw new Error('Artifact UUID is not patched');
  if (!packages.some(entry => entry.name === 'exceljs' && entry.version === '4.4.0')) throw new Error('Artifact ExcelJS cohort differs');
  for (const entry of packages) {
    if (typeof entry.name !== 'string' || typeof entry.lock_path !== 'string'
      || !entry.lock_path.startsWith('node_modules/') || entry.lock_path.includes('\\')
      || entry.lock_path.split('/').includes('..')
      || !(entry.lock_path === `node_modules/${entry.name}` || entry.lock_path.endsWith(`/node_modules/${entry.name}`))) {
      throw new Error('Artifact package name does not match its lock path');
    }
    const installed = lock.packages[entry.lock_path];
    if (!installed || (installed.name && installed.name !== entry.name)
      || installed.version !== entry.version || installed.integrity !== entry.integrity
      || installed.resolved !== entry.resolved || !/^sha512-/.test(entry.integrity)
      || !entry.resolved.startsWith('https://registry.npmjs.org/')) throw new Error('Artifact package proof differs from npm lock');
  }
}

function collectNotices(repoRoot, packages) {
  return Buffer.from([...packages].sort((a, b) => a.lock_path.localeCompare(b.lock_path)).map(entry => {
    const directory = path.join(repoRoot, entry.lock_path);
    const metadata = JSON.parse(readRegular(path.join(directory, 'package.json')));
    if (metadata.name !== entry.name || metadata.version !== entry.version) throw new Error('Notice package identity differs');
    const names = fs.readdirSync(directory).filter(name => /^(?:licen[sc]e|copying|notice|copyright)(?:$|[._-])/i.test(name)).sort();
    if (!names.length) names.push(...fs.readdirSync(directory).filter(name => {
      if (!/^readme(?:$|[._-])/i.test(name)) return false;
      const text = readRegular(path.join(directory, name)).toString('utf8');
      return /^#+\s+Licen[sc]e\s*$/im.test(text) && /Copyright/i.test(text)
        && /Permission (?:is hereby granted|to use, copy)/i.test(text);
    }).sort());
    if (!names.length && entry.name === 'saxes' && entry.version === '5.0.1' && metadata.license === 'ISC') {
      // The published tarball omits its license; preserve the exact release-tag upstream text.
      const notice = readRegular(path.join(repoRoot, 'scripts/edge/vendor-notices/saxes-5.0.1-LICENSE'));
      if (sha256(notice) !== '0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e') throw new Error('Pinned upstream saxes notice differs');
      return `Package: saxes@5.0.1\nLicense metadata: "ISC"\nSource: https://github.com/lddubeau/saxes/blob/6ef6a275b20f19cb67808daf0d8f64e06aaf5b0e/LICENSE\n${notice.toString('utf8')}\n`;
    }
    if (!names.length) throw new Error(`Upstream license/notice text missing: ${entry.name}`);
    const heading = `Package: ${entry.name}@${entry.version}\nLicense metadata: ${JSON.stringify(metadata.license ?? metadata.licenses ?? null)}\n`;
    return heading + names.map(name => `${name}:\n${readRegular(path.join(directory, name)).toString('utf8')}\n`).join('\n');
  }).join('\n'));
}

function readArtifact(repoRoot) {
  const root = fs.realpathSync(repoRoot);
  const directory = path.join(root, DIRECTORY);
  if (fs.realpathSync(directory) !== directory) throw new Error('Artifact directory must not be a symlink');
  const manifestBytes = readRegular(path.join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const lockBytes = readRegular(path.join(root, 'package-lock.json'));
  if (manifest.schema !== 'masarx.resource-import-exceljs.v1'
    || manifest.package_lock_sha256 !== sha256(lockBytes)
    || manifest.generator_sha256 !== sha256(readRegular(__filename))
    || !semver.satisfies(manifest.esbuild_version, '^0.25.0')) throw new Error('Artifact generation inputs are stale');
  validatePackages(manifest.packages, JSON.parse(lockBytes));
  if (!Array.isArray(manifest.inputs) || !manifest.inputs.length || manifest.inputs.some(input =>
    !/^node_modules\//.test(input.path) || input.path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(input.sha256))
    || manifest.packages.some(entry => !manifest.inputs.some(input => input.path.startsWith(entry.lock_path + '/')))) {
    throw new Error('Artifact bundled input proof is incomplete');
  }
  if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...FILES].sort())) throw new Error('Artifact file set differs');
  for (const file of FILES) {
    if (sha256(readRegular(path.join(directory, file))) !== manifest.files[file]) throw new Error(`Artifact bytes differ: ${file}`);
  }
  validateBundle(readRegular(path.join(directory, 'exceljs.mjs')), { outputs: {} });
  return { path: DIRECTORY, manifest_sha256: sha256(manifestBytes), ...manifest };
}

function publishArtifact(repoRoot, files) {
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify([...FILES, 'manifest.json'].sort())
    || Object.values(files).some(bytes => !Buffer.isBuffer(bytes))) throw new Error('Invalid artifact publication set');
  const parent = path.join(fs.realpathSync(repoRoot), path.dirname(DIRECTORY));
  if (fs.realpathSync(parent) !== parent) throw new Error('Artifact parent must not be a symlink');
  const target = path.join(parent, '_vendor');
  if (fs.existsSync(target)) {
    if (fs.realpathSync(target) !== target || !fs.statSync(target).isDirectory()) throw new Error('Unsafe artifact directory');
    if (JSON.stringify(fs.readdirSync(target).sort()) !== JSON.stringify(Object.keys(files).sort())) throw new Error('Existing artifact file set differs; preserve and reconcile');
    for (const [name, bytes] of Object.entries(files)) {
      if (!readRegular(path.join(target, name)).equals(bytes)) throw new Error('Existing artifact differs; preserve and reconcile');
    }
    return;
  }
  const staging = fs.mkdtempSync(path.join(parent, '.exceljs-'));
  try {
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(staging, name), bytes, { flag: 'wx', mode: 0o644 });
    fs.renameSync(staging, target);
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true });
  }
}

async function generate(repoRoot) {
  const root = fs.realpathSync(repoRoot);
  const lockBytes = readRegular(path.join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  const esbuild = require(require.resolve('esbuild', { paths: [root] }));
  if (!semver.satisfies(esbuild.version, '^0.25.0') || lock.packages['node_modules/esbuild'].version !== esbuild.version) {
    throw new Error('Install the qualified esbuild lock graph before generation');
  }
  const excelRoot = path.dirname(require.resolve('exceljs/package.json', { paths: [root] }));
  const uuidRoot = path.dirname(require.resolve('uuid/package.json', { paths: [excelRoot] }));
  if (JSON.parse(readRegular(path.join(uuidRoot, 'package.json'))).version !== '11.1.1') throw new Error('Install patched ExcelJS UUID before generation');
  const result = await esbuild.build({
    absWorkingDir: root,
    stdin: { contents: 'import Workbook from "exceljs/lib/doc/workbook.js"; export { Workbook };', resolveDir: root, sourcefile: 'resource-import-exceljs-entry.mjs', loader: 'js' },
    bundle: true, format: 'esm', platform: 'node', target: 'es2022', write: false,
    outfile: 'exceljs.mjs', metafile: true, sourcemap: false, legalComments: 'inline', logLevel: 'silent',
    banner: { js: 'import { createRequire } from "node:module"; import { Buffer } from "node:buffer"; import process from "node:process"; const require = createRequire(import.meta.url);' },
  });
  if (result.warnings.length) throw new Error(`ExcelJS bundling warnings: ${result.warnings.map(entry => entry.text).join('; ')}`);
  const bytes = Buffer.from(result.outputFiles[0].contents);
  validateBundle(bytes, result.metafile);
  const packages = new Map();
  const inputs = [];
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input === 'resource-import-exceljs-entry.mjs') continue;
    const file = path.resolve(root, input);
    if (!file.startsWith(path.join(root, 'node_modules') + path.sep) || fs.realpathSync(file) !== file) throw new Error('Bundled input escapes qualified node_modules');
    let directory = path.dirname(file);
    let identity;
    while (true) {
      if (fs.existsSync(path.join(directory, 'package.json'))) {
        identity = JSON.parse(readRegular(path.join(directory, 'package.json')));
        if (identity.name && identity.version) break;
      }
      const next = path.dirname(directory);
      if (next === directory || directory === path.join(root, 'node_modules')) throw new Error('Bundled package identity missing');
      directory = next;
    }
    const lockPath = path.relative(root, directory).replace(/\\/g, '/');
    const locked = lock.packages[lockPath];
    packages.set(lockPath, { name: identity.name, version: identity.version, lock_path: lockPath, integrity: locked?.integrity, resolved: locked?.resolved });
    inputs.push({ path: path.relative(root, file).replace(/\\/g, '/'), sha256: sha256(readRegular(file)) });
  }
  const inventory = [...packages.values()].sort((a, b) => a.lock_path.localeCompare(b.lock_path));
  validatePackages(inventory, lock);
  const files = {
    'exceljs.mjs': bytes,
    'exceljs.d.mts': Buffer.from(DECLARATIONS),
    'exceljs-types.d.ts': readRegular(path.join(excelRoot, 'index.d.ts')),
    'THIRD-PARTY-NOTICES.txt': collectNotices(root, inventory),
  };
  const manifest = {
    schema: 'masarx.resource-import-exceljs.v1',
    package_lock_sha256: sha256(lockBytes), generator_sha256: sha256(readRegular(__filename)),
    esbuild_version: esbuild.version, packages: inventory,
    inputs: inputs.sort((a, b) => a.path.localeCompare(b.path)),
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha256(value)])),
  };
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  publishArtifact(root, files);
  return readArtifact(root);
}

if (require.main === module) generate(path.join(__dirname, '..', '..')).then(value => {
  console.log(`ExcelJS artifact verified: ${value.files['exceljs.mjs']}`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { generate, readArtifact, publishArtifact, validateBundle, validatePackages, collectNotices, DECLARATIONS };
