#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT_PACKAGE = require('../../../package.json');
const ROOT_NX_PROJECT = String(ROOT_PACKAGE?.name || '').trim();
const UNIT_COHORT_CONFIG_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'config',
  'ci',
  'local-gate-unit-cohorts.json',
);

const DIRECT_UNIT_TEST_RE = /^tests\/unit\/.+\.test\.(?:js|jsx|ts|tsx)$/i;
const ALLOWED_IMPACT_SURFACES = new Set(['ci', 'docs']);
const UNIT_COHORT_CONFIG_KEYS = new Set(['schema_version', 'cohorts']);
const UNIT_COHORT_KEYS = new Set([
  'id',
  'required_direct_surface_ids',
  'required_impact_surfaces',
  'allowed_changed_path_re',
  'test_paths',
]);
const CANONICAL_IMPACT_SELECTION_ARRAY_KEYS = Object.freeze([
  'changedFiles',
  'unmatchedFiles',
  'impactSurfaces',
  'requiredSuites',
  'selectedSuites',
  'impactedSurfaceIds',
  'directSurfaceIds',
  'surfaceIds',
  'requiredPreviewSurfaceIds',
]);
const FOCUSED_UNIT_TEST_INERT_PATTERNS = Object.freeze([
  /^docs\//i,
  /^(?:AGENTS|CLAUDE)\.md$/i,
]);
const UNIT_TEST_SELECTION_RISK_PATTERNS = Object.freeze([
  /(^|\/)package(?:-lock)?\.json$/i,
  /(^|\/)(?:npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock)$/i,
  /^config\/tooling\//i,
  /(^|\/)(?:jest|babel|vitest|swc)\.config\.[cm]?[jt]s$/i,
  /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i,
  /^nx\.json$/i,
  /(^|\/)project\.json$/i,
  /^\.nvmrc$/i,
  /^\.node-version$/i,
  /^\.github\/actions\/setup-cloud-env\//i,
  /^\.github\/workflows\/reviewer-gate-pr\.ya?ml$/i,
  /^config\/ci\/(?:deploy-surfaces|local-gate-unit-cohorts|test-impact-map)\.json$/i,
  /^scripts\/ops\/ci\/(?:deploy-surface-registry|focused-unit-selection|local-gate|nx-task-runner|pr-change-classify)\.js$/i,
]);
const COHORT_REVIEWABLE_UNIT_RISK_PATTERNS = Object.freeze([
  /^\.github\/workflows\/reviewer-gate-pr\.ya?ml$/i,
]);

function normalizePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniq(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  ));
}

function parseJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value.slice();
  const raw = String(value || '').trim();
  if (!raw) return fallback.slice();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback.slice();
  } catch {
    return fallback.slice();
  }
}

function normalizeStringArray(value) {
  return uniq(parseJsonArray(value).map(normalizePath));
}

function resolveDirectChangedUnitTests(changedFiles = []) {
  return normalizeStringArray(changedFiles)
    .filter((filePath) => DIRECT_UNIT_TEST_RE.test(filePath) && !filePath.split('/').includes('..'));
}

function isUnitTestSelectionRiskPath(filePath) {
  const normalized = normalizePath(filePath);
  return UNIT_TEST_SELECTION_RISK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isCohortReviewableUnitRiskPath(filePath) {
  const normalized = normalizePath(filePath);
  return COHORT_REVIEWABLE_UNIT_RISK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isFocusedUnitTestInertPath(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized || normalized.split('/').includes('..')) return false;
  return FOCUSED_UNIT_TEST_INERT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function selectionArray(selection, ...keys) {
  for (const key of keys) {
    if (Array.isArray(selection?.[key])) return uniq(selection[key].map(normalizePath));
    const parsed = parseJsonArray(selection?.[key]);
    if (parsed.length) return uniq(parsed.map(normalizePath));
  }
  return [];
}

function fullSelection(reason, details = {}) {
  return {
    mode: 'full',
    reason,
    testPaths: [],
    ...details,
  };
}

function exactStringArray(value, { normalize = (entry) => String(entry || '').trim() } = {}) {
  if (!Array.isArray(value)) return null;
  const normalized = value.map((entry) => (
    typeof entry === 'string' ? normalize(entry) : ''
  ));
  if (normalized.some((entry) => !entry) || new Set(normalized).size !== normalized.length) return null;
  return normalized;
}

function equalStringSets(left, right) {
  const normalizedLeft = uniq(left).sort();
  const normalizedRight = uniq(right).sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
}

function validateCanonicalImpactSelection(selection, changedFiles = []) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    return { ok: false, reason: 'selection_shape_invalid' };
  }
  if (String(selection.selectionConfidence || '').trim().toLowerCase() !== 'explicit') {
    return { ok: false, reason: 'selection_not_explicit' };
  }
  if (selection.unknown !== false) {
    return { ok: false, reason: 'selection_unknown' };
  }
  if (selection.fallbackToFull !== false) {
    return { ok: false, reason: 'selection_fallback_to_full' };
  }

  const arrays = {};
  for (const key of CANONICAL_IMPACT_SELECTION_ARRAY_KEYS) {
    const values = exactStringArray(selection[key], {
      normalize: key === 'changedFiles' ? normalizePath : (value) => String(value || '').trim(),
    });
    if (values === null) return { ok: false, reason: 'selection_shape_invalid', key };
    arrays[key] = values;
  }

  const normalizedChangedFiles = normalizeStringArray(changedFiles);
  if (!normalizedChangedFiles.length) return { ok: false, reason: 'changed_files_missing' };
  if (!equalStringSets(arrays.changedFiles, normalizedChangedFiles)) {
    return { ok: false, reason: 'selection_changed_files_mismatch' };
  }
  return { ok: true, arrays };
}

