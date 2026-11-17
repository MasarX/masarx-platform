#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  CONTRACT: INSTALL_CONTRACT,
  PROBE_CONTRACT: INSTALL_PROBE_CONTRACT,
  assertNoCompetingNpmInstall,
  collectProcessSnapshot,
  createProbes,
  isPathInside,
  parseLastJsonLine,
  resolveDependencyTreeTargets,
  resolveInstallTimeout,
  resolveNpmInvocation,
  runProbeInChild,
  runProbes,
  validateInstallEnvironment,
} = require('./install-unit-qualification-dependencies');

const PROJECTION_CONTRACT = Object.freeze({
  schema: 'masarx.unit-qualification-dependency-projection.v1',
  receipt_schema: 'masarx.unit-qualification-dependency-projection-receipt.v1',
  lease_schema: 'masarx.unit-qualification-dependency-projection-lease.v1',
  root_relative: path.join('MasarX', 'dependency-projections', 'v1'),
  required_dependency_root_count: 6,
  required_workspace_link_count: 8,
  min_free_bytes: 5 * 1024 * 1024 * 1024,
  command_timeout_ms: 90 * 60 * 1000,
  cleanup_timeout_ms: 10 * 60 * 1000,
  digest_timeout_ms: 10 * 60 * 1000,
  quiescence_timeout_ms: 30 * 1000,
  quiescence_interval_ms: 250,
  quiescence_stable_samples: 2,
  probe_descendant_grace_ms: 30 * 1000,
});

function slash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath, fsImpl = fs) {
  return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
}

function resolveInstallManifestMap(repoRoot, workspaceEntries, fsImpl = fs) {
  const relatives = [
    'package.json',
    ...workspaceEntries.map((entry) => `${entry.relative}/package.json`),
  ].sort();
  return relatives.map((relative) => {
    const manifest = readJson(path.join(repoRoot, ...relative.split('/')), fsImpl);
    delete manifest.scripts;
    return { relative, sha256: sha256(stableJson(manifest)) };
  });
}

function resolveWorkspaceEntries(repoRoot = process.cwd(), fsImpl = fs) {
  const realRepoRoot = fsImpl.realpathSync(path.resolve(repoRoot));
  const rootDependencyTarget = path.join(realRepoRoot, 'node_modules');
  const workspaceRoots = resolveDependencyTreeTargets(realRepoRoot, fsImpl)
    .filter((target) => path.resolve(target) !== path.resolve(rootDependencyTarget))
    .map((target) => path.dirname(target));
  const entries = workspaceRoots.map((workspaceRoot) => {
    const manifestPath = path.join(workspaceRoot, 'package.json');
    const manifest = readJson(manifestPath, fsImpl);
    const name = String(manifest.name || '').trim();
    const relative = slash(path.relative(realRepoRoot, workspaceRoot));
    if (!name || !relative || relative.startsWith('../')) {
      throw new Error(`dependency_projection_workspace_invalid:${relative || '<empty>'}`);
    }
    return { name, relative, manifest_path: manifestPath };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const names = entries.map((entry) => entry.name);
  const relatives = entries.map((entry) => entry.relative);
  if (entries.length !== PROJECTION_CONTRACT.required_workspace_link_count
    || new Set(names).size !== entries.length
    || new Set(relatives).size !== entries.length) {
    throw new Error(`dependency_projection_workspace_count:${entries.length}`);
  }
  return entries;
}

function resolveExpectedDependencyRoots(
  repoRoot = process.cwd(),
  fsImpl = fs,
  workspaceEntries = resolveWorkspaceEntries(repoRoot, fsImpl),
) {
  const realRepoRoot = fsImpl.realpathSync(path.resolve(repoRoot));
  const lock = readJson(path.join(realRepoRoot, 'package-lock.json'), fsImpl);
  const packageKeys = Object.keys(lock.packages || {}).map(slash);
  const candidates = [
    'node_modules',
    ...workspaceEntries.map((entry) => `${entry.relative}/node_modules`),
  ];
  const roots = candidates.filter((relative) => {
    const prefix = `${relative}/`;
    return packageKeys.some((packageKey) => packageKey.startsWith(prefix));
  }).sort();
  if (roots.length !== PROJECTION_CONTRACT.required_dependency_root_count) {
    throw new Error(`dependency_projection_root_count:${roots.length}`);
  }
  return roots;
}

function readNpmVersion({ execPath = process.execPath, fsImpl = fs } = {}) {
  const npmManifestPath = path.join(
    path.dirname(execPath),
    'node_modules',
    'npm',
    'package.json',
  );
  if (!fsImpl.existsSync(npmManifestPath)) {
    throw new Error(`dependency_projection_npm_manifest_missing:${npmManifestPath}`);
  }
  const version = String(readJson(npmManifestPath, fsImpl).version || '').trim();
  if (!version) throw new Error('dependency_projection_npm_version_missing');
  return version;
}

function createProjectionIdentity({
  repoRoot = process.cwd(),
  fsImpl = fs,
  runtime = {},
  probeContract = INSTALL_PROBE_CONTRACT,
} = {}) {
  const realRepoRoot = fsImpl.realpathSync(path.resolve(repoRoot));
  const lockBytes = fsImpl.readFileSync(path.join(realRepoRoot, 'package-lock.json'));
  const workspaceEntries = resolveWorkspaceEntries(realRepoRoot, fsImpl);
  const dependencyRoots = resolveExpectedDependencyRoots(realRepoRoot, fsImpl, workspaceEntries);
  const installManifestMap = resolveInstallManifestMap(realRepoRoot, workspaceEntries, fsImpl);
  const requiredProbeIds = Array.isArray(probeContract?.required_probe_ids)
    ? probeContract.required_probe_ids
    : INSTALL_CONTRACT.required_probe_ids;
  const probeContractSha256 = sha256(stableJson(probeContract));
  const payload = {
    schema: PROJECTION_CONTRACT.schema,
    lock_sha256: sha256(lockBytes),
    workspace_map: workspaceEntries.map(({ name, relative }) => ({ name, relative })),
    install_manifest_map: installManifestMap,
    dependency_roots: dependencyRoots,
    platform: runtime.platform || process.platform,
    arch: runtime.arch || process.arch,
    node_version: runtime.node_version || process.versions.node,
    node_abi: runtime.node_abi || process.versions.modules,
    npm_version: runtime.npm_version || readNpmVersion({ fsImpl }),
    npm_args: INSTALL_CONTRACT.npm_args,
    required_probe_ids: requiredProbeIds,
    probe_contract: probeContract,
    probe_contract_sha256: probeContractSha256,
  };
  return {
    ...payload,
    key: sha256(stableJson(payload)),
    repo_root: realRepoRoot,
    workspace_entries: workspaceEntries,
  };
}

function assertNoReparseComponents(targetPath, fsImpl = fs) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  const relative = path.relative(parsed.root, resolved);
  let cursor = parsed.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fsImpl.existsSync(cursor)) continue;
    if (fsImpl.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`dependency_projection_path_reparse:${cursor}`);
    }
  }
  return resolved;
}

