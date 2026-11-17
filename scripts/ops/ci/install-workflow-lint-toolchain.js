#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'ci', 'workflow-lint-toolchain.json');
const EXPECTED_SCHEMA = 'workflow-lint-toolchain.v1';
const GOPROXY = 'https://proxy.golang.org';
const GOSUMDB = 'sum.golang.org';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readConfig(configPath = CONFIG_PATH, fsImpl = fs) {
  const bytes = fsImpl.readFileSync(configPath);
  let config;
  try {
    config = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Workflow lint toolchain config is invalid JSON: ${error.message}`);
  }
  validateConfig(config);
  return { config, digest: sha256(bytes) };
}

function validateConfig(config) {
  if (config?.schema_version !== EXPECTED_SCHEMA) {
    throw new Error(`Unsupported workflow lint toolchain schema: ${String(config?.schema_version || '<missing>')}`);
  }
  const actionlint = config.actionlint || {};
  const requiredActionlint = ['module_root', 'module', 'source_commit', 'version', 'module_sum', 'go_mod_sum', 'go_version'];
  for (const key of requiredActionlint) {
    if (!String(actionlint[key] || '').trim()) throw new Error(`Missing actionlint.${key} pin.`);
  }
  if (!/^[0-9a-f]{40}$/.test(actionlint.source_commit)) throw new Error('actionlint.source_commit must be a full commit SHA.');
  if (actionlint.build?.cgo_enabled !== '0' || actionlint.build?.trimpath !== true
    || actionlint.build?.buildvcs !== false || actionlint.build?.ldflags !== '-buildid=') {
    throw new Error('Actionlint deterministic build contract is invalid.');
  }
  if (config.shellcheck?.version !== '0.11.0') throw new Error('ShellCheck must be pinned to 0.11.0.');
  for (const key of ['install_ms', 'probe_ms', 'lint_ms']) {
    if (config.timeouts?.[key] !== 90000) throw new Error(`timeouts.${key} must be exactly 90000.`);
  }
  if (!Number.isInteger(config.download_attempts) || config.download_attempts < 1 || config.download_attempts > 2) {
    throw new Error('download_attempts must be between 1 and 2.');
  }
  if (Object.keys(config.targets || {}).sort().join(',') !== 'linux-amd64,windows-amd64') {
    throw new Error('Workflow lint toolchain supports only linux-amd64 and windows-amd64.');
  }
  for (const [targetId, target] of Object.entries(config.targets)) {
    for (const key of ['actionlint_sha256', 'shellcheck_asset_sha256', 'shellcheck_sha256']) {
      if (!/^[0-9a-f]{64}$/.test(String(target[key] || ''))) throw new Error(`${targetId}.${key} must be an exact SHA-256.`);
    }
    if (!String(target.shellcheck_asset_url || '').startsWith('https://github.com/koalaman/shellcheck/releases/download/v0.11.0/')) {
      throw new Error(`${targetId} must use the official ShellCheck 0.11.0 asset.`);
    }
  }
  return config;
}

function resolveTargetId(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'windows-amd64';
  if (platform === 'linux' && arch === 'x64') return 'linux-amd64';
  throw new Error(`Unsupported workflow lint target: ${platform}-${arch}.`);
}

function commandText(result) {
  return `${String(result?.stdout || '')}${String(result?.stderr || '')}`.trim();
}

function runChecked(spawn, executable, args, options, label, timeoutMs) {
  const result = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result?.error?.code === 'ETIMEDOUT' || result?.signal === 'SIGTERM') {
    throw new Error(`${label} timed out after ${timeoutMs}ms.`);
  }
  if (result?.error) throw new Error(`${label} failed to start: ${result.error.message || result.error}`);
  if (result?.status !== 0) {
    const output = commandText(result);
    throw new Error(`${label} failed with status ${String(result?.status)}${output ? `:\n${output}` : '.'}`);
  }
  return result;
}

function resolveCacheRoot({ env = process.env, platform = process.platform } = {}) {
  const explicit = String(env.WORKFLOW_LINT_TOOLCHAIN_ROOT || '').trim();
  const runner = String(env.RUNNER_TOOL_CACHE || '').trim();
  let value = explicit || runner;
  if (!value && platform === 'win32') {
    const local = String(env.LOCALAPPDATA || '').trim();
    if (local) value = path.join(local, 'MasarX', 'workflow-lint-toolchain');
  }
  if (!value && platform === 'linux') {
    const cache = String(env.XDG_CACHE_HOME || '').trim();
    const home = String(env.HOME || '').trim();
    if (cache) value = path.join(cache, 'masarx', 'workflow-lint-toolchain');
    else if (home) value = path.join(home, '.cache', 'masarx', 'workflow-lint-toolchain');
  }
  if (!value || !path.isAbsolute(value)) {
    throw new Error('Workflow lint toolchain requires an absolute persistent cache root.');
  }
  return path.resolve(value);
}

function hashFile(file, fsImpl = fs) {
  return sha256(fsImpl.readFileSync(file));
}

function exactFile(file, expectedHash, fsImpl = fs) {
  const stat = fsImpl.statSync(file);
  if (!stat.isFile()) throw new Error(`Toolchain path is not a regular file: ${file}`);
  const actual = hashFile(file, fsImpl);
  if (actual !== expectedHash) throw new Error(`Toolchain hash mismatch for ${file}: expected ${expectedHash}, got ${actual}.`);
}

function parseModuleMetadata(output, config) {
  let metadata;
  try {
    metadata = JSON.parse(String(output || ''));
  } catch (error) {
    throw new Error(`Go module metadata is invalid JSON: ${error.message}`);
  }
  const expected = config.actionlint;
  if (metadata.Path !== expected.module_root || metadata.Query !== expected.source_commit
    || metadata.Version !== expected.version || metadata.Sum !== expected.module_sum
    || metadata.GoModSum !== expected.go_mod_sum || metadata.Origin?.Hash !== expected.source_commit
    || metadata.Origin?.URL !== `https://${expected.module_root}`) {
    throw new Error('Go module metadata does not match the pinned actionlint commit, pseudo-version, sums, and origin.');
  }
  return metadata;
}

