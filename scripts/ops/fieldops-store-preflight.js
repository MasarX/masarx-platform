const fs = require('fs');
const path = require('path');
const {
  loadFieldopsReleaseContract,
  resolveFieldopsAppSlug,
} = require('./fieldops-release-contract');
const { loadEnv } = require('../utils/load-env');
const { loadPublicEnv } = require('../utils/load-public-env');
const { createFieldopsScenarioSet } = require('../qa/fieldops-ui-screenshot-scenarios');

const ENV_CONTRACT_RELATIVE_PATH = path.join(
  'config',
  'ci',
  'mobile-fieldops-release-env-contract.json',
);
const REQUIRED_BUILD_ENV_KEYS = Object.freeze([
  'NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS',
  'NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS',
  'NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS',
]);
const LEGACY_SCENARIO_NAME_ALIASES = Object.freeze({
  'C-android-route-overview': Object.freeze(['C-android-route-map']),
  'C-ios-route-overview': Object.freeze(['C-ios-route-map']),
  'C-android-more-operations': Object.freeze(['C-android-more']),
  'C-ios-more-operations': Object.freeze(['C-ios-more']),
});

const REQUIRED_RUNTIME_ENV_KEYS = Object.freeze([
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
]);

const REQUIRED_SELFTEST_PLATFORMS = Object.freeze(['android', 'ios']);
const REQUIRED_SELFTEST_CONTRACT_STEP_PREFIXES = Object.freeze([
  'OK - Header contract',
  'OK - Drawer contract',
]);
const NATIVE_SCREENSHOT_SUBDIR = 'ui-screenshots-native-runtime';
const SAMPLE_SCREENSHOT_SUBDIR = 'ui-screenshots-version-c';

const UUID_V4_OR_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IOS_BUNDLE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const ANDROID_PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const NON_STABLE_EXPO_TAG_RE = /(alpha|beta|canary|next|preview|rc)/i;
const DEFAULT_SCREENSHOT_MAX_AGE_HOURS = 24 * 7;
const DEFAULT_PREFLIGHT_PROFILE = 'release';
const ALLOWED_PREFLIGHT_PROFILES = Object.freeze(['release', 'ci']);

function resolveRepoRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'apps', 'fieldops'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir || process.cwd());
    current = parent;
  }
}

