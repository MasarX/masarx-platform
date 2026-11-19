#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const {
  COLLECTION_SCHEMA,
  POLICY_RELATIVE_PATH,
  POLICY_SECTION_KEYS,
  assertCanonicalPgtapBaseName,
  assertKnownKeys,
  assertNoDuplicateJsonKeys,
  canonicalJson,
  compareAscii,
  isPathWithin,
  isPlainObject,
  normalizePolicyFilePath,
  requireArray,
  requirePositiveInteger,
  requireString,
  sha256,
  strictPositiveInteger,
  validatePolicyFileOnDisk,
} = require('./pr-validation-focused-common');

const MIN_FOCUSED_HOST_TIMEOUT_MS = 60000;
const MAX_FOCUSED_HOST_TIMEOUT_MS = 3600000;

const COLLECTIBLE_REQUIREMENT_KEYS = new Set([
  'pgtap_failure_evidence',
  'logical_transaction_isolation_verified',
  'all_pre_and_post_guards_green',
  'no_hard_stop_signal',
]);

const CAPACITY_EVIDENCE_REQUIREMENT_KEYS = new Set([
  'exact_lifecycle_proof',
  'artifact_schema_proof',
  'logical_transaction_isolation_proof',
  'parallel_eligibility_proof',
  'one_stack_one_writer_proof',
  'migration_fingerprint_stable',
  'measured_host_pressure_proof',
  'measured_host_cpu_memory_proof',
  'measured_active_runner_pressure_proof',
  'measured_database_connection_proof',
  'dynamic_database_operational_headroom',
  'measured_lock_wait_proof',
  'measured_deadlock_proof',
  'measured_serialization_failure_proof',
  'no_contamination',
  'no_hard_stop',
]);

const ADAPTIVE_SHRINK_CONDITION_KEYS = new Set([
  'eligible_isolated_files',
  'policy_host_connection_cap',
  'policy_database_connection_cap',
]);

const ADAPTIVE_HARD_STOP_CONDITION_KEYS = new Set([
  'host_pressure',
  'database_capacity_unknown_or_red',
  'lock_or_serialization_signal',
  'contamination',
  'unknown_classification',
  'missing_worker_marker',
  'missing_completion_marker',
  'active_runner_pressure',
  'host_cpu_or_memory_unknown',
]);

const PARALLEL_HAZARD_CLASSES = new Set([
  'ddl',
  'global_settings',
  'sequences',
  'shared_fixed_rows',
  'advisory_or_global_locks',
  'background_workers',
  'non_rollback',
  'non_unique_fixtures',
  'dynamic_sql_unresolved',
  'external_side_effect',
]);

function validateExactPolicyKeys(values, expected, label) {
  const items = requireArray(values, label + 's')
    .map((value, index) => requireString(value, label + ' ' + index, { maxLength: 120 }));
  if (items.length !== expected.size || new Set(items).size !== items.length) {
    throw new Error('Focused parallel-wave ' + label + 's must be complete and unique.');
  }
  for (const item of items) {
    if (!expected.has(item)) throw new Error('Unknown focused parallel-wave ' + label + ': ' + item);
  }
  return items;
}