function verifyVersionOutput({ actionlintOutput, shellcheckOutput, config }) {
  if (!String(actionlintOutput || '').includes(config.actionlint.version)) {
    throw new Error(`actionlint version output does not contain ${config.actionlint.version}.`);
  }
  if (!new RegExp(`(?:version:\\s*|ShellCheck - shell script analysis tool\\s+version:?)\\s*${config.shellcheck.version.replace(/\./g, '\\.')}`, 'i')
    .test(String(shellcheckOutput || ''))) {
    throw new Error(`ShellCheck version output does not contain exact version ${config.shellcheck.version}.`);
  }
}

function expectedManifest({ config, digest, targetId, actionlintPath, shellcheckPath, target }) {
  return {
    schema_version: 'workflow-lint-toolchain-cache.v1',
    config_sha256: digest,
    target: targetId,
    actionlint: {
      path: actionlintPath,
      sha256: target.actionlint_sha256,
      version: config.actionlint.version,
      source_commit: config.actionlint.source_commit,
      module_sum: config.actionlint.module_sum,
      go_version: config.actionlint.go_version,
    },
    shellcheck: {
      path: shellcheckPath,
      sha256: target.shellcheck_sha256,
      version: config.shellcheck.version,
      asset_url: target.shellcheck_asset_url,
      asset_sha256: target.shellcheck_asset_sha256,
    },
  };
}

function validateCache({ targetDir, config, digest, targetId, spawn = spawnSync, fsImpl = fs }) {
  const target = config.targets[targetId];
  const manifestPath = path.join(targetDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Workflow lint cache is stale or corrupt: ${error.message}`);
  }
  const actionlintPath = path.resolve(targetDir, 'bin', target.actionlint_binary);
  const shellcheckPath = path.resolve(targetDir, 'bin', target.shellcheck_binary);
  const expected = expectedManifest({ config, digest, targetId, actionlintPath, shellcheckPath, target });
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error('Workflow lint cache manifest does not match the exact configured contract.');
  }
  if (!path.isAbsolute(manifest.actionlint.path) || !path.isAbsolute(manifest.shellcheck.path)
    || path.resolve(manifest.actionlint.path) !== actionlintPath || path.resolve(manifest.shellcheck.path) !== shellcheckPath) {
    throw new Error('Workflow lint cache manifest paths are not exact absolute cache paths.');
  }
  exactFile(actionlintPath, target.actionlint_sha256, fsImpl);
  exactFile(shellcheckPath, target.shellcheck_sha256, fsImpl);
  const timeout = config.timeouts.probe_ms;
  const actionlintVersion = runChecked(spawn, actionlintPath, ['-version'], { cwd: targetDir, env: process.env }, 'actionlint version probe', timeout);
  const shellcheckVersion = runChecked(spawn, shellcheckPath, ['--version'], { cwd: targetDir, env: process.env }, 'ShellCheck version probe', timeout);
  verifyVersionOutput({ actionlintOutput: commandText(actionlintVersion), shellcheckOutput: commandText(shellcheckVersion), config });
  return { actionlintPath, shellcheckPath, manifestPath, targetDir, manifest };
}

async function defaultDownload(url, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function defaultExtract({ archivePath, destination, spawn, timeoutMs }) {
  runChecked(spawn, 'tar', ['-xf', archivePath, '-C', destination], { cwd: destination, env: process.env }, 'ShellCheck archive extraction', timeoutMs);
}

async function downloadPinnedAsset(url, { attempts, download, timeoutMs }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await download(url, { timeoutMs, attempt });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Pinned asset download failed after ${attempts} same-URL attempt(s): ${lastError?.message || lastError}`);
}