function resolveProjectionPaths({
  identity,
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
} = {}) {
  if (!identity?.key) throw new Error('dependency_projection_identity_required');
  const localAppData = String(env.LOCALAPPDATA || '').trim();
  const configured = String(env.MASARX_DEPENDENCY_PROJECTION_ROOT || '').trim();
  if (platform === 'win32' && !localAppData) {
    throw new Error('dependency_projection_localappdata_required');
  }
  const canonicalBase = path.resolve(path.join(localAppData, PROJECTION_CONTRACT.root_relative));
  if (configured && path.resolve(configured).toLowerCase() !== canonicalBase.toLowerCase()) {
    throw new Error(`dependency_projection_root_override_invalid:${configured}`);
  }
  const base = canonicalBase;
  if (platform === 'win32') {
    const allowedRoot = path.parse(path.resolve(localAppData)).root.toLowerCase();
    if (path.parse(base).root.toLowerCase() !== allowedRoot) {
      throw new Error(`dependency_projection_wrong_volume:${base}`);
    }
  }
  if (isPathInside(identity.repo_root, base) || isPathInside(base, identity.repo_root)) {
    throw new Error('dependency_projection_repository_overlap');
  }
  assertNoReparseComponents(base, fsImpl);
  const projectionRoot = path.join(base, 'projections', identity.key);
  const paths = {
    base,
    projection_root: projectionRoot,
    receipt_path: path.join(projectionRoot, '.masarx-dependency-projection.json'),
    npm_cache: path.join(base, 'npm-cache'),
    lock_path: path.join(base, 'locks', `${identity.key}.build.lock`),
    lease_lock_path: path.join(base, 'locks', `${identity.key}.lease.lock`),
    leases_root: path.join(base, 'leases'),
    receipts_root: path.join(base, 'receipts'),
    staging_root: path.join(base, 'staging'),
  };
  for (const candidate of Object.values(paths)) {
    if (!isPathInside(base, candidate)) {
      throw new Error(`dependency_projection_path_escape:${candidate}`);
    }
  }
  return paths;
}

function prepareProjectionBase(paths, {
  fsImpl = fs,
  minFreeBytes = PROJECTION_CONTRACT.min_free_bytes,
} = {}) {
  for (const directory of [
    paths.base,
    path.dirname(paths.lock_path),
    paths.leases_root,
    paths.receipts_root,
    paths.staging_root,
    paths.npm_cache,
  ]) {
    assertNoReparseComponents(directory, fsImpl);
    fsImpl.mkdirSync(directory, { recursive: true });
    assertNoReparseComponents(directory, fsImpl);
  }
  if (typeof fsImpl.statfsSync !== 'function') {
    throw new Error('dependency_projection_capacity_unavailable');
  }
  const stats = fsImpl.statfsSync(paths.base);
  const freeBytes = Number(stats?.bavail) * Number(stats?.bsize);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < minFreeBytes) {
    throw new Error(`dependency_projection_capacity_insufficient:${freeBytes || 0}:${minFreeBytes}`);
  }
  return { free_bytes: freeBytes };
}

function listReparsePaths(rootPath, fsImpl = fs) {
  const root = path.resolve(rootPath);
  const reparses = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fsImpl.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        reparses.push(slash(path.relative(root, absolute)));
      } else if (entry.isDirectory()) {
        pending.push(absolute);
      }
    }
  }
  return reparses.sort();
}

function computeProjectionTreeDigest(rootPath, fsImpl = fs, spawnSyncImpl = spawnSync) {
  const root = path.resolve(rootPath);
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fsImpl.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = slash(path.relative(root, absolute));
      if (entry.isSymbolicLink()) {
        throw new Error(`dependency_projection_digest_reparse:${relative}`);
      }
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()
        && relative !== '.masarx-dependency-projection.json') {
        if (/\r|\n/.test(relative)) {
          throw new Error(`dependency_projection_digest_path_invalid:${relative}`);
        }
        files.push({
          relative,
          size: String(fsImpl.statSync(absolute, { bigint: true }).size),
        });
      } else if (!entry.isFile()) {
        throw new Error(`dependency_projection_digest_entry_invalid:${relative}`);
      }
    }
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  const result = spawnSyncImpl('git', ['hash-object', '--no-filters', '--stdin-paths'], {
    cwd: root,
    input: files.length ? `${files.map((entry) => entry.relative).join('\n')}\n` : '',
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: PROJECTION_CONTRACT.digest_timeout_ms,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result?.error || result?.status !== 0) {
    throw new Error(`dependency_projection_digest_failed:${result?.error?.code || result?.status || 'unknown'}`);
  }
  const hashes = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (hashes.length !== files.length || hashes.some((hash) => !/^[0-9a-f]{40,64}$/i.test(hash))) {
    throw new Error(`dependency_projection_digest_receipt_invalid:${hashes.length}:${files.length}`);
  }
  const digest = crypto.createHash('sha256');
  for (const [index, entry] of files.entries()) {
    digest.update(entry.relative);
    digest.update('\0');
    digest.update(hashes[index].toLowerCase());
    digest.update('\0');
    digest.update(entry.size);
    digest.update('\n');
  }
  return { digest: digest.digest('hex'), file_count: files.length };
}

function expectedWorkspaceLinks(rootPath, identity) {
  return identity.workspace_entries.map((entry) => {
    const segments = entry.name.split('/');
    if (segments.length !== 2 || !segments[0].startsWith('@') || !segments[1]) {
      throw new Error(`dependency_projection_workspace_name_invalid:${entry.name}`);
    }
    return {
      ...entry,
      link_path: path.join(rootPath, 'node_modules', ...segments),
      link_relative: slash(path.join('node_modules', ...segments)),
    };
  }).sort((left, right) => left.link_relative.localeCompare(right.link_relative));
}

function assertDirectoryLink(linkPath, expectedTarget, fsImpl = fs) {
  if (!fsImpl.existsSync(linkPath) || !fsImpl.lstatSync(linkPath).isSymbolicLink()) {
    throw new Error(`dependency_projection_link_invalid:${linkPath}`);
  }
  const actual = fsImpl.realpathSync(linkPath);
  const expected = fsImpl.realpathSync(expectedTarget);
  if (path.resolve(actual) !== path.resolve(expected)) {
    throw new Error(`dependency_projection_link_target_mismatch:${linkPath}:${actual}:${expected}`);
  }
  return true;
}

function removeDirectoryLink(linkPath, expectedTarget, {
  fsImpl = fs,
} = {}) {
  assertDirectoryLink(linkPath, expectedTarget, fsImpl);
  fsImpl.unlinkSync(linkPath);
  if (fsImpl.existsSync(linkPath)) {
    throw new Error(`dependency_projection_link_remove_failed:${linkPath}`);
  }
}

function validateDependencyRoots(rootPath, identity, fsImpl = fs) {
  const expected = new Set(identity.dependency_roots);
  const allTargets = resolveDependencyTreeTargets(rootPath, fsImpl)
    .map((target) => slash(path.relative(rootPath, target)));
  for (const relative of allTargets) {
    const absolute = path.join(rootPath, ...relative.split('/'));
    const exists = fsImpl.existsSync(absolute);
    if (expected.has(relative)) {
      if (!exists || !fsImpl.lstatSync(absolute).isDirectory()
        || fsImpl.lstatSync(absolute).isSymbolicLink()
        || fsImpl.readdirSync(absolute).length === 0) {
        throw new Error(`dependency_projection_root_invalid:${relative}`);
      }
    } else if (exists) {
      throw new Error(`dependency_projection_unexpected_root:${relative}`);
    }
  }
  return [...expected].sort();
}

function validateInstalledWorkspaceLinks(rootPath, identity, fsImpl = fs) {
  const expected = expectedWorkspaceLinks(rootPath, identity);
  const actual = listReparsePaths(rootPath, fsImpl);
  const expectedRelatives = expected.map((entry) => entry.link_relative);
  if (stableJson(actual) !== stableJson(expectedRelatives)) {
    throw new Error(`dependency_projection_reparse_set_invalid:${stableJson(actual)}`);
  }
  for (const entry of expected) {
    const target = path.join(rootPath, ...entry.relative.split('/'));
    assertDirectoryLink(entry.link_path, target, fsImpl);
  }
  return expected;
}

