#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const POLICY_PATH = path.join('config', 'ops', 'pr-validation-pg-prove-toolchain.json');
const START_MARKER = 'MASARX_PG_PROVE_TOOLCHAIN_START';
const DONE_MARKER = 'MASARX_PG_PROVE_TOOLCHAIN_DONE';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isPathWithin(parent, child) {
  const root = path.resolve(parent);
  const target = path.resolve(child);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function exactString(value, label, pattern, maxLength = 300) {
  const result = String(value || '').trim();
  if (!result || result.length > maxLength || (pattern && !pattern.test(result))) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

function exactPositiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer.`);
  return result;
}

function loadPolicy(cwd = process.cwd(), options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = path.resolve(cwd);
  const policyPath = path.resolve(root, POLICY_PATH);
  if (!isPathWithin(root, policyPath)) throw new Error('pg_prove toolchain policy escapes the worktree.');
  const stat = fsImpl.lstatSync(policyPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('pg_prove toolchain policy must be a regular non-symlink file.');
  const raw = fsImpl.readFileSync(policyPath, 'utf8');
  const policy = JSON.parse(raw);
  if (policy.schema !== 'masarx_pr_validation_pg_prove_toolchain_v1'
    || policy.engine !== 'pg_prove'
    || policy.execution_mode !== 'ephemeral_docker_container') {
    throw new Error('pg_prove toolchain policy contract is unsupported.');
  }
  const image = policy.image || {};
  exactString(image.tag, 'pg_prove image tag', /^[a-z0-9./_-]+:[A-Za-z0-9._-]+$/u);
  exactString(image.base, 'pg_prove base image', /^postgres:15-bookworm@sha256:[a-f0-9]{64}$/u);
  exactString(image.package, 'pg_prove package', /^libtap-parser-sourcehandler-pgtap-perl$/u);
  exactString(image.package_version, 'pg_prove package version', /^\d+\.\d+-\d+$/u);
  exactString(image.pg_prove_version, 'pg_prove version', /^\d+\.\d+$/u);
  if (image.psql_major !== 15) throw new Error('pg_prove toolchain psql major must remain 15.');
  const dockerfilePath = path.resolve(root, exactString(policy.dockerfile, 'pg_prove Dockerfile'));
  if (!isPathWithin(root, dockerfilePath)) throw new Error('pg_prove Dockerfile escapes the worktree.');
  const dockerfileStat = fsImpl.lstatSync(dockerfilePath);
  if (!dockerfileStat.isFile() || dockerfileStat.isSymbolicLink()) {
    throw new Error('pg_prove Dockerfile must be a regular non-symlink file.');
  }
  const runner = policy.runner || {};
  exactString(runner.workspace_mount, 'pg_prove workspace mount', /^\/workspace$/u);
  exactString(runner.state_mount, 'pg_prove state mount', /^\/state$/u);
  exactString(runner.database_host_alias, 'pg_prove database host alias', /^host\.docker\.internal$/u);
  exactString(runner.user, 'pg_prove container user', /^\d+:\d+$/u);
  exactString(runner.cpus, 'pg_prove CPU limit', /^\d+(?:\.\d+)?$/u);
  exactString(runner.memory, 'pg_prove memory limit', /^\d+[mg]$/u);
  exactPositiveInteger(runner.pids_limit, 'pg_prove pids limit');
  exactString(runner.tmpfs, 'pg_prove tmpfs');
  exactPositiveInteger(runner.internal_timeout_margin_ms, 'pg_prove timeout margin');
  exactPositiveInteger(runner.cleanup_wait_ms, 'pg_prove cleanup wait');
  const allowedEnv = Array.isArray(runner.allowed_forwarded_env) ? runner.allowed_forwarded_env : [];
  if (!allowedEnv.length || new Set(allowedEnv).size !== allowedEnv.length
    || allowedEnv.some((entry) => !/^PG[A-Z_]+$/u.test(String(entry)))) {
    throw new Error('pg_prove forwarded environment allowlist is invalid.');
  }
  return {
    cwd: root,
    path: policyPath,
    raw,
    policy,
    policySha256: sha256(canonicalJson(policy)),
    dockerfilePath,
    dockerfileSha256: sha256(fsImpl.readFileSync(dockerfilePath)),
  };
}

function expectedImageLabels(loaded) {
  return {
    'org.nzxmhryhtqlzoshjkyozkpup.example.invalidntract': 'pr-validation-pg-prove-toolchain-v1',
    'org.masarx.pg-prove.package-version': loaded.policy.image.package_version,
    'org.masarx.pg-prove.psql-major': String(loaded.policy.image.psql_major),
    'org.masarx.pg-prove.policy-sha256': loaded.policySha256,
    'org.masarx.pg-prove.dockerfile-sha256': loaded.dockerfileSha256,
  };
}

function parseImageInspect(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const image = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!image || !/^sha256:[a-f0-9]{64}$/u.test(String(image.Id || ''))) {
    throw new Error('pg_prove toolchain image inspect payload is invalid.');
  }
  return image;
}

function inspectImage(loaded, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const outcome = spawnSyncImpl('docker', ['image', 'inspect', loaded.policy.image.tag], {
    cwd: loaded.cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (outcome.status !== 0 || outcome.error) {
    throw new Error('focused_pg_prove_toolchain_missing: prepare the pinned image before validation.');
  }
  const image = parseImageInspect(outcome.stdout);
  const labels = image.Config?.Labels || {};
  for (const [key, expected] of Object.entries(expectedImageLabels(loaded))) {
    if (String(labels[key] || '') !== expected) {
      throw new Error(`focused_pg_prove_toolchain_label_mismatch: ${key}`);
    }
  }
  return {
    imageId: image.Id,
    imageTag: loaded.policy.image.tag,
    labels: expectedImageLabels(loaded),
    policySha256: loaded.policySha256,
    dockerfileSha256: loaded.dockerfileSha256,
  };
}

function buildImageCommand(loaded) {
  const context = path.dirname(loaded.dockerfilePath);
  return {
    command: 'docker',
    args: [
      'build', '--pull=false', '--network', 'default',
      '--file', loaded.dockerfilePath,
      '--tag', loaded.policy.image.tag,
      '--build-arg', `MASARX_PG_PROVE_PACKAGE_VERSION=${loaded.policy.image.package_version}`,
      '--build-arg', `MASARX_TOOLCHAIN_POLICY_SHA=${loaded.policySha256}`,
      '--build-arg', `MASARX_TOOLCHAIN_DOCKERFILE_SHA=${loaded.dockerfileSha256}`,
      context,
    ],
  };
}

function containerNameFor(options = {}) {
  const phase = exactString(options.phase, 'pg_prove phase', /^(?:parallel_wave|isolated_rerun|serial_quarantine)$/u);
  const identity = sha256(canonicalJson({
    cwd: path.resolve(options.cwd || process.cwd()),
    stateDirectory: path.resolve(options.stateDirectory || ''),
    phase,
    logicalArgs: options.logicalArgs || [],
  })).slice(0, 24);
  return `masarx-pgtap-${identity}`;
}

function mapLogicalArgsToContainer(logicalArgs, stateDirectory, loaded) {
  const result = [];
  let mappedSql = 0;
  for (let index = 0; index < logicalArgs.length; index += 1) {
    const value = String(logicalArgs[index] || '');
    if (logicalArgs[index - 1] === '--host' && /^(?:127\.0\.0\.1|localhost|::1)$/u.test(value)) {
      result.push(loaded.policy.runner.database_host_alias);
      continue;
    }
    if (path.isAbsolute(value) && isPathWithin(stateDirectory, value)) {
      const relative = path.relative(stateDirectory, path.resolve(value)).split(path.sep).join('/');
      if (!relative || relative.startsWith('../') || !relative.endsWith('.sql')) {
        throw new Error('pg_prove execution argument is not a canonical wrapper SQL path.');
      }
      result.push(`${loaded.policy.runner.state_mount}/${relative}`);
      mappedSql += 1;
      continue;
    }
    if (path.isAbsolute(value)) throw new Error('pg_prove logical arguments contain an unmounted absolute host path.');
    result.push(value);
  }
  if (mappedSql < 1) throw new Error('pg_prove logical arguments contain no wrapper SQL files.');
  return result;
}

function buildDockerRunCommand(options = {}) {
  const loaded = options.loaded || loadPolicy(options.cwd);
  const cwd = loaded.cwd;
  const requestedState = String(options.stateDirectory || '');
  const stateDirectory = path.resolve(requestedState);
  if (!path.isAbsolute(requestedState) || requestedState !== stateDirectory || !isPathWithin(cwd, stateDirectory)) {
    throw new Error('pg_prove state directory must be canonical and inside the active worktree.');
  }
  const stateStat = fs.lstatSync(stateDirectory);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new Error('pg_prove state directory must be a regular non-symlink directory.');
  }
  const timeoutMs = exactPositiveInteger(options.timeoutMs, 'pg_prove host timeout');
  const margin = loaded.policy.runner.internal_timeout_margin_ms;
  if (timeoutMs <= margin + 5000) throw new Error('pg_prove timeout is too short for bounded container cleanup.');
  const internalSeconds = Math.max(5, Math.floor((timeoutMs - margin) / 1000));
  const logicalArgs = Array.isArray(options.logicalArgs) ? options.logicalArgs.map(String) : [];
  const containerArgs = mapLogicalArgsToContainer(logicalArgs, stateDirectory, loaded);
  const name = containerNameFor({ cwd, stateDirectory, phase: options.phase, logicalArgs });
  const imageReference = options.imageId
    ? exactString(options.imageId, 'pg_prove prepared image ID', /^sha256:[a-f0-9]{64}$/u)
    : loaded.policy.image.tag;
  const args = [
    'run', '--rm', '--init', '--pull', 'never', '--name', name,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', loaded.policy.runner.user,
    '--cpus', loaded.policy.runner.cpus,
    '--memory', loaded.policy.runner.memory,
    '--pids-limit', String(loaded.policy.runner.pids_limit),
    '--tmpfs', loaded.policy.runner.tmpfs,
    '--add-host', `${loaded.policy.runner.database_host_alias}:host-gateway`,
    '--mount', `type=bind,source=${cwd},target=${loaded.policy.runner.workspace_mount},readonly`,
    '--mount', `type=bind,source=${stateDirectory},target=${loaded.policy.runner.state_mount}`,
    '--workdir', loaded.policy.runner.state_mount,
    '--env', 'HOME=/tmp',
  ];
  for (const key of loaded.policy.runner.allowed_forwarded_env) {
    if (process.env[key] != null && process.env[key] !== '') args.push('--env', key);
  }
  args.push(
    '--label', 'org.masarx.resource-class=pr-validation-pg-prove-runner',
    '--label', `org.masarx.phase=${options.phase}`,
    '--label', `org.masarx.pg-prove.policy-sha256=${loaded.policySha256}`,
    '--label', `org.masarx.pg-prove.dockerfile-sha256=${loaded.dockerfileSha256}`,
    imageReference,
    'timeout', '--signal=TERM', '--kill-after=5s', `${internalSeconds}s`,
    'pg_prove', ...containerArgs,
  );
  return {
    command: 'docker',
    args,
    containerName: name,
    containerArgs,
    internalTimeoutMs: internalSeconds * 1000,
    stateFile: path.join(stateDirectory, '.pg_prove'),
  };
}

function buildToolchainCommand(options = {}) {
  const loaded = loadPolicy(options.cwd);
  const script = path.resolve(loaded.cwd, 'scripts', 'ops', 'pr-validation-pg-prove-toolchain-cli.js');
  const logicalArgs = Array.isArray(options.logicalArgs) ? options.logicalArgs.map(String) : [];
  const containerName = containerNameFor({
    cwd: loaded.cwd,
    stateDirectory: options.stateDirectory,
    phase: options.phase,
    logicalArgs,
  });
  return {
    command: process.execPath,
    args: [
      script, 'run', '--cwd', loaded.cwd,
      '--state-directory', path.resolve(options.stateDirectory),
      '--phase', String(options.phase),
      '--timeout-ms', String(options.timeoutMs),
      '--', ...logicalArgs,
    ],
    containerName,
    stateFile: path.join(path.resolve(options.stateDirectory), '.pg_prove'),
    policySha256: loaded.policySha256,
    dockerfileSha256: loaded.dockerfileSha256,
  };
}

function markerFields(line, marker) {
  const match = String(line || '').match(new RegExp(`^${marker} image=(sha256:[a-f0-9]{64}) policy=([a-f0-9]{64}) dockerfile=([a-f0-9]{64}) container=([a-z0-9-]+)(?: residual=(0|1) exit=(\\d+))?$`, 'u'));
  if (!match) return null;
  return {
    imageId: match[1],
    policySha256: match[2],
    dockerfileSha256: match[3],
    containerName: match[4],
    residual: match[5] == null ? null : Number(match[5]),
    exit: match[6] == null ? null : Number(match[6]),
  };
}

function assertToolchainEvidence(output, options = {}) {
  const loaded = loadPolicy(options.cwd);
  const lines = String(output || '').split(/\r?\n/u);
  const starts = lines.map((line) => markerFields(line, START_MARKER)).filter(Boolean);
  const dones = lines.map((line) => markerFields(line, DONE_MARKER)).filter(Boolean);
  if (starts.length !== 1 || dones.length !== 1) throw new Error('pg_prove toolchain markers are missing or ambiguous.');
  const start = starts[0];
  const done = dones[0];
  if (start.imageId !== done.imageId
    || start.policySha256 !== loaded.policySha256
    || done.policySha256 !== loaded.policySha256
    || start.dockerfileSha256 !== loaded.dockerfileSha256
    || done.dockerfileSha256 !== loaded.dockerfileSha256
    || start.containerName !== done.containerName
    || done.residual !== 0) {
    throw new Error('pg_prove toolchain evidence does not match the active source or zero-residual contract.');
  }
  return done;
}

module.exports = {
  DONE_MARKER,
  POLICY_PATH,
  START_MARKER,
  assertToolchainEvidence,
  buildDockerRunCommand,
  buildImageCommand,
  buildToolchainCommand,
  canonicalJson,
  containerNameFor,
  expectedImageLabels,
  inspectImage,
  loadPolicy,
  mapLogicalArgsToContainer,
  parseImageInspect,
  sha256,
};