function writeGithubOutput(result, { format, env = process.env, fsImpl = fs }) {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (format === 'github-output') {
    const output = String(env.GITHUB_OUTPUT || '').trim();
    if (!output || !path.isAbsolute(output)) throw new Error('GITHUB_OUTPUT must be an explicit absolute path.');
    fsImpl.appendFileSync(output, `go_version=${result.goVersion}\n`, 'utf8');
    return;
  }
  if (format !== 'github-env') throw new Error(`Unsupported output format: ${format}.`);
  const githubEnv = String(env.GITHUB_ENV || '').trim();
  const githubPath = String(env.GITHUB_PATH || '').trim();
  if (!githubEnv || !path.isAbsolute(githubEnv) || !githubPath || !path.isAbsolute(githubPath)) {
    throw new Error('GITHUB_ENV and GITHUB_PATH must be explicit absolute paths.');
  }
  for (const file of [result.actionlintPath, result.shellcheckPath, result.manifestPath]) {
    if (!path.isAbsolute(file)) throw new Error(`Refusing to export non-absolute toolchain path: ${file}`);
  }
  fsImpl.appendFileSync(githubEnv,
    `ACTIONLINT_BIN=${result.actionlintPath}\nSHELLCHECK_BIN=${result.shellcheckPath}\nWORKFLOW_LINT_TOOLCHAIN_MANIFEST=${result.manifestPath}\n`, 'utf8');
  const dirs = [...new Set([path.dirname(result.actionlintPath), path.dirname(result.shellcheckPath)])];
  fsImpl.appendFileSync(githubPath, `${dirs.join('\n')}\n`, 'utf8');
}

