#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.resolve(__dirname, '..', '..', '..', 'config', 'ci', 'local-gate-manifest-policy.json');
const EMPTY_STATUS_SHA256 = crypto.createHash('sha256').update('', 'utf8').digest('hex');
const CANDIDATE_POLICY_PATH = 'config/ci/local-gate-manifest-policy.json';
const MIN_CANDIDATE_MAX_AGE_MINUTES = 60;
const MAX_CANDIDATE_MAX_AGE_MINUTES = 1440;
const BOOTSTRAP_POLICY_V1 = Object.freeze({
  schema_version: 'local-gate-manifest-policy.v1',
  manifest_schema_version: 'local-gate-manifest.v1',
  manifest_kind: 'masarx-local-admission-proof',
  digest_algorithm: 'sha256',
  max_age_minutes: 480,
  allowed_modes: Object.freeze(['impact', 'strict']),
  strict_satisfies_impact: true,
  require_clean_worktree: true,
  require_exact_changed_files: true,
  require_exact_surfaces: true,
  require_exact_suites: true,
  require_exact_commands: true,
});
const POLICY_KEYS = new Set([
  'schema_version',
  'manifest_schema_version',
  'manifest_kind',
  'digest_algorithm',
  'max_age_minutes',
  'allowed_modes',
  'strict_satisfies_impact',
  'require_clean_worktree',
  'require_exact_changed_files',
  'require_exact_surfaces',
  'require_exact_suites',
  'require_exact_commands',
]);

function normalizeString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizePath(value) {
  return normalizeString(value).replace(/\\/g, '/');
}

function normalizeSha(value) {
  const normalized = normalizeString(value).toLowerCase();
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : '';
}

function uniqSorted(values, normalizer = normalizeString) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(normalizer).filter(Boolean))).sort();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  const body = typeof value === 'string' ? value : canonicalJson(value);
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