function validateFocusedCollectionPolicy(section, options = {}) {
  assertKnownKeys(section, POLICY_SECTION_KEYS, 'focused_failure_collection');
  if (section.schema_version !== 2) throw new Error('focused_failure_collection.schema_version must be 2.');
  if (typeof section.enabled !== 'boolean') throw new Error('focused_failure_collection.enabled must be boolean.');
  if (section.mode !== 'experimental_parallel_wave_default_off') {
    throw new Error('focused_failure_collection.mode must remain experimental_parallel_wave_default_off.');
  }
  if (section.activation !== 'explicit_collect_flag_and_jobs') {
    throw new Error('focused_failure_collection.activation must require the explicit collect flag and jobs value.');
  }
  if (section.artifact_schema !== COLLECTION_SCHEMA) throw new Error('Focused parallel-wave artifact schema is unsupported.');
  if (section.collected_failure_result !== 'nonzero') throw new Error('Collected failures must remain nonzero.');

  const discovery = section.discovery;
  assertKnownKeys(discovery, new Set(['roots', 'file_globs', 'recursive', 'sort', 'max_files']), 'focused_failure_collection.discovery');
  const discoveryRoots = requireArray(discovery.roots, 'focused discovery roots')
    .map((value, index) => requireString(value, 'focused discovery root ' + index, { maxLength: 240 }).replace(/\\/gu, '/'));
  if (!discoveryRoots.length || new Set(discoveryRoots).size !== discoveryRoots.length) throw new Error('Focused discovery roots must be non-empty and unique.');
  for (const root of discoveryRoots) {
    if (path.posix.isAbsolute(root) || /(^|\/)\.\.(\/|$)/u.test(root) || root.startsWith('./') || root.endsWith('/')) {
      throw new Error('Focused discovery roots must be canonical repo-relative paths.');
    }
  }
  const discoveryGlobs = requireArray(discovery.file_globs, 'focused discovery globs')
    .map((value, index) => requireString(value, 'focused discovery glob ' + index, { maxLength: 80 }));
  if (!discoveryGlobs.length || new Set(discoveryGlobs).size !== discoveryGlobs.length || discoveryGlobs.some((glob) => !/^\*\.[A-Za-z0-9]+$/u.test(glob))) {
    throw new Error('Focused discovery globs must be unique top-level extension globs.');
  }
  if (discovery.recursive !== false || discovery.sort !== 'filesystem_ascii') throw new Error('Focused discovery must remain top-level and filesystem ASCII sorted.');
  const discoveryMaxFiles = requirePositiveInteger(discovery.max_files, 'focused discovery max files');

  const execution = section.execution;
  assertKnownKeys(execution, new Set([
    'engine', 'jobs_option', 'saved_state', 'isolated_rerun_state',
    'state_file_scoped_to_session_artifacts', 'separate_connection_per_file',
    'one_runtime_database', 'one_lifecycle_owner', 'internal_harness_batching',
    'host_timeout_ms', 'parallel_failure_classification', 'pilot_state', 'isolated_rerun_jobs', 'final_a_to_z_serial',
    'final_local_candidate_serial', 'final_local_candidate_run_count',
  ]), 'focused_failure_collection.execution');
  const hostTimeoutMs = validateFocusedHostTimeoutMs(execution.host_timeout_ms);
  if (
    execution.engine !== 'pg_prove'
    || execution.jobs_option !== '--jobs'
    || execution.saved_state !== 'save'
    || execution.isolated_rerun_state !== 'save'
    || execution.state_file_scoped_to_session_artifacts !== true
    || execution.separate_connection_per_file !== true
    || execution.one_runtime_database !== true
    || execution.one_lifecycle_owner !== true
    || execution.internal_harness_batching !== false
    || execution.parallel_failure_classification !== 'triage_only_until_isolated_serial_rerun'
    || !new Set(['source_only_not_authorized', 'cos_authorized']).has(execution.pilot_state)
    || execution.isolated_rerun_jobs !== 1
    || execution.final_a_to_z_serial !== true
    || execution.final_local_candidate_serial !== true
    || execution.final_local_candidate_run_count !== 1
  ) throw new Error('Focused parallel-wave execution contract is unsafe or unsupported.');

  const finalGates = section.final_gates;
  assertKnownKeys(finalGates, new Set(['a_to_z', 'local_candidate_by_target_kind']), 'focused_failure_collection.final_gates');
  const validateCommand = (command, label) => {
    assertKnownKeys(command, new Set(['script', 'args', 'env']), label, { allowMissing: true });
    const script = requireString(command.script, label + ' script', { maxLength: 240 }).replace(/\\/gu, '/');
    if (path.posix.isAbsolute(script) || /(^|\/)\.\.(\/|$)/u.test(script) || !script.endsWith('.js')) throw new Error(label + ' script must be a safe repo-relative JavaScript file.');
    const args = requireArray(command.args, label + ' args').map((value, index) => requireString(value, label + ' arg ' + index, { maxLength: 240 }));
    const env = command.env || {};
    if (!isPlainObject(env)) throw new Error(label + ' env must be an object.');
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || typeof value !== 'string') throw new Error(label + ' env is invalid.');
    }
    return { script, args, env };
  };
  const aToZCommand = validateCommand(finalGates.a_to_z, 'focused A-to-Z command');
  if (!isPlainObject(finalGates.local_candidate_by_target_kind)) throw new Error('Focused local-candidate commands must be keyed by target kind.');
  const localCandidateByTargetKind = {};
  for (const [kind, command] of Object.entries(finalGates.local_candidate_by_target_kind)) {
    if (!new Set(['pr', 'branch_candidate']).has(kind)) throw new Error('Focused local-candidate target kind is unsupported: ' + kind);
    localCandidateByTargetKind[kind] = validateCommand(command, 'focused local-candidate ' + kind + ' command');
  }

  const waves = section.parallel_waves;
  assertKnownKeys(waves, new Set([
    'requested_jobs', 'batch_size', 'hard_jobs', 'host_connection_cap',
    'database_connection_cap', 'database_connection_reserve', 'adaptation', 'effective_jobs_expression',
    'max_files_per_wave', 'adaptive_shrink_conditions', 'hard_stop_conditions',
    'capacity_evidence_requirements', 'promotion_sequence', 'promotion_gates',
    'future_direct_requested_jobs',
  ]), 'focused_failure_collection.parallel_waves');
  const requestedJobs = requirePositiveInteger(waves.requested_jobs, 'focused parallel-wave requested jobs');
  const batchSize = requirePositiveInteger(waves.batch_size, 'focused parallel-wave batch size');
  const hardJobs = requirePositiveInteger(waves.hard_jobs, 'focused parallel-wave hard jobs');
  const hostConnectionCap = requirePositiveInteger(waves.host_connection_cap, 'focused parallel-wave host connection cap');
  const databaseConnectionCap = requirePositiveInteger(waves.database_connection_cap, 'focused parallel-wave database connection cap');
  const databaseConnectionReserve = waves.database_connection_reserve;
  assertKnownKeys(databaseConnectionReserve, new Set([
    'minimum_connections', 'minimum_fraction', 'include_measured_non_test_usage', 'include_control_connections',
  ]), 'focused parallel-wave database connection reserve');
  const minimumReserveConnections = requirePositiveInteger(databaseConnectionReserve.minimum_connections, 'focused DB minimum operational reserve');
  const minimumReserveFraction = Number(databaseConnectionReserve.minimum_fraction);
  if (minimumReserveConnections < 10 || !Number.isFinite(minimumReserveFraction) || minimumReserveFraction < 0.2 || minimumReserveFraction >= 1
    || databaseConnectionReserve.include_measured_non_test_usage !== true
    || databaseConnectionReserve.include_control_connections !== true) {
    throw new Error('Focused DB reserve must include at least 10 connections, 20%, non-test usage, and control connections.');
  }
  if (requestedJobs > hardJobs || batchSize > hardJobs) {
    throw new Error('Focused parallel-wave requested jobs and batch size cannot exceed the policy hard ceiling.');
  }
  if (hostConnectionCap > hardJobs || databaseConnectionCap > hardJobs || hardJobs !== 60 || batchSize !== 60) {
    throw new Error('Focused parallel-wave policy connection caps cannot exceed the hard ceiling.');
  }
  if (
    waves.adaptation !== 'min_requested_eligible_policy_caps'
    || waves.effective_jobs_expression !== 'min(requested_jobs, eligible_isolated_files, host_connection_cap, database_connection_cap)'
    || waves.max_files_per_wave !== 'min(batch_size,effective_jobs)'
  ) throw new Error('Focused parallel-wave adaptive expression is unsafe or unsupported.');
  const shrinkConditions = validateExactPolicyKeys(waves.adaptive_shrink_conditions, ADAPTIVE_SHRINK_CONDITION_KEYS, 'adaptive shrink condition');
  const hardStopConditions = validateExactPolicyKeys(waves.hard_stop_conditions, ADAPTIVE_HARD_STOP_CONDITION_KEYS, 'adaptive hard-stop condition');
  const capacityRequirements = validateExactPolicyKeys(waves.capacity_evidence_requirements, CAPACITY_EVIDENCE_REQUIREMENT_KEYS, 'capacity evidence requirement');
  if (canonicalJson(waves.promotion_sequence) !== canonicalJson([30, 45, 60])) throw new Error('Focused requested-job promotion sequence must be 30, 45, 60.');
  const promotionGates = requireArray(waves.promotion_gates, 'focused requested-job promotion gates');
  if (promotionGates.length !== 2) throw new Error('Focused requested-job promotion requires exactly two measured gates.');
  const expectedGates = [[30, 45, 30], [45, 60, 45]];
  promotionGates.forEach((gate, index) => {
    assertKnownKeys(gate, new Set(['from_requested_jobs', 'to_requested_jobs', 'state', 'required_clean_accepted_jobs', 'evidence']), 'focused requested-job promotion gate');
    const expected = expectedGates[index];
    if (gate.from_requested_jobs !== expected[0] || gate.to_requested_jobs !== expected[1]
      || gate.required_clean_accepted_jobs !== expected[2]
      || !new Set(['locked_pending_clean_accepted_wave', 'clean_accepted_wave']).has(gate.state)) {
      throw new Error('Focused requested-job promotion gates must remain locked pending clean accepted waves.');
    }
    if (gate.state === 'clean_accepted_wave') validateFocusedPromotionEvidence(gate.evidence, expected[2]);
    else if (gate.evidence !== null) throw new Error('Locked focused requested-job promotion gates cannot carry evidence.');
  });
  const futureDirect = waves.future_direct_requested_jobs;
  assertKnownKeys(futureDirect, new Set(['maximum', 'requires_durable_same_environment_evidence', 'requires_policy_permission', 'evidence']), 'focused future direct requested jobs');
  if (futureDirect.maximum !== 60 || futureDirect.requires_durable_same_environment_evidence !== true || futureDirect.requires_policy_permission !== true) {
    throw new Error('Focused future direct requested jobs must fail closed above 60 or without durable same-environment evidence.');
  }
  if (futureDirect.evidence !== null) validateFocusedPromotionEvidence(futureDirect.evidence, 60, { requireDurableSameEnvironment: true });
  if (requestedJobs === 45 && promotionGates[0].state !== 'clean_accepted_wave') {
    throw new Error('Focused requested_jobs 45 requires a clean accepted 30 wave.');
  }
  if (requestedJobs === 60 && !(
    (promotionGates[0].state === 'clean_accepted_wave' && promotionGates[1].state === 'clean_accepted_wave')
    || futureDirect.evidence !== null
  )) throw new Error('Focused requested_jobs 60 requires accepted promotion gates or durable same-environment evidence.');

  const repairScheduler = section.repair_scheduler;
  assertKnownKeys(repairScheduler, new Set([
    'state', 'queue_states', 'wave_fill_order', 'max_requested_files',
    'one_validation_stack', 'one_pg_prove_writer', 'repair_worktrees_must_be_disjoint',
    'repair_owner_may_own_runtime', 'repair_owner_may_run_validation',
    'repair_owner_may_mutate_validation_checkout', 'integration_owner_serial',
    'migration_replay_without_fingerprint_change', 'parallel_db_writers_outside_pg_prove',
  ]), 'focused_failure_collection.repair_scheduler');
  const exactQueueStates = [
    'untested', 'in_wave', 'failed_unconfirmed', 'confirmed_fixture_only',
    'repair_in_progress', 'repair_ready', 'passed', 'serial_quarantine',
    'hard_stop', 'skipped',
  ];
  if (
    !new Set(['source_only_not_authorized', 'cos_authorized']).has(repairScheduler.state)
    || repairScheduler.state !== execution.pilot_state
    || canonicalJson(repairScheduler.queue_states) !== canonicalJson(exactQueueStates)
    || canonicalJson(repairScheduler.wave_fill_order) !== canonicalJson(['repair_ready', 'untested'])
    || repairScheduler.max_requested_files !== 60
    || repairScheduler.max_requested_files !== hardJobs
    || repairScheduler.one_validation_stack !== true
    || repairScheduler.one_pg_prove_writer !== true
    || repairScheduler.repair_worktrees_must_be_disjoint !== true
    || repairScheduler.repair_owner_may_own_runtime !== false
    || repairScheduler.repair_owner_may_run_validation !== false
    || repairScheduler.repair_owner_may_mutate_validation_checkout !== false
    || repairScheduler.integration_owner_serial !== true
    || repairScheduler.migration_replay_without_fingerprint_change !== false
    || repairScheduler.parallel_db_writers_outside_pg_prove !== false
  ) throw new Error('Focused repair scheduler must remain explicitly authorized or source-only, disjoint, single-writer, and fail closed.');

  const parallelEligibility = section.parallel_eligibility;
  assertKnownKeys(parallelEligibility, new Set([
    'default_action', 'parallel_eligible_state', 'serial_quarantine_state',
    'requires_logical_transaction_isolation', 'writes_require_unique_fixture_metadata',
    'hazard_classes', 'safe_function_allowlist', 'unique_fixture_allowlist',
  ]), 'focused_failure_collection.parallel_eligibility');
  if (
    parallelEligibility.default_action !== 'quarantine_serially'
    || parallelEligibility.parallel_eligible_state !== 'parallel_eligible'
    || parallelEligibility.serial_quarantine_state !== 'serial_quarantine_required'
    || parallelEligibility.requires_logical_transaction_isolation !== true
    || parallelEligibility.writes_require_unique_fixture_metadata !== true
  ) throw new Error('Focused parallel eligibility must fail closed to serial quarantine.');
  const hazardClasses = requireArray(parallelEligibility.hazard_classes, 'focused parallel hazard classes')
    .map((value, index) => requireString(value, 'parallel hazard class ' + index, { maxLength: 120 }));
  if (hazardClasses.length !== PARALLEL_HAZARD_CLASSES.size || new Set(hazardClasses).size !== hazardClasses.length) {
    throw new Error('Focused parallel hazard classes must be complete and unique.');
  }
  for (const hazardClass of hazardClasses) {
    if (!PARALLEL_HAZARD_CLASSES.has(hazardClass)) throw new Error('Unknown focused parallel hazard class: ' + hazardClass);
  }
  const safeFunctions = requireArray(parallelEligibility.safe_function_allowlist, 'parallel safe function allowlist')
    .map((value, index) => requireString(value, 'parallel safe function ' + index, { maxLength: 120 }));
  if (!safeFunctions.length || new Set(safeFunctions).size !== safeFunctions.length) {
    throw new Error('Parallel safe function allowlist must be non-empty and unique.');
  }
  for (const name of safeFunctions) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new Error('Parallel safe function name is not canonical: ' + name);
  }
  const uniqueFixtureByFile = {};
  for (const entry of requireArray(parallelEligibility.unique_fixture_allowlist, 'parallel unique fixture allowlist')) {
    assertKnownKeys(entry, new Set([
      'file', 'fixture_namespace', 'source_sha256', 'state', 'evidence_ref',
      'artifact_sha256', 'accepted_by', 'accepted_at',
    ]), 'parallel unique fixture entry');
    const file = normalizePolicyFilePath(entry.file);
    if (uniqueFixtureByFile[file]) throw new Error('Duplicate parallel unique fixture file: ' + file);
    requireString(entry.fixture_namespace, 'parallel unique fixture namespace', { maxLength: 160 });
    if (!/^[a-f0-9]{64}$/u.test(String(entry.source_sha256 || ''))) throw new Error('Parallel unique fixture source digest is invalid.');
    if (entry.state !== 'cos_accepted') throw new Error('Parallel unique fixture metadata must be CoS accepted.');
    requireString(entry.evidence_ref, 'parallel unique fixture evidence_ref', { maxLength: 260 });
    if (!/^[a-f0-9]{64}$/u.test(String(entry.artifact_sha256 || ''))) throw new Error('Parallel unique fixture artifact digest is invalid.');
    requireString(entry.accepted_by, 'parallel unique fixture accepted_by', { maxLength: 120 });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(String(entry.accepted_at || ''))) {
      throw new Error('Parallel unique fixture accepted_at must be an ISO UTC timestamp.');
    }
    if (!options.cwd) throw new Error('Parallel unique fixture metadata requires local evidence verification.');
    validatePolicyFileOnDisk(options.cwd, file, discoveryRoots, options.fsImpl || fs);
    const evidencePath = path.resolve(options.cwd, entry.evidence_ref);
    if (!isPathWithin(options.cwd, evidencePath)) throw new Error('Parallel unique fixture evidence_ref escapes the active worktree.');
    const evidenceStat = (options.fsImpl || fs).lstatSync(evidencePath);
    if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink() || evidenceStat.size > 5 * 1024 * 1024) {
      throw new Error('Parallel unique fixture evidence_ref must be a safe local artifact.');
    }
    const evidenceRaw = (options.fsImpl || fs).readFileSync(evidencePath);
    if (sha256(evidenceRaw) !== entry.artifact_sha256) throw new Error('Parallel unique fixture artifact digest does not match evidence_ref.');
    uniqueFixtureByFile[file] = entry;
  }
  const allowlist = requireArray(section.collectible_failure_allowlist, 'focused collection collectible allowlist');
  const collectibleClasses = {};
  for (const entry of allowlist) {
    assertKnownKeys(entry, new Set(['failure_class', 'family', 'matcher', 'requires']), 'collectible failure entry');
    const failureClass = requireString(entry.failure_class, 'collectible failure class', { maxLength: 120 });
    if (collectibleClasses[failureClass]) throw new Error('Duplicate collectible failure class: ' + failureClass);
    if (entry.family !== 'fixture_test_only') throw new Error('Collectible failures must remain fixture_test_only.');
    assertKnownKeys(entry.matcher, new Set(['type', 'value']), 'collectible failure matcher');
    if (entry.matcher.type !== 'case_insensitive_literal') throw new Error('Collectible matchers must be case-insensitive literals.');
    requireString(entry.matcher.value, 'collectible failure literal', { maxLength: 500 });
    const seenRequirements = new Set();
    const entryRequirements = requireArray(entry.requires, 'collectible failure requirements');
    if (!entryRequirements.length) throw new Error('Collectible failure requirements cannot be empty.');
    entryRequirements.forEach((value, index) => {
      const requirement = requireString(value, 'collectible requirement ' + index, { maxLength: 120 });
      if (!COLLECTIBLE_REQUIREMENT_KEYS.has(requirement)) throw new Error('Unknown collectible failure requirement: ' + requirement);
      if (seenRequirements.has(requirement)) throw new Error('Duplicate collectible failure requirement: ' + requirement);
      seenRequirements.add(requirement);
    });
    collectibleClasses[failureClass] = entry;
  }

  const isolation = section.isolation;
  assertKnownKeys(isolation, new Set([
    'artifact_claim', 'physical_zero_leakage_claim_allowed', 'quarantine', 'cleanup_equivalence_allowlist',
  ]), 'focused_failure_collection.isolation');
  if (isolation.artifact_claim !== 'logical_transaction_isolation_verified') {
    throw new Error('Focused collection isolation wording must remain logical_transaction_isolation_verified.');
  }
  if (isolation.physical_zero_leakage_claim_allowed !== false) throw new Error('Physical zero-leakage claims must remain forbidden.');
  const quarantineByFile = {};
  for (const entry of requireArray(isolation.quarantine, 'focused collection quarantine')) {
    assertKnownKeys(entry, new Set([
      'file', 'collectible', 'isolation_state', 'quarantine_reason', 'cleanup_equivalence',
    ]), 'focused collection quarantine entry');
    const file = normalizePolicyFilePath(entry.file);
    if (quarantineByFile[file]) throw new Error('Duplicate focused collection quarantine path: ' + file);
    if (entry.collectible !== false) throw new Error('Quarantined files cannot be collectible: ' + file);
    requireString(entry.isolation_state, 'quarantine isolation_state', { maxLength: 120 });
    requireString(entry.quarantine_reason, 'quarantine reason', { maxLength: 160 });
    assertKnownKeys(entry.cleanup_equivalence, new Set(['state', 'method', 'evidence_ref', 'reason']), 'cleanup equivalence metadata');
    if (entry.cleanup_equivalence.state !== 'not_approved' || entry.cleanup_equivalence.method !== null || entry.cleanup_equivalence.evidence_ref !== null) {
      throw new Error('Initial quarantine cleanup equivalence must remain not_approved: ' + file);
    }
    requireString(entry.cleanup_equivalence.reason, 'cleanup equivalence reason', { maxLength: 240 });
    if (options.cwd) validatePolicyFileOnDisk(options.cwd, file, discoveryRoots, options.fsImpl || fs);
    quarantineByFile[file] = entry;
  }
  const cleanupAllowlist = requireArray(isolation.cleanup_equivalence_allowlist, 'cleanup equivalence allowlist');
  if (cleanupAllowlist.length) throw new Error('Initial cleanup equivalence allowlist must remain empty.');

  assertKnownKeys(section.migration_drift, new Set([
    'controlled_rebuild_limit', 'authorization_cold_start_reason', 'automatic_rebuild_allowed',
  ]), 'focused_failure_collection.migration_drift');
  requirePositiveInteger(section.migration_drift.controlled_rebuild_limit, 'controlled rebuild limit');
  requireString(section.migration_drift.authorization_cold_start_reason, 'controlled rebuild reason', { maxLength: 160 });
  if (section.migration_drift.automatic_rebuild_allowed !== false) throw new Error('Automatic focused collection rebuilds must remain disabled.');

  return {
    section,
    discovery: { roots: discoveryRoots, fileGlobs: discoveryGlobs, recursive: false, sort: discovery.sort, maxFiles: discoveryMaxFiles },
    execution,
    hostTimeoutMs,
    finalGates: { aToZ: aToZCommand, localCandidateByTargetKind },
    requestedJobs,
    batchSize,
    hardJobs,
    hostConnectionCap,
    databaseConnectionCap,
    databaseConnectionReserve,
    shrinkConditions,
    hardStopConditions,
    capacityRequirements,
    repairScheduler,
    parallelEligibility,
    uniqueFixtureByFile,
    collectibleClasses,
    quarantineByFile,
  };
}