function validateUnitCohortConfig(config, {
  repoRoot = process.cwd(),
  fsImpl = fs,
  validateTestFiles = false,
} = {}) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, errors: ['config_not_object'], cohorts: [] };
  }
  for (const key of Object.keys(config)) {
    if (!UNIT_COHORT_CONFIG_KEYS.has(key)) errors.push(`config_unknown_key:${key}`);
  }
  if (config.schema_version !== 'local-gate-unit-cohorts.v1') {
    errors.push('config_schema_version_invalid');
  }
  if (!Array.isArray(config.cohorts) || !config.cohorts.length) {
    errors.push('config_cohorts_invalid');
  }

  const cohorts = [];
  const cohortIds = new Set();
  for (const [index, rawCohort] of (Array.isArray(config.cohorts) ? config.cohorts : []).entries()) {
    const label = `cohort_${index}`;
    if (!rawCohort || typeof rawCohort !== 'object' || Array.isArray(rawCohort)) {
      errors.push(`${label}_not_object`);
      continue;
    }
    for (const key of Object.keys(rawCohort)) {
      if (!UNIT_COHORT_KEYS.has(key)) errors.push(`${label}_unknown_key:${key}`);
    }
    const id = typeof rawCohort.id === 'string' ? rawCohort.id.trim() : '';
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) errors.push(`${label}_id_invalid`);
    else if (cohortIds.has(id)) errors.push(`cohort_id_duplicate:${id}`);
    else cohortIds.add(id);

    const requiredDirectSurfaceIds = rawCohort.required_direct_surface_ids === undefined
      ? []
      : exactStringArray(rawCohort.required_direct_surface_ids);
    const requiredImpactSurfaces = rawCohort.required_impact_surfaces === undefined
      ? []
      : exactStringArray(rawCohort.required_impact_surfaces, {
        normalize: (entry) => String(entry || '').trim().toLowerCase(),
      });
    if (requiredDirectSurfaceIds === null) errors.push(`${label}_required_direct_surface_ids_invalid`);
    if (requiredImpactSurfaces === null) errors.push(`${label}_required_impact_surfaces_invalid`);
    if (!requiredDirectSurfaceIds?.length && !requiredImpactSurfaces?.length) {
      errors.push(`${label}_required_selection_invalid`);
    }
    if (requiredDirectSurfaceIds?.length && requiredImpactSurfaces?.length) {
      errors.push(`${label}_required_selection_ambiguous`);
    }

    const allowedChangedPathPatterns = exactStringArray(rawCohort.allowed_changed_path_re);
    const allowedChangedPathRegexps = [];
    if (!allowedChangedPathPatterns?.length) {
      errors.push(`${label}_allowed_changed_path_re_invalid`);
    } else {
      for (const pattern of allowedChangedPathPatterns) {
        try {
          allowedChangedPathRegexps.push(new RegExp(pattern));
        } catch {
          errors.push(`${label}_allowed_changed_path_re_malformed:${pattern}`);
        }
      }
    }

    const testPaths = exactStringArray(rawCohort.test_paths, { normalize: normalizePath });
    if (!testPaths?.length || testPaths.some((testPath) => !DIRECT_UNIT_TEST_RE.test(testPath))) {
      errors.push(`${label}_test_paths_invalid`);
    } else if (
      validateTestFiles
      && runtimeFocusedTests(testPaths, { repoRoot, fsImpl }).length !== testPaths.length
    ) {
      errors.push(`${label}_test_paths_unsafe`);
    }

    cohorts.push({
      id,
      requiredDirectSurfaceIds: requiredDirectSurfaceIds || [],
      requiredImpactSurfaces: requiredImpactSurfaces || [],
      allowedChangedPathPatterns: allowedChangedPathPatterns || [],
      allowedChangedPathRegexps,
      testPaths: testPaths || [],
    });
  }

  return {
    ok: errors.length === 0,
    errors: Array.from(new Set(errors)),
    cohorts: errors.length ? [] : cohorts,
  };
}

