#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POLICY_RELATIVE_PATH = path.join('config', 'ops', 'codex-os-v2-policy.json');
const COLLECTION_SCHEMA = 'pr-validation-session.focused-parallel-wave.v1';
const ISOLATION_SCANNER_VERSION = 2;
const POLICY_SECTION_KEYS = new Set([
  'schema_version',
  'enabled',
  'mode',
  'activation',
  'artifact_schema',
  'collected_failure_result',
  'discovery',
  'execution',
  'final_gates',
  'parallel_waves',
  'repair_scheduler',
  'parallel_eligibility',
  'collectible_failure_allowlist',
  'isolation',
  'migration_drift',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareAscii(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort(compareAscii)) {
    out[key] = canonicalJsonValue(value[key]);
  }
  return out;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

function assertNoDuplicateJsonKeys(rawValue) {
  const raw = String(rawValue || '');
  let index = 0;
  const skipWhitespace = () => {
    while (index < raw.length && /\s/u.test(raw[index])) index += 1;
  };
  const parseString = () => {
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === '\\') {
        index += 2;
        continue;
      }
      if (raw[index] === '"') {
        index += 1;
        return JSON.parse(raw.slice(start, index));
      }
      index += 1;
    }
    throw new Error('JSON string is unterminated.');
  };
  const parseValue = () => {
    skipWhitespace();
    if (raw[index] === '{') {
      index += 1;
      const keys = new Set();
      skipWhitespace();
      if (raw[index] === '}') {
        index += 1;
        return;
      }
      while (index < raw.length) {
        skipWhitespace();
        if (raw[index] !== '"') throw new Error('JSON object key is invalid.');
        const key = parseString();
        if (keys.has(key)) throw new Error('JSON object contains a duplicate key: ' + key);
        keys.add(key);
        skipWhitespace();
        if (raw[index] !== ':') throw new Error('JSON object separator is invalid.');
        index += 1;
        parseValue();
        skipWhitespace();
        if (raw[index] === '}') {
          index += 1;
          return;
        }
        if (raw[index] !== ',') throw new Error('JSON object delimiter is invalid.');
        index += 1;
      }
      throw new Error('JSON object is unterminated.');
    }
    if (raw[index] === '[') {
      index += 1;
      skipWhitespace();
      if (raw[index] === ']') {
        index += 1;
        return;
      }
      while (index < raw.length) {
        parseValue();
        skipWhitespace();
        if (raw[index] === ']') {
          index += 1;
          return;
        }
        if (raw[index] !== ',') throw new Error('JSON array delimiter is invalid.');
        index += 1;
      }
      throw new Error('JSON array is unterminated.');
    }
    if (raw[index] === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < raw.length && !/[\s,\]}]/u.test(raw[index])) index += 1;
    if (index === start) throw new Error('JSON value is invalid.');
  };
  parseValue();
  skipWhitespace();
  if (index !== raw.length) throw new Error('JSON has trailing content.');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertKnownKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new Error(label + ' must be an object.');
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(label + ' has unknown fields: ' + unknown.sort(compareAscii).join(', '));
}

function requireString(value, label, options = {}) {
  if (typeof value !== 'string') throw new Error(label + ' must be a non-empty string.');
  const out = value;
  if (!out.trim() || out !== out.trim() || /[\u0000-\u001f\u007f]/u.test(out)) {
    throw new Error(label + ' must be a canonical non-empty string.');
  }
  if (options.maxLength && out.length > options.maxLength) {
    throw new Error(label + ' exceeds the maximum length.');
  }
  return out;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(label + ' must be a positive integer.');
  return value;
}

function strictPositiveInteger(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[1-9][0-9]*$/u.test(text)) throw new Error(label + ' must be a positive integer.');
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(label + ' exceeds the safe integer range.');
  return parsed;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array.');
  return value;
}

