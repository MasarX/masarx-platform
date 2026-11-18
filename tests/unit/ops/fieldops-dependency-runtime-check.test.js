const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  REQUIRED_PACKAGE_FILES,
  buildNpmCiArgs,
  collectInstalledFindings,
  collectLockFindings,
  createSummary,
  formatHumanSummary,
  parseArgs,
} = require('../../../scripts/ops/fieldops-dependency-runtime-check');

function writeFile(filePath, contents = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldops-deps-'));
  const packages = {
    '': {
      workspaces: ['apps/*', 'packages/*'],
    },
    'apps/fieldops': {
      name: '@masarx/fieldops',
    },
  };
  for (const item of REQUIRED_PACKAGE_FILES) {
    if (!item.optionalLockPath) {
      packages[item.lockPath.replace(/\\/g, '/')] = {
        version: '0.0.0-test',
      };
    }
  }
  packages['node_modules/source-map-support'] = {
    version: '0.5.13',
    dependencies: { 'source-map': '^0.6.0' },
  };
  packages['node_modules/source-map-support/node_modules/source-map'] = { version: '0.6.1' };
  writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'test-repo', workspaces: ['apps/*', 'packages/*'] }, null, 2),
  );
  writeFile(path.join(repoRoot, 'package-lock.json'), JSON.stringify({ packages }, null, 2));
  return repoRoot;
}


const SOURCE_MAP_SUPPORT_PATH = 'node_modules/source-map-support';
const NESTED_SOURCE_MAP_PATH = SOURCE_MAP_SUPPORT_PATH + '/node_modules/source-map';
const HOISTED_SOURCE_MAP_PATH = 'node_modules/source-map';
const sourceMapRequirement = REQUIRED_PACKAGE_FILES.filter((item) => item.id === 'source-map-support-source-map');

function writeSourceMapPackages(repoRoot, dependencyPath = NESTED_SOURCE_MAP_PATH) {
  writeFile(path.join(repoRoot, SOURCE_MAP_SUPPORT_PATH, 'package.json'), JSON.stringify({
    name: 'source-map-support',
    version: '0.5.13',
    dependencies: { 'source-map': '^0.6.0' },
  }));
  writeFile(path.join(repoRoot, dependencyPath, 'package.json'), JSON.stringify({ name: 'source-map', version: '0.6.1' }));
}