function loadUnitCohortConfig({
  configPath = UNIT_COHORT_CONFIG_PATH,
  repoRoot = process.cwd(),
  fsImpl = fs,
  validateTestFiles = false,
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      errors: [`config_read_failed:${String(error?.message || error)}`],
      cohorts: [],
    };
  }
  return validateUnitCohortConfig(parsed, { repoRoot, fsImpl, validateTestFiles });
}

function resolveSurfaceUnitCohort({
  changedFiles,
  impactSelection,
  selectedSuites,
  cohortConfig,
  cohortConfigPath,
  repoRoot,
  fsImpl,
  validateCohortTestFiles,
}) {
  const directSurfaceIds = selectionArray(
    impactSelection,
    'directSurfaceIds',
    'direct_surface_ids_json',
  );
  const productSurfaceIds = uniq([
    ...selectionArray(impactSelection, 'impactedSurfaceIds', 'impacted_surface_ids_json'),
    ...selectionArray(impactSelection, 'surfaceIds', 'surface_ids_json'),
    ...selectionArray(impactSelection, 'requiredPreviewSurfaceIds', 'required_preview_surface_ids_json'),
  ]);
  const impactSurfaces = selectionArray(
    impactSelection,
    'impactSurfaces',
    'impact_surfaces_json',
  ).map((value) => String(value || '').trim().toLowerCase());
  if (!selectedSuites.includes('test_unit')) {
    return fullSelection('test_unit_not_selected', { selectedSuites });
  }

  const validation = cohortConfig === undefined
    ? loadUnitCohortConfig({
      configPath: cohortConfigPath,
      repoRoot,
      fsImpl,
      validateTestFiles: validateCohortTestFiles,
    })
    : validateUnitCohortConfig(cohortConfig, {
      repoRoot,
      fsImpl,
      validateTestFiles: validateCohortTestFiles,
    });
  if (!validation.ok) {
    return fullSelection('unit_cohort_config_invalid', {
      cohortErrors: validation.errors,
    });
  }

  for (const cohort of validation.cohorts) {
    if (cohort.requiredDirectSurfaceIds.length) {
      if (!equalStringSets(directSurfaceIds, cohort.requiredDirectSurfaceIds)) continue;
      if (!equalStringSets(productSurfaceIds, cohort.requiredDirectSurfaceIds)) continue;
    } else {
      if (directSurfaceIds.length || productSurfaceIds.length) continue;
      if (!impactSurfaces.length || impactSurfaces.some((surface) => !ALLOWED_IMPACT_SURFACES.has(surface))) continue;
      if (!cohort.requiredImpactSurfaces.every((surface) => impactSurfaces.includes(surface))) continue;
    }
    if (!changedFiles.every((filePath) => (
      cohort.allowedChangedPathRegexps.some((pattern) => pattern.test(filePath))
    ))) continue;
    const testPaths = uniq([
      ...cohort.testPaths,
      ...resolveDirectChangedUnitTests(changedFiles),
    ]);
    if (
      validateCohortTestFiles
      && runtimeFocusedTests(testPaths, { repoRoot, fsImpl }).length !== testPaths.length
    ) {
      return fullSelection('unit_cohort_test_paths_unsafe', { cohortId: cohort.id });
    }
    return {
      mode: 'focused',
      reason: cohort.requiredDirectSurfaceIds.length
        ? 'explicit_surface_unit_cohort'
        : 'explicit_control_plane_unit_cohort',
      cohortId: cohort.id,
      testPaths,
    };
  }
  return productSurfaceIds.length
    ? fullSelection('selection_has_product_surfaces', { productSurfaceIds })
    : null;
}