function validateFocusedHostTimeoutMs(value) {
  const timeoutMs = requirePositiveInteger(value, 'focused pg_prove host timeout');
  if (timeoutMs < MIN_FOCUSED_HOST_TIMEOUT_MS || timeoutMs > MAX_FOCUSED_HOST_TIMEOUT_MS) {
    throw new Error('Focused pg_prove host timeout must be between ' + MIN_FOCUSED_HOST_TIMEOUT_MS + ' and ' + MAX_FOCUSED_HOST_TIMEOUT_MS + ' milliseconds.');
  }
  return timeoutMs;
}

function focusedPolicySafetyView(section) {
  const safety = JSON.parse(JSON.stringify(section));
  delete safety.execution.pilot_state;
  delete safety.parallel_waves.requested_jobs;
  delete safety.repair_scheduler.state;
  return safety;
}

function loadFocusedCollectionPolicy(cwd, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const policyPath = path.resolve(cwd, POLICY_RELATIVE_PATH);
  const stat = fsImpl.lstatSync(policyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error('Focused collection policy must be a regular non-symlink file below 1 MiB.');
  }
  const realCwd = fsImpl.realpathSync(path.resolve(cwd));
  const realPolicyPath = fsImpl.realpathSync(policyPath);
  if (!isPathWithin(realCwd, realPolicyPath)) throw new Error('Focused collection policy resolves outside the active worktree.');
  const handle = fsImpl.openSync(realPolicyPath, 'r');
  let raw;
  try {
    const openedStat = fsImpl.fstatSync(handle);
    if (!openedStat.isFile() || openedStat.size !== stat.size || openedStat.size > 1024 * 1024) {
      throw new Error('Focused collection policy changed during admission.');
    }
    raw = fsImpl.readFileSync(handle, 'utf8');
  } finally {
    fsImpl.closeSync(handle);
  }
  let policy;
  try {
    policy = JSON.parse(raw);
    assertNoDuplicateJsonKeys(raw);
  } catch (error) {
    throw new Error('Focused collection policy JSON is malformed: ' + String(error.message || error));
  }
  if (policy.version !== 1 || policy.name !== 'masarx-codex-os-v2') throw new Error('Focused collection policy root identity is invalid.');
  if (!isPlainObject(policy.focused_failure_collection)) throw new Error('Focused collection policy section is missing.');
  const normalized = validateFocusedCollectionPolicy(policy.focused_failure_collection, { cwd, fsImpl });
  return {
    ...normalized,
    policyPath,
    policyFileFingerprint: sha256(raw),
    focusedPolicyFingerprint: sha256(canonicalJson(normalized.section)),
    focusedPolicySafetyFingerprint: sha256(canonicalJson(focusedPolicySafetyView(normalized.section))),
  };
}