function sanitizeInstalledWorkspaceLinks(rootPath, identity, {
  fsImpl = fs,
} = {}) {
  const links = validateInstalledWorkspaceLinks(rootPath, identity, fsImpl);
  for (const entry of [...links].reverse()) {
    const target = path.join(rootPath, ...entry.relative.split('/'));
    removeDirectoryLink(entry.link_path, target, { fsImpl });
  }
  return links.map((entry) => entry.link_relative);
}

function writeJsonAtomic(filePath, value, fsImpl = fs) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  fsImpl.renameSync(temporary, filePath);
}

function acquireExclusiveLock(lockPath, payload, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const receipt = {
    ...payload,
    token,
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  };
  let descriptor;
  try {
    descriptor = fsImpl.openSync(lockPath, 'wx', 0o600);
    fsImpl.writeFileSync(descriptor, `${JSON.stringify(receipt)}\n`, 'utf8');
    fsImpl.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
    if (error?.code === 'EEXIST') {
      throw new Error(`dependency_projection_lock_held:${lockPath}`);
    }
    throw error;
  }
  fsImpl.closeSync(descriptor);
  return receipt;
}

function releaseExclusiveLock(lockPath, token, fsImpl = fs) {
  const current = readJson(lockPath, fsImpl);
  if (current.token !== token || current.pid !== process.pid) {
    throw new Error(`dependency_projection_lock_identity_mismatch:${lockPath}`);
  }
  fsImpl.unlinkSync(lockPath);
}

function resolveCandidateLockPath(paths, candidateRoot) {
  return path.join(paths.base, 'locks', `candidate-${sha256(path.resolve(candidateRoot).toLowerCase())}.lock`);
}

function resolveCandidateReceiptPath(paths, candidateRoot) {
  return path.join(paths.receipts_root, `candidate-${sha256(path.resolve(candidateRoot).toLowerCase())}.json`);
}

function copyProjectionManifests(identity, destinationRoot, fsImpl = fs) {
  const relatives = ['package-lock.json', ...identity.install_manifest_map.map((entry) => entry.relative)];
  for (const relative of relatives) {
    const source = path.join(identity.repo_root, ...relative.split('/'));
    const destination = path.join(destinationRoot, ...relative.split('/'));
    if (!isPathInside(destinationRoot, destination)) {
      throw new Error(`dependency_projection_manifest_escape:${relative}`);
    }
    fsImpl.mkdirSync(path.dirname(destination), { recursive: true });
    fsImpl.copyFileSync(source, destination, fsImpl.constants.COPYFILE_EXCL);
  }
  return relatives.sort();
}

function validateProjectionManifestCopy(identity, destinationRoot, fsImpl = fs) {
  const copiedLock = fsImpl.readFileSync(path.join(destinationRoot, 'package-lock.json'));
  const copiedManifestMap = resolveInstallManifestMap(
    destinationRoot,
    identity.workspace_entries,
    fsImpl,
  );
  if (sha256(copiedLock) !== identity.lock_sha256
    || stableJson(copiedManifestMap) !== stableJson(identity.install_manifest_map)) {
    throw new Error('dependency_projection_manifest_copy_drift');
  }
  return { lock_sha256: identity.lock_sha256, install_manifest_map: copiedManifestMap };
}

function assertProjectionIdentityCurrent(identity, fsImpl = fs) {
  const current = createProjectionIdentity({
    repoRoot: identity.repo_root,
    fsImpl,
    runtime: {
      platform: identity.platform,
      arch: identity.arch,
      node_version: identity.node_version,
      node_abi: identity.node_abi,
      npm_version: identity.npm_version,
    },
  });
  if (current.key !== identity.key) {
    throw new Error(`dependency_projection_candidate_identity_drift:${identity.key}:${current.key}`);
  }
  return current;
}

function validatePublishedProjection(paths, identity, fsImpl = fs) {
  if (!fsImpl.existsSync(paths.projection_root) || !fsImpl.existsSync(paths.receipt_path)) {
    throw new Error('dependency_projection_published_missing');
  }
  assertNoReparseComponents(paths.projection_root, fsImpl);
  const receipt = readJson(paths.receipt_path, fsImpl);
  if (receipt.schema !== PROJECTION_CONTRACT.receipt_schema
    || receipt.key !== identity.key
    || receipt.lock_sha256 !== identity.lock_sha256
    || stableJson(receipt.dependency_roots) !== stableJson(identity.dependency_roots)
    || stableJson(receipt.workspace_map) !== stableJson(identity.workspace_map)
    || stableJson(receipt.install_manifest_map) !== stableJson(identity.install_manifest_map)
    || stableJson(receipt.required_probe_ids) !== stableJson(identity.required_probe_ids)
    || stableJson(receipt.probe_contract) !== stableJson(identity.probe_contract)
    || receipt.probe_contract_sha256 !== identity.probe_contract_sha256) {
    throw new Error('dependency_projection_receipt_invalid');
  }
  validateDependencyRoots(paths.projection_root, identity, fsImpl);
  const tree = computeProjectionTreeDigest(paths.projection_root, fsImpl);
  if (!receipt.tree_digest || receipt.tree_digest !== tree.digest
    || receipt.tree_file_count !== tree.file_count) {
    throw new Error('dependency_projection_tree_digest_invalid');
  }
  return receipt;
}

function cleanupProjectionPathDirect(targetPath, allowedRoot, fsImpl = fs) {
  const target = path.resolve(targetPath);
  const allowed = path.resolve(allowedRoot);
  if (target === allowed || !isPathInside(allowed, target)) {
    throw new Error(`dependency_projection_cleanup_escape:${target}`);
  }
  assertNoReparseComponents(target, fsImpl);
  if (!fsImpl.existsSync(target)) return { passed: true, skipped: true };
  const reparses = listReparsePaths(target, fsImpl);
  if (reparses.length) {
    throw new Error(`dependency_projection_cleanup_reparse:${stableJson(reparses)}`);
  }
  fsImpl.rmSync(target, { recursive: true, force: false, maxRetries: 0, retryDelay: 0 });
  if (fsImpl.existsSync(target)) throw new Error(`dependency_projection_cleanup_remaining:${target}`);
  return { passed: true, skipped: false };
}

function runBoundedCleanup(targetPath, allowedRoot, {
  spawnSyncImpl = spawnSync,
  timeoutMs = PROJECTION_CONTRACT.cleanup_timeout_ms,
} = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const result = spawnSyncImpl(process.execPath, [
    __filename,
    '--cleanup-projection-path',
    path.resolve(targetPath),
  ], {
    cwd: path.dirname(__filename),
    env: {
      ...process.env,
      MASARX_DEPENDENCY_PROJECTION_CLEANUP_ROOT: path.resolve(allowedRoot),
      MASARX_DEPENDENCY_PROJECTION_CLEANUP_TOKEN: token,
    },
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 1024 * 1024,
  });
  const receipt = parseLastJsonLine(result?.stdout);
  if (result?.error || result?.status !== 0 || receipt?.passed !== true
    || receipt?.token !== token) {
    throw new Error(`dependency_projection_cleanup_failed:${result?.error?.code || result?.status || 'receipt'}`);
  }
  return receipt;
}

