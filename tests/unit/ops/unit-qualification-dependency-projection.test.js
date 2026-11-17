/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CONTRACT: INSTALL_CONTRACT,
  PROBE_CONTRACT,
  collectProcessSnapshot,
  createProbes,
} = require('../../../scripts/ops/ci/install-unit-qualification-dependencies');
const {
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
  resolveBackupBase,
  resolveCandidateLockPath,
  resolveCandidateReceiptPath,
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
} = require('../../../scripts/ops/ci/unit-qualification-dependency-projection');

const WORKSPACES = [
  ['apps/console', '@masarx/console'],
  ['apps/fieldops', '@masarx/fieldops'],
  ['apps/portal', '@masarx/portal'],
  ['packages/api', '@masarx/api'],
  ['packages/auth', '@masarx/auth'],
  ['packages/config', '@masarx/config'],
  ['packages/mobile-core', '@masarx/mobile-core'],
  ['packages/ui', '@masarx/ui'],
];

const POPULATED_ROOTS = [
  'node_modules',
  'apps/console/node_modules',
  'apps/fieldops/node_modules',
  'apps/portal/node_modules',
  'packages/mobile-core/node_modules',
  'packages/ui/node_modules',
].sort();

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepository(root, { script = 'node first.js' } = {}) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'package.json'), {
    name: 'masarx-delivery-platform',
    private: true,
    scripts: { proof: script },
    workspaces: ['apps/*', 'packages/*'],
  });
  const packages = {
    '': { name: 'masarx-delivery-platform', workspaces: ['apps/*', 'packages/*'] },
    'node_modules/jest': { version: '30.0.0' },
    'apps/console/node_modules/next': { version: '15.0.0' },
    'apps/fieldops/node_modules/expo': { version: '55.0.32' },
    'apps/portal/node_modules/next': { version: '15.0.0' },
    'packages/mobile-core/node_modules/react': { version: '19.0.0' },
    'packages/ui/node_modules/react': { version: '19.0.0' },
  };
  for (const [relative, name] of WORKSPACES) {
    writeJson(path.join(root, ...relative.split('/'), 'package.json'), {
      name,
      version: '0.1.0',
      private: true,
    });
    packages[relative] = { name, version: '0.1.0' };
    packages[`node_modules/${name}`] = { resolved: relative, link: true };
  }
  writeJson(path.join(root, 'package-lock.json'), {
    name: 'masarx-delivery-platform',
    lockfileVersion: 3,
    requires: true,
    packages,
  });
  return root;
}

function writeExpoProbePackage(root, segments, version) {
  const expoRoot = path.join(root, ...segments);
  fs.mkdirSync(path.join(expoRoot, 'bin'), { recursive: true });
  writeJson(path.join(expoRoot, 'package.json'), { name: 'expo', version, bin: { expo: 'bin/cli.js' } });
  fs.writeFileSync(path.join(expoRoot, 'bin', 'cli.js'), '#!/usr/bin/env node\n');
}

function prepareExpoProbeFixture(root, {
  nested = false,
  lockVersion = '55.0.32',
  omitLockEntry = false,
  bothLayouts = false,
  hoistedVersion = '55.0.31',
} = {}) {
  const nestedKey = 'apps/fieldops/node_modules/expo';
  const hoistedKey = 'node_modules/expo';
  if (bothLayouts) {
    writeExpoProbePackage(root, ['node_modules', 'expo'], hoistedVersion);
    writeExpoProbePackage(root, ['apps', 'fieldops', 'node_modules', 'expo'], lockVersion);
  } else {
    writeExpoProbePackage(root, nested ? ['apps', 'fieldops', 'node_modules', 'expo'] : ['node_modules', 'expo'], '55.0.32');
  }
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  for (const key of Object.keys(lock.packages)) {
    if (key === hoistedKey || key === nestedKey) delete lock.packages[key];
  }
  if (bothLayouts) {
    lock.packages[hoistedKey] = { version: hoistedVersion };
    lock.packages[nestedKey] = { version: lockVersion };
  } else if (!omitLockEntry) {
    lock.packages[nested ? nestedKey : hoistedKey] = { version: lockVersion };
  }
  writeJson(lockPath, lock);
  return createProbes({ repoRoot: root }).find((probe) => probe.id === 'expo');
}

function runtime() {
  return {
    platform: 'win32',
    arch: 'x64',
    node_version: '24.0.0',
    node_abi: '137',
    npm_version: '11.0.0',
  };
}

function populateProjection(projectionRoot, identity, { links = false } = {}) {
  for (const relative of identity.dependency_roots) {
    const target = path.join(projectionRoot, ...relative.split('/'));
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.proof'), relative);
  }
  if (links) {
    for (const entry of identity.workspace_entries) {
      const target = path.join(projectionRoot, ...entry.relative.split('/'));
      const [scope, name] = entry.name.split('/');
      const link = path.join(projectionRoot, 'node_modules', scope, name);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, 'junction');
    }
  }
}