function resolveFocusedUnitSelection({
  changedFiles = [],
  impactSelection = {},
  cohortConfig,
  cohortConfigPath = UNIT_COHORT_CONFIG_PATH,
  repoRoot = process.cwd(),
  fsImpl = fs,
  validateCohortTestFiles = false,
} = {}) {
  const normalizedChangedFiles = normalizeStringArray(changedFiles);
  if (!normalizedChangedFiles.length) return fullSelection('changed_files_missing');

  const canonicalSelection = validateCanonicalImpactSelection(impactSelection, normalizedChangedFiles);
  if (!canonicalSelection.ok) return fullSelection(canonicalSelection.reason);

  const unmatchedFiles = canonicalSelection.arrays.unmatchedFiles;
  if (unmatchedFiles.length) return fullSelection('selection_has_unmatched_files', { unmatchedFiles });

  const selectedSuites = uniq([
    ...selectionArray(impactSelection, 'selectedSuites', 'selected_suites_json'),
    ...(Array.isArray(impactSelection?.requiredSuites)
      ? impactSelection.requiredSuites
      : String(impactSelection?.requiredSuites || impactSelection?.required_suites || '').split(',')),
  ].map((value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '_')));
  if (!selectedSuites.includes('test_unit')) return fullSelection('test_unit_not_selected', { selectedSuites });

  const riskPaths = normalizedChangedFiles.filter(isUnitTestSelectionRiskPath);
  const nonReviewableRiskPaths = riskPaths.filter((filePath) => !isCohortReviewableUnitRiskPath(filePath));
  if (nonReviewableRiskPaths.length) {
    return fullSelection('test_execution_config_changed', { riskPaths: nonReviewableRiskPaths });
  }

  const surfaceCohort = resolveSurfaceUnitCohort({
    changedFiles: normalizedChangedFiles,
    impactSelection,
    selectedSuites,
    cohortConfig,
    cohortConfigPath,
    repoRoot,
    fsImpl,
    validateCohortTestFiles,
  });
  if (surfaceCohort) return surfaceCohort;

  if (riskPaths.length) return fullSelection('test_execution_config_changed', { riskPaths });

  const impactSurfaces = Array.isArray(impactSelection?.impactSurfaces)
    ? uniq(impactSelection.impactSurfaces.map((value) => String(value || '').trim().toLowerCase()))
    : uniq(String(impactSelection?.impactSurfaces || impactSelection?.impact_surfaces || '')
      .split(',')
      .map((value) => value.trim().toLowerCase()));
  if (!impactSurfaces.length || impactSurfaces.some((surface) => !ALLOWED_IMPACT_SURFACES.has(surface))) {
    return fullSelection('selection_not_ci_docs_only', { impactSurfaces });
  }

  const testPaths = resolveDirectChangedUnitTests(normalizedChangedFiles);
  if (!testPaths.length) return fullSelection('direct_unit_tests_missing');

  const dependencyRiskPaths = normalizedChangedFiles.filter((filePath) => (
    !DIRECT_UNIT_TEST_RE.test(filePath) && !isFocusedUnitTestInertPath(filePath)
  ));
  if (dependencyRiskPaths.length) {
    return fullSelection('dependency_closure_unproven', { dependencyRiskPaths });
  }

  return {
    mode: 'focused',
    reason: 'explicit_ci_docs_direct_unit_tests',
    testPaths,
  };
}

function resolveTargetedJestRoots(targetedTests = []) {
  return uniq(normalizeStringArray(targetedTests).map((filePath) => path.posix.dirname(filePath)))
    .filter((dir) => dir && dir !== '.');
}

function resolveJestInvocation({
  configPath,
  targetedTests = [],
  localJestBinPath = 'node_modules/jest/bin/jest.js',
  repoRoot = process.cwd(),
  fsImpl = fs,
} = {}) {
  const normalizedTargets = normalizeStringArray(targetedTests);
  const targetedRoots = resolveTargetedJestRoots(normalizedTargets);
  const baseArgs = [
    '--config',
    String(configPath || '').trim(),
    '--runInBand',
    ...(targetedRoots.length ? ['--roots', ...targetedRoots] : []),
    ...(normalizedTargets.length ? ['--runTestsByPath', ...normalizedTargets] : []),
  ];
  const executableJestPath = path.isAbsolute(String(localJestBinPath || ''))
    ? String(localJestBinPath)
    : path.resolve(repoRoot, String(localJestBinPath || ''));
  if (localJestBinPath && fsImpl.existsSync(executableJestPath)) {
    return { command: 'node', args: [normalizePath(localJestBinPath), ...baseArgs] };
  }
  return null;
}