function updateLock(repoRoot, change) {
  const lockPath = path.join(repoRoot, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  change(lock.packages);
  writeFile(lockPath, JSON.stringify(lock, null, 2));
}

function createSourceMapRepo({ layout = 'hoisted', range = '^0.6.0', version = '0.6.1', installed = true } = {}) {
  const repoRoot = createTempRepo();
  const dependencyPath = layout === 'nested' ? NESTED_SOURCE_MAP_PATH : HOISTED_SOURCE_MAP_PATH;
  updateLock(repoRoot, (packages) => {
    delete packages[NESTED_SOURCE_MAP_PATH];
    packages[dependencyPath] = { version };
    packages[SOURCE_MAP_SUPPORT_PATH].dependencies['source-map'] = range;
  });
  if (installed) writeSourceMapPackages(repoRoot, dependencyPath);
  return repoRoot;
}

function sourceMapSummary(repoRoot, options = {}) {
  return createSummary({ repoRoot, requiredPackageFiles: sourceMapRequirement, ...options });
}

describe('fieldops-dependency-runtime-check', () => {
  test('builds the bounded FieldOps workspace npm ci command', () => {
    expect(buildNpmCiArgs({ dryRun: true, cacheDir: 'tmp/cache' })).toEqual([
      'ci',
      '--workspace',
      '@masarx/fieldops',
      '--include-workspace-root=false',
      '--dry-run',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      'tmp/cache',
    ]);
  });

  test('parses checker modes and cache options', () => {
    expect(parseArgs(['--dry-run', '--json', '--cache', 'tmp/cache'])).toEqual({
      mode: 'dry-run',
      json: true,
      cacheDir: 'tmp/cache',
    });
    expect(parseArgs(['--materialize']).mode).toBe('materialize');
  });

  test('reports missing installed package internals without changing files', () => {
    const repoRoot = createTempRepo();
    const findings = collectInstalledFindings({ repoRoot });

    expect(findings.some((finding) => finding.path === 'node_modules/pg-types/lib/textParsers.js')).toBe(true);
    expect(findings.some((finding) => finding.path === 'node_modules/buffer/index.d.ts')).toBe(true);
  });

  test('passes installed tree check when required files are present', () => {
    const repoRoot = createTempRepo();
    for (const item of REQUIRED_PACKAGE_FILES) {
      if (!item.optionalFile) writeFile(path.join(repoRoot, item.filePath), 'ok');
    }

    writeSourceMapPackages(repoRoot);
    expect(collectInstalledFindings({ repoRoot })).toEqual([]);
  });

  test('accepts a declared alternate package layout', () => {
    const repoRoot = createTempRepo();
    const expoCli = REQUIRED_PACKAGE_FILES.find((item) => item.id === 'expo-cli');
    const lockPath = path.join(repoRoot, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    delete lock.packages[expoCli.lockPath];
    lock.packages[expoCli.alternateLockPaths[0]] = { version: '0.0.0-test' };
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));

    for (const item of REQUIRED_PACKAGE_FILES) {
      if (item.optionalFile) continue;
      const filePath = item.id === 'expo-cli' ? item.alternateFilePaths[0] : item.filePath;
      writeFile(path.join(repoRoot, filePath), 'ok');
    }

    writeSourceMapPackages(repoRoot);
    expect(collectLockFindings({ repoRoot })).toEqual([]);
    expect(collectInstalledFindings({ repoRoot })).toEqual([]);
  });

  test('detects lockfile source-of-truth problems', () => {
    const repoRoot = createTempRepo();
    const lockPath = path.join(repoRoot, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    delete lock.packages['node_modules/pg-types'];
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    writeFile(path.join(repoRoot, 'apps/fieldops/package-lock.json'), '{}');

    const findings = collectLockFindings({ repoRoot });

    expect(findings.map((finding) => finding.type)).toEqual(
      expect.arrayContaining(['missing-lock-entry', 'unexpected-local-lockfile']),
    );
  });

  test('dry-run mode can pass without a materialized node_modules tree', () => {
    const repoRoot = createTempRepo();
    const summary = createSummary({
      repoRoot,
      mode: 'dry-run',
      npmRunner: () => ({
        command: 'npm ci --dry-run',
        status: 0,
        stdout: 'added 1 package',
        stderr: '',
      }),
    });

    expect(summary.ok).toBe(true);
    expect(summary.installedFindings).toEqual([]);
    expect(summary.npm.status).toBe(0);
  });

  test('human summary includes repair guidance on failure', () => {
    const repoRoot = createTempRepo();
    const summary = createSummary({ repoRoot, mode: 'check' });
    const text = formatHumanSummary(summary);

    expect(text).toContain('status=failed');
    expect(text).toContain('safest repair path');
    expect(text).toContain('Do not copy node_modules between worktrees');
  });
  test.each(['nested', 'hoisted'])('accepts lock-backed compatible %s source-map resolution', (layout) => {
    const repoRoot = createSourceMapRepo({ layout });
    const beforeLock = fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8');
    expect(sourceMapSummary(repoRoot)).toMatchObject({ ok: true, lockFindings: [], installedFindings: [] });
    expect(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')).toBe(beforeLock);
  });

  test('rejects a missing locked dependency even when its installed file exists', () => {
    const repoRoot = createSourceMapRepo();
    updateLock(repoRoot, (packages) => { delete packages[HOISTED_SOURCE_MAP_PATH]; });
    expect(sourceMapSummary(repoRoot)).toMatchObject({ ok: false });
    expect(collectLockFindings({ repoRoot, requiredPackageFiles: sourceMapRequirement })).toEqual([
      expect.objectContaining({ type: 'missing-lock-entry' }),
    ]);
  });

  test('rejects a missing installed dependency', () => {
    const repoRoot = createSourceMapRepo({ installed: false });
    writeFile(path.join(repoRoot, SOURCE_MAP_SUPPORT_PATH, 'package.json'), JSON.stringify({
      name: 'source-map-support', version: '0.5.13', dependencies: { 'source-map': '^0.6.0' },
    }));
    expect(sourceMapSummary(repoRoot).ok).toBe(false);
    expect(sourceMapSummary(repoRoot).installedFindings).toHaveLength(1);
  });

  test('rejects a missing installed consumer', () => {
    const repoRoot = createSourceMapRepo({ installed: false });
    writeFile(path.join(repoRoot, HOISTED_SOURCE_MAP_PATH, 'package.json'), JSON.stringify({ name: 'source-map', version: '0.6.1' }));
    expect(sourceMapSummary(repoRoot).installedFindings).toEqual([
      expect.objectContaining({ type: 'missing-installed-file', path: SOURCE_MAP_SUPPORT_PATH + '/package.json' }),
    ]);
  });

  test.each(['^0.7.0', '^0.6.1', ''])('fails closed when the locked consumer range changes to %j', (range) => {
    const repoRoot = createSourceMapRepo({ range });
    expect(sourceMapSummary(repoRoot).lockFindings).toEqual([
      expect.objectContaining({ type: 'incompatible-lock-dependency' }),
    ]);
    expect(sourceMapSummary(repoRoot).ok).toBe(false);
  });

  test.each(['0.7.0', '0.6.1-beta.1', 'invalid'])('rejects incompatible or unsupported locked source-map %s', (version) => {
    const repoRoot = createSourceMapRepo({ version });
    expect(sourceMapSummary(repoRoot).ok).toBe(false);
    expect(sourceMapSummary(repoRoot).lockFindings).toEqual([
      expect.objectContaining({ type: 'incompatible-lock-dependency' }),
    ]);
  });

  test('rejects a locked incompatible nearest nested dependency despite a compatible hoisted ancestor', () => {
    const repoRoot = createSourceMapRepo();
    updateLock(repoRoot, (packages) => { packages[NESTED_SOURCE_MAP_PATH] = { version: '0.7.0' }; });
    writeFile(path.join(repoRoot, NESTED_SOURCE_MAP_PATH, 'package.json'), JSON.stringify({ name: 'source-map', version: '0.7.0' }));
    expect(sourceMapSummary(repoRoot).lockFindings).toEqual([
      expect.objectContaining({ type: 'incompatible-lock-dependency', path: NESTED_SOURCE_MAP_PATH }),
    ]);
    expect(sourceMapSummary(repoRoot).ok).toBe(false);
  });

  test.each(['0.7.0', '0.6.1'])('rejects an unlocked nearest nested source-map %s shadowing the locked ancestor', (version) => {
    const repoRoot = createSourceMapRepo();
    writeFile(path.join(repoRoot, NESTED_SOURCE_MAP_PATH, 'package.json'), JSON.stringify({ name: 'source-map', version }));
    expect(sourceMapSummary(repoRoot).installedFindings).toEqual([
      expect.objectContaining({ type: 'installed-lock-mismatch', path: NESTED_SOURCE_MAP_PATH + '/package.json' }),
    ]);
    expect(sourceMapSummary(repoRoot).ok).toBe(false);
  });

  test('rejects a compatible installed version that differs from the selected lock entry', () => {
    const repoRoot = createSourceMapRepo();
    writeFile(path.join(repoRoot, HOISTED_SOURCE_MAP_PATH, 'package.json'), JSON.stringify({ name: 'source-map', version: '0.6.2' }));
    expect(sourceMapSummary(repoRoot).installedFindings).toEqual([
      expect.objectContaining({ type: 'installed-lock-mismatch' }),
    ]);
  });

  test.each([
    { name: 'source-map-support', version: '0.5.13', dependencies: { 'source-map': '^0.7.0' } },
    { name: 'source-map-support', version: '0.5.21', dependencies: { 'source-map': '^0.6.0' } },
  ])('rejects installed consumer metadata that differs from the lock: %j', (consumer) => {
    const repoRoot = createSourceMapRepo();
    writeFile(path.join(repoRoot, SOURCE_MAP_SUPPORT_PATH, 'package.json'), JSON.stringify(consumer));
    expect(sourceMapSummary(repoRoot).installedFindings).toEqual([
      expect.objectContaining({ type: 'installed-lock-mismatch' }),
    ]);
  });

  test('rejects installed dependency metadata for a different package', () => {
    const repoRoot = createSourceMapRepo();
    writeFile(path.join(repoRoot, HOISTED_SOURCE_MAP_PATH, 'package.json'), JSON.stringify({ name: 'other-package', version: '0.6.1' }));
    expect(sourceMapSummary(repoRoot).installedFindings).toEqual([
      expect.objectContaining({ type: 'installed-lock-mismatch' }),
    ]);
  });

  test('requires the consumer itself to be lock-backed', () => {
    const repoRoot = createSourceMapRepo();
    updateLock(repoRoot, (packages) => { delete packages[SOURCE_MAP_SUPPORT_PATH]; });
    expect(sourceMapSummary(repoRoot).lockFindings).toEqual([
      expect.objectContaining({ type: 'missing-lock-entry', path: SOURCE_MAP_SUPPORT_PATH }),
    ]);
  });

  test('rechecks consumer-relative resolution after owner-scoped materialization', () => {
    const repoRoot = createSourceMapRepo({ installed: false });
    const summary = sourceMapSummary(repoRoot, {
      mode: 'materialize',
      npmRunner: () => {
        writeSourceMapPackages(repoRoot, HOISTED_SOURCE_MAP_PATH);
        return { command: 'npm ci fixture', status: 0, stdout: '', stderr: '' };
      },
    });
    expect(summary).toMatchObject({ ok: true, installedFindings: [], npm: { status: 0 } });
  });

  test('freshly resolves after a same-process check then materialization rehoists source-map', () => {
    const repoRoot = createSourceMapRepo();
    writeSourceMapPackages(repoRoot, NESTED_SOURCE_MAP_PATH);
    expect(sourceMapSummary(repoRoot).ok).toBe(false);
    const summary = sourceMapSummary(repoRoot, {
      mode: 'materialize',
      npmRunner: () => {
        fs.rmSync(path.join(repoRoot, NESTED_SOURCE_MAP_PATH, 'package.json'));
        fs.rmdirSync(path.join(repoRoot, NESTED_SOURCE_MAP_PATH));
        writeSourceMapPackages(repoRoot, HOISTED_SOURCE_MAP_PATH);
        return { command: 'npm ci rehoist fixture', status: 0, stdout: '', stderr: '' };
      },
    });
    expect(summary).toMatchObject({ ok: true, lockFindings: [], installedFindings: [] });
    expect(sourceMapSummary(repoRoot).ok).toBe(true);
  });

  test('rejects an incomplete nearest nested package instead of falling through to a compatible ancestor', () => {
    const repoRoot = createSourceMapRepo();
    fs.mkdirSync(path.join(repoRoot, NESTED_SOURCE_MAP_PATH), { recursive: true });
    expect(sourceMapSummary(repoRoot).installedFindings).toEqual([
      expect.objectContaining({ type: 'missing-installed-file', path: NESTED_SOURCE_MAP_PATH + '/package.json' }),
    ]);
    expect(sourceMapSummary(repoRoot).ok).toBe(false);
  });

});