function normalizePolicyFilePath(value) {
  const file = requireString(value, 'focused collection quarantine file', { maxLength: 260 });
  if (file.includes('\\') || file.includes('\0') || path.isAbsolute(file) || /(^|\/)\.\.(\/|$)/u.test(file)) {
    throw new Error('Focused collection quarantine paths must be safe repo-relative POSIX paths.');
  }
  if (!file.includes('/') || !file.endsWith('.sql')) throw new Error('Focused collection policy paths must be repo-relative SQL files.');
  const baseName = path.posix.basename(file);
  if (!baseName || baseName.includes('/') || path.posix.basename(baseName) !== baseName) {
    throw new Error('Focused collection policy paths must name one harness-discoverable file.');
  }
  assertCanonicalPgtapBaseName(baseName, 'Focused collection quarantine file');
  return file;
}

function assertCanonicalPgtapBaseName(value, label = 'pgTAP file') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/u.test(value)) {
    throw new Error(label + ' must use a canonical harness-safe filename.');
  }
  return value;
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative)
  );
}

function ensureSafeDirectoryWithin(root, target, fsImpl = fs) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  if (!isPathWithin(rootPath, targetPath)) throw new Error('Focused artifact directory escapes the active worktree.');
  const rootStat = fsImpl.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Focused artifact worktree root must be a canonical non-symlink directory.');
  }
  const realRoot = fsImpl.realpathSync(rootPath);
  let cursor = rootPath;
  const relative = path.relative(rootPath, targetPath);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fsImpl.existsSync(cursor)) fsImpl.mkdirSync(cursor);
    const stat = fsImpl.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Focused artifact directory contains a symlink or non-directory component.');
    }
    const realCursor = fsImpl.realpathSync(cursor);
    if (!isPathWithin(realRoot, realCursor)) throw new Error('Focused artifact directory resolves outside the active worktree.');
  }
  const realTarget = path.resolve(fsImpl.realpathSync(targetPath));
  const canonicalTarget = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  const canonicalRealTarget = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;
  if (canonicalRealTarget !== canonicalTarget) {
    throw new Error('Focused artifact directory is not canonical.');
  }
  return targetPath;
}

function validatePolicyFileOnDisk(cwd, file, discoveryRoots, fsImpl = fs) {
  const roots = requireArray(discoveryRoots, 'focused discovery roots').map((root) => path.resolve(cwd, root));
  const absolute = path.resolve(cwd, file.replace(/\//gu, path.sep));
  const testRoot = roots.find((root) => isPathWithin(root, absolute));
  if (!testRoot) throw new Error('Policy file path escapes configured focused discovery roots: ' + file);
  const stat = fsImpl.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) {
    throw new Error('Policy quarantine path must be a regular non-symlink file below 5 MiB: ' + file);
  }
  const realRoot = fsImpl.realpathSync(testRoot);
  const realFile = fsImpl.realpathSync(absolute);
  if (!isPathWithin(realRoot, realFile)) throw new Error('Policy quarantine path resolves outside the pgTAP test root: ' + file);
  const expectedName = path.posix.basename(file);
  const matchingNames = fsImpl.readdirSync(testRoot).filter((entry) => entry.toLowerCase() === expectedName.toLowerCase());
  if (matchingNames.length !== 1 || matchingNames[0] !== expectedName) {
    throw new Error('Policy quarantine path must use unique canonical filesystem case: ' + file);
  }
}

module.exports = {
  COLLECTION_SCHEMA,
  ISOLATION_SCANNER_VERSION,
  POLICY_RELATIVE_PATH,
  POLICY_SECTION_KEYS,
  assertCanonicalPgtapBaseName,
  assertKnownKeys,
  assertNoDuplicateJsonKeys,
  canonicalJson,
  canonicalJsonValue,
  compareAscii,
  ensureSafeDirectoryWithin,
  isPathWithin,
  isPlainObject,
  normalizePolicyFilePath,
  requireArray,
  requirePositiveInteger,
  requireString,
  sha256,
  strictPositiveInteger,
  validatePolicyFileOnDisk,
};