function parseArgs(argv) {
  const options = {
    strict: true,
    repoRoot: resolveRepoRoot(process.cwd()),
    outputPath: null,
    manifestPath: null,
    nativeManifestPath: null,
    sampleManifestPath: null,
    maxScreenshotAgeHours: null,
    profile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '').trim();
    if (!arg) continue;
    if (arg === '--no-strict') {
      options.strict = false;
      continue;
    }
    if (arg === '--strict') {
      options.strict = true;
      continue;
    }
    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --output');
      options.outputPath = path.resolve(options.repoRoot, String(value));
      index += 1;
      continue;
    }
    if (arg === '--manifest') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --manifest');
      options.manifestPath = path.resolve(options.repoRoot, String(value));
      index += 1;
      continue;
    }
    if (arg === '--native-manifest') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --native-manifest');
      options.nativeManifestPath = path.resolve(options.repoRoot, String(value));
      index += 1;
      continue;
    }
    if (arg === '--sample-manifest') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --sample-manifest');
      options.sampleManifestPath = path.resolve(options.repoRoot, String(value));
      index += 1;
      continue;
    }
    if (arg === '--max-screenshot-age-hours') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --max-screenshot-age-hours');
      const parsed = Number.parseInt(String(value), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --max-screenshot-age-hours value: ${value}`);
      }
      options.maxScreenshotAgeHours = parsed;
      index += 1;
      continue;
    }
    if (arg === '--profile') {
      const value = normalizeEnvValue(argv[index + 1]).toLowerCase();
      if (!value) throw new Error('Missing value for --profile');
      if (!ALLOWED_PREFLIGHT_PROFILES.includes(value)) {
        throw new Error(`Invalid --profile value: ${value}`);
      }
      options.profile = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function formatDateYmd(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveDefaultOutputPath(repoRoot, date = new Date()) {
  return path.join(
    repoRoot,
    'docs',
    'ops',
    'evidence',
    formatDateYmd(date),
    'mobile-fieldops',
    'store-release-preflight.json',
  );
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeEnvValue(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function resolveScenarioAliasNames(expectedName) {
  return LEGACY_SCENARIO_NAME_ALIASES[expectedName] || [];
}

function findScenarioMatch(scenariosByName, expectedName) {
  if (scenariosByName.has(expectedName)) {
    return {
      matchedName: expectedName,
      scenario: scenariosByName.get(expectedName),
    };
  }
  for (const aliasName of resolveScenarioAliasNames(expectedName)) {
    if (!scenariosByName.has(aliasName)) continue;
    return {
      matchedName: aliasName,
      scenario: scenariosByName.get(aliasName),
    };
  }
  return {
    matchedName: null,
    scenario: null,
  };
}

function isExpoVersionStable(version) {
  const value = normalizeEnvValue(version);
  if (!value) return false;
  return !NON_STABLE_EXPO_TAG_RE.test(value);
}

function ensureCheck(checks, name, pass, details, required = true) {
  checks.push({
    name,
    pass: Boolean(pass),
    required: Boolean(required),
    details: String(details || ''),
  });
}

function normalizeEnvContractEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const key = normalizeEnvValue(entry.key);
  if (!key) return null;
  const aliases = Array.isArray(entry.aliases)
    ? entry.aliases.map((value) => normalizeEnvValue(value)).filter(Boolean)
    : [];
  const sources = Array.isArray(entry.sources)
    ? entry.sources.map((value) => normalizeEnvValue(value)).filter(Boolean)
    : [];
  return {
    key,
    aliases,
    sources,
  };
}

function normalizeEnvContractSection(section, fallbackKeys = []) {
  const keys = Array.isArray(section?.keys)
    ? section.keys
        .map((entry) => normalizeEnvContractEntry(entry))
        .filter(Boolean)
    : [];
  if (keys.length > 0) return keys;
  return fallbackKeys.map((key) => ({
    key,
    aliases: [],
    sources: [],
  }));
}

function loadEnvContract(repoRoot, checks) {
  const contractLoad = loadFieldopsReleaseContract(repoRoot);
  const contractPath = contractLoad.contractPath;
  if (contractLoad.error && !contractLoad.contract) {
    ensureCheck(
      checks,
      'fieldops.env_contract.exists',
      false,
      `Missing ${ENV_CONTRACT_RELATIVE_PATH}; required to define FieldOps release env matrix.`,
    );
    return {
      path: contractPath,
      buildKeys: normalizeEnvContractSection(null, REQUIRED_BUILD_ENV_KEYS),
      runtimeKeys: normalizeEnvContractSection(null, REQUIRED_RUNTIME_ENV_KEYS),
      appSlug: '',
      valid: false,
    };
  }

  const contract = contractLoad.contract;
  if (!contract) {
    ensureCheck(
      checks,
      'fieldops.env_contract.parse',
      false,
      `Invalid JSON at ${ENV_CONTRACT_RELATIVE_PATH}: ${contractLoad.error.message}`,
    );
    return {
      path: contractPath,
      buildKeys: normalizeEnvContractSection(null, REQUIRED_BUILD_ENV_KEYS),
      runtimeKeys: normalizeEnvContractSection(null, REQUIRED_RUNTIME_ENV_KEYS),
      appSlug: '',
      valid: false,
    };
  }

  const buildSection = contract?.sections?.['fieldops.build'];
  const runtimeSection = contract?.sections?.['fieldops.runtime'];
  const buildKeys = normalizeEnvContractSection(buildSection, REQUIRED_BUILD_ENV_KEYS);
  const runtimeKeys = normalizeEnvContractSection(runtimeSection, REQUIRED_RUNTIME_ENV_KEYS);
  const appSlug = resolveFieldopsAppSlug(contract);
  const valid = buildKeys.length > 0 && runtimeKeys.length > 0;

  ensureCheck(
    checks,
    'fieldops.env_contract.exists',
    true,
    `Loaded ${ENV_CONTRACT_RELATIVE_PATH}`,
  );
  ensureCheck(
    checks,
    'fieldops.env_contract.sections',
    valid,
    valid
      ? `build_keys=${buildKeys.length} runtime_keys=${runtimeKeys.length}`
      : `Contract must define non-empty sections for fieldops.build and fieldops.runtime in ${ENV_CONTRACT_RELATIVE_PATH}.`,
  );
  ensureCheck(
    checks,
    'fieldops.app.slug',
    Boolean(appSlug),
    appSlug
      ? `Canonical FieldOps Expo slug: ${appSlug}`
      : `Contract must define non-empty app.slug in ${ENV_CONTRACT_RELATIVE_PATH}.`,
  );

  return {
    path: contractPath,
    buildKeys,
    runtimeKeys,
    appSlug,
    valid,
  };
}

function validateRequiredEnv(checks, env, contractEntries, label) {
  const missing = [];
  for (const entry of contractEntries) {
    const candidateKeys = [entry.key, ...entry.aliases];
    const present = candidateKeys.some((candidate) => normalizeEnvValue(env[candidate]));
    if (!present) missing.push(entry);
  }

  const formatMissingEntry = (entry) => {
    const aliasSegment =
      entry.aliases.length > 0 ? ` (or ${entry.aliases.join(', ')})` : '';
    const sourceSegment =
      entry.sources.length > 0 ? ` | sources: ${entry.sources.join(' | ')}` : '';
    return `${entry.key}${aliasSegment}${sourceSegment}`;
  };

  ensureCheck(
    checks,
    `${label}.required_env`,
    missing.length === 0,
    missing.length
      ? `Missing required env vars: ${missing.map((entry) => formatMissingEntry(entry)).join(' ; ')}`
      : `All required ${label} env vars are present.`,
  );
}

function validateEnvFormats(checks, env) {
  const iosBundle = normalizeEnvValue(env.NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS);
  const androidPackage = normalizeEnvValue(env.NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS);
  const easProjectId = normalizeEnvValue(env.NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS);

  ensureCheck(
    checks,
    'fieldops.ios_bundle_identifier.format',
    !iosBundle || IOS_BUNDLE_RE.test(iosBundle),
    iosBundle
      ? `NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS=${iosBundle}`
      : 'Skipped format check because value is missing.',
  );
  ensureCheck(
    checks,
    'fieldops.android_package.format',
    !androidPackage || ANDROID_PACKAGE_RE.test(androidPackage),
    androidPackage
      ? `NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS=${androidPackage}`
      : 'Skipped format check because value is missing.',
  );
  ensureCheck(
    checks,
    'fieldops.eas_project_id.format',
    !easProjectId || UUID_V4_OR_V5_RE.test(easProjectId),
    easProjectId
      ? `NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS=${easProjectId}`
      : 'Skipped format check because value is missing.',
  );
}

function validateEasConfig(checks, easConfigPath) {
  if (!fs.existsSync(easConfigPath)) {
    ensureCheck(checks, 'eas.config.exists', false, `Missing ${easConfigPath}`);
    return null;
  }

  const easConfig = readJson(easConfigPath);
  ensureCheck(checks, 'eas.config.exists', true, `Found ${easConfigPath}`);

  const productionBuild = easConfig?.build?.production || {};
  const productionSubmit = easConfig?.submit?.production;
  const developmentBuild = easConfig?.build?.development || {};
  const stgBuild = easConfig?.build?.stg || {};
  const hasLegacyPreviewProfile = Object.prototype.hasOwnProperty.call(easConfig?.build || {}, 'preview');

  ensureCheck(
    checks,
    'eas.build.production.distribution',
    productionBuild.distribution === 'store',
    `Expected store, got ${JSON.stringify(productionBuild.distribution || null)}`,
  );
  ensureCheck(
    checks,
    'eas.submit.production.exists',
    Boolean(productionSubmit && typeof productionSubmit === 'object'),
    productionSubmit && typeof productionSubmit === 'object'
      ? 'Found submit.production profile.'
      : 'Missing submit.production profile.',
  );
  ensureCheck(
    checks,
    'eas.profile.suffix.development',
    normalizeEnvValue(developmentBuild?.env?.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX) === '.dev',
    `Expected .dev, got ${JSON.stringify(developmentBuild?.env?.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX || null)}`,
  );
  ensureCheck(
    checks,
    'eas.profile.suffix.stg',
    normalizeEnvValue(stgBuild?.env?.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX) === '.stg',
    `Expected .stg, got ${JSON.stringify(stgBuild?.env?.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX || null)}`,
  );
  ensureCheck(
    checks,
    'eas.profile.preview.removed',
    !hasLegacyPreviewProfile,
    hasLegacyPreviewProfile
      ? 'Legacy preview profile must stay removed; use build.stg for the canonical internal staging release lane.'
      : 'Legacy preview profile is removed.',
  );
  ensureCheck(
    checks,
    'eas.profile.suffix.production',
    typeof productionBuild?.env?.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX === 'undefined',
    typeof productionBuild?.env?.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX === 'undefined'
      ? 'OK: production profile does not set NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX (no suffix).'
      : `Expected unset suffix, got ${JSON.stringify(productionBuild?.env?.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX || null)}`,
  );

  return easConfig;
}

function resolveLatestManifestBySubdir(repoRoot, screenshotSubdir) {
  const evidenceRoot = path.join(repoRoot, 'docs', 'ops', 'evidence');
  if (!fs.existsSync(evidenceRoot)) return null;
  const dateDirs = fs
    .readdirSync(evidenceRoot)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .reverse();
  for (const dateDir of dateDirs) {
    const manifestPath = path.join(
      evidenceRoot,
      dateDir,
      'mobile-fieldops',
      screenshotSubdir,
      'manifest.json',
    );
    if (fs.existsSync(manifestPath)) return manifestPath;
  }
  return null;
}

function resolveLatestScreenshotManifest(repoRoot) {
  return resolveLatestManifestBySubdir(repoRoot, SAMPLE_SCREENSHOT_SUBDIR);
}

function resolveLatestNativeRuntimeManifest(repoRoot) {
  return resolveLatestManifestBySubdir(repoRoot, NATIVE_SCREENSHOT_SUBDIR);
}

function evaluateScreenshotManifest(manifest, checks, options = {}) {
  const manifestDir = normalizeEnvValue(options.manifestDir) ? path.resolve(options.manifestDir) : null;
  const maxScreenshotAgeHours = Number.isFinite(options.maxScreenshotAgeHours)
    ? Number(options.maxScreenshotAgeHours)
    : DEFAULT_SCREENSHOT_MAX_AGE_HOURS;
  const checkPrefix = normalizeEnvValue(options.checkPrefix) || 'screenshots';
  const required = options.required !== false;
  const freshnessRequired = options.freshnessRequired !== false && required;
  const expectedCaptureMode = normalizeEnvValue(options.expectedCaptureMode).toLowerCase();
  const expectedCaptureSources = Array.isArray(options.expectedCaptureSources)
    ? options.expectedCaptureSources
        .map((value) => normalizeEnvValue(value).toLowerCase())
        .filter(Boolean)
    : [];

  const capturedAtRaw = normalizeEnvValue(manifest?.captured_at);
  const capturedAtMs = capturedAtRaw ? Date.parse(capturedAtRaw) : Number.NaN;
  const maxAgeMs = maxScreenshotAgeHours * 60 * 60 * 1000;
  const ageMs = Number.isFinite(capturedAtMs) ? Date.now() - capturedAtMs : Number.NaN;
  const isFresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
  ensureCheck(
    checks,
    `${checkPrefix}.manifest.freshness`,
    isFresh,
    isFresh
      ? `captured_at=${capturedAtRaw}; age_hours=${(ageMs / (60 * 60 * 1000)).toFixed(2)}`
      : capturedAtRaw
        ? `captured_at=${capturedAtRaw}; max_age_hours=${maxScreenshotAgeHours}`
        : 'Missing manifest captured_at timestamp.',
    freshnessRequired,
  );

  if (expectedCaptureMode) {
    const actualCaptureMode = normalizeEnvValue(manifest?.capture_mode).toLowerCase();
    const pass = actualCaptureMode === expectedCaptureMode;
    ensureCheck(
      checks,
      `${checkPrefix}.manifest.capture_mode`,
      pass,
      pass
        ? `capture_mode=${actualCaptureMode}`
        : `Expected capture_mode=${expectedCaptureMode}, got ${actualCaptureMode || '<missing>'}.`,
      required,
    );
  }

  const selftests = Array.isArray(manifest?.selftests) ? manifest.selftests : [];
  for (const platform of REQUIRED_SELFTEST_PLATFORMS) {
    const testEntry = selftests.find(
      (entry) => String(entry?.platform || '').toLowerCase() === platform,
    );
    const pass = Boolean(testEntry && String(testEntry.status || '').toLowerCase() === 'pass');
    ensureCheck(
      checks,
      `${checkPrefix}.selftest.${platform}`,
      pass,
      pass
        ? `Selftest passed for ${platform}.`
        : `Missing or non-passing selftest for ${platform}.`,
      required,
    );
  }

  for (const platform of REQUIRED_SELFTEST_PLATFORMS) {
    const testEntry = selftests.find(
      (entry) => String(entry?.platform || '').toLowerCase() === platform,
    );
    const stepTexts = Array.isArray(testEntry?.steps)
      ? testEntry.steps
          .map((step) => String(step || '').trim())
          .filter(Boolean)
      : [];
    const missingStepPrefixes = REQUIRED_SELFTEST_CONTRACT_STEP_PREFIXES.filter(
      (prefix) => !stepTexts.some((step) => step.startsWith(prefix)),
    );
    ensureCheck(
      checks,
      `${checkPrefix}.selftest.contract.${platform}`,
      missingStepPrefixes.length === 0,
      missingStepPrefixes.length === 0
        ? `Selftest contract steps present for ${platform}.`
        : `Missing required selftest contract steps for ${platform}: ${missingStepPrefixes.join(', ')}`,
      required,
    );
  }

  const scenarios = Array.isArray(manifest?.scenarios) ? manifest.scenarios : [];
  if (expectedCaptureSources.length > 0) {
    const sources = new Set(
      scenarios
        .map((entry) => normalizeEnvValue(entry?.capture_source).toLowerCase())
        .filter(Boolean),
    );
    const missingSources = expectedCaptureSources.filter((source) => !sources.has(source));
    ensureCheck(
      checks,
      `${checkPrefix}.scenarios.capture_sources`,
      missingSources.length === 0,
      missingSources.length === 0
        ? `All expected capture sources present: ${expectedCaptureSources.join(', ')}.`
        : `Missing capture sources: ${missingSources.join(', ')}.`,
      required,
    );
  }
  const scenarioNames = new Set(
    scenarios
      .map((entry) => String(entry?.name || '').trim())
      .filter(Boolean),
  );
  const hasAndroidScenario = Array.from(scenarioNames).some((name) => /^C-android-/.test(name));
  const hasIosScenario = Array.from(scenarioNames).some((name) => /^C-ios-/.test(name));
  ensureCheck(
    checks,
    `${checkPrefix}.scenarios.android_ios`,
    hasAndroidScenario && hasIosScenario,
    `hasAndroid=${hasAndroidScenario} hasIos=${hasIosScenario}`,
    required,
  );

  const scenariosByName = new Map();
  for (const scenario of scenarios) {
    const scenarioName = String(scenario?.name || '').trim();
    if (!scenarioName || scenariosByName.has(scenarioName)) continue;
    scenariosByName.set(scenarioName, scenario);
  }

  const missingByPlatform = {};
  const expectedScenarioNames = [];
  for (const platform of REQUIRED_SELFTEST_PLATFORMS) {
    const expected = createFieldopsScenarioSet(platform).map((entry) => entry.name);
    expectedScenarioNames.push(...expected);
    const missing = expected.filter((name) => findScenarioMatch(scenariosByName, name).scenario == null);
    missingByPlatform[platform] = missing;
    ensureCheck(
      checks,
      `${checkPrefix}.scenarios.coverage.${platform}`,
      missing.length === 0,
      missing.length === 0
        ? `All ${expected.length} expected ${platform} scenarios are present.`
        : `Missing ${missing.length}/${expected.length} ${platform} scenarios: ${missing.join(', ')}`,
      required,
    );
  }
  const totalExpected = REQUIRED_SELFTEST_PLATFORMS.reduce(
    (sum, platform) => sum + createFieldopsScenarioSet(platform).length,
    0,
  );
  const totalMissing = Object.values(missingByPlatform).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
    0,
  );
  ensureCheck(
    checks,
    `${checkPrefix}.scenarios.matrix_complete`,
    totalMissing === 0,
    totalMissing === 0
      ? `All ${totalExpected} required screenshot scenarios are present across android+ios.`
      : `Missing ${totalMissing}/${totalExpected} required screenshot scenarios across android+ios.`,
    required,
  );

  const missingFileField = [];
  const invalidFileField = [];
  const missingArtifactFiles = [];

  for (const scenarioName of expectedScenarioNames) {
    const match = findScenarioMatch(scenariosByName, scenarioName);
    const entry = match.scenario || {};
    const fileName = String(entry?.file || '').trim();
    if (!fileName) {
      missingFileField.push(scenarioName);
      continue;
    }
    const allowedFileNames = new Set([
      `${scenarioName}.png`,
      ...resolveScenarioAliasNames(scenarioName).map((aliasName) => `${aliasName}.png`),
    ]);
    if (!allowedFileNames.has(fileName)) {
      invalidFileField.push(`${scenarioName}->${fileName}`);
    }
    if (!manifestDir) continue;
    const resolved = path.resolve(manifestDir, fileName);
    const manifestDirWithSep = manifestDir.endsWith(path.sep) ? manifestDir : `${manifestDir}${path.sep}`;
    const insideManifestDir =
      resolved === manifestDir || resolved.startsWith(manifestDirWithSep);
    if (!insideManifestDir || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      missingArtifactFiles.push(fileName);
    }
  }

  ensureCheck(
    checks,
    `${checkPrefix}.scenarios.files_named`,
    missingFileField.length === 0 && invalidFileField.length === 0,
    missingFileField.length === 0 && invalidFileField.length === 0
      ? `All ${expectedScenarioNames.length} required scenarios include canonical .png file names.`
      : [
          missingFileField.length
            ? `missing_file_field=${missingFileField.join(', ')}`
            : null,
          invalidFileField.length
            ? `invalid_file_field=${invalidFileField.join(', ')}`
            : null,
        ]
          .filter(Boolean)
          .join(' ; '),
    required,
  );

  ensureCheck(
    checks,
    `${checkPrefix}.scenarios.files_exist`,
    missingArtifactFiles.length === 0,
    manifestDir
      ? missingArtifactFiles.length === 0
        ? `All required scenario files exist under ${manifestDir}.`
        : `Missing or invalid scenario files: ${Array.from(new Set(missingArtifactFiles)).join(', ')}`
      : 'Manifest directory not provided; file existence check skipped.',
    required && Boolean(manifestDir),
  );
}

function validateFieldopsPackage(checks, packagePath) {
  if (!fs.existsSync(packagePath)) {
    ensureCheck(checks, 'fieldops.package.exists', false, `Missing ${packagePath}`);
    return;
  }
  const pkg = readJson(packagePath);
  ensureCheck(checks, 'fieldops.package.exists', true, `Found ${packagePath}`);

  const expoVersion = normalizeEnvValue(pkg?.dependencies?.expo);
  ensureCheck(
    checks,
    'fieldops.expo.version.stable_channel',
    isExpoVersionStable(expoVersion),
    expoVersion
      ? `expo dependency: ${expoVersion}`
      : 'Missing expo dependency version in apps/fieldops/package.json',
  );
}

function validateIosScreenshotParityCss(checks, cssPath) {
  if (!fs.existsSync(cssPath)) {
    ensureCheck(checks, 'screenshots.ios.css.exists', false, `Missing ${cssPath}`);
    return;
  }

  const css = fs.readFileSync(cssPath, 'utf8');
  ensureCheck(checks, 'screenshots.ios.css.exists', true, `Found ${cssPath}`);

  const iosAfterRules = Array.from(
    css.matchAll(/\.device\[data-platform=["']ios["']\]::after\s*\{([\s\S]*?)\}/gi),
  );
  const hasOnlyDisabledAfterRule =
    iosAfterRules.length === 0 ||
    iosAfterRules.every((match) => /content\s*:\s*none\s*;?/i.test(String(match[1] || '')));

  ensureCheck(
    checks,
    'screenshots.ios.no_synthetic_notch_overlay',
    hasOnlyDisabledAfterRule,
    iosAfterRules.length === 0
      ? 'No iOS ::after overlay rule detected.'
      : hasOnlyDisabledAfterRule
        ? 'iOS ::after overlay rule is disabled via content:none.'
        : 'iOS ::after rule is present without content:none; synthetic notch overlays are not allowed.',
  );

  const hasSafeAreaTopbarRule =
    /\.device\[data-platform=["']ios["']\]\s+\.topbar\s*\{[\s\S]*?env\(safe-area-inset-top\)/i.test(css);
  ensureCheck(
    checks,
    'screenshots.ios.safe_area_topbar_spacing',
    hasSafeAreaTopbarRule,
    hasSafeAreaTopbarRule
      ? 'iOS topbar safe-area spacing rule is present.'
      : 'Missing iOS topbar safe-area spacing rule with env(safe-area-inset-top).',
  );
}

function summarizeChecks(checks) {
  const failedRequired = checks.filter((check) => !check.pass && check.required).length;
  const failedAdvisory = checks.filter((check) => !check.pass && !check.required).length;
  return {
    checks: checks.length,
    failed_required: failedRequired,
    failed_advisory: failedAdvisory,
    pass: failedRequired === 0,
  };
}

function runFieldopsStorePreflight(options = {}) {
  const repoRoot = resolveRepoRoot(options.repoRoot || process.cwd());
  const strict = options.strict !== false;
  loadEnv();
  loadPublicEnv({ appDir: path.join(repoRoot, 'apps', 'fieldops') });

  const envProfile = normalizeEnvValue(process.env.FIELDOPS_STORE_PREFLIGHT_PROFILE).toLowerCase();
  const profile =
    normalizeEnvValue(options.profile).toLowerCase() ||
    (ALLOWED_PREFLIGHT_PROFILES.includes(envProfile) ? envProfile : '') ||
    DEFAULT_PREFLIGHT_PROFILE;
  const envMaxScreenshotAgeHours = Number.parseInt(
    normalizeEnvValue(process.env.FIELDOPS_SCREENSHOT_MAX_AGE_HOURS),
    10,
  );
  const maxScreenshotAgeHours = Number.isFinite(options.maxScreenshotAgeHours)
    ? Number(options.maxScreenshotAgeHours)
    : Number.isFinite(envMaxScreenshotAgeHours) && envMaxScreenshotAgeHours > 0
      ? envMaxScreenshotAgeHours
      : DEFAULT_SCREENSHOT_MAX_AGE_HOURS;

  const checks = [];
  const envContract = loadEnvContract(repoRoot, checks);
  validateRequiredEnv(checks, process.env, envContract.buildKeys, 'fieldops.build');
  validateRequiredEnv(checks, process.env, envContract.runtimeKeys, 'fieldops.runtime');
  validateEnvFormats(checks, process.env);
  validateEasConfig(checks, path.join(repoRoot, 'apps', 'fieldops', 'eas.json'));
  validateFieldopsPackage(checks, path.join(repoRoot, 'apps', 'fieldops', 'package.json'));
  validateIosScreenshotParityCss(
    checks,
    path.join(repoRoot, 'docs', 'product', 'examples', 'mobile-field-ops-ui', 'app.css'),
  );

  const envNativeManifest = normalizeEnvValue(process.env.FIELDOPS_NATIVE_SCREENSHOT_MANIFEST_PATH);
  const explicitNativeManifest = options.nativeManifestPath
    ? path.resolve(repoRoot, options.nativeManifestPath)
    : options.manifestPath
      ? path.resolve(repoRoot, options.manifestPath)
      : envNativeManifest
        ? path.resolve(repoRoot, envNativeManifest)
        : null;
  const nativeManifestPath = explicitNativeManifest || resolveLatestNativeRuntimeManifest(repoRoot);
  ensureCheck(
    checks,
    'screenshots.native.manifest.exists',
    Boolean(nativeManifestPath && fs.existsSync(nativeManifestPath)),
    nativeManifestPath
      ? `Using native screenshot manifest: ${nativeManifestPath}`
      : `No native screenshot manifest found under docs/ops/evidence/<date>/mobile-fieldops/${NATIVE_SCREENSHOT_SUBDIR}/manifest.json`,
  );
  if (nativeManifestPath && fs.existsSync(nativeManifestPath)) {
    const manifest = readJson(nativeManifestPath);
    evaluateScreenshotManifest(manifest, checks, {
      manifestDir: path.dirname(nativeManifestPath),
      maxScreenshotAgeHours,
      checkPrefix: 'screenshots.native',
      required: true,
      freshnessRequired: profile === 'release',
      expectedCaptureMode: 'native_runtime',
      expectedCaptureSources: ['adb', 'simctl'],
    });
  }

  const explicitSampleManifest = options.sampleManifestPath
    ? path.resolve(repoRoot, options.sampleManifestPath)
    : null;
  const sampleManifestPath = explicitSampleManifest || resolveLatestScreenshotManifest(repoRoot);
  ensureCheck(
    checks,
    'screenshots.sample.manifest.exists',
    Boolean(sampleManifestPath && fs.existsSync(sampleManifestPath)),
    sampleManifestPath
      ? `Using sample screenshot manifest: ${sampleManifestPath}`
      : `No sample screenshot manifest found under docs/ops/evidence/<date>/mobile-fieldops/${SAMPLE_SCREENSHOT_SUBDIR}/manifest.json`,
    false,
  );
  if (sampleManifestPath && fs.existsSync(sampleManifestPath)) {
    const sampleManifest = readJson(sampleManifestPath);
    evaluateScreenshotManifest(sampleManifest, checks, {
      manifestDir: path.dirname(sampleManifestPath),
      maxScreenshotAgeHours,
      checkPrefix: 'screenshots.sample',
      required: false,
      expectedCaptureMode: 'sample_static',
    });
  }

  if (!strict) {
    for (const check of checks) {
      if (!check.pass) check.required = false;
    }
  }

  const summary = summarizeChecks(checks);
  return {
    generated_at: new Date().toISOString(),
    strict,
    profile,
    repo_root: repoRoot,
    env_contract_path: envContract.path,
    manifest_path: nativeManifestPath || null,
    native_manifest_path: nativeManifestPath || null,
    sample_manifest_path: sampleManifestPath || null,
    max_screenshot_age_hours: maxScreenshotAgeHours,
    checks,
    summary,
  };
}

function writeReport(report, outputPath) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return absolute;
}

function formatCheckLine(check) {
  const status = check.pass ? 'PASS' : check.required ? 'FAIL' : 'WARN';
  return `[${status}] ${check.name} - ${check.details}`;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = runFieldopsStorePreflight(args);
    const outputPath = args.outputPath || resolveDefaultOutputPath(args.repoRoot || process.cwd());
    const absolutePath = writeReport(report, outputPath);

    for (const check of report.checks) {
      console.log(formatCheckLine(check));
    }
    console.log(
      `[fieldops-store-preflight] summary checks=${report.summary.checks} failed_required=${report.summary.failed_required} failed_advisory=${report.summary.failed_advisory}`,
    );
    console.log(`[fieldops-store-preflight] wrote ${absolutePath}`);

    process.exit(report.summary.pass ? 0 : 1);
  } catch (error) {
    console.error(`[fieldops-store-preflight] ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ANDROID_PACKAGE_RE,
  IOS_BUNDLE_RE,
  REQUIRED_BUILD_ENV_KEYS,
  REQUIRED_RUNTIME_ENV_KEYS,
  REQUIRED_SELFTEST_PLATFORMS,
  REQUIRED_SELFTEST_CONTRACT_STEP_PREFIXES,
  DEFAULT_SCREENSHOT_MAX_AGE_HOURS,
  DEFAULT_PREFLIGHT_PROFILE,
  NATIVE_SCREENSHOT_SUBDIR,
  SAMPLE_SCREENSHOT_SUBDIR,
  ALLOWED_PREFLIGHT_PROFILES,
  UUID_V4_OR_V5_RE,
  evaluateScreenshotManifest,
  formatDateYmd,
  isExpoVersionStable,
  parseArgs,
  loadEnvContract,
  resolveDefaultOutputPath,
  resolveLatestManifestBySubdir,
  resolveLatestNativeRuntimeManifest,
  resolveLatestScreenshotManifest,
  resolveRepoRoot,
  runFieldopsStorePreflight,
  summarizeChecks,
  validateIosScreenshotParityCss,
  validateEasConfig,
  writeReport,
};
