const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isLockfileOnlyChangeSet,
  readLockfileAtRef,
  parseNpmLockfileV3,
  diffLockfilePackages,
  resolveOwnerWorkspaceForLockEntry,
  resolveLockfileOnlyImpact,
} = require('../../../scripts/ops/ci/lockfile-impact-selection');

const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

function lock(packages) {
  return JSON.stringify({
    name: 'masarx',
    lockfileVersion: 3,
    packages,
  });
}

function resolver({ basePackages, headPackages }) {
  return ({ ref }) => {
    if (ref === 'base') return lock(basePackages);
    if (ref === 'head') return lock(headPackages);
    throw new Error(`unexpected ref ${ref}`);
  };
}

describe('lockfile-impact-selection', () => {
  test('recognizes exact package-lock-only changes', () => {
    expect(isLockfileOnlyChangeSet(['package-lock.json'])).toBe(true);
    expect(isLockfileOnlyChangeSet(['package-lock.json', 'package.json'])).toBe(false);
    expect(isLockfileOnlyChangeSet(['pnpm-lock.yaml'])).toBe(false);
  });

  test('reads the real repository lockfile through the default git show path', () => {
    const expected = execFileSync('git', ['cat-file', 'blob', 'HEAD:package-lock.json'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(parseNpmLockfileV3(expected).ok).toBe(true);
    expect(readLockfileAtRef({ ref: 'HEAD', cwd: ROOT_DIR })).toBe(expected);
  });

  test('reads a synthetic lockfile larger than the default child-process buffer', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lockfile-impact-'));
    const options = { cwd, encoding: 'utf8', windowsHide: true };
    const expected = lock({ 'node_modules/fixture': { version: '1.0.0', description: 'x'.repeat(1024 * 1024) } });
    try {
      fs.writeFileSync(path.join(cwd, 'package-lock.json'), expected);
      execFileSync('git', ['init', '--quiet'], options);
      execFileSync('git', ['add', 'package-lock.json'], options);
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test',
        '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', 'commit', '--quiet', '-m', 'fixture'], options);
      expect(Buffer.byteLength(expected)).toBeGreaterThan(1024 * 1024);
      expect(readLockfileAtRef({ ref: 'HEAD', cwd })).toBe(expected);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('parses npm lockfile v3 and rejects malformed or non-v3 locks', () => {
    expect(parseNpmLockfileV3(lock({}))).toMatchObject({ ok: true });
    expect(parseNpmLockfileV3('{')).toMatchObject({ ok: false, reason: 'parse_error' });
    expect(parseNpmLockfileV3(JSON.stringify({ lockfileVersion: 2, packages: {} })))
      .toMatchObject({ ok: false, reason: 'non_v3_lockfile' });
  });

  test('diffs lockfile package entries deterministically', () => {
    const baseLock = JSON.parse(lock({ 'apps/console/node_modules/zod': { version: '1.0.0' } }));
    const headLock = JSON.parse(lock({ 'apps/console/node_modules/zod': { version: '1.0.1' } }));
    expect(diffLockfilePackages({ baseLock, headLock })).toEqual(['apps/console/node_modules/zod']);
  });

  test.each([
    ['apps/console/node_modules/zod', 'apps/console'],
    ['apps/portal/node_modules/zod', 'apps/portal'],
    ['apps/fieldops/node_modules/expo-camera', 'apps/fieldops'],
    ['packages/ui/node_modules/date-fns', 'packages/ui'],
    ['packages/api', 'packages/api'],
    ['node_modules/zod', ''],
    ['tools/custom/node_modules/zod', ''],
  ])('resolves owner for %s', (key, owner) => {
    expect(resolveOwnerWorkspaceForLockEntry(key)).toBe(owner);
  });

  test('optimizes console-scoped lockfile changes to console package classification', () => {
    const impact = resolveLockfileOnlyImpact({
      changedFiles: ['package-lock.json'],
      baseRef: 'base',
      headRef: 'head',
      gitShowImpl: resolver({
        basePackages: { 'apps/console/node_modules/zod': { version: '1.0.0' } },
        headPackages: { 'apps/console/node_modules/zod': { version: '1.0.1' } },
      }),
    });
    expect(impact).toMatchObject({
      applicable: true,
      optimized: true,
      mode: 'optimized',
      reason: 'workspace_scoped',
      classificationFiles: ['apps/console/package.json'],
      ownerWorkspaces: ['apps/console'],
    });
  });

  test('optimizes package-scoped UI lockfile changes to package classification', () => {
    const impact = resolveLockfileOnlyImpact({
      changedFiles: ['package-lock.json'],
      baseRef: 'base',
      headRef: 'head',
      gitShowImpl: resolver({
        basePackages: { 'packages/ui/node_modules/date-fns': { version: '1.0.0' } },
        headPackages: { 'packages/ui/node_modules/date-fns': { version: '1.0.1' } },
      }),
    });
    expect(impact.classificationFiles).toEqual(['packages/ui/package.json']);
    expect(impact.ownerWorkspaces).toEqual(['packages/ui']);
  });

  test('allows mobile-native dependency changes when clearly owned by fieldops', () => {
    const impact = resolveLockfileOnlyImpact({
      changedFiles: ['package-lock.json'],
      baseRef: 'base',
      headRef: 'head',
      gitShowImpl: resolver({
        basePackages: { 'apps/fieldops/node_modules/expo-camera': { version: '1.0.0' } },
        headPackages: { 'apps/fieldops/node_modules/expo-camera': { version: '1.0.1' } },
      }),
    });
    expect(impact.optimized).toBe(true);
    expect(impact.classificationFiles).toEqual(['apps/fieldops/package.json']);
    expect(impact.nativePackageKeys).toEqual(['apps/fieldops/node_modules/expo-camera']);
  });

  test.each([
    ['root package metadata', { '': { dependencies: { zod: '1.0.1' } } }, 'root_global_entry'],
    ['global node_modules entry', { 'node_modules/zod': { version: '1.0.1' } }, 'root_global_entry'],
    ['unknown workspace entry', { 'tools/codegen/node_modules/zod': { version: '1.0.1' } }, 'unknown_workspace_entry'],
    ['native package outside mobile owner', { 'packages/ui/node_modules/react-native': { version: '1.0.1' } }, 'native_ambiguous'],
  ])('fails closed for %s', (_label, headPackages, reason) => {
    const impact = resolveLockfileOnlyImpact({
      changedFiles: ['package-lock.json'],
      baseRef: 'base',
      headRef: 'head',
      gitShowImpl: resolver({
        basePackages: {},
        headPackages,
      }),
    });
    expect(impact).toMatchObject({
      applicable: true,
      optimized: false,
      forceFull: true,
      mode: 'full_fallback',
      reason,
    });
  });

  test('fails closed on missing refs and unreadable lockfiles', () => {
    expect(resolveLockfileOnlyImpact({
      changedFiles: ['package-lock.json'],
      baseRef: '',
      headRef: 'head',
    })).toMatchObject({ mode: 'full_fallback', reason: 'missing_ref' });
    expect(resolveLockfileOnlyImpact({
      changedFiles: ['package-lock.json'],
      baseRef: 'base',
      headRef: 'head',
      gitShowImpl: () => { throw new Error('no lock'); },
    })).toMatchObject({ mode: 'full_fallback', reason: 'read_error' });
  });
});