describe('unit qualification dependency projection', () => {
  let tempRoot;
  let repoRoot;
  let controllerPid;

  beforeEach(() => {
    controllerPid = process.env.MASARX_DEPENDENCY_PROJECTION_CONTROLLER_PID;
    delete process.env.MASARX_DEPENDENCY_PROJECTION_CONTROLLER_PID;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-dependency-projection-'));
    repoRoot = createRepository(path.join(tempRoot, 'candidate'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } finally {
      if (controllerPid === undefined) {
        delete process.env.MASARX_DEPENDENCY_PROJECTION_CONTROLLER_PID;
      } else {
        process.env.MASARX_DEPENDENCY_PROJECTION_CONTROLLER_PID = controllerPid;
      }
    }
  });

  test('uses one exact six-root/eight-workspace content identity and ignores script-only drift', () => {
    const first = createProjectionIdentity({ repoRoot, runtime: runtime() });
    expect(resolveWorkspaceEntries(repoRoot)).toHaveLength(8);
    expect(resolveExpectedDependencyRoots(repoRoot)).toEqual(POPULATED_ROOTS);
    expect(first.workspace_map).toHaveLength(PROJECTION_CONTRACT.required_workspace_link_count);
    expect(first.dependency_roots).toHaveLength(PROJECTION_CONTRACT.required_dependency_root_count);
    expect(first.required_probe_ids).toEqual(INSTALL_CONTRACT.required_probe_ids);
    expect(first.probe_contract_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.probe_contract).toEqual(PROBE_CONTRACT);
    const evolvedProbeIdentity = createProjectionIdentity({
      repoRoot,
      runtime: runtime(),
      probeContract: { ...PROBE_CONTRACT, revision: PROBE_CONTRACT.revision + 1 },
    });
    expect(evolvedProbeIdentity.required_probe_ids).toEqual(first.required_probe_ids);
    expect(evolvedProbeIdentity.probe_contract_sha256).not.toBe(first.probe_contract_sha256);
    expect(evolvedProbeIdentity.key).not.toBe(first.key);

    const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    rootManifest.scripts.proof = 'node second.js';
    writeJson(path.join(repoRoot, 'package.json'), rootManifest);
    const second = createProjectionIdentity({ repoRoot, runtime: runtime() });
    expect(second.key).toBe(first.key);

    rootManifest.devDependencies = { jest: '30.0.1' };
    writeJson(path.join(repoRoot, 'package.json'), rootManifest);
    expect(createProjectionIdentity({ repoRoot, runtime: runtime() }).key).not.toBe(first.key);
    delete rootManifest.devDependencies;
    writeJson(path.join(repoRoot, 'package.json'), rootManifest);

    const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/jest'].version = '30.0.1';
    writeJson(path.join(repoRoot, 'package-lock.json'), lock);
    expect(createProjectionIdentity({ repoRoot, runtime: runtime() }).key).not.toBe(first.key);
  });

  test.each([
    ['hoisted', false],
    ['nested', true],
  ])('resolves the Expo lock entry from the installed %s package path', (_layout, nested) => {
    const probe = prepareExpoProbeFixture(repoRoot, { nested });
    expect(probe.run()).toMatchObject({ version: '55.0.32' });
  });

  test('prefers the nearest nested Expo package when hoisted and nested versions differ', () => {
    const probe = prepareExpoProbeFixture(repoRoot, { bothLayouts: true });
    expect(probe.run()).toMatchObject({ version: '55.0.32' });
  });

  test('matches a hoisted Expo package through the projected node_modules link', () => {
    const projectedNodeModules = path.join(tempRoot, 'projected-node-modules');
    const nodeModulesLink = path.join(repoRoot, 'node_modules');
    let linked = false;
    try {
      fs.mkdirSync(projectedNodeModules, { recursive: true });
      fs.symlinkSync(projectedNodeModules, nodeModulesLink, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch (error) {
      if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error?.code)) return;
      throw error;
    }
    try {
      const probe = prepareExpoProbeFixture(repoRoot, { nested: false });
      expect(probe.run()).toMatchObject({ version: '55.0.32' });
    } finally {
      if (linked) {
        if (process.platform === 'win32') fs.rmdirSync(nodeModulesLink);
        else fs.unlinkSync(nodeModulesLink);
      }
    }
  });

  test.each([
    ['mismatched', { nested: false, lockVersion: '55.0.31' }, 'expo_version_mismatch:55.0.32:55.0.31'],
    ['absent', { nested: true, omitLockEntry: true }, 'expo_lock_entry_unresolved'],
  ])('fails closed when the Expo lock entry is %s', (_label, options, error) => {
    const probe = prepareExpoProbeFixture(repoRoot, options);
    expect(() => probe.run()).toThrow(error);
  });

  test('contains the governed projection under LocalAppData and rejects another volume', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const localAppData = path.join(tempRoot, 'local-app-data');
    const paths = resolveProjectionPaths({
      identity,
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
    });
    expect(paths.base).toBe(path.join(
      localAppData,
      'MasarX',
      'dependency-projections',
      'v1',
    ));
    expect(paths.projection_root.startsWith(paths.base)).toBe(true);
    expect(paths.npm_cache.startsWith(paths.base)).toBe(true);

    expect(() => resolveProjectionPaths({
      identity,
      platform: 'win32',
      env: {
        LOCALAPPDATA: '/example/workspace',
        MASARX_DEPENDENCY_PROJECTION_ROOT: 'D:\\unsafe',
      },
    })).toThrow('dependency_projection_root_override_invalid');
    expect(() => resolveProjectionPaths({
      identity,
      platform: 'win32',
      env: {
        LOCALAPPDATA: '/example/workspace',
        MASARX_DEPENDENCY_PROJECTION_ROOT: 'C:\\unsafe',
      },
    })).toThrow('dependency_projection_root_override_invalid');
  });

  test('binds sorted native Git blob receipts to exact paths and sizes', () => {
    const treeRoot = path.join(tempRoot, 'native-digest');
    fs.mkdirSync(path.join(treeRoot, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(treeRoot, 'z.txt'), 'z');
    fs.writeFileSync(path.join(treeRoot, 'nested', 'a.txt'), 'alpha');
    const calls = [];
    const hashes = ['a'.repeat(40), 'b'.repeat(40)];
    const first = computeProjectionTreeDigest(treeRoot, fs, (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0, stdout: `${hashes.join('\n')}\n` };
    });
    expect(calls[0]).toMatchObject({
      executable: 'git',
      args: ['hash-object', '--no-filters', '--stdin-paths'],
    });
    expect(calls[0].options.input).toBe('nested/a.txt\nz.txt\n');
    expect(first.file_count).toBe(2);
    const reversed = computeProjectionTreeDigest(treeRoot, fs, () => ({
      status: 0,
      stdout: `${[...hashes].reverse().join('\n')}\n`,
    }));
    expect(reversed.digest).not.toBe(first.digest);
    expect(() => computeProjectionTreeDigest(treeRoot, fs, () => ({
      status: 0,
      stdout: `${hashes[0]}\n`,
    }))).toThrow('dependency_projection_digest_receipt_invalid:1:2');
    fs.symlinkSync(path.join(treeRoot, 'nested'), path.join(treeRoot, 'linked'), 'junction');
    expect(() => computeProjectionTreeDigest(treeRoot, fs, () => ({ status: 0, stdout: '' })))
      .toThrow('dependency_projection_digest_reparse:linked');
  });

  test('accepts exactly eight install-time workspace junctions then makes the SSOT source-neutral', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const projectionRoot = createRepository(path.join(tempRoot, 'projection'));
    populateProjection(projectionRoot, identity, { links: true });
    expect(listReparsePaths(projectionRoot)).toHaveLength(8);
    expect(sanitizeInstalledWorkspaceLinks(projectionRoot, identity)).toHaveLength(8);
    expect(listReparsePaths(projectionRoot)).toEqual([]);

    const unexpected = path.join(projectionRoot, 'node_modules', 'unexpected');
    fs.symlinkSync(path.join(projectionRoot, 'apps', 'console'), unexpected, 'junction');
    expect(() => sanitizeInstalledWorkspaceLinks(projectionRoot, identity))
      .toThrow('dependency_projection_reparse_set_invalid');
  });

  test('binds the neutral SSOT only to the current candidate and removes every link on release', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const projectionRoot = createRepository(path.join(tempRoot, 'projection'));
    populateProjection(projectionRoot, identity);
    const links = bindWorkspaceLinks(projectionRoot, identity, repoRoot);
    expect(links).toHaveLength(8);
    for (const entry of links) assertDirectoryLink(entry.link_path, entry.target);
    unbindWorkspaceLinks(projectionRoot, links);
    expect(listReparsePaths(projectionRoot)).toEqual([]);
  });

  test('backs up ordinary dependency roots on the candidate volume and restores them exactly', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const projectionRoot = createRepository(path.join(tempRoot, 'projection'));
    populateProjection(projectionRoot, identity);
    for (const relative of identity.dependency_roots.slice(0, 2)) {
      const candidateRoot = path.join(repoRoot, ...relative.split('/'));
      fs.mkdirSync(candidateRoot, { recursive: true });
      fs.writeFileSync(path.join(candidateRoot, 'original.txt'), relative);
    }
    const backupRoot = path.join(tempRoot, 'same-volume-backup', 'lease');
    const plan = createRootSwapPlan({ identity, projectionRoot, candidateRoot: repoRoot, backupRoot });
    attachDependencyRoots(plan);
    for (const entry of plan) assertDirectoryLink(entry.source, entry.projection);
    expect(plan.filter((entry) => entry.existed)).toHaveLength(2);

    restoreDependencyRoots(plan);
    for (const entry of plan) {
      if (entry.existed) {
        expect(fs.readFileSync(path.join(entry.source, 'original.txt'), 'utf8')).toBe(entry.relative);
        expect(fs.lstatSync(entry.source).isSymbolicLink()).toBe(false);
      } else {
        expect(fs.existsSync(entry.source)).toBe(false);
      }
    }
    expect(listReparsePaths(backupRoot)).toEqual([]);
  });

  test('rolls back the complete root wave when one attach transition fails', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const projectionRoot = createRepository(path.join(tempRoot, 'projection'));
    populateProjection(projectionRoot, identity);
    for (const relative of identity.dependency_roots) {
      const candidateRoot = path.join(repoRoot, ...relative.split('/'));
      fs.mkdirSync(candidateRoot, { recursive: true });
      fs.writeFileSync(path.join(candidateRoot, 'original.txt'), relative);
    }
    const backupRoot = path.join(tempRoot, 'same-volume-backup', 'lease');
    const plan = createRootSwapPlan({ identity, projectionRoot, candidateRoot: repoRoot, backupRoot });
    const nativeRename = fs.renameSync.bind(fs);
    let stagedRenameCount = 0;
    const fsImpl = Object.create(fs);
    fsImpl.renameSync = (source, destination) => {
      if (source.includes(`${path.sep}staged${path.sep}`)) {
        stagedRenameCount += 1;
        if (stagedRenameCount === 2) throw new Error('synthetic_sharing_violation');
      }
      return nativeRename(source, destination);
    };
    expect(() => attachDependencyRoots(plan, { fsImpl }))
      .toThrow('synthetic_sharing_violation');
    for (const entry of plan) {
      expect(fs.existsSync(path.join(entry.source, 'original.txt'))).toBe(true);
      expect(fs.lstatSync(entry.source).isSymbolicLink()).toBe(false);
    }
  });

  test('records attachment before verification so an absent original still rolls back', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const projectionRoot = createRepository(path.join(tempRoot, 'projection'));
    populateProjection(projectionRoot, identity);
    const backupRoot = path.join(tempRoot, 'same-volume-backup', 'lease');
    const plan = createRootSwapPlan({ identity, projectionRoot, candidateRoot: repoRoot, backupRoot });
    const nativeRealpath = fs.realpathSync.bind(fs);
    let injected = false;
    const fsImpl = Object.create(fs);
    fsImpl.realpathSync = (candidate) => {
      if (!injected && path.resolve(candidate) === path.resolve(plan[0].source)
        && fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
        injected = true;
        throw new Error('synthetic_post_rename_verification_failure');
      }
      return nativeRealpath(candidate);
    };
    expect(() => attachDependencyRoots(plan, { fsImpl }))
      .toThrow('synthetic_post_rename_verification_failure');
    for (const entry of plan) expect(fs.existsSync(entry.source)).toBe(false);
  });

  test('rejects a cross-volume backup contract before any dependency move', () => {
    const fakeFs = Object.create(fs);
    fakeFs.statSync = (candidate) => ({
      dev: path.resolve(candidate) === path.resolve(repoRoot) ? 1 : 2,
    });
    expect(() => resolveBackupBase(repoRoot, {
      env: { MASARX_DEPENDENCY_PROJECTION_BACKUP_ROOT: path.join(tempRoot, 'backup') },
      platform: process.platform,
      fsImpl: fakeFs,
    })).toThrow('dependency_projection_backup_cross_device');
  });

  test('keeps one exclusive lease and never steals an existing owner', () => {
    const lockPath = path.join(tempRoot, 'locks', 'projection.lock');
    const first = acquireExclusiveLock(lockPath, { schema: 'test' });
    expect(() => acquireExclusiveLock(lockPath, { schema: 'test' }))
      .toThrow('dependency_projection_lock_held');
    expect(() => releaseExclusiveLock(lockPath, 'wrong-token'))
      .toThrow('dependency_projection_lock_identity_mismatch');
    releaseExclusiveLock(lockPath, first.token);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('serializes every identity for one candidate through one candidate-root lock', () => {
    const firstIdentity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const localAppData = path.join(tempRoot, 'local-app-data');
    const firstPaths = resolveProjectionPaths({
      identity: firstIdentity,
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    manifest.devDependencies = { jest: '30.0.1' };
    writeJson(path.join(repoRoot, 'package.json'), manifest);
    const secondIdentity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const secondPaths = resolveProjectionPaths({
      identity: secondIdentity,
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
    });

    expect(secondIdentity.key).not.toBe(firstIdentity.key);
    expect(secondPaths.lease_lock_path).not.toBe(firstPaths.lease_lock_path);
    const firstCandidateLock = resolveCandidateLockPath(firstPaths, repoRoot);
    expect(resolveCandidateLockPath(secondPaths, repoRoot)).toBe(firstCandidateLock);
    expect(resolveCandidateReceiptPath(secondPaths, repoRoot))
      .toBe(resolveCandidateReceiptPath(firstPaths, repoRoot));
    const lock = acquireExclusiveLock(firstCandidateLock, { schema: 'test' });
    expect(() => acquireExclusiveLock(
      resolveCandidateLockPath(secondPaths, repoRoot),
      { schema: 'test' },
    )).toThrow('dependency_projection_lock_held');
    releaseExclusiveLock(firstCandidateLock, lock.token);
  });

  test('restores all six populated originals and leaves one neutral released receipt', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const localAppData = path.join(tempRoot, 'local-app-data');
    const backupBase = path.join(tempRoot, 'backup-base');
    const env = {
      LOCALAPPDATA: localAppData,
      MASARX_DEPENDENCY_PROJECTION_BACKUP_ROOT: backupBase,
    };
    for (const relative of identity.dependency_roots) {
      const original = path.join(repoRoot, ...relative.split('/'));
      fs.mkdirSync(original, { recursive: true });
      fs.writeFileSync(path.join(original, '.original'), `original:${relative}`);
    }
    const built = buildProjection({
      identity,
      platform: 'win32',
      env,
      spawnSyncImpl: (_executable, _args, options) => {
        populateProjection(options.cwd, identity, { links: true });
        return { pid: 600, status: 0, signal: null };
      },
      cleanupImpl: cleanupProjectionPathDirect,
    });
    const npmCliPath = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    const commandArgs = [
      npmCliPath,
      'run',
      'proof',
      '--',
      'literal&value',
      'literal|value',
      'literal$(value)',
    ];
    let commandCall = null;
    const result = withProjection({
      repoRoot,
      runtime: runtime(),
      command: ['npm.cmd', ...commandArgs.slice(1)],
      env,
      platform: 'win32',
      processSnapshot: [],
      buildImpl: () => built,
      probesImpl: () => ({ passed: true, failed_probe_ids: [], settlement_passed: true }),
      cleanupImpl: cleanupProjectionPathDirect,
      spawnSyncImpl: (executable, args, options) => {
        if (executable === 'git') return { status: 0, stdout: '' };
        if (String(executable).toLowerCase().endsWith('powershell.exe')) {
          return { status: 0, stdout: '[]' };
        }
        if (executable === process.execPath && args[0] === npmCliPath) {
          for (const relative of identity.dependency_roots) {
            assertDirectoryLink(
              path.join(repoRoot, ...relative.split('/')),
              path.join(built.paths.projection_root, ...relative.split('/')),
            );
          }
          commandCall = {
            executable,
            args,
            shell: options.shell,
            windowsHide: options.windowsHide,
          };
          return { pid: 700, status: 0, signal: null };
        }
        throw new Error(`unexpected_spawn:${executable}`);
      },
    });

    expect(result).toMatchObject({ passed: true, key: identity.key, reused: false });
    expect(commandCall).toEqual({
      executable: process.execPath,
      args: commandArgs,
      shell: false,
      windowsHide: true,
    });
    for (const relative of identity.dependency_roots) {
      const original = path.join(repoRoot, ...relative.split('/'));
      expect(fs.lstatSync(original).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(original, '.original'), 'utf8'))
        .toBe(`original:${relative}`);
    }
    expect(listReparsePaths(built.paths.projection_root)).toEqual([]);
    expect(fs.existsSync(built.paths.lease_lock_path)).toBe(false);
    expect(fs.existsSync(resolveCandidateLockPath(built.paths, repoRoot))).toBe(false);
    expect(fs.readdirSync(built.paths.leases_root)).toEqual([]);
    const terminal = JSON.parse(fs.readFileSync(
      resolveCandidateReceiptPath(built.paths, repoRoot),
      'utf8',
    ));
    expect(terminal).toMatchObject({
      status: 'released',
      candidate_root: identity.repo_root,
      key: identity.key,
      command_status: 0,
    });
    expect(terminal.roots).toHaveLength(PROJECTION_CONTRACT.required_dependency_root_count);
    for (const entry of terminal.roots) {
      expect(entry).toMatchObject({ existed: true });
      expect(entry.restored_identity).toEqual(entry.original_identity);
    }
    expect(fs.existsSync(terminal.backup_root)).toBe(false);
  });

  test('fails closed on another candidate process before any leaf rename', () => {
    expect(() => assertCandidateQuiescent(repoRoot, {
      currentPid: 500,
      processes: [
        { pid: 500, parent_pid: 400, name: 'node.exe', command_line: 'controller', cwd: repoRoot },
        { pid: 400, parent_pid: 1, name: 'powershell.exe', command_line: 'wrapper', cwd: repoRoot },
        { pid: 600, parent_pid: 1, name: 'rg.exe', command_line: `rg node_modules ${repoRoot}`, cwd: '' },
      ],
    })).toThrow('dependency_projection_candidate_busy');
    expect(assertCandidateQuiescent(repoRoot, {
      currentPid: 500,
      processes: [
        { pid: 500, parent_pid: 400, name: 'node.exe', command_line: 'controller', cwd: repoRoot },
        { pid: 400, parent_pid: 1, name: 'powershell.exe', command_line: 'wrapper', cwd: repoRoot },
      ],
    })).toEqual({ passed: true, blockers: [] });
    expect(() => assertCandidateQuiescent(repoRoot, {
      currentPid: 500,
      ownedRootPids: [700],
      processes: [
        { pid: 500, parent_pid: 400, name: 'node.exe', command_line: 'controller', cwd: repoRoot },
        { pid: 800, parent_pid: 700, name: 'worker.exe', command_line: 'worker', cwd: '' },
      ],
    })).toThrow('dependency_projection_candidate_busy');
  });

  test('requires two clean candidate snapshots and times out on recurring activity', () => {
    const busy = [{
      pid: 600,
      parent_pid: 1,
      name: 'powershell.exe',
      command_line: `status ${repoRoot}`,
      cwd: '',
    }];
    const transient = [busy, [], []];
    expect(waitForCandidateQuiescence(repoRoot, {
      snapshotImpl: () => transient.shift(),
      sleepImpl: () => {},
      nowImpl: () => 0,
    })).toMatchObject({ passed: true, clean_samples: 2, processes: [] });

    let now = 0;
    let sample = 0;
    expect(() => waitForCandidateQuiescence(repoRoot, {
      snapshotImpl: () => (sample++ % 2 ? busy : []),
      sleepImpl: (milliseconds) => { now += milliseconds; },
      nowImpl: () => now,
      timeoutMs: 500,
      intervalMs: 250,
    })).toThrow('dependency_projection_candidate_quiescence_timeout');
  });

  test('ignores only the bound hidden-controller subtree and still blocks owned descendants', () => {
    const processes = [
      { pid: 500, parent_pid: 450, name: 'node.exe', command_line: 'projection', cwd: '' },
      { pid: 450, parent_pid: 400, name: 'powershell.exe', command_line: 'hidden child', cwd: '' },
      { pid: 400, parent_pid: 1, name: 'powershell.exe', command_line: `wrapper ${repoRoot}`, cwd: '' },
      { pid: 600, parent_pid: 400, name: 'conhost.exe', command_line: 'conhost', cwd: '' },
    ];
    expect(assertCandidateQuiescent(repoRoot, {
      currentPid: 500,
      controllerRootPid: 400,
      processes,
    })).toEqual({ passed: true, blockers: [] });
    expect(() => assertCandidateQuiescent(repoRoot, {
      currentPid: 500,
      controllerRootPid: 400,
      ownedRootPids: [600],
      processes,
    })).toThrow('dependency_projection_candidate_busy');
    expect(() => assertCandidateQuiescent(repoRoot, {
      currentPid: 500,
      controllerRootPid: 999,
      processes,
    })).toThrow('dependency_projection_controller_not_ancestor:999');
  });

  test('does not treat the zero PID sentinel as ownership of the Windows system tree', () => {
    const systemProcesses = [
      { pid: 4, parent_pid: 0, name: 'System', command_line: '', cwd: '' },
      { pid: 332, parent_pid: 4, name: 'Secure System', command_line: '', cwd: '' },
      { pid: 376, parent_pid: 4, name: 'Registry', command_line: '', cwd: '' },
      { pid: 1032, parent_pid: 4, name: 'smss.exe', command_line: '', cwd: '' },
      { pid: 3112, parent_pid: 4, name: 'Memory Compression', command_line: '', cwd: '' },
    ];
    expect(assertCandidateQuiescent(repoRoot, {
      currentPid: 500,
      ownedRootPids: [0],
      processes: systemProcesses,
    })).toEqual({ passed: true, blockers: [] });
    expect(() => assertCandidateQuiescent(repoRoot, {
      currentPid: 500,
      ownedRootPids: [0],
      processes: [
        ...systemProcesses,
        { pid: 700, parent_pid: 4, name: 'node.exe', command_line: `node ${repoRoot}/worker.js`, cwd: '' },
      ],
    })).toThrow('dependency_projection_candidate_busy');
  });

  test('keeps the live Windows system tree outside zero-PID ownership', () => {
    if (process.platform !== 'win32') return;
    const systemProcesses = collectProcessSnapshot()
      .filter((entry) => entry.pid === 4 || [
        'system',
        'secure system',
        'registry',
        'smss.exe',
        'memory compression',
      ].includes(entry.name.toLowerCase()));
    expect(systemProcesses.some((entry) => entry.pid === 4)).toBe(true);
    expect(assertCandidateQuiescent(repoRoot, {
      currentPid: process.pid,
      ownedRootPids: [0],
      processes: systemProcesses,
    })).toEqual({ passed: true, blockers: [] });
  });

  test('observes the exact VCTIP orphan family without process-name matching', () => {
    const processes = [
      {
        pid: 21644,
        parent_pid: 43980,
        name: 'VCTIP.EXE',
        command_line: '"C:\\BuildTools2022\\VC\\Tools\\MSVC\\VCTIP.EXE"',
        creation_ticks: '638903278000000000',
      },
      {
        pid: 22000,
        parent_pid: 21644,
        name: 'worker.exe',
        command_line: '',
        creation_ticks: '638903278000000001',
      },
      {
        pid: 4,
        parent_pid: 0,
        name: 'System',
        command_line: '',
        creation_ticks: '638000000000000000',
      },
    ];
    expect(collectOwnedProbeProcesses(43980, processes).map((entry) => entry.pid))
      .toEqual([21644, 22000]);
  });

  test('waits for a VCTIP orphan to exit naturally and requires two clean samples', () => {
    const rootIdentity = {
      pid: 43980,
      creation_ticks: '638903277999999999',
    };
    const vctip = {
      pid: 21644,
      parent_pid: 43980,
      name: 'VCTIP.EXE',
      command_line: '',
      creation_ticks: '638903278000000000',
    };
    const snapshots = [[vctip], [], []];
    let now = 0;
    const result = waitForOwnedProbeSettlement(43980, {
      rootIdentity,
      baselineProcesses: [],
      snapshotImpl: () => snapshots.shift(),
      sleepImpl: (milliseconds) => { now += milliseconds; },
      nowImpl: () => now,
      platform: 'win32',
      timeoutMs: 1000,
      intervalMs: 100,
    });
    expect(result).toMatchObject({
      passed: true,
      root_pid: 43980,
      root_identity: rootIdentity,
      clean_samples: 2,
      sample_count: 3,
      observed: [{ pid: 21644, parent_pid: 43980, name: 'VCTIP.EXE' }],
    });
  });

  test('fails closed without killing a persistent or identity-ambiguous probe descendant', () => {
    const rootIdentity = {
      pid: 43980,
      creation_ticks: '638903277999999999',
    };
    const vctip = {
      pid: 21644,
      parent_pid: 43980,
      name: 'VCTIP.EXE',
      command_line: '',
      creation_ticks: '638903278000000000',
    };
    let now = 0;
    expect(() => waitForOwnedProbeSettlement(43980, {
      rootIdentity,
      baselineProcesses: [],
      snapshotImpl: () => [vctip],
      sleepImpl: (milliseconds) => { now += milliseconds; },
      nowImpl: () => now,
      platform: 'win32',
      timeoutMs: 200,
      intervalMs: 100,
    })).toThrow('dependency_projection_probe_descendants_active');

    const identities = [
      [vctip],
      [{ ...vctip, creation_ticks: '638903278000000001' }],
    ];
    expect(() => waitForOwnedProbeSettlement(43980, {
      rootIdentity,
      baselineProcesses: [],
      snapshotImpl: () => identities.shift(),
      sleepImpl: () => {},
      nowImpl: () => 0,
      platform: 'win32',
    })).toThrow('dependency_projection_probe_descendant_identity_ambiguous:21644');

    expect(() => waitForOwnedProbeSettlement(43980, {
      rootIdentity,
      baselineProcesses: [vctip],
      snapshotImpl: () => [vctip],
      sleepImpl: () => {},
      nowImpl: () => 0,
      platform: 'win32',
    })).toThrow('dependency_projection_probe_descendant_preexisting_pid:21644');
  });

  test('retains a vanished-intermediate orphan and requires the exact probe-root identity', () => {
    const rootIdentity = { pid: 43980, creation_ticks: '638903277999999999' };
    const orphan = {
      pid: 21644,
      parent_pid: 31000,
      name: 'VCTIP.EXE',
      command_line: '',
      creation_ticks: '638903278000000000',
    };
    let now = 0;
    expect(() => waitForOwnedProbeSettlement(43980, {
      rootIdentity,
      baselineProcesses: [],
      snapshotImpl: () => [orphan],
      sleepImpl: (milliseconds) => { now += milliseconds; },
      nowImpl: () => now,
      platform: 'win32',
      timeoutMs: 200,
      intervalMs: 100,
    })).toThrow('dependency_projection_probe_descendants_active');
    expect(() => waitForOwnedProbeSettlement(43980, {
      rootIdentity: null,
      baselineProcesses: [],
      snapshotImpl: () => [],
      sleepImpl: () => {},
      nowImpl: () => 0,
      platform: 'win32',
    })).toThrow('dependency_projection_probe_root_identity_missing:43980');
    expect(() => waitForOwnedProbeSettlement(43980, {
      rootIdentity,
      baselineProcesses: [],
      snapshotImpl: () => [{
        pid: 43980,
        parent_pid: 1,
        name: 'node.exe',
        command_line: '',
        creation_ticks: '638903278000000001',
      }],
      sleepImpl: () => {},
      nowImpl: () => 0,
      platform: 'win32',
    })).toThrow('dependency_projection_probe_root_identity_ambiguous:43980');
  });

  test('settles every probe before returning and stops immediately on unsafe settlement', () => {
    let childPid = 700;
    const spawnProbe = (_executable, args) => {
      const probeId = args[args.indexOf('--run-probe') + 1];
      childPid += 1;
      return {
        pid: childPid,
        status: 0,
        stdout: `${JSON.stringify({
          schema: 'masarx.unit-qualification-dependency-probe.v1',
          id: probeId,
          passed: true,
          evidence: {},
          process_identity: {
            pid: childPid,
            creation_ticks: String(638903278000000000n + BigInt(childPid)),
          },
        })}\n`,
      };
    };
    const settlements = [];
    const result = runProjectionProbes({
      repoRoot,
      projectionRoot: path.join(tempRoot, 'projection'),
      platform: 'win32',
      controllerRootPid: 0,
      processSnapshotImpl: () => [],
      spawnSyncImpl: spawnProbe,
      probeSettlementImpl: (pid, { snapshotImpl, rootIdentity }) => {
        expect(rootIdentity).toMatchObject({ pid, creation_ticks: expect.stringMatching(/^638/) });
        settlements.push(pid);
        return {
          passed: true,
          root_pid: pid,
          root_identity: rootIdentity,
          observed: [],
          clean_samples: 2,
          sample_count: 2,
          processes: snapshotImpl(),
        };
      },
    });
    expect(result).toMatchObject({ passed: true, settlement_passed: true });
    expect(settlements).toHaveLength(result.results.length);

    let unsafeSpawnCount = 0;
    expect(() => runProjectionProbes({
      repoRoot,
      projectionRoot: path.join(tempRoot, 'projection'),
      platform: 'win32',
      controllerRootPid: 0,
      processSnapshotImpl: () => [],
      spawnSyncImpl: (...args) => {
        unsafeSpawnCount += 1;
        return spawnProbe(...args);
      },
      probeSettlementImpl: () => {
        throw new Error('dependency_projection_probe_descendants_active:VCTIP');
      },
    })).toThrow('dependency_projection_probe_descendants_active:VCTIP');
    expect(unsafeSpawnCount).toBe(1);
  });

  test('uses direct Node for npm on Windows and rejects other command wrappers', () => {
    const execPath = process.execPath;
    const npmCliPath = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const args = ['run', 'pr:ready', '--', '--require-clean', 'literal&value'];
    for (const executable of ['npm', 'NPM.CMD', 'C:\\Tools\\NPM.CMD']) {
      expect(resolveProjectionCommand([
        executable,
        ...args,
      ], { platform: 'win32', execPath })).toEqual({
        executable: execPath,
        args: [npmCliPath, ...args],
      });
    }
    const buildImpl = jest.fn();
    for (const executable of ['tool.cmd', 'tool.BAT']) {
      expect(() => withProjection({
        repoRoot,
        command: [executable],
        platform: 'win32',
        processSnapshot: [],
        buildImpl,
      })).toThrow(`dependency_projection_windows_wrapper_unsupported:${executable.toLowerCase()}`);
    }
    expect(buildImpl).not.toHaveBeenCalled();
    expect(resolveProjectionCommand(['powershell.exe', '-NoProfile'], {
      platform: 'win32',
      execPath,
    })).toEqual({ executable: 'powershell.exe', args: ['-NoProfile'] });
  });

  test('requires an exact controller PID before production Windows admission', () => {
    const buildImpl = jest.fn();
    expect(() => withProjection({
      repoRoot,
      command: ['synthetic-command'],
      env: { LOCALAPPDATA: path.join(tempRoot, 'local-app-data') },
      platform: 'win32',
      processSnapshot: null,
      buildImpl,
    })).toThrow('dependency_projection_controller_pid_required');
    expect(buildImpl).not.toHaveBeenCalled();
  });

  test('restores and releases after a zero-PID command spawn failure', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const localAppData = path.join(tempRoot, 'local-app-data');
    const env = {
      LOCALAPPDATA: localAppData,
      MASARX_DEPENDENCY_PROJECTION_BACKUP_ROOT: path.join(tempRoot, 'backup-base'),
    };
    for (const relative of identity.dependency_roots) {
      const original = path.join(repoRoot, ...relative.split('/'));
      fs.mkdirSync(original, { recursive: true });
      fs.writeFileSync(path.join(original, '.original'), `original:${relative}`);
    }
    const built = buildProjection({
      identity,
      platform: 'win32',
      env,
      spawnSyncImpl: (_executable, _args, options) => {
        populateProjection(options.cwd, identity, { links: true });
        return { pid: 600, status: 0, signal: null };
      },
      cleanupImpl: cleanupProjectionPathDirect,
    });
    const systemProcesses = [
      { pid: 4, parent_pid: 0, name: 'System', command_line: '' },
      { pid: 332, parent_pid: 4, name: 'Secure System', command_line: '' },
      { pid: 376, parent_pid: 4, name: 'Registry', command_line: '' },
      { pid: 1032, parent_pid: 4, name: 'smss.exe', command_line: '' },
      { pid: 3112, parent_pid: 4, name: 'Memory Compression', command_line: '' },
    ];
    expect(() => withProjection({
      repoRoot,
      runtime: runtime(),
      command: ['synthetic-command'],
      env,
      platform: 'win32',
      processSnapshot: [],
      buildImpl: () => built,
      probesImpl: () => ({ passed: true, failed_probe_ids: [], settlement_passed: true }),
      cleanupImpl: cleanupProjectionPathDirect,
      spawnSyncImpl: (executable) => {
        if (executable === 'git') return { status: 0, stdout: '' };
        if (String(executable).toLowerCase().endsWith('powershell.exe')) {
          return { status: 0, stdout: JSON.stringify(systemProcesses) };
        }
        return {
          pid: 0,
          status: null,
          error: Object.assign(new Error('invalid argument'), { code: 'EINVAL' }),
        };
      },
    })).toThrow('dependency_projection_command_failed:EINVAL');
    for (const relative of identity.dependency_roots) {
      const original = path.join(repoRoot, ...relative.split('/'));
      expect(fs.lstatSync(original).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(original, '.original'), 'utf8'))
        .toBe(`original:${relative}`);
    }
    expect(listReparsePaths(built.paths.projection_root)).toEqual([]);
    expect(fs.existsSync(built.paths.lease_lock_path)).toBe(false);
    expect(fs.existsSync(resolveCandidateLockPath(built.paths, repoRoot))).toBe(false);
    expect(fs.readdirSync(built.paths.leases_root)).toEqual([]);
    const terminal = JSON.parse(fs.readFileSync(
      resolveCandidateReceiptPath(built.paths, repoRoot),
      'utf8',
    ));
    expect(terminal).toMatchObject({
      status: 'released',
      command_status: null,
      command_error: 'invalid argument',
      cleanup_error: '',
    });
    expect(terminal.roots.every((entry) => (
      JSON.stringify(entry.restored_identity) === JSON.stringify(entry.original_identity)
    ))).toBe(true);
    expect(fs.existsSync(terminal.backup_root)).toBe(false);
  });

  test('retains the exact transaction when probe-descendant settlement is unproven', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const env = {
      LOCALAPPDATA: path.join(tempRoot, 'local-app-data'),
      MASARX_DEPENDENCY_PROJECTION_BACKUP_ROOT: path.join(tempRoot, 'backup-base'),
    };
    for (const relative of identity.dependency_roots) {
      const original = path.join(repoRoot, ...relative.split('/'));
      fs.mkdirSync(original, { recursive: true });
      fs.writeFileSync(path.join(original, '.original'), `original:${relative}`);
    }
    const built = buildProjection({
      identity,
      platform: 'win32',
      env,
      spawnSyncImpl: (_executable, _args, options) => {
        populateProjection(options.cwd, identity, { links: true });
        return { pid: 600, status: 0, signal: null };
      },
      cleanupImpl: cleanupProjectionPathDirect,
    });
    const spawnSyncImpl = (executable) => {
      if (executable === 'git') return { status: 0, stdout: '' };
      if (String(executable).toLowerCase().endsWith('powershell.exe')) {
        return { status: 0, stdout: '[]' };
      }
      throw new Error(`unexpected_spawn:${executable}`);
    };
    expect(() => withProjection({
      repoRoot,
      runtime: runtime(),
      command: ['synthetic-command'],
      env,
      platform: 'win32',
      processSnapshot: [],
      buildImpl: () => built,
      cleanupImpl: cleanupProjectionPathDirect,
      spawnSyncImpl,
      probesImpl: () => {
        throw new Error('dependency_projection_probe_descendants_active:VCTIP');
      },
    })).toThrow(
      'dependency_projection_operation_and_cleanup_failed:dependency_projection_probe_descendants_active:VCTIP:dependency_projection_detach_blocked_active_process',
    );
    for (const relative of identity.dependency_roots) {
      assertDirectoryLink(
        path.join(repoRoot, ...relative.split('/')),
        path.join(built.paths.projection_root, ...relative.split('/')),
      );
    }
    expect(fs.existsSync(built.paths.lease_lock_path)).toBe(true);
    expect(fs.existsSync(resolveCandidateLockPath(built.paths, repoRoot))).toBe(true);
    const leaseFiles = fs.readdirSync(built.paths.leases_root);
    expect(leaseFiles).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(built.paths.leases_root, leaseFiles[0]), 'utf8')))
      .toMatchObject({ status: 'detach_blocked' });
  });

  test('builds once with a contained C-style npm cache and reuses the verified neutral tree', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const localAppData = path.join(tempRoot, 'local-app-data');
    const calls = [];
    const spawnSyncImpl = (executable, args, options) => {
      calls.push({ executable, args, options });
      populateProjection(options.cwd, identity, { links: true });
      return { status: 0, signal: null };
    };
    const first = buildProjection({
      identity,
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
      spawnSyncImpl,
      cleanupImpl: cleanupProjectionPathDirect,
    });
    expect(first.reused).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.env.npm_config_cache).toBe(first.paths.npm_cache);
    expect(calls[0].options.cwd.startsWith(first.paths.staging_root)).toBe(true);
    expect(listReparsePaths(first.paths.projection_root)).toEqual([]);
    expect(validatePublishedProjection(first.paths, identity)).toMatchObject({
      key: identity.key,
      dependency_roots: POPULATED_ROOTS,
      required_probe_ids: INSTALL_CONTRACT.required_probe_ids,
      probe_contract_sha256: identity.probe_contract_sha256,
    });

    const receipt = JSON.parse(fs.readFileSync(first.paths.receipt_path, 'utf8'));
    delete receipt.required_probe_ids;
    writeJson(first.paths.receipt_path, receipt);
    expect(() => validatePublishedProjection(first.paths, identity))
      .toThrow('dependency_projection_receipt_invalid');
    receipt.required_probe_ids = identity.required_probe_ids;
    receipt.probe_contract_sha256 = '0'.repeat(64);
    writeJson(first.paths.receipt_path, receipt);
    expect(() => validatePublishedProjection(first.paths, identity))
      .toThrow('dependency_projection_receipt_invalid');
    receipt.probe_contract_sha256 = identity.probe_contract_sha256;
    writeJson(first.paths.receipt_path, receipt);

    const second = buildProjection({
      identity,
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
      spawnSyncImpl,
      cleanupImpl: cleanupProjectionPathDirect,
    });
    expect(second.reused).toBe(true);
    expect(calls).toHaveLength(1);

    fs.appendFileSync(path.join(first.paths.projection_root, 'node_modules', '.proof'), 'tamper');
    expect(() => validatePublishedProjection(first.paths, identity))
      .toThrow('dependency_projection_tree_digest_invalid');
  });

  test('preserves uncertain build staging and its content-key lock after npm timeout', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const localAppData = path.join(tempRoot, 'local-app-data');
    const cleanupImpl = jest.fn();
    const paths = resolveProjectionPaths({
      identity,
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
    });
    expect(() => buildProjection({
      identity,
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
      spawnSyncImpl: () => ({
        status: null,
        error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      }),
      cleanupImpl,
    })).toThrow('dependency_projection_npm_failed:ETIMEDOUT');
    expect(cleanupImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.lock_path)).toBe(true);
    const lock = JSON.parse(fs.readFileSync(paths.lock_path, 'utf8'));
    expect(lock).toMatchObject({
      key: identity.key,
      status: 'building',
    });
    expect(lock.stage_path.startsWith(paths.staging_root)).toBe(true);
    expect(fs.existsSync(lock.stage_path)).toBe(true);
  });

  test('preserves the completed install stage and build lock after native digest timeout', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const localAppData = path.join(tempRoot, 'local-app-data');
    const cleanupImpl = jest.fn();
    const paths = resolveProjectionPaths({
      identity,
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
    });
    expect(() => buildProjection({
      identity,
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
      spawnSyncImpl: (_executable, _args, options) => {
        populateProjection(options.cwd, identity, { links: true });
        return { pid: 600, status: 0, signal: null };
      },
      digestSpawnSyncImpl: () => ({
        status: null,
        error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      }),
      cleanupImpl,
    })).toThrow('dependency_projection_digest_failed:ETIMEDOUT');
    expect(cleanupImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.lock_path)).toBe(true);
    const lock = JSON.parse(fs.readFileSync(paths.lock_path, 'utf8'));
    expect(fs.existsSync(lock.stage_path)).toBe(true);
    expect(listReparsePaths(path.join(lock.stage_path, 'workspace'))).toEqual([]);
  });

  test('retains the lease and all projected roots when a timed-out command leaves a child alive', () => {
    const identity = createProjectionIdentity({ repoRoot, runtime: runtime() });
    const localAppData = path.join(tempRoot, 'local-app-data');
    const env = {
      LOCALAPPDATA: localAppData,
      MASARX_DEPENDENCY_PROJECTION_BACKUP_ROOT: path.join(tempRoot, 'backup-base'),
    };
    const built = buildProjection({
      identity,
      platform: 'win32',
      env,
      spawnSyncImpl: (executable, args, options) => {
        populateProjection(options.cwd, identity, { links: true });
        return { status: 0, signal: null };
      },
      cleanupImpl: cleanupProjectionPathDirect,
    });
    // The guard excludes its own process, so synthetic children must use different PIDs.
    const commandPid = process.pid + 1;
    const childPid = process.pid + 2;
    let processSnapshotCalls = 0;
    const spawnSyncImpl = (executable) => {
      if (executable === 'git') return { status: 0, stdout: '' };
      if (String(executable).toLowerCase().endsWith('powershell.exe')) {
        processSnapshotCalls += 1;
        return {
          status: 0,
          stdout: processSnapshotCalls <= 2 ? '[]' : JSON.stringify({
            pid: childPid,
            parent_pid: commandPid,
            name: 'worker.exe',
            command_line: 'worker',
          }),
        };
      }
      return {
        pid: commandPid,
        status: null,
        error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      };
    };
    expect(() => withProjection({
      repoRoot,
      runtime: runtime(),
      command: ['synthetic-command'],
      env,
      platform: 'win32',
      spawnSyncImpl,
      processSnapshot: [],
      buildImpl: () => built,
      probesImpl: () => ({ passed: true, failed_probe_ids: [], settlement_passed: true }),
      cleanupImpl: cleanupProjectionPathDirect,
    })).toThrow('dependency_projection_detach_blocked_active_process');
    for (const relative of identity.dependency_roots) {
      assertDirectoryLink(
        path.join(repoRoot, ...relative.split('/')),
        path.join(built.paths.projection_root, ...relative.split('/')),
      );
    }
    expect(listReparsePaths(built.paths.projection_root)).toHaveLength(8);
    expect(fs.existsSync(built.paths.lease_lock_path)).toBe(true);
    const leaseFiles = fs.readdirSync(built.paths.leases_root);
    expect(leaseFiles).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(built.paths.leases_root, leaseFiles[0]), 'utf8')))
      .toMatchObject({ status: 'detach_blocked' });
  });

  test('bounds exact-child cleanup and rejects reparse or parent deletion', () => {
    const allowed = path.join(tempRoot, 'cleanup-root');
    const target = path.join(allowed, 'exact-child');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'proof.txt'), 'proof');
    expect(cleanupProjectionPathDirect(target, allowed)).toEqual({ passed: true, skipped: false });
    expect(fs.existsSync(target)).toBe(false);
    expect(() => cleanupProjectionPathDirect(allowed, allowed))
      .toThrow('dependency_projection_cleanup_escape');

    const linked = path.join(allowed, 'linked-child');
    const linkedTarget = path.join(tempRoot, 'linked-target');
    fs.mkdirSync(linked, { recursive: true });
    fs.mkdirSync(linkedTarget, { recursive: true });
    fs.symlinkSync(linkedTarget, path.join(linked, 'unexpected'), 'junction');
    expect(() => cleanupProjectionPathDirect(linked, allowed))
      .toThrow('dependency_projection_cleanup_reparse');
  });

  test('requires a terminal matching receipt from bounded cleanup', () => {
    const target = path.join(tempRoot, 'cleanup-target');
    const allowed = path.join(tempRoot, 'cleanup-root');
    const calls = [];
    const result = runBoundedCleanup(target, allowed, {
      timeoutMs: 1234,
      spawnSyncImpl: (executable, args, options) => {
        calls.push({ executable, args, options });
        return {
          status: 0,
          stdout: `${JSON.stringify({
            passed: true,
            token: options.env.MASARX_DEPENDENCY_PROJECTION_CLEANUP_TOKEN,
          })}\n`,
        };
      },
    });
    expect(result.passed).toBe(true);
    expect(calls[0].options).toMatchObject({
      timeout: 1234,
      shell: false,
      windowsHide: true,
      killSignal: 'SIGTERM',
    });
    expect(() => runBoundedCleanup(target, allowed, {
      spawnSyncImpl: () => ({ status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }),
    })).toThrow('dependency_projection_cleanup_failed:ETIMEDOUT');
  });
});
