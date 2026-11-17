#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INSTALL_ARGS = Object.freeze([
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--include=dev',
  '--install-strategy=hoisted',
]);
const LOCK_LS_ARGS = Object.freeze(['ls', '--package-lock-only', '--all']);
const CI_ARGS = Object.freeze([
  'ci',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--include=dev',
  '--install-strategy=hoisted',
]);
const LS_ARGS = Object.freeze(['ls', '--all']);
const NPM_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const DEPENDENCY_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const DIRECT_LINUX_PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);
const DIRECT_LINUX_PROXY_ENV_ALIASES = Object.freeze([
  Object.freeze(['HTTP_PROXY', 'http_proxy']),
  Object.freeze(['HTTPS_PROXY', 'https_proxy']),
  Object.freeze(['NO_PROXY', 'no_proxy']),
]);

function fail(message) {
  throw new Error(`[package-lock-generator] ${message}`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.from(argv || [], (value) => String(value || '').trim()).filter(Boolean);
  const allowed = new Set(['--write', '--check']);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) fail(`unknown argument(s): ${unknown.join(', ')}`);
  if (args.length !== 1) fail('exactly one of --write or --check is required.');
  return args[0] === '--write' ? 'write' : 'check';
}

function assertRegularFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} is missing: ${filePath}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file: ${filePath}`);
}

function readJsonFile(filePath, label) {
  assertRegularFile(filePath, label);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error?.message || error}`);
  }
}

function normalizeRelativePath(value, label) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    fail(`${label} must be a non-empty repository-relative path: ${value}`);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail(`${label} escapes the repository: ${value}`);
  }
  return normalized;
}

function workspacePatterns(rootManifest) {
  const value = rootManifest?.workspaces;
  const patterns = Array.isArray(value) ? value : value && Array.isArray(value.packages) ? value.packages : [];
  if (patterns.length === 0) fail('root package.json must declare at least one workspace pattern.');
  return patterns.map((pattern, index) => normalizeRelativePath(pattern, `workspace pattern ${index + 1}`));
}

function discoverWorkspaceManifestPaths(repoRoot, rootManifest) {
  const root = path.resolve(repoRoot);
  const discovered = [];
  const seen = new Set();

  for (const pattern of workspacePatterns(rootManifest)) {
    const starCount = (pattern.match(/\*/g) || []).length;
    let candidates;
    if (starCount === 0) {
      candidates = [pattern];
    } else {
      if (starCount !== 1 || !pattern.endsWith('/*')) {
        fail(`unsupported workspace pattern (only exact paths and one-level /* are allowed): ${pattern}`);
      }
      const parentRelative = pattern.slice(0, -2);
      const parentPath = path.resolve(root, ...parentRelative.split('/'));
      const relativeCheck = path.relative(root, parentPath);
      if (!relativeCheck || relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
        fail(`workspace pattern escapes or resolves to repository root: ${pattern}`);
      }
      let entries;
      try {
        entries = fs.readdirSync(parentPath, { withFileTypes: true });
      } catch (error) {
        fail(`workspace parent is missing or unreadable (${pattern}): ${error?.message || error}`);
      }
      candidates = entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => `${parentRelative}/${entry.name}`)
        .filter((candidate) => {
          const manifestPath = path.resolve(root, ...candidate.split('/'), 'package.json');
          try {
            const stat = fs.lstatSync(manifestPath);
            return !stat.isSymbolicLink() && stat.isFile();
          } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
          }
        })
        .sort();
      if (candidates.length === 0) fail(`workspace pattern matched no directories: ${pattern}`);
    }

    for (const candidate of candidates) {
      const relative = normalizeRelativePath(candidate, `workspace from ${pattern}`);
      if (seen.has(relative)) fail(`duplicate workspace path: ${relative}`);
      const workspacePath = path.resolve(root, ...relative.split('/'));
      const relativeCheck = path.relative(root, workspacePath);
      if (!relativeCheck || relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
        fail(`workspace escapes or resolves to repository root: ${relative}`);
      }
      const stat = fs.lstatSync(workspacePath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`workspace must be a regular directory: ${relative}`);
      const manifestPath = path.join(workspacePath, 'package.json');
      assertRegularFile(manifestPath, `workspace manifest (${relative})`);
      seen.add(relative);
      discovered.push(`${relative}/package.json`);
    }
  }

  return discovered.sort();
}