function runtimeFocusedTests(testPaths, { repoRoot = process.cwd(), fsImpl = fs } = {}) {
  const normalized = resolveDirectChangedUnitTests(testPaths);
  if (!normalized.length || normalized.length !== normalizeStringArray(testPaths).length) return [];
  const canonicalRoot = path.resolve(repoRoot);
  let realRoot;
  try {
    realRoot = fsImpl.realpathSync(canonicalRoot);
  } catch {
    return [];
  }
  for (const testPath of normalized) {
    const absolutePath = path.resolve(canonicalRoot, ...testPath.split('/'));
    const relative = path.relative(canonicalRoot, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
    let stat;
    let realPath;
    try {
      stat = fsImpl.lstatSync(absolutePath);
      realPath = fsImpl.realpathSync(absolutePath);
    } catch {
      return [];
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    const realRelative = path.relative(realRoot, realPath);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) return [];
  }
  return normalized;
}

function fullUnitInvocation(repoRoot = process.cwd()) {
  return {
    command: 'node',
    args: [
      path.resolve(repoRoot, 'scripts', 'ops', 'ci', 'nx-task-runner.js'),
      '--mode',
      'run-many',
      '--targets',
      'test:unit',
      '--projects',
      ROOT_NX_PROJECT,
      '--fallback-command',
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      '--fallback-args-json',
      '["run","test:unit"]',
    ],
  };
}

function executeUnitTestSelection({
  env = process.env,
  repoRoot = process.cwd(),
  fsImpl = fs,
  spawnSyncFn = spawnSync,
} = {}) {
  const requestedMode = String(env.FOCUSED_UNIT_MODE || '').trim().toLowerCase();
  const requestedTests = parseJsonArray(env.FOCUSED_UNIT_TESTS_JSON);
  const focusedTests = requestedMode === 'focused'
    ? runtimeFocusedTests(requestedTests, { repoRoot, fsImpl })
    : [];
  const localJestBinPath = path.resolve(repoRoot, 'node_modules', 'jest', 'bin', 'jest.js');
  const localJestAvailable = focusedTests.length > 0 && fsImpl.existsSync(localJestBinPath);

  let invocation;
  let effectiveMode;
  if (requestedMode === 'focused' && localJestAvailable) {
    invocation = resolveJestInvocation({
      configPath: 'config/tooling/jest.config.unit.js',
      targetedTests: focusedTests,
      localJestBinPath,
      fsImpl,
    });
    effectiveMode = 'focused';
  } else {
    invocation = fullUnitInvocation(repoRoot);
    effectiveMode = 'full';
    if (requestedMode === 'focused') {
      console.warn('[focused-unit-selection] Focused targets were missing or invalid; running the full unit suite.');
    }
  }

  console.log(`[focused-unit-selection] mode=${effectiveMode} tests=${focusedTests.length}`);
  const result = spawnSyncFn(invocation.command, invocation.args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: false,
  });
  const status = Number.isInteger(result?.status) ? result.status : 1;
  return { effectiveMode, focusedTests, invocation, status, error: result?.error || null };
}

function main() {
  if (!process.argv.slice(2).includes('--execute')) {
    throw new Error('focused_unit_selection_execute_required');
  }
  const result = executeUnitTestSelection();
  if (result.error) console.error(result.error.message || String(result.error));
  process.exitCode = result.status;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_IMPACT_SURFACES,
  CANONICAL_IMPACT_SELECTION_ARRAY_KEYS,
  COHORT_REVIEWABLE_UNIT_RISK_PATTERNS,
  DIRECT_UNIT_TEST_RE,
  FOCUSED_UNIT_TEST_INERT_PATTERNS,
  UNIT_COHORT_CONFIG_PATH,
  UNIT_TEST_SELECTION_RISK_PATTERNS,
  executeUnitTestSelection,
  fullUnitInvocation,
  isUnitTestSelectionRiskPath,
  isCohortReviewableUnitRiskPath,
  isFocusedUnitTestInertPath,
  loadUnitCohortConfig,
  normalizePath,
  resolveDirectChangedUnitTests,
  resolveFocusedUnitSelection,
  resolveJestInvocation,
  resolveSurfaceUnitCohort,
  resolveTargetedJestRoots,
  runtimeFocusedTests,
  validateCanonicalImpactSelection,
  validateUnitCohortConfig,
};