function normalizeFsPathForCompare(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(parentPath, childPath) {
  const parent = normalizeFsPathForCompare(parentPath);
  const child = normalizeFsPathForCompare(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function assertNotSymlinkOrReparse(targetPath, { allowMissing = false } = {}) {
  let stats;
  try {
    stats = fs.lstatSync(targetPath);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`local_gate_manifest_reparse_forbidden:${targetPath}`);
  }
  return stats;
}

function resolveSafeLocalGateManifestPath({
  cwd = process.cwd(),
  manifestDir = '.tmp/local-gate',
  headSha,
  createDirectory = false,
} = {}) {
  const normalizedHeadSha = normalizeSha(headSha);
  if (!normalizedHeadSha) throw new Error('local_gate_manifest_head_sha_invalid');
  const root = fs.realpathSync.native(path.resolve(cwd));
  const requestedDir = path.isAbsolute(String(manifestDir || ''))
    ? path.resolve(String(manifestDir))
    : path.resolve(root, String(manifestDir || '.tmp/local-gate'));
  if (!isPathInside(root, requestedDir)) {
    throw new Error(`local_gate_manifest_dir_outside_repository:${requestedDir}`);
  }

  const relativeParts = path.relative(root, requestedDir).split(path.sep).filter(Boolean);
  let cursor = root;
  assertNotSymlinkOrReparse(cursor);
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    const stats = assertNotSymlinkOrReparse(cursor, { allowMissing: true });
    if (stats && !stats.isDirectory()) {
      throw new Error(`local_gate_manifest_component_not_directory:${cursor}`);
    }
  }
  if (createDirectory) fs.mkdirSync(requestedDir, { recursive: true });
  const directoryStats = assertNotSymlinkOrReparse(requestedDir, { allowMissing: !createDirectory });
  if (!directoryStats) {
    throw new Error(`local_gate_manifest_dir_missing:${requestedDir}`);
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(`local_gate_manifest_dir_not_directory:${requestedDir}`);
  }
  const realDirectory = fs.realpathSync.native(requestedDir);
  if (!isPathInside(root, realDirectory) || normalizeFsPathForCompare(realDirectory) !== normalizeFsPathForCompare(requestedDir)) {
    throw new Error(`local_gate_manifest_realpath_mismatch:${requestedDir}:${realDirectory}`);
  }

  const manifestPath = path.join(realDirectory, `${normalizedHeadSha}.json`);
  const targetStats = assertNotSymlinkOrReparse(manifestPath, { allowMissing: true });
  if (targetStats && !targetStats.isFile()) {
    throw new Error(`local_gate_manifest_target_not_file:${manifestPath}`);
  }
  return { root, manifestDir: realDirectory, manifestPath };
}

function fsyncDirectoryIfSupported(directoryPath) {
  let fd;
  try {
    fd = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    const unsupportedOnWindows = process.platform === 'win32'
      && ['EACCES', 'EINVAL', 'EISDIR', 'EPERM'].includes(String(error?.code || ''));
    if (!unsupportedOnWindows) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeLocalGateManifestAtomic(manifestPath, manifest) {
  const targetPath = path.resolve(String(manifestPath || ''));
  const parent = path.dirname(targetPath);
  const targetStats = assertNotSymlinkOrReparse(targetPath, { allowMissing: true });
  if (targetStats && !targetStats.isFile()) {
    throw new Error(`local_gate_manifest_target_not_file:${targetPath}`);
  }
  const tempPath = path.join(
    parent,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const latestTargetStats = assertNotSymlinkOrReparse(targetPath, { allowMissing: true });
    if (latestTargetStats) {
      if (!latestTargetStats.isFile()) throw new Error(`local_gate_manifest_target_not_file:${targetPath}`);
    }
    fs.renameSync(tempPath, targetPath);
    fsyncDirectoryIfSupported(parent);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      const tempStats = fs.lstatSync(tempPath);
      if (!tempStats.isSymbolicLink() && tempStats.isFile()) fs.unlinkSync(tempPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function readLocalGateManifestFile(manifestPath) {
  const targetPath = path.resolve(String(manifestPath || ''));
  const before = assertNotSymlinkOrReparse(targetPath);
  if (!before.isFile()) throw new Error(`local_gate_manifest_target_not_file:${targetPath}`);
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(targetPath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(`local_gate_manifest_opened_target_not_file:${targetPath}`);
    if ((before.ino && opened.ino && before.ino !== opened.ino) || (before.dev && opened.dev && before.dev !== opened.dev)) {
      throw new Error(`local_gate_manifest_target_changed_before_read:${targetPath}`);
    }
    const body = fs.readFileSync(fd, 'utf8');
    const after = assertNotSymlinkOrReparse(targetPath);
    if (!after.isFile() || (before.ino && after.ino && before.ino !== after.ino) || (before.dev && after.dev && before.dev !== after.dev)) {
      throw new Error(`local_gate_manifest_target_changed_during_read:${targetPath}`);
    }
    return body;
  } finally {
    fs.closeSync(fd);
  }
}

function validateLocalGateManifestPolicyObject(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ['policy_not_object'];
  for (const key of Object.keys(parsed)) {
    if (!POLICY_KEYS.has(key)) errors.push(`policy_unknown_key:${key}`);
  }
  if (parsed?.schema_version !== 'local-gate-manifest-policy.v1') errors.push('policy_schema_version_invalid');
  if (parsed?.manifest_schema_version !== 'local-gate-manifest.v1') errors.push('manifest_schema_version_invalid');
  if (parsed?.manifest_kind !== 'masarx-local-admission-proof') errors.push('manifest_kind_invalid');
  if (parsed?.digest_algorithm !== 'sha256') errors.push('digest_algorithm_invalid');
  if (
    !Number.isInteger(parsed?.max_age_minutes)
    || parsed.max_age_minutes < MIN_CANDIDATE_MAX_AGE_MINUTES
    || parsed.max_age_minutes > MAX_CANDIDATE_MAX_AGE_MINUTES
  ) errors.push('max_age_minutes_invalid');
  const allowedModes = Array.isArray(parsed?.allowed_modes)
    ? parsed.allowed_modes.map((value) => (typeof value === 'string' ? normalizeString(value).toLowerCase() : ''))
    : [];
  if (
    !Array.isArray(parsed?.allowed_modes)
    || allowedModes.some((value) => !value)
    || new Set(allowedModes).size !== allowedModes.length
    || !allowedModes.includes('impact')
    || !allowedModes.includes('strict')
  ) {
    errors.push('allowed_modes_invalid');
  }
  for (const key of [
    'require_clean_worktree',
    'require_exact_changed_files',
    'require_exact_surfaces',
    'require_exact_suites',
    'require_exact_commands',
  ]) {
    if (parsed?.[key] !== true) errors.push(`${key}_invalid`);
  }
  if (typeof parsed?.strict_satisfies_impact !== 'boolean') errors.push('strict_satisfies_impact_invalid');
  return Array.from(new Set(errors));
}

function loadLocalGateManifestPolicy(policyPath = POLICY_PATH) {
  const parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const errors = validateLocalGateManifestPolicyObject(parsed);
  if (errors.length) throw new Error(`Invalid local gate manifest policy: ${errors.join(',')}`);
  return parsed;
}

function evaluateLocalGatePolicyTransition(basePolicy, candidatePolicy) {
  const errors = validateLocalGateManifestPolicyObject(candidatePolicy);
  const baseErrors = validateLocalGateManifestPolicyObject(basePolicy);
  if (baseErrors.length) errors.push(...baseErrors.map((error) => `base:${error}`));
  if (errors.length) return { ok: false, errors: Array.from(new Set(errors)), policy: null, policy_sha256: '' };

  for (const key of ['schema_version', 'manifest_schema_version', 'manifest_kind', 'digest_algorithm']) {
    if (candidatePolicy[key] !== basePolicy[key]) errors.push(`contract_field_changed:${key}`);
  }
  if (!equalCanonical(uniqSorted(candidatePolicy.allowed_modes), uniqSorted(basePolicy.allowed_modes))) {
    errors.push('allowed_modes_changed');
  }
  if (candidatePolicy.max_age_minutes > basePolicy.max_age_minutes) errors.push('max_age_weakened');
  if (candidatePolicy.max_age_minutes < MIN_CANDIDATE_MAX_AGE_MINUTES) errors.push('max_age_deadlock');
  if (basePolicy.strict_satisfies_impact === false && candidatePolicy.strict_satisfies_impact === true) {
    errors.push('strict_satisfies_impact_weakened');
  }
  for (const key of [
    'require_clean_worktree',
    'require_exact_changed_files',
    'require_exact_surfaces',
    'require_exact_suites',
    'require_exact_commands',
  ]) {
    if (basePolicy[key] === true && candidatePolicy[key] !== true) errors.push(`required_guard_weakened:${key}`);
  }
  return {
    ok: errors.length === 0,
    errors: Array.from(new Set(errors)),
    policy: errors.length ? null : candidatePolicy,
    policy_sha256: errors.length ? '' : sha256(candidatePolicy),
  };
}

function evaluateBootstrapPolicy({
  candidateHeadSha,
  candidatePolicy,
  expectedHeadSha,
  expectedPolicySha256,
} = {}) {
  const errors = [];
  const candidateHead = normalizeSha(candidateHeadSha);
  const anchoredHead = normalizeSha(expectedHeadSha);
  const anchoredPolicySha = normalizeString(expectedPolicySha256).toLowerCase();
  if (!anchoredHead) errors.push('bootstrap_expected_head_sha_missing');
  else if (candidateHead !== anchoredHead) errors.push('bootstrap_expected_head_sha_mismatch');
  if (!/^[0-9a-f]{64}$/.test(anchoredPolicySha)) errors.push('bootstrap_expected_policy_sha256_missing');
  else if (sha256(candidatePolicy) !== anchoredPolicySha) errors.push('bootstrap_expected_policy_sha256_mismatch');
  if (!equalCanonical(candidatePolicy, BOOTSTRAP_POLICY_V1)) errors.push('bootstrap_candidate_policy_not_exact_v1');
  return {
    ok: errors.length === 0,
    errors,
    policy: errors.length ? null : structuredClone(BOOTSTRAP_POLICY_V1),
    policy_sha256: errors.length ? '' : sha256(BOOTSTRAP_POLICY_V1),
  };
}

function parseCandidatePolicyContent(response) {
  const payload = response?.data && typeof response.data === 'object' ? response.data : response;
  if (!payload || payload.type !== 'file' || normalizeString(payload.encoding).toLowerCase() !== 'base64') {
    throw new Error('candidate_policy_content_invalid');
  }
  const content = normalizeString(payload.content).replace(/\s+/g, '');
  if (!content) throw new Error('candidate_policy_content_missing');
  try {
    return JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`candidate_policy_json_invalid:${error.message || error}`);
  }
}

async function loadCandidatePolicyFromGithub({ github, owner, repo, headSha }) {
  const ref = normalizeSha(headSha);
  if (!ref) throw new Error('candidate_policy_head_sha_invalid');
  if (!github?.rest?.repos?.getContent) throw new Error('candidate_policy_github_reader_missing');
  const response = await github.rest.repos.getContent({
    owner,
    repo,
    path: CANDIDATE_POLICY_PATH,
    ref,
  });
  return parseCandidatePolicyContent(response);
}

async function resolveAcceptedCandidatePolicy({
  github,
  owner,
  repo,
  headSha,
  basePolicy,
  loadCandidatePolicyImpl = loadCandidatePolicyFromGithub,
} = {}) {
  let candidatePolicy;
  try {
    candidatePolicy = await loadCandidatePolicyImpl({ github, owner, repo, headSha });
  } catch (error) {
    return {
      ok: false,
      reason: /404|not found|missing/i.test(String(error?.message || error))
        ? 'candidate_policy_missing'
        : 'candidate_policy_malformed',
      errors: [String(error?.message || error)],
      policy: null,
      policy_sha256: '',
    };
  }
  if (!basePolicy) {
    return {
      ok: false,
      reason: 'base_policy_missing',
      errors: ['base_policy_required'],
      policy: null,
      policy_sha256: '',
    };
  }
  const transition = evaluateLocalGatePolicyTransition(basePolicy, candidatePolicy);
  if (!transition.ok) {
    return {
      ...transition,
      reason: transition.errors.some((error) => /deadlock|max_age_minutes_invalid/.test(error))
        ? 'candidate_policy_deadlock'
        : 'candidate_policy_weakened',
    };
  }
  return { ...transition, reason: 'accepted' };
}

function normalizeCommand(command) {
  const step = command && typeof command === 'object' && !Array.isArray(command) ? command : {};
  const env = step.env && typeof step.env === 'object' && !Array.isArray(step.env) ? step.env : {};
  return {
    command_id: normalizeString(step.command_id),
    suite_ids: uniqSorted(step.suite_ids),
    surface_ids: uniqSorted(step.surface_ids),
    command: normalizeString(step.command),
    args: (Array.isArray(step.args) ? step.args : []).map((value) => String(value)),
    env: Object.fromEntries(Object.keys(env).sort().map((key) => [key, String(env[key] == null ? '' : env[key])])),
  };
}

function commandPlan(commands) {
  return (Array.isArray(commands) ? commands : []).map(normalizeCommand);
}

function digestManifest(manifest) {
  const payload = { ...(manifest && typeof manifest === 'object' ? manifest : {}) };
  delete payload.manifest_sha256;
  return sha256(payload);
}

function addLocalGateManifestContract(manifest, { policy = loadLocalGateManifestPolicy() } = {}) {
  const changedFiles = uniqSorted(manifest?.changed_files, normalizePath);
  const surfaceIds = uniqSorted(manifest?.surface_ids);
  const suiteIds = uniqSorted(manifest?.suite_ids);
  const commands = commandPlan(manifest?.commands);
  const plannedCommands = commandPlan(
    Array.isArray(manifest?.planned_commands) ? manifest.planned_commands : manifest?.commands,
  );
  return {
    ...manifest,
    schema_version: policy.manifest_schema_version,
    kind: policy.manifest_kind,
    policy_schema_version: policy.schema_version,
    policy_sha256: sha256(policy),
    repository_clean: true,
    repository_status_sha256: EMPTY_STATUS_SHA256,
    changed_files: changedFiles,
    changed_files_sha256: sha256(changedFiles),
    surface_ids: surfaceIds,
    surface_ids_sha256: sha256(surfaceIds),
    suite_ids: suiteIds,
    suite_ids_sha256: sha256(suiteIds),
    planned_commands: plannedCommands,
    command_plan_sha256: sha256(plannedCommands),
    command_results_sha256: sha256(commands),
  };
}

function equalCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function isCanonicalSuperset(actual, expected) {
  const actualSet = new Set(Array.isArray(actual) ? actual : []);
  return (Array.isArray(expected) ? expected : []).every((value) => actualSet.has(value));
}

function commandCoversExpected(actual, expected) {
  if (!actual || !expected || actual.command_id !== expected.command_id) return false;
  return actual.command === expected.command
    && equalCanonical(actual.args, expected.args)
    && equalCanonical(actual.env, expected.env)
    && isCanonicalSuperset(actual.suite_ids, expected.suite_ids)
    && isCanonicalSuperset(actual.surface_ids, expected.surface_ids);
}

function validateLocalGateManifest(manifest, {
  policy = loadLocalGateManifestPolicy(),
  headSha = '',
  baseSha = '',
  changedFiles = [],
  expectedSelection = null,
  expectedCommands = null,
  expectedGatePolicy = null,
  requiredMode = 'impact',
  currentStatus = '',
  nowMs = Date.now(),
} = {}) {
  const errors = [];
  const payload = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
  if (!payload) return { ok: false, errors: ['manifest_not_object'], manifest_sha256: '' };

  const manifestHead = normalizeSha(payload.head_sha || payload.sha);
  const manifestSha = normalizeSha(payload.sha);
  const manifestBase = normalizeSha(payload.base_sha);
  const expectedHead = normalizeSha(headSha);
  const expectedBase = normalizeSha(baseSha);
  const mode = normalizeString(payload.local_mode).toLowerCase();
  const requestedMode = normalizeString(requiredMode || 'impact').toLowerCase();
  const generatedAtMs = Date.parse(normalizeString(payload.generated_at));
  const maxAgeMs = Number(policy.max_age_minutes) * 60 * 1000;
  const normalizedStatus = normalizeString(currentStatus);

  if (payload.schema_version !== policy.manifest_schema_version) errors.push('schema_version_mismatch');
  if (payload.kind !== policy.manifest_kind) errors.push('kind_mismatch');
  if (payload.policy_schema_version !== policy.schema_version) errors.push('policy_schema_version_mismatch');
  if (payload.policy_sha256 !== sha256(policy)) errors.push('policy_digest_mismatch');
  if (normalizeString(payload.status).toLowerCase() !== 'passed') errors.push('status_not_passed');
  if (!manifestHead || (expectedHead && manifestHead !== expectedHead)) errors.push('head_sha_mismatch');
  if (!manifestSha || manifestSha !== manifestHead) errors.push('sha_alias_mismatch');
  if (!manifestBase || (expectedBase && manifestBase !== expectedBase)) errors.push('base_sha_mismatch');
  if (normalizePath(payload.manifest_path) !== `.tmp/local-gate/${manifestHead}.json`) errors.push('manifest_path_mismatch');
  if (!policy.allowed_modes.includes(mode)) errors.push('mode_invalid');
  const rawRiskReasons = payload.risk_reasons;
  const normalizedRiskReasons = Array.isArray(rawRiskReasons)
    ? rawRiskReasons.map((value) => (typeof value === 'string' ? normalizeString(value) : ''))
    : [];
  if (
    !Array.isArray(rawRiskReasons)
    || normalizedRiskReasons.some((value) => !value)
    || new Set(normalizedRiskReasons).size !== normalizedRiskReasons.length
  ) errors.push('risk_reasons_invalid');
  const expectedMode = normalizeString(expectedGatePolicy?.mode).toLowerCase();
  const strictSupersetSatisfiesImpact = Boolean(
    expectedGatePolicy
    && policy.strict_satisfies_impact
    && expectedMode === 'impact'
    && expectedGatePolicy.strictMode === false
    && mode === 'strict'
    && payload.strict_mode === true
  );
  if (expectedGatePolicy) {
    if (!strictSupersetSatisfiesImpact && mode !== expectedMode) errors.push('mode_mismatch');
    if (!strictSupersetSatisfiesImpact && payload.strict_mode !== Boolean(expectedGatePolicy.strictMode)) errors.push('strict_flag_mismatch');
    if (!equalCanonical(uniqSorted(normalizedRiskReasons), uniqSorted(expectedGatePolicy.riskReasons))) {
      errors.push('risk_reasons_mismatch');
    }
  } else {
    if (requestedMode === 'strict' && (mode !== 'strict' || payload.strict_mode !== true)) errors.push('strict_mode_required');
    if (requestedMode === 'impact' && mode !== 'impact' && !(policy.strict_satisfies_impact && mode === 'strict' && payload.strict_mode === true)) {
      errors.push('mode_mismatch');
    }
  }
  if (mode === 'strict' && payload.strict_mode !== true) errors.push('strict_flag_mismatch');
  if (mode === 'impact' && payload.strict_mode === true) errors.push('impact_flag_mismatch');
  if (!Number.isFinite(generatedAtMs)) errors.push('generated_at_invalid');
  else if (generatedAtMs > nowMs + 60_000) errors.push('generated_at_future');
  else if (nowMs - generatedAtMs > maxAgeMs) errors.push('manifest_expired');
  if (policy.require_clean_worktree && (payload.repository_clean !== true || payload.repository_status_sha256 !== EMPTY_STATUS_SHA256)) {
    errors.push('manifest_repository_not_clean');
  }
  if (policy.require_clean_worktree && normalizedStatus) errors.push('current_repository_not_clean');

  const actualChangedFiles = uniqSorted(payload.changed_files, normalizePath);
  const expectedChangedFiles = uniqSorted(changedFiles, normalizePath);
  if (payload.changed_files_sha256 !== sha256(actualChangedFiles)) errors.push('changed_files_digest_mismatch');
  if (policy.require_exact_changed_files && !equalCanonical(actualChangedFiles, expectedChangedFiles)) errors.push('changed_files_mismatch');

  const actualSurfaces = uniqSorted(payload.surface_ids);
  const expectedSurfaces = expectedSelection ? uniqSorted(expectedSelection.impactedSurfaceIds) : actualSurfaces;
  if (payload.surface_ids_sha256 !== sha256(actualSurfaces)) errors.push('surface_ids_digest_mismatch');
  if (policy.require_exact_surfaces && !equalCanonical(actualSurfaces, expectedSurfaces)) errors.push('surface_ids_mismatch');

  const actualSuites = uniqSorted(payload.suite_ids);
  const expectedSuites = expectedSelection ? uniqSorted(expectedSelection.selectedSuites) : actualSuites;
  if (payload.suite_ids_sha256 !== sha256(actualSuites)) errors.push('suite_ids_digest_mismatch');
  if (
    policy.require_exact_suites
    && (
      strictSupersetSatisfiesImpact
        ? !isCanonicalSuperset(actualSuites, expectedSuites)
        : !equalCanonical(actualSuites, expectedSuites)
    )
  ) errors.push('suite_ids_mismatch');

  const commands = Array.isArray(payload.commands) ? payload.commands : [];
  const normalizedCommands = commandPlan(commands);
  const plannedCommands = Array.isArray(payload.planned_commands) ? payload.planned_commands : [];
  const normalizedPlannedCommands = commandPlan(plannedCommands);
  const commandIds = normalizedCommands.map((entry) => entry.command_id);
  const plannedCommandIds = normalizedPlannedCommands.map((entry) => entry.command_id);
  if (!Array.isArray(payload.commands)) errors.push('commands_invalid');
  if (commandIds.some((value) => !value) || new Set(commandIds).size !== commandIds.length) errors.push('command_ids_invalid');
  if (plannedCommandIds.some((value) => !value) || new Set(plannedCommandIds).size !== plannedCommandIds.length) errors.push('planned_command_ids_invalid');
  if (commands.some((entry) => normalizeString(entry?.status).toLowerCase() !== 'passed')) errors.push('command_status_not_passed');
  if (commands.some((entry) => !Number.isFinite(Number(entry?.duration_ms)) || Number(entry.duration_ms) < 0)) errors.push('command_duration_invalid');
  const resultById = new Map(normalizedCommands.map((entry) => [entry.command_id, entry]));
  for (const planned of normalizedPlannedCommands) {
    if (!resultById.has(planned.command_id)) errors.push(`command_result_missing:${planned.command_id}`);
    else if (!equalCanonical(resultById.get(planned.command_id), planned)) errors.push(`command_result_mismatch:${planned.command_id}`);
  }
  const allowedRecoveryIds = new Set(['local_stop_recovery', 'local_start_recovery']);
  for (const result of normalizedCommands) {
    if (!plannedCommandIds.includes(result.command_id) && !allowedRecoveryIds.has(result.command_id)) {
      errors.push(`command_result_unplanned:${result.command_id || 'missing'}`);
    }
  }
  if (normalizedCommands.some((entry) => allowedRecoveryIds.has(entry.command_id)) && !plannedCommandIds.includes('local_verify')) {
    errors.push('command_recovery_without_local_verify');
  }
  const localStopRecovery = resultById.get('local_stop_recovery');
  const plannedLocalVerify = normalizedPlannedCommands.find((entry) => entry.command_id === 'local_verify');
  if (localStopRecovery && !equalCanonical(localStopRecovery, normalizeCommand({
    command_id: 'local_stop_recovery',
    suite_ids: plannedLocalVerify?.suite_ids || [],
    surface_ids: plannedLocalVerify?.surface_ids || [],
    command: 'npm',
    args: ['run', 'local:stop'],
    env: {},
  }))) errors.push('local_stop_recovery_invalid');
  const localStartRecovery = resultById.get('local_start_recovery');
  if (localStartRecovery && !equalCanonical(localStartRecovery, normalizeCommand({
    command_id: 'local_start_recovery',
    suite_ids: plannedLocalVerify?.suite_ids || [],
    surface_ids: plannedLocalVerify?.surface_ids || [],
    command: 'npm',
    args: ['run', 'local:start'],
    env: {
      WORKSPACE_LOCAL_START_FRESH: '1',
      WORKSPACE_LOCAL_START_RUN_MIGRATE_LOCAL: '1',
    },
  }))) errors.push('local_start_recovery_invalid');
  const computedDurationMs = commands.reduce((sum, entry) => sum + (Number(entry?.duration_ms) || 0), 0);
  if (Number(payload.duration_ms) !== computedDurationMs) errors.push('duration_mismatch');
  if (!Array.isArray(payload.planned_commands)) errors.push('planned_commands_invalid');
  if (payload.command_plan_sha256 !== sha256(normalizedPlannedCommands)) errors.push('command_plan_digest_mismatch');
  if (payload.command_results_sha256 !== sha256(normalizedCommands)) errors.push('command_results_digest_mismatch');
  if (policy.require_exact_commands && expectedCommands) {
    const normalizedExpectedCommands = commandPlan(expectedCommands);
    const commandPlanMatches = strictSupersetSatisfiesImpact
      ? normalizedExpectedCommands.every((expected) => commandCoversExpected(
          normalizedPlannedCommands.find((actual) => actual.command_id === expected.command_id),
          expected,
        ))
      : equalCanonical(normalizedPlannedCommands, normalizedExpectedCommands);
    if (!commandPlanMatches) errors.push('command_plan_mismatch');
  }
  if (!/^[0-9a-f]{64}$/.test(normalizeString(payload.manifest_sha256)) || payload.manifest_sha256 !== digestManifest(payload)) {
    errors.push('manifest_digest_mismatch');
  }

  return {
    ok: errors.length === 0,
    errors: Array.from(new Set(errors)),
    manifest_sha256: normalizeString(payload.manifest_sha256),
    mode,
  };
}

function validateLocalGateAttestationState(state, {
  policy = loadLocalGateManifestPolicy(),
  nowMs = Date.now(),
} = {}) {
  const errors = [];
  const generatedAtMs = Date.parse(normalizeString(state?.generated_at));
  if (state?.manifest_contract_version !== policy.manifest_schema_version) errors.push('manifest_contract_invalid');
  if (state?.policy_sha256 !== sha256(policy)) errors.push('policy_digest_invalid');
  if (!/^[0-9a-f]{64}$/.test(normalizeString(state?.manifest_sha256))) errors.push('manifest_digest_invalid');
  if (!/^[0-9a-f]{64}$/.test(normalizeString(state?.changed_files_sha256))) errors.push('changed_files_digest_invalid');
  if (!/^[0-9a-f]{64}$/.test(normalizeString(state?.surface_ids_sha256))) errors.push('surface_ids_digest_invalid');
  if (!/^[0-9a-f]{64}$/.test(normalizeString(state?.suite_ids_sha256))) errors.push('suite_ids_digest_invalid');
  if (!/^[0-9a-f]{64}$/.test(normalizeString(state?.command_plan_sha256))) errors.push('command_plan_digest_invalid');
  if (!/^[0-9a-f]{64}$/.test(normalizeString(state?.command_results_sha256))) errors.push('command_results_digest_invalid');
  if (state?.repository_clean !== true) errors.push('repository_not_clean');
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > nowMs + 60_000 || nowMs - generatedAtMs > Number(policy.max_age_minutes) * 60 * 1000) {
    errors.push('proof_expired');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  POLICY_PATH,
  CANDIDATE_POLICY_PATH,
  MIN_CANDIDATE_MAX_AGE_MINUTES,
  MAX_CANDIDATE_MAX_AGE_MINUTES,
  BOOTSTRAP_POLICY_V1,
  EMPTY_STATUS_SHA256,
  normalizePath,
  normalizeSha,
  uniqSorted,
  canonicalJson,
  sha256,
  normalizeFsPathForCompare,
  isPathInside,
  assertNotSymlinkOrReparse,
  resolveSafeLocalGateManifestPath,
  fsyncDirectoryIfSupported,
  writeLocalGateManifestAtomic,
  readLocalGateManifestFile,
  validateLocalGateManifestPolicyObject,
  loadLocalGateManifestPolicy,
  evaluateLocalGatePolicyTransition,
  evaluateBootstrapPolicy,
  parseCandidatePolicyContent,
  loadCandidatePolicyFromGithub,
  resolveAcceptedCandidatePolicy,
  normalizeCommand,
  commandPlan,
  digestManifest,
  addLocalGateManifestContract,
  validateLocalGateManifest,
  validateLocalGateAttestationState,
};