function parseRuntimeContract(repoRoot) {
  const rootManifest = readJsonFile(path.join(repoRoot, 'package.json'), 'root package.json');
  const nodeVersion = fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) fail('.nvmrc must contain one exact semantic version.');
  const packageManager = String(rootManifest.packageManager || '').trim();
  const npmMatch = /^npm@(\d+\.\d+\.\d+)$/.exec(packageManager);
  if (!npmMatch) fail('packageManager must pin npm to one exact semantic version.');
  return { nodeVersion, npmVersion: npmMatch[1], rootManifest };
}

function resolveNpmCli(env = process.env, nodePath = process.execPath) {
  const candidates = [
    env.MASARX_NPM_CLI,
    env.npm_execpath,
    path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isSymbolicLink() && stat.isFile()) return path.resolve(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  fail('unable to resolve the npm CLI paired with the active Node runtime.');
}

function boundedOutput(value, maxLength = 4000) {
  const text = String(value || '').trim();
  return text.length <= maxLength ? text : text.slice(-maxLength);
}

function resolveDirectLinuxProxyEnvironment({
  env = process.env,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  const sourceEnv = { ...(env || {}) };
  if (platform !== 'linux' || /^(1|true)$/i.test(String(sourceEnv.GITHUB_ACTIONS || '').trim())) return sourceEnv;

  const missingProxyKeys = new Set();
  for (const aliases of DIRECT_LINUX_PROXY_ENV_ALIASES) {
    if (!aliases.some((key) => String(sourceEnv[key] || '').trim())) {
      for (const key of aliases) missingProxyKeys.add(key);
    }
  }
  if (missingProxyKeys.size === 0) return sourceEnv;

  const result = spawnSyncImpl('/bin/bash', ['-lc', 'env'], {
    encoding: 'utf8',
    env: sourceEnv,
    shell: false,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return sourceEnv;

  const loginProxyEnv = {};
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (DIRECT_LINUX_PROXY_ENV_KEYS.includes(key) && missingProxyKeys.has(key) && value) {
      loginProxyEnv[key] = value;
    }
  }
  return { ...sourceEnv, ...loginProxyEnv };
}

function redactProxyValues(value, env = process.env) {
  let redacted = String(value || '');
  const proxyValues = [...new Set(
    DIRECT_LINUX_PROXY_ENV_KEYS.map((key) => String(env?.[key] || '').trim()).filter(Boolean),
  )].sort((left, right) => right.length - left.length);
  for (const proxyValue of proxyValues) redacted = redacted.split(proxyValue).join('[REDACTED]');
  return redacted;
}

function createNpmRunner({
  npmCli,
  nodePath = process.execPath,
  spawn = spawnSync,
  timeoutMs = NPM_COMMAND_TIMEOUT_MS,
} = {}) {
  const cli = path.resolve(npmCli || resolveNpmCli(process.env, nodePath));
  return ({ args, cwd, env = process.env, label = 'command' }) => {
    const result = spawn(nodePath, [cli, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    if (result.error?.code === 'ETIMEDOUT') fail(`npm ${label} timed out after ${timeoutMs}ms.`);
    if (result.error) fail(`npm ${label} could not start: ${redactProxyValues(result.error.message, env)}`);
    if (result.status !== 0) {
      const details = boundedOutput(redactProxyValues(`${result.stdout || ''}\n${result.stderr || ''}`, env));
      fail(`npm ${label} failed with exit ${result.status}${details ? `:\n${details}` : '.'}`);
    }
    return String(result.stdout || '').trim();
  };
}

function assertExactRuntime({ repoRoot, npmRunner, nodeVersion = process.versions.node }) {
  const contract = parseRuntimeContract(repoRoot);
  if (String(nodeVersion || '').trim() !== contract.nodeVersion) {
    fail(`Node ${contract.nodeVersion} is required; active runtime is ${nodeVersion || 'unknown'}.`);
  }
  const npmVersion = npmRunner({ args: ['--version'], cwd: repoRoot, label: 'version probe' }).trim();
  if (npmVersion !== contract.npmVersion) {
    fail(`npm ${contract.npmVersion} is required; active runtime is ${npmVersion || 'unknown'}.`);
  }
  return contract;
}

function normalizedDependencySection(value, label) {
  if (value === undefined) return {};
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${label} must be an object.`);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function validateManifestLockEntry(manifest, lockEntry, label) {
  if (!lockEntry || Array.isArray(lockEntry) || typeof lockEntry !== 'object') {
    fail(`package-lock.json is missing ${label}.`);
  }
  for (const section of DEPENDENCY_SECTIONS) {
    const expected = normalizedDependencySection(manifest?.[section], `${label} ${section}`);
    const actual = normalizedDependencySection(lockEntry?.[section], `lock ${label} ${section}`);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      fail(`package-lock.json ${label} ${section} does not match its package.json.`);
    }
  }
}

function validatePackageLock(repoRoot, lockBody) {
  let lock;
  try {
    lock = JSON.parse(lockBody);
  } catch (error) {
    fail(`package-lock.json is not valid JSON: ${error?.message || error}`);
  }
  if (lock.lockfileVersion !== 3) fail(`package-lock.json lockfileVersion must be 3, got ${lock.lockfileVersion}.`);
  if (!lock.packages || Array.isArray(lock.packages) || typeof lock.packages !== 'object') {
    fail('package-lock.json packages must be an object.');
  }
  const rootManifest = readJsonFile(path.join(repoRoot, 'package.json'), 'root package.json');
  validateManifestLockEntry(rootManifest, lock.packages[''], 'root package entry');
  const workspaceManifestPaths = discoverWorkspaceManifestPaths(repoRoot, rootManifest);
  for (const manifestRelative of workspaceManifestPaths) {
    const workspaceRelative = path.posix.dirname(manifestRelative);
    const manifest = readJsonFile(path.join(repoRoot, ...manifestRelative.split('/')), `workspace ${workspaceRelative}`);
    validateManifestLockEntry(manifest, lock.packages[workspaceRelative], `workspace entry ${workspaceRelative}`);
  }
  return { lock, workspaceManifestPaths };
}

function sha256(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function copyGenerationInputs(repoRoot, tempRoot, rootManifest) {
  const relativePaths = [
    'package.json',
    'package-lock.json',
    ...discoverWorkspaceManifestPaths(repoRoot, rootManifest),
  ];
  if (fs.existsSync(path.join(repoRoot, '.npmrc'))) relativePaths.push('.npmrc');
  for (const relative of relativePaths) {
    const source = path.join(repoRoot, ...relative.split('/'));
    assertRegularFile(source, `generation input (${relative})`);
    const destination = path.join(tempRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
  return relativePaths.sort();
}

function npmEnvironment(baseEnv = process.env, { userConfigPath, globalConfigPath } = {}) {
  const sanitized = Object.fromEntries(
    Object.entries(baseEnv || {}).filter(([key]) => !/^npm_config_/i.test(key)),
  );
  const result = {
    ...sanitized,
    NODE_ENV: 'development',
    npm_config_audit: 'false',
    npm_config_force: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_include: 'dev',
    npm_config_install_strategy: 'hoisted',
    npm_config_legacy_peer_deps: 'false',
    npm_config_omit: '',
    npm_config_update_notifier: 'false',
  };
  if (userConfigPath) result.npm_config_userconfig = path.resolve(userConfigPath);
  if (globalConfigPath) result.npm_config_globalconfig = path.resolve(globalConfigPath);
  return result;
}

function runGenerationAndValidation({ repoRoot, npmRunner, env = process.env }) {
  const userConfigPath = path.join(repoRoot, '.masarx-empty-user-npmrc');
  const globalConfigPath = path.join(repoRoot, '.masarx-empty-global-npmrc');
  fs.writeFileSync(userConfigPath, '', { flag: 'wx' });
  fs.writeFileSync(globalConfigPath, '', { flag: 'wx' });
  try {
    const npmEnv = npmEnvironment(env, { userConfigPath, globalConfigPath });
    npmRunner({ args: INSTALL_ARGS, cwd: repoRoot, env: npmEnv, label: 'lock normalization' });
    npmRunner({ args: INSTALL_ARGS, cwd: repoRoot, env: npmEnv, label: 'lock generation pass 1' });
    const lockPath = path.join(repoRoot, 'package-lock.json');
    assertRegularFile(lockPath, 'generated package-lock.json');
    const firstBody = fs.readFileSync(lockPath);
    validatePackageLock(repoRoot, firstBody);

    npmRunner({ args: INSTALL_ARGS, cwd: repoRoot, env: npmEnv, label: 'lock generation pass 2' });
    const body = fs.readFileSync(lockPath);
    const validation = validatePackageLock(repoRoot, body);
    if (!firstBody.equals(body)) {
      fail(`package-lock.json did not reach a byte-identical fixed point (${sha256(firstBody)} -> ${sha256(body)}).`);
    }

    npmRunner({ args: LOCK_LS_ARGS, cwd: repoRoot, env: npmEnv, label: 'lock tree validation' });
    npmRunner({ args: CI_ARGS, cwd: repoRoot, env: npmEnv, label: 'clean install validation' });
    npmRunner({ args: LS_ARGS, cwd: repoRoot, env: npmEnv, label: 'installed tree validation' });
    return { body, validation };
  } finally {
    fs.rmSync(userConfigPath, { force: true });
    fs.rmSync(globalConfigPath, { force: true });
  }
}

function atomicWriteFile(filePath, body) {
  const target = path.resolve(filePath);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, body, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function execute({
  mode,
  repoRoot = path.resolve(__dirname, '..', '..', '..'),
  env = process.env,
  nodeVersion = process.versions.node,
  npmRunner,
  tempParent = os.tmpdir(),
} = {}) {
  if (!['write', 'check'].includes(mode)) fail(`invalid execution mode: ${mode || 'missing'}`);
  const root = path.resolve(repoRoot);
  const runner = npmRunner || createNpmRunner({ npmCli: resolveNpmCli(env, process.execPath) });
  const contract = assertExactRuntime({ repoRoot: root, npmRunner: runner, nodeVersion });

  const committedPath = path.join(root, 'package-lock.json');
  assertRegularFile(committedPath, 'committed package-lock.json');
  const committed = fs.readFileSync(committedPath);
  const tempRoot = fs.mkdtempSync(path.join(path.resolve(tempParent), 'masarx-package-lock-'));
  try {
    copyGenerationInputs(root, tempRoot, contract.rootManifest);
    const { body: regenerated, validation } = runGenerationAndValidation({
      repoRoot: tempRoot,
      npmRunner: runner,
      env,
    });
    if (mode === 'check' && !committed.equals(regenerated)) {
      fail(
        `committed package-lock.json is not deterministic (committed=${sha256(committed)}, regenerated=${sha256(regenerated)}). Run npm run lockfile:generate with the pinned toolchain.`,
      );
    }
    if (mode === 'write') atomicWriteFile(committedPath, regenerated);
    const accepted = mode === 'write' ? regenerated : committed;
    return {
      mode,
      sha256: sha256(accepted),
      bytes: accepted.length,
      workspace_count: validation.workspaceManifestPaths.length,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main() {
  try {
    const mode = parseArgs();
    const env = resolveDirectLinuxProxyEnvironment();
    const summary = execute({ mode, env });
    console.log(`[package-lock-generator] ${JSON.stringify(summary)}`);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  DEPENDENCY_SECTIONS,
  CI_ARGS,
  INSTALL_ARGS,
  LOCK_LS_ARGS,
  LS_ARGS,
  NPM_COMMAND_TIMEOUT_MS,
  atomicWriteFile,
  assertExactRuntime,
  copyGenerationInputs,
  createNpmRunner,
  discoverWorkspaceManifestPaths,
  execute,
  npmEnvironment,
  parseArgs,
  parseRuntimeContract,
  resolveDirectLinuxProxyEnvironment,
  runGenerationAndValidation,
  sha256,
  validatePackageLock,
};
