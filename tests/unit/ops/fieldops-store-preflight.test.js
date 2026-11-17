const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFieldopsScenarioSet } = require('../../../scripts/qa/fieldops-ui-screenshot-scenarios');

jest.mock('../../../scripts/utils/load-env', () => ({
  loadEnv: jest.fn(),
}));

jest.mock('../../../scripts/utils/load-public-env', () => ({
  loadPublicEnv: jest.fn(),
}));

const { loadEnv } = require('../../../scripts/utils/load-env');
const { loadPublicEnv } = require('../../../scripts/utils/load-public-env');
const {
  DEFAULT_PREFLIGHT_PROFILE,
  NATIVE_SCREENSHOT_SUBDIR,
  REQUIRED_SELFTEST_CONTRACT_STEP_PREFIXES,
  SAMPLE_SCREENSHOT_SUBDIR,
  evaluateNativeScreenshotManifest,
  evaluateScreenshotManifest,
  isExpoVersionStable,
  loadEnvContract,
  parseArgs,
  resolveLatestNativeRuntimeManifest,
  resolveLatestScreenshotManifest,
  runFieldopsStorePreflight,
  writeReport,
} = require('../../../scripts/ops/fieldops-store-preflight');

function writeEnvContract(repoRoot) {
  const contractPath = path.join(
    repoRoot,
    'config',
    'ci',
    'mobile-fieldops-release-env-contract.json',
  );
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(
    contractPath,
    JSON.stringify(
      {
        contract_version: '2026-02-19',
        app: {
          slug: 'fieldops-eas',
        },
        sections: {
          'fieldops.build': {
            keys: [
              { key: 'NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS', aliases: [], sources: [] },
              { key: 'NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS', aliases: [], sources: [] },
              { key: 'NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS', aliases: [], sources: [] },
            ],
          },
          'fieldops.runtime': {
            keys: [
              {
                key: 'NEXT_PUBLIC_SUPABASE_URL',
                aliases: ['SUPABASE_URL'],
                sources: [],
              },
              {
                key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
                aliases: ['SUPABASE_ANON_KEY'],
                sources: [],
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
}

function createRepoFixture({
  expoVersion = '~55.0.28',
  manifest = null,
  nativeManifest = null,
  sampleManifest = null,
  dateDir = '2026-02-07',
  iosCss = null,
} = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldops-preflight-'));
  fs.mkdirSync(path.join(repoRoot, 'apps', 'fieldops'), { recursive: true });

  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ private: true }, null, 2));
  writeEnvContract(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, 'apps', 'fieldops', 'package.json'),
    JSON.stringify(
      {
        name: 'fieldops',
        dependencies: { expo: expoVersion },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(repoRoot, 'apps', 'fieldops', 'eas.json'),
    JSON.stringify(
      {
        build: {
          development: {
            developmentClient: true,
            env: { NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX: '.dev' },
            ios: { simulator: true },
          },
          stg: {
            env: { NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX: '.stg' },
          },
          production: {
            distribution: 'store',
            env: {},
          },
        },
        submit: {
          production: {},
        },
      },
      null,
      2,
    ),
  );

  const cssPath = path.join(repoRoot, 'docs', 'product', 'examples', 'mobile-field-ops-ui', 'app.css');
  fs.mkdirSync(path.dirname(cssPath), { recursive: true });
  fs.writeFileSync(
    cssPath,
    iosCss ||
      [
        '.device[data-platform="ios"]::after {',
        '  content: none;',
        '}',
        '.device[data-platform="ios"] .topbar {',
        '  padding-top: calc(var(--s-4) + env(safe-area-inset-top));',
        '}',
      ].join('\n'),
  );

  function writeManifest(manifestPayload, subdir) {
    if (!manifestPayload) return null;
    const defaultCaptureMode =
      subdir === NATIVE_SCREENSHOT_SUBDIR ? 'native_runtime' : 'sample_static';
    const normalizedManifest = {
      ...manifestPayload,
      captured_at: manifestPayload.captured_at || new Date().toISOString(),
      capture_mode: manifestPayload.capture_mode || defaultCaptureMode,
      scenarios: Array.isArray(manifestPayload.scenarios)
        ? manifestPayload.scenarios.map((entry) => {
            const name = String(entry?.name || '').trim();
            const fallbackFile = name ? `${name}.png` : '';
            return { ...entry, file: entry?.file ?? fallbackFile };
          })
        : [],
    };
    const manifestPath = path.join(
      repoRoot,
      'docs',
      'ops',
      'evidence',
      dateDir,
      'mobile-fieldops',
      subdir,
      'manifest.json',
    );
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(normalizedManifest, null, 2));
    for (const scenario of normalizedManifest.scenarios) {
      const fileName = String(scenario?.file || '').trim();
      if (!fileName) continue;
      fs.writeFileSync(path.join(path.dirname(manifestPath), fileName), 'png-placeholder');
    }
    return manifestPath;
  }

  const nativePayload = nativeManifest || manifest;
  const samplePayload = sampleManifest || manifest;
  writeManifest(nativePayload, NATIVE_SCREENSHOT_SUBDIR);
  writeManifest(samplePayload, SAMPLE_SCREENSHOT_SUBDIR);

  return repoRoot;
}

function setRequiredEnv() {
  process.env.NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS = 'com.masarx.fieldops';
  process.env.NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS = 'com.masarx.fieldops';
  process.env.NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS = '8b7b3e65-e22e-4ef7-949e-21c62f02506d';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
}

// Synthetic matrix/transport fixture, NOT an authentic native-app execution receipt.
function createStructurallyValidScreenshotManifest() {
  const scenarios = [
    ...createFieldopsScenarioSet('android'),
    ...createFieldopsScenarioSet('ios'),
  ].map((entry) => ({
    name: entry.name,
    file: `${entry.name}.png`,
    capture_source: entry.platform === 'android' ? 'adb' : 'simctl',
  }));
  const contractSteps = REQUIRED_SELFTEST_CONTRACT_STEP_PREFIXES.map((prefix) => `${prefix} verified`);
  return {
    captured_at: new Date().toISOString(),
    capture_mode: 'native_runtime',
    selftests: [
      { platform: 'android', status: 'pass', steps: contractSteps },
      { platform: 'ios', status: 'pass', steps: contractSteps },
    ],
    scenarios,
  };
}

describe('fieldops-store-preflight', () => {
  const originalEnv = process.env;
  const tempDirs = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.FIELDOPS_STORE_PREFLIGHT_PROFILE;
    delete process.env.FIELDOPS_NATIVE_SCREENSHOT_MANIFEST_PATH;
    delete process.env.FIELDOPS_SCREENSHOT_MAX_AGE_HOURS;
    loadEnv.mockReset();
    loadPublicEnv.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects stable vs non-stable expo versions', () => {
    expect(isExpoVersionStable('~55.0.28')).toBe(true);
    expect(isExpoVersionStable('~55.0.0-beta.0')).toBe(false);
    expect(isExpoVersionStable('')).toBe(false);
  });

  test('shared native manifest admission rejects missing, malformed, and prototype evidence', () => {
    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldops-native-missing-'));
    tempDirs.push(missingRoot);
    expect(evaluateNativeScreenshotManifest({ repoRoot: missingRoot }).summary.pass).toBe(false);

    const malformedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldops-native-malformed-'));
    tempDirs.push(malformedRoot);
    const malformedPath = path.join(malformedRoot, 'manifest.json');
    fs.writeFileSync(malformedPath, '{');
    expect(() => evaluateNativeScreenshotManifest({
      repoRoot: malformedRoot,
      manifestPath: malformedPath,
    })).toThrow();

    const prototypeRoot = createRepoFixture({
      nativeManifest: {
        ...createStructurallyValidScreenshotManifest(),
        capture_mode: 'device_browser_prototype',
      },
    });
    tempDirs.push(prototypeRoot);
    const prototype = evaluateNativeScreenshotManifest({ repoRoot: prototypeRoot, profile: 'ci' });
    expect(prototype.summary.pass).toBe(false);
    expect(prototype.checks).toContainEqual(expect.objectContaining({
      name: 'screenshots.native.manifest.not_known_prototype',
      pass: false,
      required: true,
    }));
  });

  test('shared native manifest admission keeps CI freshness advisory and release freshness strict', () => {
    const repoRoot = createRepoFixture({
      nativeManifest: {
        ...createStructurallyValidScreenshotManifest(),
        captured_at: '2026-01-01T00:00:00.000Z',
      },
    });
    tempDirs.push(repoRoot);
    const ci = evaluateNativeScreenshotManifest({ repoRoot, profile: 'ci' });
    const release = evaluateNativeScreenshotManifest({ repoRoot, profile: 'release' });
    expect(ci.summary.pass).toBe(true);
    expect(ci.checks).toContainEqual(expect.objectContaining({
      name: 'screenshots.native.manifest.freshness', pass: false, required: false,
    }));
    expect(release.summary.pass).toBe(false);
    expect(release.checks).toContainEqual(expect.objectContaining({
      name: 'screenshots.native.manifest.freshness', pass: false, required: true,
    }));
  });

  test('convergence profile defers native evidence without making it release eligible', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldops-native-deferred-'));
    tempDirs.push(repoRoot);
    const result = evaluateNativeScreenshotManifest({
      repoRoot, profile: 'convergence', env: { FIELDOPS_NATIVE_ACCEPTANCE_DEFERRED: '1' },
    });
    expect(result).toMatchObject({
      profile: 'convergence',
      native_evidence_status: 'deferred',
      native_release_eligible: false,
      summary: { pass: true, failed_required: 0, failed_advisory: 1 },
    });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'screenshots.native.acceptance', pass: false, required: false,
    }));
    expect(parseArgs(['--profile', 'convergence']).profile).toBe('convergence');
  });

  test('convergence profile requires the explicit capability and rejects deploy environments', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldops-native-scope-'));
    tempDirs.push(repoRoot);
    expect(() => evaluateNativeScreenshotManifest({
      repoRoot, profile: 'convergence', env: { GITHUB_ACTIONS: 'true' },
    })).toThrow('FIELDOPS_NATIVE_ACCEPTANCE_DEFERRED=1');
    expect(() => evaluateNativeScreenshotManifest({
      repoRoot, profile: 'convergence', env: {
        FIELDOPS_NATIVE_ACCEPTANCE_DEFERRED: '1', TARGET_DEPLOY_ENV: 'prod',
      },
    })).toThrow('cannot be used by deploy environments');
    expect(evaluateNativeScreenshotManifest({
      repoRoot, profile: 'convergence', env: {
        FIELDOPS_NATIVE_ACCEPTANCE_DEFERRED: '1', GITHUB_ACTIONS: 'true',
      },
    }).native_evidence_status).toBe('deferred');
  });

  test('non-strict reports cannot claim native release eligibility', () => {
    const repoRoot = createRepoFixture({
      nativeManifest: createStructurallyValidScreenshotManifest(),
    });
    tempDirs.push(repoRoot);
    const report = runFieldopsStorePreflight({ repoRoot, profile: 'release', strict: false });
    expect(report.native_release_eligible).toBe(false);
  });

  test('convergence defers only native acceptance and keeps non-native checks required', () => {
    const repoRoot = createRepoFixture();
    tempDirs.push(repoRoot);
    for (const entry of loadEnvContract(repoRoot, []).buildKeys) {
      for (const key of [entry.key, ...entry.aliases]) {
        delete process.env[key];
      }
    }
    process.env.FIELDOPS_STORE_PREFLIGHT_PROFILE = 'convergence';
    process.env.FIELDOPS_NATIVE_ACCEPTANCE_DEFERRED = '1';
    const report = runFieldopsStorePreflight({ repoRoot, profile: 'convergence' });
    expect(report.native_evidence_status).toBe('deferred');
    expect(report.summary.pass).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'screenshots.native.acceptance', pass: false, required: false }),
      expect.objectContaining({ name: 'fieldops.build.required_env', pass: false, required: true }),
    ]));
  });

  test('resolveLatestScreenshotManifest picks newest evidence date', () => {
    const repoRoot = createRepoFixture();
    tempDirs.push(repoRoot);

    const oldManifest = path.join(
      repoRoot,
      'docs',
      'ops',
      'evidence',
      '2026-02-01',
      'mobile-fieldops',
      SAMPLE_SCREENSHOT_SUBDIR,
      'manifest.json',
    );
    const newManifest = path.join(
      repoRoot,
      'docs',
      'ops',
      'evidence',
      '2026-02-07',
      'mobile-fieldops',
      SAMPLE_SCREENSHOT_SUBDIR,
      'manifest.json',
    );
    fs.mkdirSync(path.dirname(oldManifest), { recursive: true });
    fs.mkdirSync(path.dirname(newManifest), { recursive: true });
    fs.writeFileSync(oldManifest, '{}');
    fs.writeFileSync(newManifest, '{}');

    expect(resolveLatestScreenshotManifest(repoRoot)).toBe(newManifest);
  });

  test('resolveLatestNativeRuntimeManifest picks newest native evidence date', () => {
    const repoRoot = createRepoFixture();
    tempDirs.push(repoRoot);

    const oldManifest = path.join(
      repoRoot,
      'docs',
      'ops',
      'evidence',
      '2026-02-01',
      'mobile-fieldops',
      NATIVE_SCREENSHOT_SUBDIR,
      'manifest.json',
    );
    const newManifest = path.join(
      repoRoot,
      'docs',
      'ops',
      'evidence',
      '2026-02-07',
      'mobile-fieldops',
      NATIVE_SCREENSHOT_SUBDIR,
      'manifest.json',
    );
    fs.mkdirSync(path.dirname(oldManifest), { recursive: true });
    fs.mkdirSync(path.dirname(newManifest), { recursive: true });
    fs.writeFileSync(oldManifest, '{}');
    fs.writeFileSync(newManifest, '{}');

    expect(resolveLatestNativeRuntimeManifest(repoRoot)).toBe(newManifest);
  });

  test('loadEnvContract reads configured build/runtime keys', () => {
    const repoRoot = createRepoFixture();
    tempDirs.push(repoRoot);
    const checks = [];

    const contract = loadEnvContract(repoRoot, checks);

    expect(contract.valid).toBe(true);
    expect(contract.buildKeys).toHaveLength(3);
    expect(contract.runtimeKeys).toHaveLength(2);
    expect(checks.find((check) => check.name === 'fieldops.env_contract.exists')?.pass).toBe(true);
  });

  test('evaluateScreenshotManifest enforces android and ios selftests', () => {
    const checks = [];
    evaluateScreenshotManifest(
      {
        selftests: [{ platform: 'android', status: 'pass' }],
        scenarios: createFieldopsScenarioSet('android').map((entry) => ({ name: entry.name })),
      },
      checks,
    );

    const iosSelftest = checks.find((check) => check.name === 'screenshots.selftest.ios');
    const platformsCoverage = checks.find(
      (check) => check.name === 'screenshots.scenarios.android_ios',
    );
    const iosMatrixCoverage = checks.find(
      (check) => check.name === 'screenshots.scenarios.coverage.ios',
    );
    const iosContract = checks.find(
      (check) => check.name === 'screenshots.selftest.contract.ios',
    );

    expect(iosSelftest?.pass).toBe(false);
    expect(platformsCoverage?.pass).toBe(false);
    expect(iosMatrixCoverage?.pass).toBe(false);
    expect(iosContract?.pass).toBe(false);
  });

  test('evaluateScreenshotManifest enforces contract selftest steps', () => {
    const checks = [];
    evaluateScreenshotManifest(
      {
        selftests: [
          { platform: 'android', status: 'pass', steps: ['OK - Header contract'] },
          { platform: 'ios', status: 'pass', steps: ['OK - Header contract', 'OK - Drawer contract'] },
        ],
        scenarios: [
          ...createFieldopsScenarioSet('android'),
          ...createFieldopsScenarioSet('ios'),
        ].map((entry) => ({ name: entry.name })),
      },
      checks,
    );
    const androidContract = checks.find(
      (check) => check.name === 'screenshots.selftest.contract.android',
    );
    const iosContract = checks.find(
      (check) => check.name === 'screenshots.selftest.contract.ios',
    );
    expect(androidContract?.pass).toBe(false);
    expect(iosContract?.pass).toBe(true);
  });

  test('runFieldopsStorePreflight passes in strict mode when fixture is valid', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
      profile: DEFAULT_PREFLIGHT_PROFILE,
    });

    expect(report.summary.pass).toBe(true);
    expect(report.profile).toBe(DEFAULT_PREFLIGHT_PROFILE);
    expect(report.summary.failed_required).toBe(0);
    expect(report.checks.find((check) => check.name === 'screenshots.native.selftest.android')?.pass).toBe(
      true,
    );
    expect(report.checks.find((check) => check.name === 'screenshots.native.selftest.ios')?.pass).toBe(
      true,
    );
    expect(
      report.checks.find((check) => check.name === 'screenshots.ios.no_synthetic_notch_overlay')
        ?.pass,
    ).toBe(true);
    expect(
      report.checks.find((check) => check.name === 'screenshots.ios.safe_area_topbar_spacing')?.pass,
    ).toBe(true);
    expect(
      report.checks.find((check) => check.name === 'screenshots.native.scenarios.matrix_complete')?.pass,
    ).toBe(true);
    expect(report.checks.find((check) => check.name === 'eas.profile.suffix.stg')?.pass).toBe(true);
    expect(report.checks.find((check) => check.name === 'eas.profile.preview.removed')?.pass).toBe(true);
    expect(report.checks.find((check) => check.name === 'screenshots.sample.manifest.exists')?.required).toBe(
      false,
    );
  });

  test('canonical EAS development profile is a simulator development client', () => {
    const easConfig = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../apps/fieldops/eas.json'), 'utf8'),
    );
    const fieldopsManifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../apps/fieldops/package.json'), 'utf8'),
    );

    expect(easConfig.build.development).toMatchObject({
      developmentClient: true,
      distribution: 'internal',
      ios: { simulator: true },
    });
    expect(fieldopsManifest.dependencies['expo-dev-client']).toBe('~55.0.37');
  });

  test('runFieldopsStorePreflight fails strict mode when the legacy preview profile returns', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();

    const easConfigPath = path.join(repoRoot, 'apps', 'fieldops', 'eas.json');
    const easConfig = JSON.parse(fs.readFileSync(easConfigPath, 'utf8'));
    easConfig.build.preview = {
      env: { NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX: '.preview' },
    };
    fs.writeFileSync(easConfigPath, JSON.stringify(easConfig, null, 2));

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
    });

    expect(report.summary.pass).toBe(false);
    expect(report.checks.find((check) => check.name === 'eas.profile.preview.removed')?.pass).toBe(
      false,
    );
  });

  test('runFieldopsStorePreflight downgrades failures to advisory when strict is off', () => {
    const manifest = {
      selftests: [{ platform: 'android', status: 'pass' }],
      scenarios: createFieldopsScenarioSet('android').map((entry) => ({ name: entry.name })),
    };
    const repoRoot = createRepoFixture({ expoVersion: '~55.0.0-beta.0', manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: false,
    });

    expect(report.summary.pass).toBe(true);
    expect(report.summary.failed_required).toBe(0);
    expect(report.summary.failed_advisory).toBeGreaterThan(0);
  });

  test('runFieldopsStorePreflight accepts runtime alias keys defined by env contract', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
    });

    expect(report.summary.pass).toBe(true);
    expect(report.checks.find((check) => check.name === 'fieldops.runtime.required_env')?.pass).toBe(
      true,
    );
  });

  test('runFieldopsStorePreflight fails strict mode when env contract file is missing', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();
    fs.rmSync(
      path.join(repoRoot, 'config', 'ci', 'mobile-fieldops-release-env-contract.json'),
      { force: true },
    );

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
    });

    expect(report.summary.pass).toBe(false);
    expect(report.checks.find((check) => check.name === 'fieldops.env_contract.exists')?.pass).toBe(
      false,
    );
  });

  test('runFieldopsStorePreflight fails strict mode for synthetic iOS notch overlay styles', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    const repoRoot = createRepoFixture({
      manifest,
      iosCss: [
        '.device[data-platform="ios"]::after {',
        '  content: "";',
        '  position: absolute;',
        '  inset: 0;',
        '}',
        '.device[data-platform="ios"] .topbar {',
        '  padding-top: calc(var(--s-4) + env(safe-area-inset-top));',
        '}',
      ].join('\n'),
    });
    tempDirs.push(repoRoot);
    setRequiredEnv();

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
    });

    expect(report.summary.pass).toBe(false);
    expect(
      report.checks.find((check) => check.name === 'screenshots.ios.no_synthetic_notch_overlay')
        ?.pass,
    ).toBe(false);
  });

  test('runFieldopsStorePreflight fails strict mode when native screenshot matrix is incomplete', () => {
    const incompleteManifest = createStructurallyValidScreenshotManifest();
    incompleteManifest.scenarios = incompleteManifest.scenarios.filter(
      (entry) => entry.name !== 'C-ios-route-overview',
    );
    const repoRoot = createRepoFixture({ manifest: incompleteManifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
    });

    expect(report.summary.pass).toBe(false);
    expect(
      report.checks.find((check) => check.name === 'screenshots.native.scenarios.coverage.ios')?.pass,
    ).toBe(false);
    expect(
      report.checks.find((check) => check.name === 'screenshots.native.scenarios.matrix_complete')?.pass,
    ).toBe(false);
  });

  test.each(['mode', 'selftest', 'scenario', 'encoded'])('rejects known prototype evidence despite native transport: %s', marker => {
    const manifest = createStructurallyValidScreenshotManifest();
    if (marker === 'mode') manifest.capture_mode = 'device_browser_prototype';
    else if (marker === 'selftest') manifest.selftests[0].url = 'http://127.0.0.1/version-c.html?selftest=true';
    else manifest.scenarios[0].url = marker === 'encoded'
      ? 'http://127.0.0.1/version-c%2ehtml?capture=true' : 'http://127.0.0.1/version-c.html?capture=true';
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot); setRequiredEnv();
    const report = runFieldopsStorePreflight({ repoRoot, strict: true });
    expect(report.summary.pass).toBe(false);
    expect(report.checks.find(check => check.name === 'screenshots.native.manifest.not_known_prototype')?.pass).toBe(false);
    expect(report.checks.find(check => check.name === 'screenshots.native.scenarios.coverage.ios')).toBeDefined();
    expect(report.checks.find(check => check.name === 'screenshots.native.scenarios.coverage.android')).toBeDefined();
  });

  test('runFieldopsStorePreflight fails strict mode when native manifest capture_mode is invalid', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    manifest.capture_mode = 'sample_static';
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
    });

    expect(report.summary.pass).toBe(false);
    expect(
      report.checks.find((check) => check.name === 'screenshots.native.manifest.capture_mode')?.pass,
    ).toBe(false);
  });

  test('runFieldopsStorePreflight fails strict mode when expected native screenshot file is missing', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();

    const missingFile = path.join(
      repoRoot,
      'docs',
      'ops',
      'evidence',
      '2026-02-07',
      'mobile-fieldops',
      NATIVE_SCREENSHOT_SUBDIR,
      'C-ios-task-detail.png',
    );
    fs.rmSync(missingFile, { force: true });

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
    });

    expect(report.summary.pass).toBe(false);
    expect(
      report.checks.find((check) => check.name === 'screenshots.native.scenarios.files_exist')?.pass,
    ).toBe(false);
  });

  test('runFieldopsStorePreflight fails strict mode when native screenshot evidence is stale', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    manifest.captured_at = '2020-01-01T00:00:00.000Z';
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
      profile: DEFAULT_PREFLIGHT_PROFILE,
      maxScreenshotAgeHours: 24,
    });

    expect(report.summary.pass).toBe(false);
    expect(
      report.checks.find((check) => check.name === 'screenshots.native.manifest.freshness')?.pass,
    ).toBe(false);
  });

  test('loads canonical Expo slug from the FieldOps release contract', () => {
    const repoRoot = createRepoFixture();
    tempDirs.push(repoRoot);

    const checks = [];
    const contract = loadEnvContract(repoRoot, checks);

    expect(contract.appSlug).toBe('fieldops-eas');
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'fieldops.app.slug',
          pass: true,
        }),
      ]),
    );
  });

  test('runFieldopsStorePreflight keeps native screenshot freshness advisory in ci profile', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    manifest.captured_at = '2020-01-01T00:00:00.000Z';
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
      profile: 'ci',
      maxScreenshotAgeHours: 24,
    });

    expect(report.profile).toBe('ci');
    expect(report.summary.pass).toBe(true);
    const freshnessCheck = report.checks.find(
      (check) => check.name === 'screenshots.native.manifest.freshness',
    );
    expect(freshnessCheck?.pass).toBe(false);
    expect(freshnessCheck?.required).toBe(false);
  });

  test('runFieldopsStorePreflight resolves profile from env when explicit profile is absent', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    manifest.captured_at = '2020-01-01T00:00:00.000Z';
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();
    process.env.FIELDOPS_STORE_PREFLIGHT_PROFILE = 'ci';

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
      maxScreenshotAgeHours: 24,
    });

    expect(report.profile).toBe('ci');
    expect(report.summary.pass).toBe(true);
    expect(
      report.checks.find((check) => check.name === 'screenshots.native.manifest.freshness')?.required,
    ).toBe(false);
  });

  test('runFieldopsStorePreflight honors ci profile loaded from ENV_FILE before freshness evaluation', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    manifest.captured_at = '2020-01-01T00:00:00.000Z';
    const repoRoot = createRepoFixture({ manifest });
    tempDirs.push(repoRoot);
    setRequiredEnv();
    delete process.env.FIELDOPS_STORE_PREFLIGHT_PROFILE;
    loadEnv.mockImplementation(() => {
      process.env.FIELDOPS_STORE_PREFLIGHT_PROFILE = 'ci';
    });

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
      maxScreenshotAgeHours: 24,
    });

    expect(report.profile).toBe('ci');
    expect(report.summary.pass).toBe(true);
    expect(
      report.checks.find((check) => check.name === 'screenshots.native.manifest.freshness')?.required,
    ).toBe(false);
  });

  test('runFieldopsStorePreflight fails strict mode when native manifest is missing', () => {
    const manifest = createStructurallyValidScreenshotManifest();
    const repoRoot = createRepoFixture({ sampleManifest: manifest, nativeManifest: null });
    tempDirs.push(repoRoot);
    setRequiredEnv();

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
    });

    expect(report.summary.pass).toBe(false);
    expect(report.checks.find((check) => check.name === 'screenshots.native.manifest.exists')?.pass).toBe(
      false,
    );
    expect(report.checks.find((check) => check.name === 'screenshots.sample.manifest.exists')?.pass).toBe(
      true,
    );
  });

  test('sample screenshot evidence is advisory only', () => {
    const nativeManifest = createStructurallyValidScreenshotManifest();
    const repoRoot = createRepoFixture({ nativeManifest, sampleManifest: null });
    tempDirs.push(repoRoot);
    setRequiredEnv();

    const report = runFieldopsStorePreflight({
      repoRoot,
      strict: true,
    });

    expect(report.summary.pass).toBe(true);
    const sampleCheck = report.checks.find((check) => check.name === 'screenshots.sample.manifest.exists');
    expect(sampleCheck?.pass).toBe(false);
    expect(sampleCheck?.required).toBe(false);
  });

  test('writeReport persists JSON output', () => {
    const repoRoot = createRepoFixture();
    tempDirs.push(repoRoot);
    const outputPath = path.join(repoRoot, 'docs', 'ops', 'evidence', 'report.json');
    const report = { summary: { pass: true } };

    const writtenPath = writeReport(report, outputPath);
    const written = JSON.parse(fs.readFileSync(writtenPath, 'utf8'));

    expect(written).toEqual(report);
  });
});