function resolveFocusedCollectionMode(options = {}, policy = null) {
  const collectFlag = options.collectFocusedFailures === true;
  const hasJobs = options.jobs !== undefined && options.jobs !== null && String(options.jobs).trim() !== '';
  const hasLegacyBatchSize = options.batchSize !== undefined && options.batchSize !== null && String(options.batchSize).trim() !== '';
  if (hasLegacyBatchSize) throw new Error('--batch-size is retired for focused collection; use --jobs with the parallel-wave mode.');
  if (!collectFlag && !hasJobs) return { enabled: false, mode: 'fail_fast' };
  if (!collectFlag || !hasJobs) throw new Error('--collect-focused-failures and --jobs must be provided together.');
  if (!policy || policy.section?.enabled !== true || policy.section?.mode !== 'experimental_parallel_wave_default_off') {
    throw new Error('Focused parallel-wave policy is unavailable or disabled.');
  }
  const requestedJobs = strictPositiveInteger(options.jobs, '--jobs');
  if (requestedJobs > policy.hardJobs) throw new Error('--jobs exceeds the focused parallel-wave hard ceiling.');
  if (requestedJobs !== policy.requestedJobs) {
    throw new Error('--jobs must equal the policy requested_jobs target of ' + policy.requestedJobs + '.');
  }
  const effectiveJobs = Math.min(
    requestedJobs,
    policy.batchSize,
    policy.hostConnectionCap,
    policy.databaseConnectionCap,
  );
  return validateResolvedFocusedCollectionMode({
    enabled: true,
    mode: 'focused_parallel_wave',
    engine: policy.execution.engine,
    jobsOption: policy.execution.jobs_option,
    savedState: policy.execution.saved_state,
    isolatedRerunState: policy.execution.isolated_rerun_state,
    internalHarnessBatching: policy.execution.internal_harness_batching,
    requestedJobs,
    batchSize: policy.batchSize,
    eligibleIsolatedFiles: requestedJobs,
    eligibilityResolved: false,
    effectiveJobs,
    hardJobs: policy.hardJobs,
    hostConnectionCap: policy.hostConnectionCap,
    databaseConnectionCap: policy.databaseConnectionCap,
    maxFilesPerWave: Math.min(policy.batchSize, effectiveJobs),
    adaptationReason: 'awaiting_parallel_eligibility',
    parallelFailureClassification: policy.execution.parallel_failure_classification,
    pilotAuthorized: policy.execution.pilot_state === 'cos_authorized',
    isolatedRerunJobs: policy.execution.isolated_rerun_jobs,
    finalGatesSerial: policy.execution.final_a_to_z_serial && policy.execution.final_local_candidate_serial,
  });
}

