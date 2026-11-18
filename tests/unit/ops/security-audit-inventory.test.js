const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildInventory,
  buildSurfaceCatalog,
  buildSurfaceCatalogFromLockData,
  classifyPriority,
  classifyRuntimeExposure,
  normalizeFixAvailability,
  renderPriorityMatrix,
  validateNpmAuditReport,
} = require('../../../scripts/ops/security-audit-inventory');

function createRepoFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'security-audit-inventory-'));
  fs.mkdirSync(path.join(repoRoot, 'apps', 'fieldops'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'apps', 'console'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'packages', 'shared'), { recursive: true });

  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'repo-root',
        private: true,
        devDependencies: {
          eslint: '^9.0.0',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoRoot, 'apps', 'fieldops', 'package.json'),
    JSON.stringify(
      {
        name: 'fieldops',
        dependencies: {
          expo: '^54.0.0',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoRoot, 'apps', 'console', 'package.json'),
    JSON.stringify(
      {
        name: 'console',
        dependencies: {
          next: '^16.0.0',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoRoot, 'packages', 'shared', 'package.json'),
    JSON.stringify(
      {
        name: '@masarx/shared',
        dependencies: {
          lodash: '^4.17.21',
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  return repoRoot;
}

describe('security-audit-inventory helpers', () => {
  const cleanAudit = {
    auditReportVersion: 2, vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  };
  test.each([
    null, [], {}, { ...cleanAudit, error: {} },
    { ...cleanAudit, vulnerabilities: [] },
    { ...cleanAudit, vulnerabilities: { pkg: { severity: 'unknown' } } },
    ...[undefined, [], 'pkg', {}, [null], [''], [{ severity: 'high' }]].map(via => ({
      ...cleanAudit, vulnerabilities: { pkg: { severity: 'high', via } },
    })),
    { ...cleanAudit, metadata: { vulnerabilities: { ...cleanAudit.metadata.vulnerabilities, high: '0' } } },
    { ...cleanAudit, metadata: { vulnerabilities: { ...cleanAudit.metadata.vulnerabilities, total: 1 } } },
  ])('invalid audit payload cannot become a clean inventory: %j', auditReport => {
    expect(() => validateNpmAuditReport(auditReport)).toThrow('Invalid npm audit');
    expect(() => buildInventory({ auditReport, lockData: { packages: { '': {} } } })).toThrow('Invalid npm audit');
  });
  test('accepts a complete clean npm audit report', () => {
    expect(validateNpmAuditReport(cleanAudit)).toBe(cleanAudit);
  });

  test.each([
    ['null', () => null], ['array', () => []], ['empty', () => ({})], ['partial', () => ({ severity: 'high' })],
    ['source', advisory => ({ ...advisory, source: 0 })], ['range', advisory => ({ ...advisory, range: '' })],
    ['url', advisory => ({ ...advisory, url: '' })], ['title', advisory => ({ ...advisory, title: '' })],
  ])(
    'malformed direct via cannot silently become an inherited-only finding: %s', (_label, invalidate) => {
      const advisory = { source: 1240992, dependency: 'braces', severity: 'high', title: 'Fixture advisory',
        url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm', range: '<=3.0.3' };
      const malformed = invalidate(advisory);
      const auditReport = { ...cleanAudit, vulnerabilities: {
        pkg: { severity: 'high', via: ['braces', malformed] },
        braces: { severity: 'high', via: [advisory] },
      }, metadata: { vulnerabilities: { ...cleanAudit.metadata.vulnerabilities, high: 2, total: 2 } } };
      expect(() => validateNpmAuditReport(auditReport)).toThrow('Invalid npm audit advisory');
      expect(() => buildInventory({ auditReport, lockData: { packages: { '': {} } } }))
        .toThrow('Invalid npm audit advisory');
    },
  );
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('classifyRuntimeExposure returns expected buckets', () => {
    expect(classifyRuntimeExposure({ runtime_count: 2, development_count: 0 })).toBe('runtime');
    expect(classifyRuntimeExposure({ runtime_count: 0, development_count: 3 })).toBe('development_only');
    expect(classifyRuntimeExposure({ runtime_count: 1, development_count: 1 })).toBe('mixed');
    expect(classifyRuntimeExposure({ runtime_count: 0, development_count: 0, unknown_count: 2 })).toBe('mixed');
    expect(classifyRuntimeExposure({ runtime_count: 0, development_count: 0 })).toBe('unknown');
  });

  test('normalizeFixAvailability and classifyPriority handle high-risk paths', () => {
    const majorFix = normalizeFixAvailability({
      name: 'expo',
      version: '55.0.0',
      isSemVerMajor: true,
    });
    expect(majorFix.kind).toBe('semver_major');
    expect(
      classifyPriority({
        severity: 'high',
        runtimeExposure: 'runtime',
        fixKind: majorFix.kind,
      }),
    ).toBe('P0');

    const noFix = normalizeFixAvailability(false);
    expect(
      classifyPriority({
        severity: 'high',
        runtimeExposure: 'development_only',
        fixKind: noFix.kind,
      }),
    ).toBe('P1');
  });

  test('repository lockfile surface decisions equal the canonical workspace manifests', () => {
    const repoRoot = path.join(__dirname, '..', '..', '..');
    const lockData = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    const workspaceCatalog = buildSurfaceCatalog(repoRoot);
    const lockCatalog = buildSurfaceCatalogFromLockData(lockData);
    const normalize = (catalog) => ({
      manifests: catalog.manifests,
      dependencies: [...catalog.dependencySurfaces.entries()]
        .map(([name, surfaces]) => [name, [...surfaces].sort()])
        .sort(([left], [right]) => left.localeCompare(right)),
    });

    expect(normalize(lockCatalog)).toEqual(normalize(workspaceCatalog));
  });

  test('buildInventory classifies groups, exposures, and priorities deterministically', () => {
    const repoRoot = createRepoFixture();
    tempDirs.push(repoRoot);

    const auditReport = {
      auditReportVersion: 2,
      vulnerabilities: {
        expo: {
          severity: 'high',
          isDirect: false,
          via: ['minimatch'],
          effects: ['expo'],
          range: '*',
          fixAvailable: {
            name: 'expo',
            version: '55.0.0',
            isSemVerMajor: true,
          },
        },
        eslint: {
          severity: 'high',
          isDirect: true,
          via: ['minimatch'],
          effects: [],
          range: '*',
          fixAvailable: {
            name: 'eslint',
            version: '10.0.0',
            isSemVerMajor: true,
          },
        },
        ajv: {
          severity: 'moderate',
          isDirect: false,
          via: [
            {
              source: 1113214,
              name: 'ajv',
              dependency: 'ajv',
              title: 'ajv has ReDoS',
              url: 'https://github.com/advisories/GHSA-2g4f-4pwh-qvx6',
              severity: 'moderate',
              cwe: ['CWE-400'],
              cvss: {
                score: 5.3,
                vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
              },
              range: '<8.18.0',
            },
          ],
          effects: ['eslint'],
          range: '<8.18.0',
          fixAvailable: {
            name: 'ajv',
            version: '8.18.0',
            isSemVerMajor: false,
          },
        },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 1,
          high: 2,
          critical: 0,
          total: 3,
        },
      },
    };

    const lockData = {
      name: 'repo-root',
      lockfileVersion: 3,
      packages: {
        '': { name: 'repo-root', devDependencies: { eslint: '^9.0.0' } },
        'apps/console': { name: 'console', dependencies: { next: '^16.0.0' } },
        'apps/fieldops': { name: 'fieldops', dependencies: { expo: '^54.0.0' } },
        'packages/shared': { name: '@masarx/shared', dependencies: { lodash: '^4.17.21' } },
        'node_modules/eslint': { name: 'eslint', dev: true },
        'node_modules/ajv': { name: 'ajv', dev: true },
        'apps/fieldops/node_modules/expo': { name: 'expo', dev: false },
      },
    };

    const workspaceCatalog = buildSurfaceCatalog(repoRoot);
    const lockCatalog = buildSurfaceCatalogFromLockData(lockData);
    expect(lockCatalog.manifests).toEqual(workspaceCatalog.manifests);
    expect(
      [...lockCatalog.dependencySurfaces.entries()]
        .map(([name, surfaces]) => [name, [...surfaces].sort()])
        .sort(([left], [right]) => left.localeCompare(right)),
    ).toEqual(
      [...workspaceCatalog.dependencySurfaces.entries()]
        .map(([name, surfaces]) => [name, [...surfaces].sort()])
        .sort(([left], [right]) => left.localeCompare(right)),
    );

    const inventory = buildInventory({
      auditReport,
      lockData,
      repoRoot,
      generatedAt: '2026-02-19T00:00:00.000Z',
      auditFile: path.join(repoRoot, 'docs', 'ops', 'evidence', '2026-02-19', 'production-readiness', 'npm-audit.json'),
      lockFile: path.join(repoRoot, 'package-lock.json'),
      signedOffBy: '@example-maintainer (worker wt-9202)',
    });

    expect(inventory.summary.vulnerabilities_total).toBe(3);
    expect(Array.isArray(inventory.methodology.references)).toBe(true);
    expect(inventory.methodology.references).toEqual(
      expect.arrayContaining(['https://docs.npmjs.com/cli/v11/commands/npm-audit']),
    );
    expect(inventory.summary.by_priority.P0).toBe(1);
    expect(inventory.summary.by_priority.P1).toBe(1);
    expect(inventory.summary.by_priority.P2).toBe(1);

    const expoFinding = inventory.findings.find((finding) => finding.package_name === 'expo');
    expect(expoFinding.runtime_exposure).toBe('runtime');
    expect(expoFinding.priority).toBe('P0');
    expect(expoFinding.package_groups).toEqual(expect.arrayContaining(['app:fieldops']));

    const eslintFinding = inventory.findings.find((finding) => finding.package_name === 'eslint');
    expect(eslintFinding.runtime_exposure).toBe('development_only');
    expect(eslintFinding.priority).toBe('P1');
    expect(eslintFinding.package_groups).toEqual(expect.arrayContaining(['tooling']));

    const ajvFinding = inventory.findings.find((finding) => finding.package_name === 'ajv');
    expect(ajvFinding.priority).toBe('P2');
    expect(ajvFinding.advisories).toHaveLength(1);

    const matrix = renderPriorityMatrix(inventory);
    expect(matrix).toContain('Signed-off-by: @example-maintainer (worker wt-9202)');
    expect(matrix).toContain('## Method Standards');
    expect(matrix).toContain('## P0');
    expect(matrix).toContain('| expo | high | runtime |');
  });

  test('buildInventory indexes root and nested node_modules lock paths for scoped packages', () => {
    const repoRoot = createRepoFixture();
    tempDirs.push(repoRoot);

    const auditReport = {
      auditReportVersion: 2,
      vulnerabilities: {
        '@expo/fingerprint': {
          severity: 'high',
          isDirect: false,
          via: ['minimatch'],
          effects: [],
          range: '*',
          fixAvailable: false,
          nodes: [
            'node_modules/@expo/fingerprint',
            'node_modules/expo/node_modules/@expo/fingerprint',
          ],
        },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 1,
          critical: 0,
          total: 1,
        },
      },
    };

    const lockData = {
      name: 'repo-root',
      lockfileVersion: 3,
      packages: {
        '': { name: 'repo-root' },
        'node_modules/@expo/fingerprint': { version: '0.1.4', dev: false },
        'node_modules/expo/node_modules/@expo/fingerprint': { version: '0.1.4', dev: false },
      },
    };

    const inventory = buildInventory({
      auditReport,
      lockData,
      repoRoot,
      generatedAt: '2026-02-23T00:00:00.000Z',
      auditFile: path.join(repoRoot, 'security-audit.json'),
      lockFile: path.join(repoRoot, 'package-lock.json'),
    });

    const finding = inventory.findings.find((item) => item.package_name === '@expo/fingerprint');
    expect(finding).toBeDefined();
    expect(finding.lock_stats.total_nodes).toBe(2);
    expect(finding.lock_stats.runtime_count).toBe(2);
    expect(finding.runtime_exposure).toBe('runtime');
    expect(finding.nodes).toEqual([
      {
        path: 'node_modules/@expo/fingerprint',
        version: '0.1.4',
        dev: false,
        optional: false,
      },
      {
        path: 'node_modules/expo/node_modules/@expo/fingerprint',
        version: '0.1.4',
        dev: false,
        optional: false,
      },
    ]);
  });

  test('buildInventory keeps only authoritative vulnerable lock paths', () => {
    const repoRoot = createRepoFixture();
    tempDirs.push(repoRoot);

    const auditReport = {
      auditReportVersion: 2,
      vulnerabilities: {
        'brace-expansion': {
          severity: 'high',
          via: ['brace-expansion'],
          nodes: [
            'node_modules/nx/node_modules/brace-expansion',
            'node_modules/metro/node_modules/brace-expansion',
          ],
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
    };
    const lockData = {
      packages: {
        '': { name: 'repo-root', devDependencies: { nx: '22.7.8' } },
        'node_modules/brace-expansion': { version: '2.1.4', dev: false },
        'node_modules/nx': { version: '22.7.8', dev: true },
        'node_modules/nx/node_modules/brace-expansion': { version: '5.0.8', dev: true },
        'node_modules/metro/node_modules/brace-expansion': { version: '5.0.8' },
      },
    };

    const inventory = buildInventory({
      auditReport,
      lockData,
      repoRoot,
    });

    const finding = inventory.findings.find((item) => item.package_name === 'brace-expansion');
    expect(finding.package_name).toBe('brace-expansion');
    expect(finding.runtime_exposure).toBe('mixed');
    expect(finding.lock_stats).toMatchObject({ total_nodes: 2, development_count: 1, runtime_count: 1 });
    expect(finding.nodes).toEqual([
      {
        path: 'node_modules/nx/node_modules/brace-expansion',
        version: '5.0.8',
        dev: true,
        optional: false,
      },
      {
        path: 'node_modules/metro/node_modules/brace-expansion',
        version: '5.0.8',
        dev: false,
        optional: false,
      },
    ]);
    auditReport.vulnerabilities['brace-expansion'].nodes.push('node_modules/unindexed/brace-expansion');
    expect(() => buildInventory({ auditReport, lockData, repoRoot }))
      .toThrow('Unresolved npm audit installed paths: brace-expansion');
  });
});