function buildProjection({
  identity = createProjectionIdentity(),
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  digestSpawnSyncImpl = spawnSync,
  cleanupImpl = runBoundedCleanup,
} = {}) {
  if (platform !== 'win32') throw new Error('dependency_projection_windows_only');
  const environment = validateInstallEnvironment(env);
  if (!environment.ok) {
    throw new Error(`dependency_projection_environment_invalid:${environment.errors.join(',')}`);
  }
  const paths = resolveProjectionPaths({ identity, env, platform, fsImpl });
  const capacity = prepareProjectionBase(paths, { fsImpl });
  if (fsImpl.existsSync(paths.projection_root)) {
    if (fsImpl.existsSync(paths.lock_path)) {
      throw new Error(`dependency_projection_build_recovery_required:${paths.lock_path}`);
    }
    return { paths, receipt: validatePublishedProjection(paths, identity, fsImpl), reused: true };
  }
  const lock = acquireExclusiveLock(paths.lock_path, {
    schema: PROJECTION_CONTRACT.schema,
    operation: 'build',
    key: identity.key,
  }, fsImpl);
  const stage = path.join(
    paths.staging_root,
    `${identity.key}.build-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  const workspace = path.join(stage, 'workspace');
  let buildLockCanRelease = false;
  let buildCleanupAuthorized = true;
  try {
    if (fsImpl.existsSync(paths.projection_root)) {
      buildLockCanRelease = true;
      return { paths, receipt: validatePublishedProjection(paths, identity, fsImpl), reused: true };
    }
    fsImpl.mkdirSync(workspace, { recursive: true });
    const manifestFiles = copyProjectionManifests(identity, workspace, fsImpl);
    validateProjectionManifestCopy(identity, workspace, fsImpl);
    const tempRoot = path.join(stage, 'temp');
    const logRoot = path.join(stage, 'logs');
    fsImpl.mkdirSync(tempRoot, { recursive: true });
    fsImpl.mkdirSync(logRoot, { recursive: true });
    const invocation = resolveNpmInvocation(platform);
    writeJsonAtomic(paths.lock_path, {
      ...lock,
      status: 'building',
      stage_path: stage,
    }, fsImpl);
    buildCleanupAuthorized = false;
    const result = spawnSyncImpl(invocation.executable, [
      ...invocation.prefixArgs,
      ...INSTALL_CONTRACT.npm_args,
    ], {
      cwd: workspace,
      env: {
        ...env,
        TMP: tempRoot,
        TEMP: tempRoot,
        TMPDIR: tempRoot,
        npm_config_cache: paths.npm_cache,
        npm_config_logs_dir: logRoot,
        npm_config_logs_max: '20',
      },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      timeout: resolveInstallTimeout(INSTALL_CONTRACT, platform),
      killSignal: 'SIGTERM',
    });
    buildCleanupAuthorized = Number.isInteger(result?.status);
    if (result?.error || result?.status !== 0) {
      throw new Error(`dependency_projection_npm_failed:${result?.error?.code || result?.status || 'unknown'}`);
    }
    validateDependencyRoots(workspace, identity, fsImpl);
    const removedLinks = sanitizeInstalledWorkspaceLinks(workspace, identity, { fsImpl });
    buildCleanupAuthorized = false;
    const tree = computeProjectionTreeDigest(workspace, fsImpl, digestSpawnSyncImpl);
    buildCleanupAuthorized = true;
    const receipt = {
      schema: PROJECTION_CONTRACT.receipt_schema,
      key: identity.key,
      lock_sha256: identity.lock_sha256,
      workspace_map: identity.workspace_map,
      install_manifest_map: identity.install_manifest_map,
      dependency_roots: identity.dependency_roots,
      runtime: {
        platform: identity.platform,
        arch: identity.arch,
        node_version: identity.node_version,
        node_abi: identity.node_abi,
        npm_version: identity.npm_version,
      },
      npm_args: identity.npm_args,
      required_probe_ids: identity.required_probe_ids,
      probe_contract: identity.probe_contract,
      probe_contract_sha256: identity.probe_contract_sha256,
      manifest_files: manifestFiles,
      removed_workspace_links: removedLinks,
      tree_digest: tree.digest,
      tree_file_count: tree.file_count,
      free_bytes_before: capacity.free_bytes,
      started_at: lock.acquired_at,
      completed_at: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(workspace, '.masarx-dependency-projection.json'), receipt, fsImpl);
    fsImpl.mkdirSync(path.dirname(paths.projection_root), { recursive: true });
    fsImpl.renameSync(workspace, paths.projection_root);
    cleanupImpl(stage, paths.staging_root);
    buildLockCanRelease = true;
    return { paths, receipt, reused: false };
  } catch (error) {
    if (buildCleanupAuthorized && fsImpl.existsSync(workspace)) {
      try {
        const reparses = listReparsePaths(workspace, fsImpl);
        const expected = expectedWorkspaceLinks(workspace, identity);
        const expectedByRelative = new Map(expected.map((entry) => [entry.link_relative, entry]));
        if (reparses.every((relative) => expectedByRelative.has(relative))) {
          for (const relative of [...reparses].reverse()) {
            const entry = expectedByRelative.get(relative);
            const target = path.join(workspace, ...entry.relative.split('/'));
            removeDirectoryLink(entry.link_path, target, { fsImpl });
          }
        }
        if (!listReparsePaths(stage, fsImpl).length) {
          cleanupImpl(stage, paths.staging_root);
          buildLockCanRelease = !fsImpl.existsSync(stage);
        }
      } catch {
        // Preserve uncertain staging state and the build lock for explicit recovery.
      }
    }
    throw error;
  } finally {
    if (buildLockCanRelease && fsImpl.existsSync(paths.lock_path)) {
      try { releaseExclusiveLock(paths.lock_path, lock.token, fsImpl); } catch { /* fail closed on next use */ }
    }
  }
}

function bindWorkspaceLinks(projectionRoot, identity, candidateRoot, {
  fsImpl = fs,
} = {}) {
  const created = [];
  try {
    for (const entry of expectedWorkspaceLinks(projectionRoot, identity)) {
      const target = path.join(candidateRoot, ...entry.relative.split('/'));
      if (!fsImpl.existsSync(target) || fsImpl.lstatSync(target).isSymbolicLink()) {
        throw new Error(`dependency_projection_candidate_workspace_invalid:${entry.relative}`);
      }
      fsImpl.mkdirSync(path.dirname(entry.link_path), { recursive: true });
      fsImpl.symlinkSync(target, entry.link_path, 'junction');
      created.push({ ...entry, target });
      assertDirectoryLink(entry.link_path, target, fsImpl);
    }
    return created;
  } catch (error) {
    for (const entry of [...created].reverse()) {
      try { removeDirectoryLink(entry.link_path, entry.target, { fsImpl }); } catch { /* retain proof */ }
    }
    throw error;
  }
}

function unbindWorkspaceLinks(projectionRoot, boundLinks, {
  fsImpl = fs,
} = {}) {
  for (const entry of [...boundLinks].reverse()) {
    removeDirectoryLink(entry.link_path, entry.target, { fsImpl });
  }
}

function resolveBackupBase(candidateRoot, {
  env = process.env,
  fsImpl = fs,
  platform = process.platform,
} = {}) {
  const realCandidate = fsImpl.realpathSync(path.resolve(candidateRoot));
  const volumeRoot = path.parse(realCandidate).root;
  const configured = String(env.MASARX_DEPENDENCY_PROJECTION_BACKUP_ROOT || '').trim();
  const base = path.resolve(configured || path.join(
    volumeRoot,
    'MasarX-dependency-projection-backups',
    'v1',
  ));
  if (isPathInside(realCandidate, base) || isPathInside(base, realCandidate)) {
    throw new Error('dependency_projection_backup_repository_overlap');
  }
  if (platform === 'win32'
    && path.parse(base).root.toLowerCase() !== volumeRoot.toLowerCase()) {
    throw new Error(`dependency_projection_backup_cross_volume:${base}`);
  }
  assertNoReparseComponents(base, fsImpl);
  fsImpl.mkdirSync(base, { recursive: true });
  assertNoReparseComponents(base, fsImpl);
  const candidateStats = fsImpl.statSync(realCandidate);
  const backupStats = fsImpl.statSync(base);
  if (String(candidateStats.dev) !== String(backupStats.dev)) {
    throw new Error('dependency_projection_backup_cross_device');
  }
  return base;
}

function createRootSwapPlan({
  identity,
  projectionRoot,
  candidateRoot,
  backupRoot,
} = {}) {
  return identity.dependency_roots.map((relative) => ({
    relative,
    source: path.join(candidateRoot, ...relative.split('/')),
    projection: path.join(projectionRoot, ...relative.split('/')),
    backup: path.join(backupRoot, 'original', ...relative.split('/')),
    staged: path.join(backupRoot, 'staged', ...relative.split('/')),
    detached: path.join(backupRoot, 'detached', ...relative.split('/')),
    existed: false,
    attached: false,
    original_identity: null,
    restored_identity: null,
  }));
}

function readDirectoryIdentity(directoryPath, fsImpl = fs) {
  const stats = fsImpl.statSync(directoryPath, { bigint: true });
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function rootReceiptEntries(plan) {
  return plan.map((entry) => ({
    relative: entry.relative,
    source: entry.source,
    projection: entry.projection,
    backup: entry.backup,
    existed: entry.existed,
    original_identity: entry.original_identity,
    restored_identity: entry.restored_identity,
  }));
}

function attachDependencyRoots(plan, {
  fsImpl = fs,
} = {}) {
  try {
    for (const entry of plan) {
      if (!fsImpl.existsSync(entry.projection)
        || fsImpl.lstatSync(entry.projection).isSymbolicLink()) {
        throw new Error(`dependency_projection_source_invalid:${entry.relative}`);
      }
      entry.existed = fsImpl.existsSync(entry.source);
      if (entry.existed && fsImpl.lstatSync(entry.source).isSymbolicLink()) {
        throw new Error(`dependency_projection_candidate_root_reparse:${entry.relative}`);
      }
      if (entry.existed) entry.original_identity = readDirectoryIdentity(entry.source, fsImpl);
      for (const target of [entry.backup, entry.staged, entry.detached]) {
        if (fsImpl.existsSync(target)) {
          throw new Error(`dependency_projection_swap_collision:${target}`);
        }
        fsImpl.mkdirSync(path.dirname(target), { recursive: true });
      }
      fsImpl.symlinkSync(entry.projection, entry.staged, 'junction');
      assertDirectoryLink(entry.staged, entry.projection, fsImpl);
      if (entry.existed) fsImpl.renameSync(entry.source, entry.backup);
      fsImpl.renameSync(entry.staged, entry.source);
      entry.attached = true;
      assertDirectoryLink(entry.source, entry.projection, fsImpl);
    }
    return plan;
  } catch (error) {
    try { restoreDependencyRoots(plan, { fsImpl }); } catch { /* preserve exact state */ }
    throw error;
  }
}

function restoreDependencyRoots(plan, {
  fsImpl = fs,
} = {}) {
  const errors = [];
  for (const entry of [...plan].reverse()) {
    try {
      const hasBackup = fsImpl.existsSync(entry.backup);
      const hasStaged = fsImpl.existsSync(entry.staged);
      const hasDetached = fsImpl.existsSync(entry.detached);
      if (!entry.attached && !hasBackup && !hasStaged && !hasDetached) continue;
      if (fsImpl.existsSync(entry.source)) {
        if (fsImpl.lstatSync(entry.source).isSymbolicLink()) {
          assertDirectoryLink(entry.source, entry.projection, fsImpl);
          fsImpl.mkdirSync(path.dirname(entry.detached), { recursive: true });
          fsImpl.renameSync(entry.source, entry.detached);
        } else if (hasBackup || entry.attached) {
          throw new Error('source_original_and_backup_ambiguous');
        }
      }
      if (fsImpl.existsSync(entry.staged)) {
        assertDirectoryLink(entry.staged, entry.projection, fsImpl);
        removeDirectoryLink(entry.staged, entry.projection, { fsImpl });
      }
      if (entry.existed) {
        if (!fsImpl.existsSync(entry.backup) || fsImpl.existsSync(entry.source)) {
          throw new Error('backup_restore_precondition');
        }
        fsImpl.renameSync(entry.backup, entry.source);
        if (!fsImpl.existsSync(entry.source) || fsImpl.lstatSync(entry.source).isSymbolicLink()) {
          throw new Error('backup_restore_verification');
        }
        entry.restored_identity = readDirectoryIdentity(entry.source, fsImpl);
        if (stableJson(entry.restored_identity) !== stableJson(entry.original_identity)) {
          throw new Error('backup_restore_identity_mismatch');
        }
      } else if (fsImpl.existsSync(entry.source)) {
        throw new Error('absent_source_reappeared');
      }
      if (fsImpl.existsSync(entry.detached)) {
        removeDirectoryLink(entry.detached, entry.projection, { fsImpl });
      }
      entry.attached = false;
    } catch (error) {
      errors.push({ relative: entry.relative, error: String(error?.message || error) });
    }
  }
  if (errors.length) {
    throw new Error(`dependency_projection_restore_failed:${stableJson(errors)}`);
  }
  return plan;
}

function processIdentityKey(entry, { platform = process.platform } = {}) {
  const pid = Number(entry?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('dependency_projection_process_identity_pid_invalid');
  }
  if (platform !== 'win32') return String(pid);
  const creationTicks = String(entry?.creation_ticks || '');
  if (!/^[1-9]\d*$/.test(creationTicks)) {
    throw new Error(`dependency_projection_process_identity_missing:${pid}`);
  }
  return `${pid}:${creationTicks}`;
}

function collectOwnedProbeProcesses(rootPid, processes) {
  const normalizedRootPid = Number(rootPid);
  if (!Number.isInteger(normalizedRootPid) || normalizedRootPid <= 0) return [];
  const ownedPids = new Set([normalizedRootPid]);
  const entries = (Array.isArray(processes) ? processes : [])
    .filter((entry) => Number.isInteger(Number(entry?.pid)) && Number(entry.pid) > 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      const pid = Number(entry.pid);
      if (ownedPids.has(pid)) continue;
      if (ownedPids.has(Number(entry.parent_pid))) {
        ownedPids.add(pid);
        changed = true;
      }
    }
  }
  return entries.filter((entry) => (
    Number(entry.pid) === normalizedRootPid || ownedPids.has(Number(entry.pid))
  ));
}

function waitForOwnedProbeSettlement(rootPid, {
  rootIdentity,
  baselineProcesses = [],
  snapshotImpl = () => collectProcessSnapshot(),
  sleepImpl = (milliseconds) => Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  ),
  timeoutMs = PROJECTION_CONTRACT.probe_descendant_grace_ms,
  intervalMs = PROJECTION_CONTRACT.quiescence_interval_ms,
  stableSamples = PROJECTION_CONTRACT.quiescence_stable_samples,
  platform = process.platform,
  nowImpl = Date.now,
} = {}) {
  const normalizedRootPid = Number(rootPid);
  if (!Number.isInteger(normalizedRootPid) || normalizedRootPid <= 0) {
    return {
      passed: true,
      root_pid: null,
      root_identity: null,
      observed: [],
      clean_samples: stableSamples,
      processes: [],
    };
  }
  if (Number(rootIdentity?.pid) !== normalizedRootPid) {
    throw new Error(`dependency_projection_probe_root_identity_missing:${normalizedRootPid}`);
  }
  const rootIdentityKey = processIdentityKey(rootIdentity, { platform });
  const rootCreationTicks = platform === 'win32'
    ? BigInt(String(rootIdentity.creation_ticks))
    : null;
  const baselineByPid = new Map();
  for (const entry of Array.isArray(baselineProcesses) ? baselineProcesses : []) {
    const pid = Number(entry?.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    baselineByPid.set(pid, processIdentityKey(entry, { platform }));
  }
  if (baselineByPid.get(normalizedRootPid) === rootIdentityKey) {
    throw new Error(`dependency_projection_probe_root_identity_preexisting:${normalizedRootPid}`);
  }
  const observedByPid = new Map();
  const deadline = nowImpl() + timeoutMs;
  let cleanSamples = 0;
  let sampleCount = 0;
  let processes = [];
  do {
    processes = snapshotImpl();
    sampleCount += 1;
    const currentByPid = new Map(processes.map((entry) => [Number(entry.pid), entry]));
    const rootEntry = currentByPid.get(normalizedRootPid);
    if (rootEntry && processIdentityKey(rootEntry, { platform }) !== rootIdentityKey) {
      throw new Error(`dependency_projection_probe_root_identity_ambiguous:${normalizedRootPid}`);
    }
    const ownedPids = new Set(collectOwnedProbeProcesses(normalizedRootPid, processes)
      .map((entry) => Number(entry.pid)));
    const candidates = processes.filter((entry) => {
      const pid = Number(entry?.pid);
      if (!Number.isInteger(pid) || pid <= 0) return false;
      const identity = processIdentityKey(entry, { platform });
      const baselineIdentity = baselineByPid.get(pid);
      if (baselineIdentity && baselineIdentity !== identity) {
        throw new Error(`dependency_projection_probe_descendant_identity_ambiguous:${pid}`);
      }
      if (ownedPids.has(pid)) {
        if (baselineIdentity === identity) {
          throw new Error(`dependency_projection_probe_descendant_preexisting_pid:${pid}`);
        }
        return true;
      }
      if (platform !== 'win32' || baselineIdentity === identity) return false;
      return BigInt(String(entry.creation_ticks)) >= rootCreationTicks;
    });
    for (const entry of candidates) {
      const pid = Number(entry.pid);
      const identity = processIdentityKey(entry, { platform });
      const previous = observedByPid.get(pid);
      if (previous && previous.identity !== identity) {
        throw new Error(`dependency_projection_probe_descendant_identity_ambiguous:${pid}`);
      }
      if (!previous) {
        observedByPid.set(pid, {
          identity,
          pid,
          parent_pid: Number(entry.parent_pid),
          name: String(entry.name || ''),
          creation_ticks: String(entry.creation_ticks || ''),
        });
      }
    }
    const active = [];
    for (const observed of observedByPid.values()) {
      const current = currentByPid.get(observed.pid);
      if (!current) continue;
      const currentIdentity = processIdentityKey(current, { platform });
      if (currentIdentity !== observed.identity) {
        throw new Error(`dependency_projection_probe_descendant_identity_ambiguous:${observed.pid}`);
      }
      active.push(observed);
    }
    if (active.length === 0) {
      cleanSamples += 1;
      if (cleanSamples >= stableSamples) {
        return {
          passed: true,
          root_pid: normalizedRootPid,
          root_identity: rootIdentity,
          observed: [...observedByPid.values()],
          clean_samples: cleanSamples,
          sample_count: sampleCount,
          processes,
        };
      }
    } else {
      cleanSamples = 0;
    }
    if (nowImpl() >= deadline) {
      const error = new Error(`dependency_projection_probe_descendants_active:${stableJson(active)}`);
      error.code = 'DEPENDENCY_PROJECTION_PROBE_SETTLEMENT_UNSAFE';
      throw error;
    }
    sleepImpl(intervalMs);
  } while (true);
}

function assertCandidateQuiescent(candidateRoot, {
  processes = collectProcessSnapshot(),
  currentPid = process.pid,
  controllerRootPid = Number(process.env.MASARX_DEPENDENCY_PROJECTION_CONTROLLER_PID || 0),
  ownedRootPids = [],
  additionalProtectedRoots = [],
} = {}) {
  const byPid = new Map(processes.map((entry) => [Number(entry.pid), entry]));
  const ancestors = new Set([Number(currentPid)]);
  let cursor = byPid.get(Number(currentPid));
  while (cursor && !ancestors.has(Number(cursor.parent_pid))) {
    ancestors.add(Number(cursor.parent_pid));
    cursor = byPid.get(Number(cursor.parent_pid));
  }
  if (controllerRootPid > 0 && !ancestors.has(controllerRootPid)) {
    throw new Error(`dependency_projection_controller_not_ancestor:${controllerRootPid}`);
  }
  const normalizedRoots = [candidateRoot, ...additionalProtectedRoots]
    .map((candidate) => path.resolve(candidate).toLowerCase());
  const ownedRoots = new Set(ownedRootPids
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0));
  const belongsToOwnedTree = (entry) => {
    let pid = Number(entry.pid);
    const visited = new Set();
    while (Number.isInteger(pid) && pid > 0 && !visited.has(pid)) {
      if (ownedRoots.has(pid)) return true;
      visited.add(pid);
      const parentPid = Number(byPid.get(pid)?.parent_pid);
      if (ownedRoots.has(parentPid)) return true;
      pid = parentPid;
    }
    return false;
  };
  const belongsToControllerTree = (entry) => {
    if (!(controllerRootPid > 0)) return false;
    let pid = Number(entry.pid);
    const visited = new Set();
    while (Number.isInteger(pid) && pid > 0 && !visited.has(pid)) {
      if (pid === controllerRootPid) return true;
      visited.add(pid);
      pid = Number(byPid.get(pid)?.parent_pid);
    }
    return false;
  };
  const processTreeMentionsCandidate = (entry) => {
    let cursorEntry = entry;
    const visited = new Set();
    while (cursorEntry && !visited.has(Number(cursorEntry.pid))) {
      visited.add(Number(cursorEntry.pid));
      const processText = `${cursorEntry.command_line || ''}\n${cursorEntry.cwd || ''}`.toLowerCase();
      if (normalizedRoots.some((root) => processText.includes(root))) return true;
      cursorEntry = byPid.get(Number(cursorEntry.parent_pid));
    }
    return false;
  };
  const blockers = processes.filter((entry) => !ancestors.has(Number(entry.pid)))
    .filter((entry) => belongsToOwnedTree(entry)
      || (!belongsToControllerTree(entry) && processTreeMentionsCandidate(entry)))
    .map((entry) => ({ pid: Number(entry.pid), name: entry.name }));
  if (blockers.length) {
    throw new Error(`dependency_projection_candidate_busy:${stableJson(blockers)}`);
  }
  return { passed: true, blockers: [] };
}

function waitForCandidateQuiescence(candidateRoot, {
  snapshotImpl = () => collectProcessSnapshot(),
  sleepImpl = (milliseconds) => Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  ),
  timeoutMs = PROJECTION_CONTRACT.quiescence_timeout_ms,
  intervalMs = PROJECTION_CONTRACT.quiescence_interval_ms,
  stableSamples = PROJECTION_CONTRACT.quiescence_stable_samples,
  additionalProtectedRoots = [],
  nowImpl = Date.now,
  controllerRootPid = Number(process.env.MASARX_DEPENDENCY_PROJECTION_CONTROLLER_PID || 0),
} = {}) {
  const deadline = nowImpl() + timeoutMs;
  let cleanSamples = 0;
  let lastError = null;
  let processes = [];
  do {
    processes = snapshotImpl();
    try {
      assertCandidateQuiescent(candidateRoot, {
        processes,
        additionalProtectedRoots,
        controllerRootPid,
      });
      cleanSamples += 1;
      if (cleanSamples >= stableSamples) {
        return { passed: true, clean_samples: cleanSamples, processes };
      }
    } catch (error) {
      cleanSamples = 0;
      lastError = error;
    }
    if (nowImpl() >= deadline) break;
    sleepImpl(intervalMs);
  } while (true);
  throw new Error(
    `dependency_projection_candidate_quiescence_timeout:${lastError?.message || 'unstable'}`,
  );
}

function runProjectionProbes({
  repoRoot = process.cwd(),
  projectionRoot,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  processSnapshotImpl = () => collectProcessSnapshot({ fsImpl, spawnSyncImpl }),
  probeSettlementImpl = waitForOwnedProbeSettlement,
  platform = process.platform,
  controllerRootPid = Number(process.env.MASARX_DEPENDENCY_PROJECTION_CONTROLLER_PID || 0),
} = {}) {
  const settlements = [];
  const result = runProbes({
    probes: createProbes({ repoRoot }),
    contract: INSTALL_CONTRACT,
    rethrowErrorImpl: (error) => String(error?.message || error)
      .startsWith('dependency_projection_probe_'),
    runProbeImpl: (probe) => {
      const baselineProcesses = processSnapshotImpl();
      let childPid = null;
      let childIdentity = null;
      try {
        return runProbeInChild(probe, {
          contract: INSTALL_CONTRACT,
          repoRoot,
          spawnSyncImpl,
          env: {
            ...process.env,
            MASARX_DEPENDENCY_PROJECTION_PROBE_IDENTITY: '1',
          },
          onChildResult: (childResult) => {
            childPid = childResult.pid;
            childIdentity = childResult.process_identity;
          },
        });
      } finally {
        try {
          let processes;
          if (Number.isInteger(childPid) && childPid > 0) {
            const settlement = probeSettlementImpl(childPid, {
              rootIdentity: childIdentity,
              baselineProcesses,
              snapshotImpl: processSnapshotImpl,
              platform,
            });
            ({ processes } = settlement);
            settlements.push({
              probe_id: probe.id,
              root_pid: settlement.root_pid,
              root_identity: settlement.root_identity,
              observed: settlement.observed,
              clean_samples: settlement.clean_samples,
              sample_count: settlement.sample_count,
            });
          } else {
            processes = processSnapshotImpl();
          }
          assertCandidateQuiescent(repoRoot, {
            processes,
            additionalProtectedRoots: projectionRoot ? [projectionRoot] : [],
            controllerRootPid,
          });
        } catch (error) {
          const message = String(error?.message || error);
          if (message.startsWith('dependency_projection_probe_')) throw error;
          throw new Error(`dependency_projection_probe_settlement_failed:${message}`, { cause: error });
        }
      }
    },
  });
  return { ...result, settlement_passed: true, settlements };
}

function gitStatus(repoRoot, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl('git', ['status', '--porcelain=v1', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result?.error || result?.status !== 0) {
    throw new Error(`dependency_projection_git_status_failed:${result?.error?.code || result?.status}`);
  }
  return String(result.stdout || '');
}

function resolveProjectionCommand(command, {
  platform = process.platform,
  execPath = process.execPath,
} = {}) {
  if (!Array.isArray(command) || !command.length || command.some((argument) => typeof argument !== 'string')) {
    throw new Error('dependency_projection_command_required');
  }
  const executable = command[0].trim();
  if (!executable) throw new Error('dependency_projection_command_required');
  const args = command.slice(1);
  if (platform !== 'win32') return { executable, args };
  const basename = path.win32.basename(executable).toLowerCase();
  if (basename === 'npm' || basename === 'npm.cmd') {
    const invocation = resolveNpmInvocation(platform, execPath);
    return {
      executable: invocation.executable,
      args: [...invocation.prefixArgs, ...args],
    };
  }
  if (/\.(?:cmd|bat)$/i.test(basename)) {
    throw new Error(`dependency_projection_windows_wrapper_unsupported:${basename}`);
  }
  return { executable, args };
}

function withProjection({
  repoRoot = process.cwd(),
  command,
  env = process.env,
  platform = process.platform,
  runtime = {},
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  processSnapshot,
  buildImpl = buildProjection,
  probesImpl = runProjectionProbes,
  cleanupImpl = runBoundedCleanup,
} = {}) {
  const resolvedCommand = resolveProjectionCommand(command, { platform });
  const hasInjectedProcessSnapshot = Array.isArray(processSnapshot);
  const controllerRootPid = Number(env.MASARX_DEPENDENCY_PROJECTION_CONTROLLER_PID || 0);
  if (platform === 'win32' && !hasInjectedProcessSnapshot
    && (!Number.isInteger(controllerRootPid) || controllerRootPid <= 0)) {
    throw new Error('dependency_projection_controller_pid_required');
  }
  const identity = createProjectionIdentity({ repoRoot, fsImpl, runtime });
  const built = buildImpl({ identity, env, platform, fsImpl, spawnSyncImpl, cleanupImpl });
  assertProjectionIdentityCurrent(identity, fsImpl);
  const initialAdmission = hasInjectedProcessSnapshot
    ? { processes: processSnapshot }
    : waitForCandidateQuiescence(identity.repo_root, {
      snapshotImpl: () => collectProcessSnapshot({ fsImpl, spawnSyncImpl, platform }),
      controllerRootPid,
    });
  assertNoCompetingNpmInstall({ processes: initialAdmission.processes });
  if (hasInjectedProcessSnapshot) {
    assertCandidateQuiescent(identity.repo_root, { processes: processSnapshot, controllerRootPid });
  }
  const statusBefore = gitStatus(identity.repo_root, spawnSyncImpl);
  const backupBase = resolveBackupBase(identity.repo_root, { env, fsImpl, platform });
  const candidateLockPath = resolveCandidateLockPath(built.paths, identity.repo_root);
  const terminalReceiptPath = resolveCandidateReceiptPath(built.paths, identity.repo_root);
  const candidateLock = acquireExclusiveLock(candidateLockPath, {
    schema: PROJECTION_CONTRACT.lease_schema,
    operation: 'candidate',
    candidate_root: identity.repo_root,
  }, fsImpl);
  let leaseLock;
  try {
    leaseLock = acquireExclusiveLock(built.paths.lease_lock_path, {
      schema: PROJECTION_CONTRACT.lease_schema,
      operation: 'projection',
      key: identity.key,
      candidate_root: identity.repo_root,
    }, fsImpl);
  } catch (error) {
    releaseExclusiveLock(candidateLockPath, candidateLock.token, fsImpl);
    throw error;
  }
  const backupRoot = path.join(
    backupBase,
    sha256(identity.repo_root.toLowerCase()),
    leaseLock.token,
  );
  const leasePath = path.join(built.paths.leases_root, `${leaseLock.token}.json`);
  const plan = createRootSwapPlan({
    identity,
    projectionRoot: built.paths.projection_root,
    candidateRoot: identity.repo_root,
    backupRoot,
  });
  let boundLinks = [];
  let commandResult = null;
  let cleanupPassed = false;
  let detachAuthorized = true;
  let operationError = null;
  let cleanupError = null;
  let leaseRecorded = false;
  let attachedAt = '';
  let commandCompletedAt = '';
  let restoredAt = '';
  try {
    writeJsonAtomic(leasePath, {
      ...leaseLock,
      status: 'planned',
      projection_root: built.paths.projection_root,
      candidate_lock_path: candidateLockPath,
      backup_root: backupRoot,
      roots: rootReceiptEntries(plan),
    }, fsImpl);
    leaseRecorded = true;
    const leasedAdmission = waitForCandidateQuiescence(identity.repo_root, {
      snapshotImpl: () => collectProcessSnapshot({ fsImpl, spawnSyncImpl, platform }),
      additionalProtectedRoots: [built.paths.projection_root],
      controllerRootPid,
    });
    assertNoCompetingNpmInstall({ processes: leasedAdmission.processes });
    assertProjectionIdentityCurrent(identity, fsImpl);
    boundLinks = bindWorkspaceLinks(
      built.paths.projection_root,
      identity,
      identity.repo_root,
      { fsImpl },
    );
    attachDependencyRoots(plan, { fsImpl });
    if (gitStatus(identity.repo_root, spawnSyncImpl) !== statusBefore) {
      throw new Error('dependency_projection_git_status_drift_after_attach');
    }
    assertProjectionIdentityCurrent(identity, fsImpl);
    attachedAt = new Date().toISOString();
    writeJsonAtomic(leasePath, {
      ...readJson(leasePath, fsImpl),
      status: 'attached',
      attached_at: attachedAt,
      roots: rootReceiptEntries(plan),
    }, fsImpl);
    detachAuthorized = false;
    let probes;
    try {
      probes = probesImpl({
        repoRoot: identity.repo_root,
        projectionRoot: built.paths.projection_root,
        fsImpl,
        spawnSyncImpl,
        controllerRootPid,
      });
    } finally {
      assertCandidateQuiescent(identity.repo_root, {
        processes: collectProcessSnapshot({ fsImpl, spawnSyncImpl, platform }),
        additionalProtectedRoots: [built.paths.projection_root],
        controllerRootPid,
      });
      detachAuthorized = probes?.settlement_passed === true;
    }
    if (probes?.passed !== true) {
      throw new Error(`dependency_projection_probes_failed:${stableJson(probes?.failed_probe_ids || [])}`);
    }
    assertProjectionIdentityCurrent(identity, fsImpl);
    writeJsonAtomic(leasePath, {
      ...readJson(leasePath, fsImpl),
      status: 'running',
      probes,
      command_started_at: new Date().toISOString(),
    }, fsImpl);
    detachAuthorized = false;
    commandResult = spawnSyncImpl(resolvedCommand.executable, resolvedCommand.args, {
      cwd: identity.repo_root,
      env,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      timeout: PROJECTION_CONTRACT.command_timeout_ms,
      killSignal: 'SIGTERM',
    });
    assertCandidateQuiescent(identity.repo_root, {
      processes: collectProcessSnapshot({ fsImpl, spawnSyncImpl, platform }),
      ownedRootPids: Number.isInteger(commandResult?.pid) && commandResult.pid > 0
        ? [commandResult.pid]
        : [],
      additionalProtectedRoots: [built.paths.projection_root],
      controllerRootPid,
    });
    commandCompletedAt = new Date().toISOString();
    detachAuthorized = true;
    assertProjectionIdentityCurrent(identity, fsImpl);
  } catch (error) {
    operationError = error;
  } finally {
    if (!detachAuthorized) {
      cleanupError = new Error('dependency_projection_detach_blocked_active_process');
    } else {
      try {
        restoreDependencyRoots(plan, { fsImpl });
        if (boundLinks.length) {
          unbindWorkspaceLinks(built.paths.projection_root, boundLinks, { fsImpl });
        }
        validatePublishedProjection(built.paths, identity, fsImpl);
        if (gitStatus(identity.repo_root, spawnSyncImpl) !== statusBefore) {
          throw new Error('dependency_projection_git_status_drift_after_restore');
        }
        if (fsImpl.existsSync(backupRoot)) cleanupImpl(backupRoot, backupBase);
        restoredAt = new Date().toISOString();
        cleanupPassed = true;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (leaseRecorded) {
      writeJsonAtomic(leasePath, {
        ...readJson(leasePath, fsImpl),
        status: cleanupPassed ? 'restored' : (detachAuthorized ? 'cleanup_failed' : 'detach_blocked'),
        completed_at: new Date().toISOString(),
        attached_at: attachedAt,
        command_completed_at: commandCompletedAt,
        restored_at: restoredAt,
        roots: rootReceiptEntries(plan),
        command_status: Number.isInteger(commandResult?.status) ? commandResult.status : null,
        command_error: commandResult?.error ? String(commandResult.error.message || commandResult.error) : '',
        cleanup_error: cleanupError ? String(cleanupError.message || cleanupError) : '',
      }, fsImpl);
    }
    if (cleanupPassed) {
      releaseExclusiveLock(built.paths.lease_lock_path, leaseLock.token, fsImpl);
      releaseExclusiveLock(candidateLockPath, candidateLock.token, fsImpl);
      if (leaseRecorded) {
        writeJsonAtomic(terminalReceiptPath, {
          ...readJson(leasePath, fsImpl),
          status: 'released',
          released_at: new Date().toISOString(),
        }, fsImpl);
        if (fsImpl.existsSync(leasePath)) fsImpl.unlinkSync(leasePath);
      }
    }
  }
  if (operationError && cleanupError) {
    throw new Error(
      `dependency_projection_operation_and_cleanup_failed:${operationError.message}:${cleanupError.message}`,
      { cause: operationError },
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  if (commandResult?.error || commandResult?.status !== 0) {
    throw new Error(`dependency_projection_command_failed:${commandResult?.error?.code || commandResult?.status}`);
  }
  return {
    passed: true,
    key: identity.key,
    reused: built.reused,
    receipt_path: terminalReceiptPath,
  };
}

function main() {
  if (process.argv[2] === '--cleanup-projection-path') {
    const target = process.argv[3];
    const allowedRoot = String(process.env.MASARX_DEPENDENCY_PROJECTION_CLEANUP_ROOT || '');
    const token = String(process.env.MASARX_DEPENDENCY_PROJECTION_CLEANUP_TOKEN || '');
    if (!target || !allowedRoot || !token) throw new Error('dependency_projection_cleanup_binding_missing');
    const receipt = cleanupProjectionPathDirect(target, allowedRoot);
    process.stdout.write(`${JSON.stringify({ ...receipt, token })}\n`);
    return;
  }
  if (process.argv[2] === '--print-plan') {
    const identity = createProjectionIdentity();
    const paths = resolveProjectionPaths({ identity });
    process.stdout.write(`${JSON.stringify({
      contract: PROJECTION_CONTRACT,
      key: identity.key,
      lock_sha256: identity.lock_sha256,
      required_probe_ids: identity.required_probe_ids,
      probe_contract_sha256: identity.probe_contract_sha256,
      dependency_roots: identity.dependency_roots,
      workspace_map: identity.workspace_map,
      projection_root: paths.projection_root,
      npm_cache: paths.npm_cache,
    }, null, 2)}\n`);
    return;
  }
  if (process.argv[2] === '--with-projection') {
    const separator = process.argv.indexOf('--', 3);
    if (separator === -1) throw new Error('dependency_projection_command_separator_required');
    const result = withProjection({ command: process.argv.slice(separator + 1) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error('usage: --print-plan | --with-projection -- <command> [args...]');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  PROJECTION_CONTRACT,
  acquireExclusiveLock,
  assertCandidateQuiescent,
  assertDirectoryLink,
  attachDependencyRoots,
  bindWorkspaceLinks,
  buildProjection,
  cleanupProjectionPathDirect,
  collectOwnedProbeProcesses,
  computeProjectionTreeDigest,
  createProjectionIdentity,
  createRootSwapPlan,
  listReparsePaths,
  releaseExclusiveLock,
  resolveCandidateLockPath,
  resolveCandidateReceiptPath,
  resolveBackupBase,
  resolveExpectedDependencyRoots,
  resolveProjectionPaths,
  resolveProjectionCommand,
  resolveWorkspaceEntries,
  restoreDependencyRoots,
  runBoundedCleanup,
  runProjectionProbes,
  sanitizeInstalledWorkspaceLinks,
  unbindWorkspaceLinks,
  validatePublishedProjection,
  waitForCandidateQuiescence,
  waitForOwnedProbeSettlement,
  withProjection,
};