function adaptFocusedCollectionModeToEligibility(modeValue, eligibleIsolatedFiles) {
  const mode = validateResolvedFocusedCollectionMode(modeValue);
  if (!Number.isInteger(eligibleIsolatedFiles) || eligibleIsolatedFiles < 0) {
    throw new Error('Focused parallel-wave eligible isolated file count must be a nonnegative integer.');
  }
  const effectiveJobs = Math.min(
    mode.requestedJobs,
    mode.batchSize,
    eligibleIsolatedFiles,
    mode.hostConnectionCap,
    mode.databaseConnectionCap,
  );
  return validateResolvedFocusedCollectionMode({
    ...mode,
    eligibleIsolatedFiles,
    eligibilityResolved: true,
    effectiveJobs,
    maxFilesPerWave: Math.min(mode.batchSize, effectiveJobs),
    adaptationReason: effectiveJobs === 0
      ? 'no_parallel_eligible_files_serial_quarantine_only'
      : (effectiveJobs < mode.requestedJobs
        ? 'shrunk_to_eligible_or_policy_capacity'
        : 'requested_jobs_within_eligible_policy_capacity'),
  });
}

function validateResolvedFocusedCollectionMode(mode) {
  assertKnownKeys(mode, new Set([
    'enabled', 'mode', 'engine', 'jobsOption', 'savedState', 'isolatedRerunState',
    'internalHarnessBatching', 'requestedJobs', 'batchSize', 'eligibleIsolatedFiles',
    'eligibilityResolved', 'effectiveJobs', 'hardJobs', 'hostConnectionCap',
    'databaseConnectionCap', 'maxFilesPerWave', 'adaptationReason', 'parallelFailureClassification',
    'isolatedRerunJobs', 'finalGatesSerial', 'pilotAuthorized',
  ]), 'resolved focused parallel-wave mode');
  if (
    mode.enabled !== true || mode.mode !== 'focused_parallel_wave' || mode.engine !== 'pg_prove'
    || mode.jobsOption !== '--jobs' || mode.savedState !== 'save' || mode.isolatedRerunState !== 'save'
    || mode.internalHarnessBatching !== false
  ) {
    throw new Error('Resolved focused parallel-wave mode is not enabled.');
  }
  for (const key of ['requestedJobs', 'batchSize', 'hardJobs', 'hostConnectionCap', 'databaseConnectionCap', 'isolatedRerunJobs']) {
    requirePositiveInteger(mode[key], 'resolved focused parallel-wave ' + key);
  }
  if (!Number.isInteger(mode.eligibleIsolatedFiles) || mode.eligibleIsolatedFiles < 0) {
    throw new Error('Resolved focused parallel-wave eligible isolated files must be nonnegative.');
  }
  if (!Number.isInteger(mode.effectiveJobs) || mode.effectiveJobs < 0 || !Number.isInteger(mode.maxFilesPerWave) || mode.maxFilesPerWave < 0) {
    throw new Error('Resolved focused parallel-wave adaptive bounds must be nonnegative integers.');
  }
  const expectedEffectiveJobs = Math.min(
    mode.requestedJobs,
    mode.batchSize,
    mode.eligibleIsolatedFiles,
    mode.hostConnectionCap,
    mode.databaseConnectionCap,
  );
  if (
    mode.requestedJobs > mode.hardJobs
    || mode.batchSize > mode.hardJobs
    || mode.hostConnectionCap > mode.hardJobs
    || mode.databaseConnectionCap > mode.hardJobs
    || mode.effectiveJobs !== expectedEffectiveJobs
    || mode.maxFilesPerWave !== Math.min(mode.batchSize, mode.effectiveJobs)
    || mode.isolatedRerunJobs !== 1
    || mode.parallelFailureClassification !== 'triage_only_until_isolated_serial_rerun'
    || typeof mode.pilotAuthorized !== 'boolean'
    || mode.finalGatesSerial !== true
  ) throw new Error('Resolved focused parallel-wave mode has inconsistent safety bounds.');
  if (typeof mode.eligibilityResolved !== 'boolean') throw new Error('Resolved focused parallel-wave eligibility state is invalid.');
  const expectedReason = mode.eligibilityResolved !== true
    ? 'awaiting_parallel_eligibility'
    : (mode.effectiveJobs === 0
      ? 'no_parallel_eligible_files_serial_quarantine_only'
      : (mode.effectiveJobs < mode.requestedJobs
        ? 'shrunk_to_eligible_or_policy_capacity'
        : 'requested_jobs_within_eligible_policy_capacity'));
  if (mode.adaptationReason !== expectedReason) throw new Error('Resolved focused parallel-wave adaptation is inconsistent.');
  return mode;
}
function normalizeRequestedFocusedFile(value, discovery = null) {
  const input = requireString(value, 'focused pgTAP file', { maxLength: 300 }).replace(/\\/gu, '/');
  if (input.includes('\0') || path.posix.isAbsolute(input) || /(^|\/)\.\.(\/|$)/u.test(input)) {
    throw new Error('Focused pgTAP file path is unsafe: ' + input);
  }
  const roots = discovery?.roots || [];
  const relative = input.includes('/') ? input : (roots.length === 1 ? roots[0] + '/' + input : input);
  const root = roots.length ? roots.find((candidate) => relative.startsWith(candidate + '/')) : path.posix.dirname(relative);
  if (!root || root === '.' || (roots.length && !roots.includes(root))) throw new Error('Focused pgTAP file is outside configured discovery roots.');
  const baseName = path.posix.basename(relative);
  if (!baseName || path.posix.dirname(relative) !== root) throw new Error('Focused pgTAP files must be top-level within one configured discovery root.');
  assertCanonicalPgtapBaseName(baseName, 'Focused pgTAP file');
  const extensions = (discovery?.fileGlobs || ['*.sql']).map((glob) => glob.slice(1));
  if (!extensions.some((extension) => baseName.endsWith(extension))) throw new Error('Focused pgTAP file does not match configured discovery globs.');
  if (input.includes('/') && input !== root + '/' + baseName) throw new Error('Focused pgTAP files must use the canonical repository path.');
  return relative;
}