async function installWorkflowLintToolchain({
  configPath = CONFIG_PATH,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  spawn = spawnSync,
  download = defaultDownload,
  extract = defaultExtract,
  fsImpl = fs,
  cacheRoot,
} = {}) {
  const { config, digest } = readConfig(configPath, fsImpl);
  const targetId = resolveTargetId(platform, arch);
  const target = config.targets[targetId];
  const root = cacheRoot ? path.resolve(cacheRoot) : resolveCacheRoot({ env, platform });
  const targetDir = path.join(root, 'v1', digest, targetId);
  if (fsImpl.existsSync(targetDir)) {
    return { ...validateCache({ targetDir, config, digest, targetId, spawn, fsImpl }), goVersion: config.actionlint.go_version };
  }

  const parent = path.dirname(targetDir);
  fsImpl.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `${targetId}.staging-${process.pid}`);
  if (fsImpl.existsSync(staging)) throw new Error(`Owned workflow lint staging path already exists: ${staging}`);
  fsImpl.mkdirSync(path.join(staging, 'bin'), { recursive: true });
  fsImpl.mkdirSync(path.join(staging, 'extract'), { recursive: true });
  const timeout = config.timeouts.install_ms;
  const buildEnv = {
    ...env,
    GOTOOLCHAIN: 'local',
    GOPROXY,
    GOSUMDB,
    GOPRIVATE: '',
    GONOPROXY: '',
    GONOSUMDB: '',
    CGO_ENABLED: config.actionlint.build.cgo_enabled,
    GOOS: target.goos,
    GOARCH: target.goarch,
    GOBIN: path.join(staging, 'bin'),
  };
  try {
    const goVersion = runChecked(spawn, 'go', ['env', 'GOVERSION'], { cwd: REPO_ROOT, env: buildEnv }, 'Go version probe', timeout);
    if (commandText(goVersion) !== `go${config.actionlint.go_version}`) {
      throw new Error(`Go version must be exactly go${config.actionlint.go_version}; got ${commandText(goVersion) || '<empty>'}.`);
    }
    const module = runChecked(spawn, 'go', ['mod', 'download', '-json', `${config.actionlint.module_root}@${config.actionlint.source_commit}`],
      { cwd: REPO_ROOT, env: buildEnv }, 'actionlint module resolution', timeout);
    parseModuleMetadata(module.stdout, config);
    runChecked(spawn, 'go', [
      'install', '-trimpath', '-buildvcs=false', '-ldflags=-buildid=',
      `${config.actionlint.module}@${config.actionlint.source_commit}`,
    ], { cwd: REPO_ROOT, env: buildEnv }, 'actionlint deterministic build', timeout);
    const actionlintPath = path.resolve(staging, 'bin', target.actionlint_binary);
    exactFile(actionlintPath, target.actionlint_sha256, fsImpl);
    const buildInfo = runChecked(spawn, 'go', ['version', '-m', actionlintPath], { cwd: REPO_ROOT, env: buildEnv }, 'actionlint build metadata probe', timeout);
    const buildText = commandText(buildInfo);
    if (!buildText.includes(`mod\t${config.actionlint.module_root}\t${config.actionlint.version}`)
      || !buildText.includes(`build\tCGO_ENABLED=${config.actionlint.build.cgo_enabled}`)
      || !buildText.includes(`build\tGOOS=${target.goos}`) || !buildText.includes(`build\tGOARCH=${target.goarch}`)) {
      throw new Error('actionlint build metadata does not match the deterministic source contract.');
    }
    const buildId = runChecked(spawn, 'go', ['tool', 'buildid', actionlintPath], { cwd: REPO_ROOT, env: buildEnv }, 'actionlint build-id probe', timeout);
    if (commandText(buildId)) throw new Error('actionlint deterministic build unexpectedly contains a build id.');

    const asset = await downloadPinnedAsset(target.shellcheck_asset_url, {
      attempts: config.download_attempts,
      download,
      timeoutMs: timeout,
    });
    const assetHash = sha256(asset);
    if (assetHash !== target.shellcheck_asset_sha256) {
      throw new Error(`ShellCheck asset hash mismatch: expected ${target.shellcheck_asset_sha256}, got ${assetHash}.`);
    }
    const archivePath = path.join(staging, target.shellcheck_asset_name);
    fsImpl.writeFileSync(archivePath, asset);
    extract({ archivePath, destination: path.join(staging, 'extract'), spawn, timeoutMs: timeout, target });
    const extracted = path.join(staging, 'extract', ...target.shellcheck_archive_path.split('/'));
    const shellcheckPath = path.resolve(staging, 'bin', target.shellcheck_binary);
    if (!fsImpl.existsSync(extracted)) throw new Error(`ShellCheck archive is missing ${target.shellcheck_archive_path}.`);
    fsImpl.copyFileSync(extracted, shellcheckPath);
    if (platform !== 'win32') fsImpl.chmodSync(shellcheckPath, 0o755);
    exactFile(shellcheckPath, target.shellcheck_sha256, fsImpl);

    const actionlintVersion = runChecked(spawn, actionlintPath, ['-version'], { cwd: staging, env: buildEnv }, 'actionlint version probe', config.timeouts.probe_ms);
    const shellcheckVersion = runChecked(spawn, shellcheckPath, ['--version'], { cwd: staging, env: buildEnv }, 'ShellCheck version probe', config.timeouts.probe_ms);
    verifyVersionOutput({ actionlintOutput: commandText(actionlintVersion), shellcheckOutput: commandText(shellcheckVersion), config });
    const manifestPath = path.join(staging, 'manifest.json');
    const manifest = expectedManifest({ config, digest, targetId, actionlintPath: path.resolve(targetDir, 'bin', target.actionlint_binary), shellcheckPath: path.resolve(targetDir, 'bin', target.shellcheck_binary), target });
    const partialManifest = `${manifestPath}.partial`;
    fsImpl.writeFileSync(partialManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fsImpl.renameSync(partialManifest, manifestPath);
    fsImpl.rmSync(path.join(staging, 'extract'), { recursive: true, force: true });
    fsImpl.rmSync(archivePath, { force: true });
    fsImpl.renameSync(staging, targetDir);
    return { ...validateCache({ targetDir, config, digest, targetId, spawn, fsImpl }), goVersion: config.actionlint.go_version };
  } catch (error) {
    if (fsImpl.existsSync(staging)) fsImpl.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const args = { format: 'json', resolveOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--format') args.format = argv[++index];
    else if (argv[index] === '--resolve-only') args.resolveOnly = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.resolveOnly) {
    const { config } = readConfig();
    writeGithubOutput({ goVersion: config.actionlint.go_version }, { format: args.format });
    return;
  }
  const result = await installWorkflowLintToolchain();
  writeGithubOutput(result, { format: args.format });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[install-workflow-lint-toolchain] ${String(error?.stack || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIG_PATH,
  defaultExtract,
  downloadPinnedAsset,
  exactFile,
  installWorkflowLintToolchain,
  parseModuleMetadata,
  readConfig,
  resolveCacheRoot,
  resolveTargetId,
  runChecked,
  sha256,
  validateCache,
  validateConfig,
  verifyVersionOutput,
  writeGithubOutput,
};