function buildSortedFocusedQueue(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const fsImpl = options.fsImpl || fs;
  const discovery = options.policy?.discovery || options.discovery;
  if (!discovery?.roots?.length) throw new Error('Focused collection requires validated discovery policy.');
  const requested = requireArray(options.requestedFiles, 'requested focused files');
  if (!requested.length) throw new Error('Focused collection requires at least one requested file.');
  if (requested.length > discovery.maxFiles) throw new Error('Focused collection requested queue exceeds the policy safety limit.');
  const rootFacts = new Map(discovery.roots.map((root) => {
    const absolute = path.resolve(cwd, root.replace(/\//gu, path.sep));
    const stat = fsImpl.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Focused discovery root must be a canonical non-symlink directory: ' + root);
    return [root, { absolute, real: fsImpl.realpathSync(absolute), names: fsImpl.readdirSync(absolute) }];
  }));
  const seen = new Set();
  const sourceOrder = [];
  for (const value of requested) {
    const file = normalizeRequestedFocusedFile(value, discovery);
    const duplicateKey = file.toLowerCase();
    if (seen.has(duplicateKey)) throw new Error('Duplicate focused pgTAP file: ' + file);
    seen.add(duplicateKey);
    const root = discovery.roots.find((candidate) => file.startsWith(candidate + '/'));
    const rootFact = rootFacts.get(root);
    const absolute = path.resolve(cwd, file.replace(/\//gu, path.sep));
    if (!isPathWithin(rootFact.absolute, absolute)) throw new Error('Focused pgTAP path escapes its discovery root: ' + file);
    const stat = fsImpl.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) {
      throw new Error('Focused pgTAP path must be a regular non-symlink file below 5 MiB: ' + file);
    }
    const realFile = fsImpl.realpathSync(absolute);
    if (!isPathWithin(rootFact.real, realFile)) throw new Error('Focused pgTAP path resolves outside its discovery root: ' + file);
    const expectedName = path.posix.basename(file);
    const matchingNames = rootFact.names.filter((entry) => entry.toLowerCase() === expectedName.toLowerCase());
    if (matchingNames.length !== 1 || matchingNames[0] !== expectedName) {
      throw new Error('Focused pgTAP path must use unique canonical filesystem case: ' + file);
    }
    const handle = fsImpl.openSync(realFile, 'r');
    let source;
    try {
      const openedStat = fsImpl.fstatSync(handle);
      if (!openedStat.isFile() || openedStat.size !== stat.size || openedStat.size > 5 * 1024 * 1024) {
        throw new Error('Focused pgTAP file changed during admission: ' + file);
      }
      source = fsImpl.readFileSync(handle);
    } finally {
      fsImpl.closeSync(handle);
    }
    sourceOrder.push({
      path: file,
      absolutePath: realFile,
      digest: sha256(source),
    });
  }
  const sortedQueue = [...sourceOrder].sort((left, right) => compareAscii(left.path, right.path));
  const manifest = sortedQueue.map((entry) => ({ path: entry.path, digest: entry.digest }));
  return {
    sourceOrder,
    sortedQueue,
    queueManifest: manifest,
    queueDigest: sha256(canonicalJson(manifest)),
  };
}

function buildCanonicalFocusedManifest(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const fsImpl = options.fsImpl || fs;
  const policy = options.policy;
  const identity = options.identity;
  if (!policy?.discovery?.roots?.length || !identity?.bindingFingerprint) throw new Error('Canonical focused manifest requires validated policy and target identity.');
  const records = [];
  for (const root of policy.discovery.roots) {
    const absoluteRoot = path.resolve(cwd, root.replace(/\//gu, path.sep));
    const stat = fsImpl.lstatSync(absoluteRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Canonical focused manifest root is unsafe: ' + root);
    const realRoot = fsImpl.realpathSync(absoluteRoot);
    for (const name of fsImpl.readdirSync(absoluteRoot).sort(compareAscii)) {
      if (!policy.discovery.fileGlobs.some((glob) => name.endsWith(glob.slice(1)))) continue;
      assertCanonicalPgtapBaseName(name, 'Canonical focused manifest file');
      const file = root + '/' + name;
      const absolute = path.resolve(absoluteRoot, name);
      const fileStat = fsImpl.lstatSync(absolute);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 5 * 1024 * 1024) throw new Error('Canonical focused manifest file is unsafe: ' + file);
      const realFile = fsImpl.realpathSync(absolute);
      if (!isPathWithin(realRoot, realFile)) throw new Error('Canonical focused manifest file resolves outside its root: ' + file);
      const handle = fsImpl.openSync(realFile, 'r');
      let body;
      try {
        const openedStat = fsImpl.fstatSync(handle);
        if (!openedStat.isFile() || openedStat.size !== fileStat.size || openedStat.size > 5 * 1024 * 1024) {
          throw new Error('Canonical focused manifest file changed during admission: ' + file);
        }
        body = fsImpl.readFileSync(handle);
      } finally {
        fsImpl.closeSync(handle);
      }
      records.push({ path: file, digest: sha256(body) });
    }
  }
  records.sort((left, right) => compareAscii(left.path, right.path));
  if (!records.length || records.length > policy.discovery.maxFiles) throw new Error('Canonical focused manifest file count is invalid.');
  const binding = {
    repoId: identity.repoId,
    repoPath: identity.repoPath,
    worktreeId: identity.worktreeId,
    worktreePath: identity.worktreePath,
    targetKind: identity.targetKind,
    targetId: identity.targetId,
    branch: identity.branch,
    headSha: identity.headSha,
    policyFileFingerprint: identity.policyFileFingerprint,
    focusedPolicyFingerprint: identity.focusedPolicyFingerprint,
    focusedPolicySafetyFingerprint: identity.focusedPolicySafetyFingerprint,
    migrationFingerprintDigest: identity.migrationFingerprint.digest,
    identityBindingFingerprint: identity.bindingFingerprint,
    lineageFingerprint: identity.lineageFingerprint,
  };
  const manifest = {
    schema: 'pr-validation-session.focused-file-manifest.v1',
    binding,
    fileCount: records.length,
    files: records,
    queueDigest: sha256(canonicalJson(records)),
  };
  manifest.contentSha256 = sha256(canonicalJson(manifest));
  return manifest;
}

function validateCanonicalFocusedManifest(manifest, identity) {
  if (manifest?.schema !== 'pr-validation-session.focused-file-manifest.v1') throw new Error('Canonical focused manifest schema is invalid.');
  const copy = JSON.parse(JSON.stringify(manifest));
  const digest = copy.contentSha256;
  delete copy.contentSha256;
  if (sha256(canonicalJson(copy)) !== digest) throw new Error('Canonical focused manifest content digest is invalid.');
  if (!Array.isArray(manifest.files) || manifest.fileCount !== manifest.files.length || !manifest.files.length) throw new Error('Canonical focused manifest file count is invalid.');
  if (manifest.queueDigest !== sha256(canonicalJson(manifest.files))) throw new Error('Canonical focused manifest queue digest is invalid.');
  const expectedBinding = {
    repoId: identity.repoId, repoPath: identity.repoPath, worktreeId: identity.worktreeId, worktreePath: identity.worktreePath,
    targetKind: identity.targetKind, targetId: identity.targetId, branch: identity.branch, headSha: identity.headSha,
    policyFileFingerprint: identity.policyFileFingerprint, focusedPolicyFingerprint: identity.focusedPolicyFingerprint,
    focusedPolicySafetyFingerprint: identity.focusedPolicySafetyFingerprint,
    migrationFingerprintDigest: identity.migrationFingerprint.digest,
    identityBindingFingerprint: identity.bindingFingerprint, lineageFingerprint: identity.lineageFingerprint,
  };
  if (canonicalJson(manifest.binding) !== canonicalJson(expectedBinding)) throw new Error('Canonical focused manifest target binding is stale or cross-target.');
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index];
    normalizeRequestedFocusedFile(entry.path, { roots: [path.posix.dirname(entry.path)], fileGlobs: ['*.sql'] });
    if (!/^[a-f0-9]{64}$/u.test(String(entry.digest || '')) || (index && compareAscii(manifest.files[index - 1].path, entry.path) >= 0)) {
      throw new Error('Canonical focused manifest files are not uniquely sorted and digest-bound.');
    }
  }
  return manifest;
}

function validateFocusedPromotionEvidence(value = {}, expectedJobs, options = {}) {
  assertKnownKeys(value, new Set([
    'accepted', 'clean', 'requestedJobs', 'environmentFingerprint', 'durableSameEnvironment',
    'hostCpuGreen', 'hostMemoryGreen', 'databaseCapacityKnown', 'lockWaitCount',
    'deadlockCount', 'serializationFailureCount', 'serializationEvidence', 'activeRunnerPressureGreen',
    'contaminationStable', 'policyPermission',
  ]), 'focused requested-job promotion evidence');
  const serializationEvidence = value.serializationEvidence;
  if (!isPlainObject(serializationEvidence)) throw new Error('Focused requested-job promotion serialization evidence is missing.');
  assertKnownKeys(serializationEvidence, new Set([
    'source', 'observedBefore', 'observedAfter', 'observedSqlstate40001Count',
    'waveOutputDigests', 'artifactSha256',
  ]), 'focused promotion serialization evidence');
  const serializationPayload = { ...serializationEvidence };
  delete serializationPayload.artifactSha256;
  const serializationEvidenceGreen = serializationEvidence.source === 'structured_pg_prove_output'
    && serializationEvidence.observedBefore === 0
    && serializationEvidence.observedAfter === 0
    && serializationEvidence.observedSqlstate40001Count === 0
    && Array.isArray(serializationEvidence.waveOutputDigests)
    && serializationEvidence.waveOutputDigests.length > 0
    && serializationEvidence.waveOutputDigests.every((digest) => /^[a-f0-9]{64}$/u.test(String(digest || '')))
    && serializationEvidence.artifactSha256 === sha256(canonicalJson(serializationPayload));
  if (value.accepted !== true || value.clean !== true || value.requestedJobs !== expectedJobs
    || !/^[a-f0-9]{64}$/u.test(String(value.environmentFingerprint || ''))
    || value.hostCpuGreen !== true || value.hostMemoryGreen !== true
    || value.databaseCapacityKnown !== true || value.activeRunnerPressureGreen !== true
    || value.contaminationStable !== true || value.policyPermission !== true
    || value.lockWaitCount !== 0 || value.deadlockCount !== 0 || value.serializationFailureCount !== 0
    || serializationEvidenceGreen !== true
    || (options.requireDurableSameEnvironment === true && value.durableSameEnvironment !== true)) {
    throw new Error('Focused requested-job promotion evidence is missing, contended, unknown, or not accepted.');
  }
  return value;
}

function resolveFocusedRequestedJobsPromotion(options = {}) {
  const policy = options.policy;
  const current = strictPositiveInteger(options.currentRequestedJobs, 'current focused requested jobs');
  const requested = strictPositiveInteger(options.requestedJobs, 'next focused requested jobs');
  if (!policy || policy.hardJobs !== 60 || requested > 60 || current > 60) throw new Error('Focused requested jobs exceed the configurable hard ceiling of 60.');
  if (requested <= current) return { requestedJobs: requested, promotion: 'same_or_adaptive_shrink', evidence: null };
  if (current === 30 && requested === 45) {
    validateFocusedPromotionEvidence(options.evidence, 30);
    return { requestedJobs: 45, promotion: 'clean_accepted_30_to_45', evidence: options.evidence };
  }
  if (current === 45 && requested === 60) {
    validateFocusedPromotionEvidence(options.evidence, 45);
    return { requestedJobs: 60, promotion: 'clean_accepted_45_to_60', evidence: options.evidence };
  }
  if (requested === 60 && options.futureStablePr === true) {
    validateFocusedPromotionEvidence(options.evidence, 60, { requireDurableSameEnvironment: true });
    return { requestedJobs: 60, promotion: 'durable_same_environment_direct_to_60', evidence: options.evidence };
  }
  throw new Error('Focused requested jobs must follow the measured 30 to 45 to 60 promotion gates.');
}

module.exports = {
  MAX_FOCUSED_HOST_TIMEOUT_MS,
  MIN_FOCUSED_HOST_TIMEOUT_MS,
  adaptFocusedCollectionModeToEligibility,
  buildCanonicalFocusedManifest,
  buildSortedFocusedQueue,
  focusedPolicySafetyView,
  loadFocusedCollectionPolicy,
  normalizeRequestedFocusedFile,
  resolveFocusedCollectionMode,
  resolveFocusedRequestedJobsPromotion,
  validateResolvedFocusedCollectionMode,
  validateCanonicalFocusedManifest,
  validateFocusedCollectionPolicy,
  validateFocusedHostTimeoutMs,
  validateFocusedPromotionEvidence,
};
