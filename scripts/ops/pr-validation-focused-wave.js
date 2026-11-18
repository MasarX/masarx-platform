#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const {
  COLLECTION_SCHEMA,
  assertKnownKeys,
  canonicalJson,
  compareAscii,
  ensureSafeDirectoryWithin,
  isPathWithin,
  requirePositiveInteger,
  sha256,
} = require('./pr-validation-focused-common');
const {
  adaptFocusedCollectionModeToEligibility,
  normalizeRequestedFocusedFile,
  validateCanonicalFocusedManifest,
  validateResolvedFocusedCollectionMode,
} = require('./pr-validation-focused-policy');
const {
  buildFocusedCollectionIdentity,
  classifyFocusedFileDisposition,
  normalizeFocusedGuardSummary,
  redactFocusedFailureExcerpt,
  writeJsonAtomic,
} = require('./pr-validation-focused-state');
const { validateFocusedRepairSchedulerState } = require('./pr-validation-focused-scheduler');

const LOCK_SERIALIZATION_CLASSES = Object.freeze([
  'none_observed',
  'lock_wait',
  'deadlock',
  'serialization_failure',
  'statement_timeout',
  'connection_failure',
  'unknown_parallel_failure',
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('Focused parallel-wave timestamp must be canonical ISO UTC.');
  }
  return value;
}

function exactSha(value, label) {
  const text = String(value || '');
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new Error(label + ' must be a sha256 digest.');
  return text;
}

function classifyLockSerialization(value) {
  const text = String(value || '');
  if (/\b40P01\b|deadlock detected/iu.test(text)) return 'deadlock';
  if (/\b40001\b|could not serialize access|serialization failure/iu.test(text)) return 'serialization_failure';
  if (/lock timeout|canceling statement due to lock timeout|waiting for .* lock/iu.test(text)) return 'lock_wait';
  if (/statement timeout|canceling statement due to statement timeout/iu.test(text)) return 'statement_timeout';
  if (/connection (?:refused|reset|closed)|server closed the connection|terminating connection/iu.test(text)) return 'connection_failure';
  return /\b(?:ERROR|FATAL|PANIC|SQLSTATE)\b/iu.test(text) ? 'unknown_parallel_failure' : 'none_observed';
}

function normalizeContaminationCheck(value, label = 'contamination check') {
  assertKnownKeys(value, new Set([
    'checkedAt', 'beforeDigest', 'afterDigest', 'stable', 'sequenceDeltaCount',
    'sequenceDeltas', 'sharedRowDeltaCount', 'lockResidueCount', 'lockDeltas',
    'backgroundActivityDeltaCount', 'backgroundActivityDeltas',
  ]), label);
  const out = cloneJson(value);
  const parsed = new Date(out.checkedAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== out.checkedAt) {
    throw new Error(label + ' checkedAt must be canonical ISO UTC.');
  }
  exactSha(out.beforeDigest, label + ' beforeDigest');
  exactSha(out.afterDigest, label + ' afterDigest');
  for (const key of ['sequenceDeltaCount', 'sharedRowDeltaCount', 'lockResidueCount', 'backgroundActivityDeltaCount']) {
    if (!Number.isInteger(out[key]) || out[key] < 0) throw new Error(label + ' ' + key + ' must be a nonnegative integer.');
  }
  for (const [key, countKey] of [
    ['sequenceDeltas', 'sequenceDeltaCount'],
    ['lockDeltas', 'lockResidueCount'],
    ['backgroundActivityDeltas', 'backgroundActivityDeltaCount'],
  ]) {
    if (out[key] === undefined) continue;
    if (!Array.isArray(out[key]) || out[key].length !== out[countKey]) {
      throw new Error(label + ' ' + key + ' must match ' + countKey + '.');
    }
    for (const delta of out[key]) {
      assertKnownKeys(delta, new Set(['identity', 'before', 'after']), label + ' ' + key + ' entry');
      if (!delta.identity || typeof delta.identity !== 'object' || Array.isArray(delta.identity)) {
        throw new Error(label + ' ' + key + ' identity must be an object.');
      }
      if (delta.before === null && delta.after === null) {
        throw new Error(label + ' ' + key + ' entry must contain before or after evidence.');
      }
    }
  }
  const expectedStable = out.beforeDigest === out.afterDigest
    && out.sequenceDeltaCount === 0
    && out.sharedRowDeltaCount === 0
    && out.lockResidueCount === 0
    && out.backgroundActivityDeltaCount === 0;
  if (out.stable !== expectedStable) throw new Error(label + ' stable flag is inconsistent.');
  return out;
}

function buildPgProveWaveInvocation(options = {}) {
  const mode = validateResolvedFocusedCollectionMode(options.mode);
  const phase = String(options.phase || 'parallel_wave');
  if (!new Set(['parallel_wave', 'isolated_rerun', 'serial_quarantine']).has(phase)) {
    throw new Error('pg_prove focused phase is unsupported.');
  }
  const files = (options.files || []).map(normalizeRequestedFocusedFile).sort(compareAscii);
  if (!files.length || new Set(files).size !== files.length) throw new Error('pg_prove focused invocation requires unique files.');
  if (phase === 'parallel_wave' && mode.effectiveJobs < 1) {
    throw new Error('pg_prove parallel wave requires at least one eligible capacity-admitted file.');
  }
  const jobs = phase === 'parallel_wave' ? Math.min(mode.effectiveJobs, files.length) : 1;
  if (phase === 'parallel_wave' && files.length > mode.maxFilesPerWave) {
    throw new Error('pg_prove parallel wave exceeds the effective job bound.');
  }
  if (phase !== 'parallel_wave' && files.length !== 1) {
    throw new Error('Every isolated or quarantined pgTAP execution must contain exactly one file.');
  }
  const rawStateDirectory = String(options.stateDirectory || '');
  if (!rawStateDirectory || !path.isAbsolute(rawStateDirectory)) throw new Error('pg_prove state directory must be absolute.');
  const stateDirectory = path.resolve(rawStateDirectory);
  const executionRoot = path.resolve(options.cwd || process.cwd());
  if (!isPathWithin(executionRoot, stateDirectory)) {
    throw new Error('pg_prove state directory must stay inside the active worktree.');
  }
  const args = [
    '--norc', '--ext', '.sql', mode.jobsOption, String(jobs), '--timer', '--verbose', '--nocolor',
    '--state', phase === 'isolated_rerun' ? mode.isolatedRerunState : mode.savedState,
  ];
  for (const [flag, key] of [['--dbname', 'database'], ['--host', 'host'], ['--port', 'port'], ['--username', 'username']]) {
    const value = String(options.connection?.[key] || '');
    const valid = key === 'port'
      ? /^\d{1,5}$/u.test(value) && Number(value) > 0 && Number(value) <= 65535
      : /^[A-Za-z0-9_.:-]{1,160}$/u.test(value);
    if (!valid) throw new Error('pg_prove connection ' + key + ' is invalid.');
    args.push(flag, value);
  }
  const absoluteFiles = files.map((file) => path.resolve(executionRoot, file));
  if (absoluteFiles.some((file) => !isPathWithin(executionRoot, file))) {
    throw new Error('pg_prove focused file escapes the active worktree.');
  }
  const executionFiles = options.executionFiles == null
    ? absoluteFiles
    : options.executionFiles.map((file) => path.resolve(String(file || '')));
  if (
    executionFiles.length !== files.length
    || executionFiles.some((file) => !isPathWithin(stateDirectory, file) || !file.endsWith('.sql'))
  ) throw new Error('pg_prove wrapper files must map one-to-one beneath the session state directory.');
  args.push(...executionFiles);
  return {
    command: 'pg_prove',
    args,
    cwd: stateDirectory,
    phase,
    jobs,
    files,
    executionFiles,
    stateFile: path.join(
      stateDirectory,
      options.executionPlatform === 'linux' ? '.pg_prove' : (process.platform === 'win32' ? '_pg_prove' : '.pg_prove'),
    ),
    internalHarnessBatching: mode.internalHarnessBatching,
    oneRuntimeDatabase: true,
    separateConnections: true,
  };
}

function buildPgProveWrapperSql(options = {}) {
  const file = normalizeRequestedFocusedFile(options.file);
  const jobOrdinal = requirePositiveInteger(options.jobOrdinal, 'pg_prove job ordinal');
  const digest = exactSha(options.sourceSha256, 'pg_prove wrapper source digest');
  const fileKey = sha256(file);
  const requestedSource = String(options.sourcePath || '');
  let resolvedSource;
  if (requestedSource) {
    const normalized = requestedSource.replace(/\\/gu, '/');
    if (!normalized.startsWith('/') || normalized.includes('/../') || normalized.includes("'") || !normalized.endsWith(`/${file}`)) {
      throw new Error('pg_prove wrapper source path is not the exact mounted canonical file.');
    }
    resolvedSource = normalized;
  } else {
    resolvedSource = path.resolve(options.cwd || process.cwd(), file).replace(/\\/gu, '/');
  }
  const absolute = resolvedSource.replace(/'/gu, "''");
  return [
    "\\set ON_ERROR_STOP 1",
    "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS masarx_started_ms \\gset",
    "SELECT diag('MASARX_PG_PROVE_JOB job=" + jobOrdinal + " backend_pid=' || pg_backend_pid() || ' file_key=" + fileKey + " file_sha256=" + digest + "');",
    "\\ir '" + absolute + "'",
    "SELECT diag('MASARX_PG_PROVE_DONE job=" + jobOrdinal + " backend_pid=' || pg_backend_pid() || ' file_key=" + fileKey + " file_sha256=" + digest + " elapsed_ms=' || GREATEST(0, (extract(epoch FROM clock_timestamp()) * 1000)::bigint - :masarx_started_ms));",
    '',
  ].join('\n');
}
function normalizeExpectedMarker(expected = {}) {
  return {
    jobOrdinal: requirePositiveInteger(expected.jobOrdinal, 'expected pg_prove job ordinal'),
    fileKey: exactSha(expected.fileKey, 'expected pg_prove file key'),
    sourceSha256: exactSha(expected.sourceSha256, 'expected pg_prove file digest'),
  };
}

function parsePgProveWorkerMarker(output, expectedValue) {
  const expected = normalizeExpectedMarker(expectedValue);
  const matches = [...String(output || '').matchAll(/MASARX_PG_PROVE_JOB job=(\d+) backend_pid=(\d+) file_key=([a-f0-9]{64}) file_sha256=([a-f0-9]{64})/gu)]
    .filter((match) => Number(match[1]) === expected.jobOrdinal && match[3] === expected.fileKey && match[4] === expected.sourceSha256);
  if (matches.length !== 1) {
    throw new Error('pg_prove worker marker is missing, duplicated, or not file-bound.');
  }
  return {
    jobOrdinal: Number(matches[0][1]),
    backendPid: Number(matches[0][2]),
    fileKey: matches[0][3],
    markerObserved: true,
  };
}

function parsePgProveCompletionMarker(output, expectedValue) {
  const expected = normalizeExpectedMarker(expectedValue);
  const matches = [...String(output || '').matchAll(/MASARX_PG_PROVE_DONE job=(\d+) backend_pid=(\d+) file_key=([a-f0-9]{64}) file_sha256=([a-f0-9]{64}) elapsed_ms=(\d+)/gu)]
    .filter((match) => Number(match[1]) === expected.jobOrdinal && match[3] === expected.fileKey && match[4] === expected.sourceSha256);
  if (matches.length !== 1) {
    throw new Error('pg_prove completion marker is missing, duplicated, or not file-bound.');
  }
  return {
    jobOrdinal: Number(matches[0][1]),
    backendPid: Number(matches[0][2]),
    fileKey: matches[0][3],
    elapsedMs: Number(matches[0][5]),
    markerObserved: true,
  };
}

function buildFocusedParallelWavePlan(options = {}) {
  let mode = validateResolvedFocusedCollectionMode(options.mode);
  const focusedManifest = validateCanonicalFocusedManifest(options.focusedManifest, options.identity);
  const queue = options.queue;
  if (!queue?.sortedQueue?.length || !/^[a-f0-9]{64}$/u.test(String(queue.queueDigest || ''))) {
    throw new Error('Focused parallel-wave plan requires a canonical sorted queue.');
  }
  const queueManifest = queue.sortedQueue.map((entry) => ({ path: entry.path, digest: entry.digest }));
  if (sha256(canonicalJson(queueManifest)) !== queue.queueDigest) {
    throw new Error('Focused parallel-wave queue digest does not match its sorted manifest.');
  }
  const manifestByPath = new Map(focusedManifest.files.map((entry) => [entry.path, entry.digest]));
  if (queueManifest.some((entry) => manifestByPath.get(entry.path) !== entry.digest)) {
    throw new Error('Focused selected queue is not an exact digest-bound subset of the canonical focused manifest.');
  }
  const records = queue.sortedQueue.map((entry, index) => {
    const normalizedPath = normalizeRequestedFocusedFile(entry.path);
    if (normalizedPath !== entry.path || !/^[a-f0-9]{64}$/u.test(String(entry.digest || ''))) {
      throw new Error('Focused parallel-wave queue entry is not canonical.');
    }
    if (index > 0 && compareAscii(queue.sortedQueue[index - 1].path, entry.path) >= 0) {
      throw new Error('Focused parallel-wave queue must remain strictly filesystem sorted.');
    }
    const isolation = options.isolationByFile?.[entry.path];
    const eligibility = options.parallelEligibilityByFile?.[entry.path];
    if (!isolation || isolation.file !== entry.path || isolation.sourceSha256 !== entry.digest) {
      throw new Error('Focused parallel-wave isolation evidence is missing or stale: ' + entry.path);
    }
    if (!eligibility || eligibility.file !== entry.path || eligibility.sourceSha256 !== entry.digest) {
      throw new Error('Focused parallel-wave eligibility evidence is missing or stale: ' + entry.path);
    }
    const lane = isolation.eligible === true && isolation.isolationState === 'logical_transaction_isolation_verified'
      && eligibility.eligible === true && eligibility.parallelState === 'parallel_eligible'
      ? 'parallel_wave'
      : 'serial_quarantine';
    return {
      path: entry.path,
      digest: entry.digest,
      queueIndex: index,
      lane,
      isolation,
      parallelEligibility: eligibility,
    };
  });
  const parallelRecords = records.filter((entry) => entry.lane === 'parallel_wave');
  mode = adaptFocusedCollectionModeToEligibility(mode, parallelRecords.length);
  const waves = [];
  for (let offset = 0; offset < parallelRecords.length; offset += mode.maxFilesPerWave) {
    const files = parallelRecords.slice(offset, offset + mode.maxFilesPerWave).map((entry) => entry.path);
    waves.push({
      number: waves.length + 1,
      jobs: mode.effectiveJobs,
      files,
    });
  }
  const serialQuarantine = records.filter((entry) => entry.lane === 'serial_quarantine').map((entry) => entry.path);
  const manifest = records.map((entry) => ({
    path: entry.path,
    digest: entry.digest,
    lane: entry.lane,
    parallelState: entry.parallelEligibility.parallelState,
  }));
  const queueScope = canonicalJson(queueManifest) === canonicalJson(focusedManifest.files)
    && queue.queueDigest === focusedManifest.queueDigest
    ? 'complete_focused_chain'
    : 'pilot_subset';
  const selected = new Set(queueManifest.map((entry) => entry.path));
  const manifestRemainder = focusedManifest.files
    .filter((entry) => !selected.has(entry.path))
    .map((entry) => entry.path);
  return {
    schema: COLLECTION_SCHEMA,
    mode,
    queueDigest: queue.queueDigest,
    queueScope,
    focusedManifest,
    manifestRemainder,
    manifest,
    records,
    waves,
    serialQuarantine,
    planDigest: sha256(canonicalJson({
      mode, queueDigest: queue.queueDigest, queueScope, focusedManifest, manifest, waves, serialQuarantine,
    })),
  };
}

function baseFileRecord(entry, waves) {
  const wave = waves.find((item) => item.files.includes(entry.path));
  return {
    path: entry.path,
    digest: entry.digest,
    queueIndex: entry.queueIndex,
    lane: entry.lane,
    waveNumber: wave?.number || null,
    status: entry.lane === 'parallel_wave' ? 'pending_parallel' : 'pending_serial_quarantine',
    isolation: entry.isolation,
    parallelEligibility: entry.parallelEligibility,
    worker: null,
    elapsedMs: null,
    lockSerializationClass: 'none_observed',
    parallelResult: null,
    isolatedRerun: null,
    finalSerializedResult: null,
    failedHistory: [],
    contaminationChecks: [],
  };
}

function createFocusedParallelWaveState(plan, identityValues, options = {}) {
  if (plan?.schema !== COLLECTION_SCHEMA) throw new Error('Focused parallel-wave plan schema is unsupported.');
  const identity = buildFocusedCollectionIdentity(identityValues);
  validateCanonicalFocusedManifest(plan.focusedManifest, identity);
  const queueScope = plan.queueScope;
  if (!new Set(['pilot_subset', 'complete_focused_chain']).has(queueScope)) throw new Error('Focused parallel-wave plan queue scope is invalid.');
  return {
    schema: COLLECTION_SCHEMA,
    revision: 0,
    status: 'pending',
    startedAt: nowIso(options),
    updatedAt: nowIso(options),
    identity,
    planDigest: plan.planDigest,
    queueDigest: plan.queueDigest,
    queueScope,
    focusedManifest: cloneJson(plan.focusedManifest),
    manifestRemainder: cloneJson(plan.manifestRemainder),
    scheduler: null,
    mode: cloneJson(plan.mode),
    waves: plan.waves.map((wave) => ({
      ...wave,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      guardBefore: null,
      guardAfter: [],
      contaminationBefore: null,
      contaminationAfter: null,
      pgProveState: null,
      capacitySampleIndex: null,
    })),
    perFile: plan.records.map((entry) => baseFileRecord(entry, plan.waves)),
    sets: {
      orderedPassSet: [],
      parallelTriageFailureSet: [],
      isolatedRerunSet: [],
      completeFailureSet: [],
      unresolvedFailureSet: [],
      collectedFailureSet: [],
      serialQuarantineSet: [...plan.serialQuarantine],
      skippedRemainder: [],
    },
    finalSerializedResult: {
      required: true,
      preGateGuard: null,
      aToZ: { state: 'pending', serial: true },
      localCandidate: { state: 'pending', serial: true, requiredRunCount: 1 },
      state: 'pending',
    },
    repairSelection: null,
    repairHistory: [],
    capacitySamples: [],
    hardStop: null,
  };
}

function skipRemainder(state, failureClass, family = 'unknown') {
  state.status = 'hard_stopped';
  state.hardStop = { family, failureClass };
  for (const entry of state.perFile) {
    if (entry.status.startsWith('pending_')) {
      entry.status = 'skipped';
      state.sets.skippedRemainder.push(entry.path);
    }
  }
  state.sets.skippedRemainder.sort(compareAscii);
}

function classifyParallelAttempt(facts = {}) {
  const output = String(facts.output || '');
  const lockSerializationClass = classifyLockSerialization(output);
  if (
    facts.interrupted !== false
    || facts.spawnError !== false
    || facts.closeObserved !== true
    || facts.timedOut !== false
    || typeof facts.signal !== 'string'
    || facts.signal
    || facts.writerMayBeActive !== false
    || !Number.isInteger(facts.exit)
    || facts.exit < 0
    || facts.exit > 1
    || lockSerializationClass !== 'none_observed'
    || (facts.hardStopSignals || []).length
  ) {
    return {
      disposition: 'hard_stop',
      failureClass: facts.hardStopSignals?.[0]?.failureClass
        || (lockSerializationClass !== 'none_observed'
          ? 'parallel_wave_' + lockSerializationClass + '_hard_stop'
          : 'parallel_wave_lifecycle_or_hard_stop'),
      family: facts.hardStopSignals?.[0]?.family || 'lifecycle',
      lockSerializationClass,
      outputDigest: sha256(redactFocusedFailureExcerpt(output, Number.POSITIVE_INFINITY)),
      excerpt: redactFocusedFailureExcerpt(output),
    };
  }
  return {
    disposition: facts.exit === 0 ? 'passed' : 'parallel_failed_triage',
    failureClass: facts.exit === 0 ? '' : 'parallel_failure_requires_isolated_rerun',
    family: facts.exit === 0 ? '' : 'triage_only',
    lockSerializationClass,
    outputDigest: sha256(redactFocusedFailureExcerpt(output, Number.POSITIVE_INFINITY)),
    excerpt: facts.exit === 0 ? '' : redactFocusedFailureExcerpt(output),
  };
}

function nextPendingFile(state) {
  const isolated = state.perFile.find((entry) => entry.status === 'pending_isolated_rerun');
  if (isolated) return isolated.path;
  const parallel = state.perFile.find((entry) => entry.status === 'pending_parallel');
  if (parallel) return parallel.path;
  const serial = state.perFile.find((entry) => entry.status === 'pending_serial_quarantine');
  if (serial) return serial.path;
  return state.perFile.find((entry) => entry.status === 'collected_failure')?.path || '';
}

function assertCompleteFocusedChain(state) {
  validateCanonicalFocusedManifest(state.focusedManifest, state.identity);
  const selected = [...state.perFile]
    .sort((left, right) => left.queueIndex - right.queueIndex)
    .map((entry) => ({ path: entry.path, digest: entry.digest }));
  if (
    state.queueScope !== 'complete_focused_chain'
    || state.manifestRemainder.length !== 0
    || canonicalJson(selected) !== canonicalJson(state.focusedManifest.files)
    || state.queueDigest !== state.focusedManifest.queueDigest
  ) throw new Error('Final serialized gates require exact canonical focused-manifest equality.');
}

function assertGuardBoundToState(guard, state, expectedFileDigest = '') {
  const identity = state.identity;
  const matches = guard.leaseId === identity.leaseId
    && guard.migrationFingerprintDigest === identity.migrationFingerprint.digest
    && guard.policyFileFingerprint === identity.policyFileFingerprint
    && guard.focusedPolicyFingerprint === identity.focusedPolicyFingerprint
    && guard.runnerFingerprint === identity.runnerFingerprint
    && guard.pgtapHarnessFingerprint === identity.pgtapHarnessFingerprint
    && guard.fixtureBootstrapFingerprint === identity.fixtureBootstrapFingerprint
    && guard.warmBaselineFingerprint === identity.warmBaselineFingerprint
    && guard.validationStackGeneration === identity.validationStackGeneration;
  if (!matches || (expectedFileDigest && guard.testFileDigest !== expectedFileDigest)) {
    throw new Error('Focused parallel-wave guard is not bound to the active owner/runtime/file.');
  }
  return guard;
}

function classifyFocusedGuardFailure(guard) {
  if (guard.hostGreen !== true) return { family: 'host_red', failureClass: 'focused_guard_host_red' };
  if (guard.migrationFingerprintStable !== true) return { family: 'migration', failureClass: 'focused_guard_migration_drift' };
  if (
    guard.policyFingerprintStable !== true
    || guard.runnerFingerprintStable !== true
    || guard.harnessFingerprintStable !== true
    || guard.fixtureBootstrapFingerprintStable !== true
  ) return { family: 'fingerprint', failureClass: 'focused_guard_contract_fingerprint_drift' };
  if (guard.dirtyGuardGreen !== true || guard.testFileDigestStable !== true) {
    return { family: 'dirty', failureClass: 'focused_guard_dirty_or_test_digest_drift' };
  }
  if (
    guard.leaseGuardGreen !== true
    || guard.processGuardGreen !== true
    || guard.heartbeatGuardGreen !== true
    || guard.overlayGuardGreen !== true
  ) return { family: 'lifecycle', failureClass: 'focused_guard_owner_runtime_lifecycle_red' };
  return { family: 'unknown', failureClass: 'focused_guard_unknown_red' };
}

function normalizeCapacitySample(value, state) {
  assertKnownKeys(value, new Set([
    'sampledAt', 'phase', 'waveNumber', 'files', 'requestedJobs', 'batchSize',
    'hostConnectionCap', 'databaseConnectionCap', 'effectiveJobs',
    'hostGreen', 'hostPressure', 'databaseCapacityKnown',
    'hostCpuGreen', 'hostMemoryGreen', 'activeRunnerPressureGreen',
    'lockWaitCount', 'deadlockCount', 'serializationFailureCount',
    'serializationFailureCountBefore', 'serializationFailureCountAfter',
    'serializationFailureDelta', 'serializationEvidence',
  ]), 'focused capacity sample');
  const sample = cloneJson(value);
  const parsed = new Date(sample.sampledAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== sample.sampledAt) throw new Error('Focused capacity sample timestamp is invalid.');
  if (!new Set(['parallel_wave', 'isolated_rerun', 'serial_quarantine', 'repaired_failed']).has(sample.phase)) throw new Error('Focused capacity sample phase is invalid.');
  if (!Array.isArray(sample.files) || !sample.files.length || new Set(sample.files).size !== sample.files.length) throw new Error('Focused capacity sample files are invalid.');
  for (const file of sample.files) {
    if (!state.perFile.some((entry) => entry.path === file)) throw new Error('Focused capacity sample escapes the selected queue.');
  }
  for (const key of ['requestedJobs', 'batchSize', 'hostConnectionCap', 'databaseConnectionCap', 'effectiveJobs']) {
    if (!Number.isInteger(sample[key]) || sample[key] < 1) throw new Error('Focused capacity sample bounds are invalid.');
  }
  if (sample.hostGreen !== true || sample.hostPressure !== false || sample.databaseCapacityKnown !== true) {
    throw new Error('Focused capacity sample is red or unknown.');
  }
  const serializationPayload = sample.serializationEvidence ? cloneJson(sample.serializationEvidence) : null;
  if (serializationPayload) delete serializationPayload.artifactSha256;
  const serializationEvidenceGreen = serializationPayload
    && new Set(['pre_admission_no_pg_prove_started', 'structured_pg_prove_output']).has(serializationPayload.source)
    && Number.isInteger(serializationPayload.observedCount)
    && Array.isArray(serializationPayload.observations)
    && serializationPayload.observations.length === serializationPayload.observedCount
    && Array.isArray(serializationPayload.sampleDigests)
    && (serializationPayload.source !== 'structured_pg_prove_output' || serializationPayload.sampleDigests.length > 0)
    && sample.serializationEvidence.artifactSha256 === sha256(canonicalJson(serializationPayload));
  if (sample.hostCpuGreen !== true || sample.hostMemoryGreen !== true
    || sample.activeRunnerPressureGreen !== true || sample.lockWaitCount !== 0
    || sample.deadlockCount !== 0 || sample.serializationFailureCount !== 0
    || serializationEvidenceGreen !== true
    || sample.serializationFailureCountBefore !== serializationPayload.observedCount
    || sample.serializationFailureCountAfter !== serializationPayload.observedCount
    || sample.serializationFailureDelta !== 0) {
    throw new Error('Focused capacity sample has contention, runner pressure, or unknown host metrics.');
  }
  if (sample.effectiveJobs !== Math.min(sample.requestedJobs, sample.batchSize, sample.files.length, sample.hostConnectionCap, sample.databaseConnectionCap)) {
    throw new Error('Focused capacity sample effective job count is inconsistent.');
  }
  return sample;
}

function rechunkPendingParallelWaves(state, effectiveJobs, sampleIndex) {
  const completed = state.waves.filter((wave) => wave.status === 'completed');
  const pendingFiles = state.waves.filter((wave) => wave.status === 'pending').flatMap((wave) => wave.files);
  const rebuilt = [];
  for (let offset = 0; offset < pendingFiles.length; offset += effectiveJobs) {
    rebuilt.push({
      number: completed.length + rebuilt.length + 1,
      jobs: effectiveJobs,
      files: pendingFiles.slice(offset, offset + effectiveJobs),
      status: 'pending', startedAt: null, finishedAt: null, guardBefore: null, guardAfter: [],
      contaminationBefore: null, contaminationAfter: null, pgProveState: null,
      capacitySampleIndex: rebuilt.length === 0 ? sampleIndex : null,
    });
  }
  state.waves = [...completed, ...rebuilt];
  for (const record of state.perFile.filter((entry) => entry.status === 'pending_parallel')) {
    record.waveNumber = state.waves.find((wave) => wave.files.includes(record.path))?.number || null;
  }
}
function reduceFocusedParallelWaveState(current, event = {}, options = {}) {
  const state = cloneJson(current);
  if (
    state.schema !== COLLECTION_SCHEMA
    || ['hard_stopped', 'final_serial_passed', 'focused_subset_terminal_passed'].includes(state.status)
  ) {
    throw new Error('Focused parallel-wave state is not reducible.');
  }
  const timestamp = nowIso(options);
  const type = String(event.type || '');

  if (type === 'capacity_sample_failed') {
    const family = String(event.family || 'host_red');
    const failureClass = String(event.failureClass || 'focused_capacity_sample_missing_or_red');
    state.capacitySamples.push({
      sampledAt: timestamp,
      phase: String(event.phase || 'unknown'),
      files: [...(event.files || [])],
      state: 'failed',
      family,
      failureClass,
      reason: redactFocusedFailureExcerpt(event.reason || '', 240),
    });
    skipRemainder(state, failureClass, family);
  } else if (type === 'capacity_sample_recorded') {
    const sample = normalizeCapacitySample(event.sample, state);
    const sampleIndex = state.capacitySamples.length;
    state.capacitySamples.push({ ...sample, state: 'green' });
    if (sample.phase === 'parallel_wave') {
      const nextWave = state.waves.find((wave) => wave.status === 'pending');
      if (!nextWave || sample.waveNumber !== nextWave.number || canonicalJson(sample.files) !== canonicalJson(nextWave.files)) {
        throw new Error('Focused capacity sample is not bound to the next pending parallel wave.');
      }
      rechunkPendingParallelWaves(state, sample.effectiveJobs, sampleIndex);
      state.mode = validateResolvedFocusedCollectionMode({
        ...state.mode,
        eligibleIsolatedFiles: sample.files.length,
        eligibilityResolved: true,
        effectiveJobs: sample.effectiveJobs,
        hostConnectionCap: sample.hostConnectionCap,
        databaseConnectionCap: sample.databaseConnectionCap,
        maxFilesPerWave: sample.effectiveJobs,
        adaptationReason: sample.effectiveJobs < sample.requestedJobs
          ? 'shrunk_to_eligible_or_policy_capacity'
          : 'requested_jobs_within_eligible_policy_capacity',
      });
    }
  } else if (type === 'wave_started') {
    const wave = state.waves.find((item) => item.number === event.waveNumber);
    const nextWave = state.waves.find((item) => item.status === 'pending');
    if (!wave || wave.status !== 'pending' || nextWave?.number !== wave.number || !Number.isInteger(wave.capacitySampleIndex)) {
      throw new Error('Focused parallel wave cannot start out of order or twice.');
    }
    if (state.waves.some((item) => item.status === 'running') || state.perFile.some((item) => item.status === 'pending_isolated_rerun')) {
      throw new Error('Only one pg_prove wave may be active and prior failures must rerun alone first.');
    }
    const guardBefore = assertGuardBoundToState(normalizeFocusedGuardSummary(event.guardBefore), state);
    const contaminationBefore = normalizeContaminationCheck(event.contaminationBefore, 'wave contamination baseline');
    if (guardBefore.allGreen !== true || contaminationBefore.stable !== true) {
      const failure = guardBefore.allGreen !== true
        ? classifyFocusedGuardFailure(guardBefore)
        : { family: 'lifecycle', failureClass: 'parallel_wave_contaminated_baseline' };
      wave.guardBefore = guardBefore;
      wave.contaminationBefore = contaminationBefore;
      skipRemainder(state, failure.failureClass, failure.family);
      state.revision += 1;
      state.updatedAt = timestamp;
      return state;
    }
    wave.status = 'running';
    wave.startedAt = timestamp;
    wave.guardBefore = guardBefore;
    wave.contaminationBefore = contaminationBefore;
    state.status = 'parallel_wave_running';
  } else if (type === 'parallel_file_finished') {
    const record = state.perFile.find((item) => item.path === event.file);
    const wave = state.waves.find((item) => item.number === record?.waveNumber);
    if (!record || record.status !== 'pending_parallel' || wave?.status !== 'running') {
      throw new Error('Focused parallel file result is not bound to a running wave.');
    }
    const worker = event.worker;
    if (
      !worker || worker.markerObserved !== true || !Number.isInteger(worker.jobOrdinal) || worker.jobOrdinal <= 0
      || !Number.isInteger(worker.backendPid) || worker.backendPid <= 0
      || worker.fileKey !== sha256(record.path)
      || worker.jobOrdinal !== wave.files.indexOf(record.path) + 1
    ) {
      record.status = 'hard_stop';
      record.parallelResult = {
        disposition: 'hard_stop',
        family: 'lifecycle',
        failureClass: 'parallel_file_worker_marker_missing_or_ambiguous',
        lockSerializationClass: 'unknown_parallel_failure',
        outputDigest: sha256(redactFocusedFailureExcerpt(event.facts?.output || '', Number.POSITIVE_INFINITY)),
        excerpt: redactFocusedFailureExcerpt(event.facts?.output || ''),
      };
      record.failedHistory.push({ phase: 'parallel_wave', at: timestamp, result: record.parallelResult });
      state.sets.completeFailureSet.push(record.path);
      state.sets.unresolvedFailureSet.push(record.path);
      skipRemainder(state, record.parallelResult.failureClass, record.parallelResult.family);
      state.revision += 1;
      state.updatedAt = timestamp;
      for (const key of Object.keys(state.sets)) state.sets[key] = [...new Set(state.sets[key])].sort(compareAscii);
      return state;
    }
    if (!Number.isInteger(event.elapsedMs) || event.elapsedMs < 0) throw new Error('Focused parallel file elapsedMs is invalid.');
    if (worker.jobOrdinal > wave.jobs) throw new Error('Focused parallel file job ordinal exceeds the wave job bound.');
    const duplicateWorker = state.perFile.find((item) => item.waveNumber === wave.number && item.worker
      && (item.worker.jobOrdinal === worker.jobOrdinal || item.worker.backendPid === worker.backendPid));
    if (duplicateWorker) throw new Error('Focused parallel wave reused a job ordinal or database backend connection.');
    const result = classifyParallelAttempt(event.facts);
    record.worker = cloneJson(worker);
    record.elapsedMs = event.elapsedMs;
    record.lockSerializationClass = result.lockSerializationClass;
    record.parallelResult = result;
    record.failedHistory.push({ phase: 'parallel_wave', at: timestamp, result });
    if (result.disposition === 'hard_stop') {
      record.status = 'hard_stop';
      state.sets.completeFailureSet.push(record.path);
      state.sets.unresolvedFailureSet.push(record.path);
      skipRemainder(state, result.failureClass, result.family);
    } else if (result.disposition === 'passed') {
      record.status = 'parallel_passed';
      state.sets.orderedPassSet.push(record.path);
    } else {
      record.status = 'pending_isolated_rerun';
      state.sets.parallelTriageFailureSet.push(record.path);
      state.sets.completeFailureSet.push(record.path);
      state.sets.unresolvedFailureSet.push(record.path);
    }
  } else if (type === 'wave_finished') {
    const wave = state.waves.find((item) => item.number === event.waveNumber);
    if (!wave || wave.status !== 'running') throw new Error('Focused parallel wave is not running.');
    if (wave.files.some((file) => state.perFile.find((entry) => entry.path === file)?.status === 'pending_parallel')) {
      throw new Error('Focused parallel wave cannot finish before every file reports.');
    }
    wave.contaminationAfter = normalizeContaminationCheck(event.contaminationAfter, 'wave contamination result');
    if (event.guardAfter == null) {
      if (wave.contaminationAfter.stable === true) {
        throw new Error('Focused parallel wave requires post-wave guards when contamination is stable.');
      }
      wave.guardAfter = [];
    } else {
      if (!Array.isArray(event.guardAfter) || event.guardAfter.length !== wave.files.length) {
        throw new Error('Focused parallel wave requires one post-wave guard per exact file.');
      }
      wave.guardAfter = event.guardAfter.map((item, index) => {
        if (item?.file !== wave.files[index]) throw new Error('Focused post-wave guards must preserve exact wave file order.');
        const record = state.perFile.find((entry) => entry.path === item.file);
        return { file: item.file, guard: assertGuardBoundToState(normalizeFocusedGuardSummary(item.guard), state, record.digest) };
      });
    }
    const redGuard = wave.guardAfter.find((item) => item.guard.allGreen !== true);
    wave.pgProveState = {
      fileSha256: exactSha(event.pgProveState?.fileSha256, 'pg_prove saved state'),
      saved: event.pgProveState?.saved === true,
      resultDerivedFailedFiles: wave.files
        .filter((file) => state.perFile.find((entry) => entry.path === file)?.status === 'pending_isolated_rerun')
        .sort(compareAscii),
    };
    if (redGuard) {
      const failure = classifyFocusedGuardFailure(redGuard.guard);
      skipRemainder(state, failure.failureClass, failure.family);
    } else if (!wave.contaminationAfter.stable || wave.pgProveState.saved !== true) {
      skipRemainder(state, !wave.contaminationAfter.stable ? 'parallel_wave_contamination_detected' : 'pg_prove_failed_state_not_saved', 'lifecycle');
    } else {
      wave.status = 'completed';
      wave.finishedAt = timestamp;
      state.status = nextPendingFile(state) ? 'focused_work_pending' : 'focused_complete_final_serial_required';
    }
  } else if (type === 'isolated_rerun_finished' || type === 'serial_quarantine_finished' || type === 'repaired_failed_file_finished') {
    const record = state.perFile.find((item) => item.path === event.file);
    const expectedStatus = type === 'isolated_rerun_finished'
      ? 'pending_isolated_rerun'
      : (type === 'serial_quarantine_finished' ? 'pending_serial_quarantine' : 'collected_failure');
    if (!record || record.status !== expectedStatus) throw new Error('Focused serialized result is not bound to the next required file.');
    const expectedCapacityPhase = type === 'isolated_rerun_finished'
      ? 'isolated_rerun'
      : (type === 'repaired_failed_file_finished' ? 'repaired_failed' : 'serial_quarantine');
    const latestCapacity = state.capacitySamples.at(-1);
    if (
      latestCapacity?.state !== 'green'
      || latestCapacity.phase !== expectedCapacityPhase
      || canonicalJson(latestCapacity.files) !== canonicalJson([record.path])
      || latestCapacity.effectiveJobs !== 1
    ) throw new Error('Focused serialized execution requires a fresh file-bound one-job capacity sample.');
    const pendingIsolated = state.perFile.filter((item) => item.status === 'pending_isolated_rerun').sort((a, b) => a.queueIndex - b.queueIndex);
    const pendingParallel = state.perFile.some((item) => item.status === 'pending_parallel');
    const pendingSerial = state.perFile.filter((item) => item.status === 'pending_serial_quarantine').sort((a, b) => a.queueIndex - b.queueIndex);
    const pendingRepairs = Array.isArray(state.repairSelection)
      ? state.repairSelection.map((file) => state.perFile.find((item) => item.path === file)).filter(Boolean)
      : state.perFile.filter((item) => item.status === 'collected_failure').sort((a, b) => a.queueIndex - b.queueIndex);
    if (
      (type === 'isolated_rerun_finished' && pendingIsolated[0]?.path !== record.path)
      || (type === 'serial_quarantine_finished' && (pendingIsolated.length || pendingParallel || pendingSerial[0]?.path !== record.path))
      || (type === 'repaired_failed_file_finished' && (pendingIsolated.length || pendingParallel || pendingSerial.length || pendingRepairs[0]?.path !== record.path))
    ) throw new Error('Focused serialized results must follow the sorted isolated-first, quarantine, then failed-only repair order.');
    if (event.jobs !== 1) throw new Error('Focused isolated, quarantine, and repaired-failed reruns must use exactly one job.');
    const contamination = normalizeContaminationCheck(event.contamination, 'serialized contamination result');
    const guard = event.guard == null
      ? null
      : assertGuardBoundToState(normalizeFocusedGuardSummary(event.guard), state, record.digest);
    if (contamination.stable === true && !guard) {
      throw new Error('Focused serialized execution requires a final guard when contamination is stable.');
    }
    if (!contamination.stable || guard.allGreen !== true) {
      record.status = 'hard_stop';
      record.contaminationChecks.push(contamination);
      state.sets.completeFailureSet.push(record.path);
      state.sets.unresolvedFailureSet.push(record.path);
      const failure = !contamination.stable
        ? { family: 'lifecycle', failureClass: 'serialized_contamination_detected' }
        : classifyFocusedGuardFailure(guard);
      skipRemainder(state, failure.failureClass, failure.family);
    } else {
      const disposition = classifyFocusedFileDisposition(event.facts, options.policy);
      record.contaminationChecks.push(contamination);
      record.failedHistory.push({ phase: type, at: timestamp, result: disposition });
      record.finalSerializedResult = disposition;
      if (type === 'repaired_failed_file_finished' && Array.isArray(state.repairSelection)) {
        state.repairSelection = state.repairSelection.filter((file) => file !== record.path);
      }
      if (type === 'isolated_rerun_finished') state.sets.isolatedRerunSet.push(record.path);
      if (disposition.disposition === 'passed') {
        if (type === 'isolated_rerun_finished') {
          record.status = 'hard_stop';
          skipRemainder(state, 'parallel_wave_failure_not_reproduced_serially', 'unknown');
        } else {
          record.status = type === 'repaired_failed_file_finished' ? 'repaired_serial_passed' : 'serial_passed';
          state.sets.orderedPassSet.push(record.path);
          if (type === 'repaired_failed_file_finished') {
            state.sets.unresolvedFailureSet = state.sets.unresolvedFailureSet.filter((file) => file !== record.path);
            state.sets.collectedFailureSet = state.sets.collectedFailureSet.filter((file) => file !== record.path);
          }
        }
      } else if (disposition.disposition === 'collected_failure') {
        record.status = 'collected_failure';
        state.sets.collectedFailureSet.push(record.path);
        if (!state.sets.completeFailureSet.includes(record.path)) state.sets.completeFailureSet.push(record.path);
        if (!state.sets.unresolvedFailureSet.includes(record.path)) state.sets.unresolvedFailureSet.push(record.path);
      } else {
        record.status = 'hard_stop';
        if (!state.sets.completeFailureSet.includes(record.path)) state.sets.completeFailureSet.push(record.path);
        if (!state.sets.unresolvedFailureSet.includes(record.path)) state.sets.unresolvedFailureSet.push(record.path);
        skipRemainder(state, disposition.failureClass, disposition.family);
      }
      if (state.status !== 'hard_stopped') {
        state.status = nextPendingFile(state) ? 'focused_work_pending' : 'focused_complete_final_serial_required';
      }
    }
  } else if (type === 'focused_subset_completed') {
    if (state.queueScope !== 'pilot_subset' || state.sets.unresolvedFailureSet.length || state.status !== 'focused_complete_final_serial_required') {
      throw new Error('Focused subset completion is not bound to a resolved pilot/subset queue.');
    }
    state.status = 'focused_subset_terminal_passed';
    state.finalSerializedResult = {
      required: false,
      preGateGuard: null,
      aToZ: { state: 'skipped', serial: true, reason: 'subset_queue_not_complete_focused_chain' },
      localCandidate: { state: 'skipped', serial: true, requiredRunCount: 1, reason: 'subset_queue_not_complete_focused_chain' },
      state: 'not_authorized_for_subset',
    };
  } else if (type === 'final_serialized_gates_guard_recorded') {
    if (state.queueScope !== 'complete_focused_chain' || state.sets.unresolvedFailureSet.length || state.status !== 'focused_complete_final_serial_required') {
      throw new Error('Final serialized pre-gate guard is not bound to complete focused-chain closure.');
    }
    assertCompleteFocusedChain(state);
    const lastRecord = [...state.perFile].sort((a, b) => a.queueIndex - b.queueIndex).at(-1);
    if (!lastRecord || event.file !== lastRecord.path) throw new Error('Final serialized pre-gate guard must bind the last sorted focused file.');
    const preGateGuard = assertGuardBoundToState(normalizeFocusedGuardSummary(event.guard), state, lastRecord.digest);
    state.finalSerializedResult.preGateGuard = preGateGuard;
    if (preGateGuard.allGreen !== true) {
      const failure = classifyFocusedGuardFailure(preGateGuard);
      skipRemainder(state, failure.failureClass, failure.family);
    }
  } else if (type === 'final_serialized_gates_failed') {
    if (state.queueScope !== 'complete_focused_chain' || state.sets.unresolvedFailureSet.length || state.status !== 'focused_complete_final_serial_required') {
      throw new Error('Final serialized gate failure is not bound to focused closure.');
    }
    if (state.finalSerializedResult.preGateGuard?.allGreen !== true) throw new Error('Final serialized gates require a fresh green pre-gate guard.');
    assertCompleteFocusedChain(state);
    const gate = String(event.gate || '');
    if (!new Set(['a_to_z', 'local_candidate']).has(gate)) throw new Error('Final serialized failed gate is invalid.');
    if (event.serial !== true || event.jobs !== 1 || Number(event.runCount || 0) !== 1) {
      throw new Error('Final serialized failed gate must be the one serial attempt.');
    }
    state.finalSerializedResult = {
      required: true,
      preGateGuard: state.finalSerializedResult.preGateGuard,
      aToZ: gate === 'a_to_z'
        ? { state: 'failed', serial: true, jobs: 1, runCount: 1, artifactSha256: exactSha(event.artifactSha256, 'failed A-to-Z artifact') }
        : { state: 'passed', serial: true, jobs: 1, runCount: 1, artifactSha256: exactSha(event.aToZArtifactSha256, 'passed A-to-Z artifact') },
      localCandidate: gate === 'local_candidate'
        ? { state: 'failed', serial: true, jobs: 1, runCount: 1, artifactSha256: exactSha(event.artifactSha256, 'failed local-candidate artifact') }
        : { state: 'skipped', serial: true, requiredRunCount: 1, reason: 'a_to_z_failed' },
      state: 'failed',
    };
    skipRemainder(state, 'final_serialized_' + gate + '_failed', 'admission');
  } else if (type === 'final_serialized_gates_recorded') {
    if (state.queueScope !== 'complete_focused_chain' || state.sets.unresolvedFailureSet.length) {
      throw new Error('Final serialized gates cannot run while repaired-failed-only reruns remain unresolved.');
    }
    if (state.status !== 'focused_complete_final_serial_required') {
      throw new Error('Final serialized gates cannot run before focused closure.');
    }
    if (state.finalSerializedResult.preGateGuard?.allGreen !== true) throw new Error('Final serialized gates require a fresh green pre-gate guard.');
    assertCompleteFocusedChain(state);
    const aToZ = event.aToZ;
    const localCandidate = event.localCandidate;
    if (
      aToZ?.state !== 'passed' || aToZ.serial !== true || aToZ.jobs !== 1
      || localCandidate?.state !== 'passed' || localCandidate.serial !== true
      || localCandidate.jobs !== 1 || localCandidate.runCount !== 1
    ) throw new Error('Final A-to-Z and one local-candidate gate must both pass serially.');
    state.finalSerializedResult = {
      required: true,
      preGateGuard: state.finalSerializedResult.preGateGuard,
      aToZ: { ...cloneJson(aToZ), artifactSha256: exactSha(aToZ.artifactSha256, 'A-to-Z artifact') },
      localCandidate: { ...cloneJson(localCandidate), artifactSha256: exactSha(localCandidate.artifactSha256, 'local-candidate artifact') },
      state: 'passed',
    };
    state.status = 'final_serial_passed';
  } else {
    throw new Error('Unknown focused parallel-wave event: ' + type);
  }

  state.revision += 1;
  state.updatedAt = timestamp;
  for (const key of Object.keys(state.sets)) state.sets[key] = [...new Set(state.sets[key])].sort(compareAscii);
  return state;
}

function hasEmptyContaminationIdentityDeltas(check = {}) {
  let normalized;
  try {
    normalized = normalizeContaminationCheck(check, 'serial pilot contamination evidence');
  } catch {
    return false;
  }
  return normalized.stable === true
    && normalized.beforeDigest === normalized.afterDigest
    && normalized.sequenceDeltaCount === 0
    && normalized.sharedRowDeltaCount === 0
    && normalized.lockResidueCount === 0
    && normalized.backgroundActivityDeltaCount === 0
    && Array.isArray(normalized.sequenceDeltas) && normalized.sequenceDeltas.length === 0
    && Array.isArray(normalized.lockDeltas) && normalized.lockDeltas.length === 0
    && Array.isArray(normalized.backgroundActivityDeltas) && normalized.backgroundActivityDeltas.length === 0;
}

function deriveSerialPilotAcceptance(state, counts) {
  const record = state.perFile[0];
  const sample = state.capacitySamples.at(-1);
  const result = record?.finalSerializedResult;
  return state.status === 'focused_subset_terminal_passed'
    && state.queueScope === 'pilot_subset'
    && state.mode?.pilotAuthorized === true
    && state.mode?.requestedJobs === 1
    && state.perFile.length === 1
    && state.waves.length === 0
    && counts.selected === 1
    && counts.serialPassed === 1
    && counts.parallelPassed === 0
    && counts.completeFailures === 0
    && counts.unresolvedFailures === 0
    && counts.skipped === 0
    && record?.status === 'serial_passed'
    && result?.disposition === 'passed'
    && result.collectible === false
    && result.failureClass === ''
    && Array.isArray(result.hardStops) && result.hardStops.length === 0
    && /^[0-9a-f]{64}$/u.test(String(result.outputDigest || ''))
    && Array.isArray(record.contaminationChecks) && record.contaminationChecks.length > 0
    && record.contaminationChecks.every(hasEmptyContaminationIdentityDeltas)
    && sample?.state === 'green'
    && sample.phase === 'serial_quarantine'
    && sample.requestedJobs === 1
    && sample.effectiveJobs === 1
    && canonicalJson(sample.files) === canonicalJson([record.path])
    && canonicalJson(state.sets.orderedPassSet) === canonicalJson([record.path])
    && canonicalJson(state.sets.serialQuarantineSet) === canonicalJson([record.path])
    && state.sets.parallelTriageFailureSet.length === 0
    && state.sets.isolatedRerunSet.length === 0
    && state.sets.completeFailureSet.length === 0
    && state.sets.unresolvedFailureSet.length === 0
    && state.sets.collectedFailureSet.length === 0
    && state.sets.skippedRemainder.length === 0
    && !state.hardStop;
}

function deriveFocusedParallelWaveArtifact(stateValue) {
  const state = cloneJson(stateValue);
  const counts = {
    selected: state.perFile.length,
    waves: state.waves.length,
    parallelPassed: state.perFile.filter((entry) => entry.status === 'parallel_passed').length,
    serialPassed: state.perFile.filter((entry) => entry.status === 'serial_passed').length,
    parallelTriageFailures: state.sets.parallelTriageFailureSet.length,
    isolatedReruns: state.sets.isolatedRerunSet.length,
    completeFailures: state.sets.completeFailureSet.length,
    unresolvedFailures: state.sets.unresolvedFailureSet.length,
    quarantinedSerially: state.sets.serialQuarantineSet.length,
    skipped: state.sets.skippedRemainder.length,
  };
  return {
    schema: COLLECTION_SCHEMA,
    revision: state.revision,
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    identity: state.identity,
    planDigest: state.planDigest,
    queueDigest: state.queueDigest,
    queueScope: state.queueScope,
    focusedManifest: state.focusedManifest,
    manifestRemainder: state.manifestRemainder,
    scheduler: state.scheduler ? cloneJson(state.scheduler) : null,
    mode: state.mode,
    oneRuntimeDatabase: true,
    oneLifecycleOwner: true,
    oneWriter: true,
    waves: state.waves,
    perFile: state.perFile,
    sets: state.sets,
    counts,
    nextSortedFile: nextPendingFile(state) || state.manifestRemainder?.[0] || '',
    finalSerializedResult: state.finalSerializedResult,
    repairSelection: state.repairSelection,
    repairHistory: state.repairHistory,
    capacitySamples: state.capacitySamples,
    hardStop: state.hardStop,
    serialPilotAccepted: deriveSerialPilotAcceptance(state, counts),
    pilotReady: state.status === 'final_serial_passed'
      && state.mode.pilotAuthorized === true,
  };
}

function focusedParallelWaveCheckpointPath(outDir, identity) {
  const root = path.resolve(outDir);
  const name = 'focused-parallel-wave-' + identity.lineageFingerprint.slice(0, 16) + '.json';
  const target = path.resolve(root, name);
  if (!isPathWithin(root, target)) throw new Error('Focused parallel-wave checkpoint path escapes its artifact directory.');
  return target;
}

function buildFocusedParallelWaveCheckpoint(state, previousRaw = '', options = {}) {
  const artifact = deriveFocusedParallelWaveArtifact(state);
  const payload = {
    ...artifact,
    previousCheckpointSha256: previousRaw ? sha256(previousRaw) : '',
    writerLockFingerprint: exactSha(options.writerLockFingerprint, 'focused parallel-wave writer lock'),
  };
  payload.contentSha256 = sha256(canonicalJson(payload));
  return payload;
}

function validateFocusedParallelWaveCheckpoint(checkpoint, expectedIdentity) {
  const normalizedIdentity = buildFocusedCollectionIdentity(expectedIdentity);
  if (checkpoint?.schema !== COLLECTION_SCHEMA) throw new Error('Focused parallel-wave checkpoint schema is unsupported.');
  const checkpointIdentity = buildFocusedCollectionIdentity(checkpoint.identity || {});
  if (
    checkpointIdentity.bindingFingerprint !== normalizedIdentity.bindingFingerprint
    || canonicalJson(checkpointIdentity) !== canonicalJson(normalizedIdentity)
  ) {
    throw new Error('Focused parallel-wave checkpoint binding does not match the active owner/runtime.');
  }
  const copy = cloneJson(checkpoint);
  const digest = copy.contentSha256;
  delete copy.contentSha256;
  if (sha256(canonicalJson(copy)) !== digest) throw new Error('Focused parallel-wave checkpoint content digest is invalid.');
  exactSha(checkpoint.writerLockFingerprint, 'focused parallel-wave checkpoint writer lock');
  validateCanonicalFocusedManifest(checkpoint.focusedManifest, checkpointIdentity);
  if (!checkpoint.scheduler) throw new Error('Focused parallel-wave checkpoint is missing its governing scheduler state.');
  const schedulerBinding = checkpoint.scheduler.checkpointBinding || {};
  validateFocusedRepairSchedulerState(checkpoint.scheduler, {
    identity: checkpointIdentity,
    plan: {
      focusedManifest: {
        contentSha256: schedulerBinding.canonicalManifestDigest,
        queueDigest: schedulerBinding.canonicalManifestQueueDigest,
      },
      queueDigest: schedulerBinding.selectedQueueDigest,
    },
  });
  return checkpoint;
}

function loadFocusedParallelWaveCheckpoint(filePath, expectedIdentity, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const stat = fsImpl.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) {
    throw new Error('Focused parallel-wave checkpoint must be a safe local file below 20 MiB.');
  }
  const raw = fsImpl.readFileSync(filePath, 'utf8');
  let checkpoint;
  try { checkpoint = JSON.parse(raw); } catch (_) { throw new Error('Focused parallel-wave checkpoint JSON is malformed.'); }
  validateFocusedParallelWaveCheckpoint(checkpoint, expectedIdentity);
  return { checkpoint, raw, fingerprint: sha256(raw) };
}

function prepareFocusedRepairState(checkpointValue, repairPlan, selectedFiles, options = {}) {
  const checkpoint = cloneJson(checkpointValue);
  if (checkpoint?.schema !== COLLECTION_SCHEMA || repairPlan?.schema !== COLLECTION_SCHEMA) {
    throw new Error('Focused repaired-failed selection requires matching parallel-wave schemas.');
  }
  const selected = [...(selectedFiles || [])].map(normalizeRequestedFocusedFile).sort(compareAscii);
  if (!selected.length || new Set(selected).size !== selected.length) {
    throw new Error('Focused repaired-failed selection must contain unique files.');
  }
  const unresolved = new Set(checkpoint.sets?.unresolvedFailureSet || []);
  const passed = new Set(checkpoint.sets?.orderedPassSet || []);
  if (selected.some((file) => !unresolved.has(file) || passed.has(file))) {
    throw new Error('Focused repaired-failed selection must be disjoint from passes and a subset of unresolved failures.');
  }
  const replacementByFile = new Map(repairPlan.records.map((entry) => [entry.path, entry]));
  if (replacementByFile.size !== selected.length || selected.some((file) => !replacementByFile.has(file))) {
    throw new Error('Focused repaired-failed plan must contain exactly the selected failure subset.');
  }
  const timestamp = nowIso(options);
  for (const file of selected) {
    const record = checkpoint.perFile.find((entry) => entry.path === file);
    const replacement = replacementByFile.get(file);
    if (!record || record.status !== 'collected_failure') {
      throw new Error('Focused repaired-failed file is not in collectible unresolved state: ' + file);
    }
    const schedulerEntry = checkpoint.scheduler?.entries?.find((entry) => entry.path === file);
    const schedulerIntegrated = schedulerEntry?.state === 'repair_ready' && schedulerEntry.digest === replacement.digest;
    if (record.digest === replacement.digest && !schedulerIntegrated) {
      throw new Error('Focused repaired-failed file source digest is unchanged without scheduler integration: ' + file);
    }
    if (schedulerEntry && !schedulerIntegrated) {
      throw new Error('Focused repaired-failed file is not scheduler-authorized repair_ready: ' + file);
    }
    record.failedHistory.push({
      phase: 'repair_selected',
      at: timestamp,
      priorDigest: record.digest,
      repairedDigest: replacement.digest,
      repairPlanDigest: repairPlan.planDigest,
    });
    record.digest = replacement.digest;
    record.isolation = replacement.isolation;
    record.parallelEligibility = replacement.parallelEligibility;
    record.lane = 'serial_quarantine';
    record.waveNumber = null;
    record.finalSerializedResult = null;
  }
  checkpoint.repairSelection = selected;
  checkpoint.repairHistory = [...(checkpoint.repairHistory || []), {
    selected,
    selectedCount: selected.length,
    repairPlanDigest: repairPlan.planDigest,
    repairQueueDigest: repairPlan.queueDigest,
    startedAt: timestamp,
  }];
  checkpoint.status = 'focused_work_pending';
  checkpoint.updatedAt = timestamp;
  delete checkpoint.contentSha256;
  delete checkpoint.previousCheckpointSha256;
  delete checkpoint.writerLockFingerprint;
  return checkpoint;
}

function writeFocusedParallelWaveCheckpointAtomic(filePath, checkpoint, options = {}) {
  const expectedIdentity = options.identity;
  const writerLockFingerprint = exactSha(options.writerLockFingerprint, 'active focused parallel-wave writer lock');
  validateFocusedParallelWaveCheckpoint(checkpoint, expectedIdentity);
  if (checkpoint.writerLockFingerprint !== writerLockFingerprint) {
    throw new Error('Focused parallel-wave checkpoint writer lock does not match the active session.');
  }
  const canonicalPath = focusedParallelWaveCheckpointPath(path.dirname(filePath), expectedIdentity);
  if (path.resolve(filePath) !== canonicalPath) throw new Error('Focused parallel-wave checkpoint path is not canonical.');
  const fsImpl = options.fsImpl || fs;
  const directory = ensureSafeDirectoryWithin(expectedIdentity.worktreePath, path.dirname(filePath), fsImpl);
  if (directory !== path.dirname(path.resolve(filePath))) throw new Error('Focused parallel-wave checkpoint directory is not canonical.');
  if (fsImpl.existsSync(filePath)) {
    const fileStat = fsImpl.lstatSync(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error('Focused parallel-wave checkpoint target must be a regular non-symlink file.');
    }
  }
  const lockPath = filePath + '.writer.lock';
  let lockHandle = null;
  try {
    lockHandle = fsImpl.openSync(lockPath, 'wx');
  } catch (_) {
    throw new Error('Focused parallel-wave checkpoint already has an active writer.');
  }
  try {
    let currentRaw = '';
    if (fsImpl.existsSync(filePath)) currentRaw = fsImpl.readFileSync(filePath, 'utf8');
    const expectedPrevious = String(options.expectedPreviousFingerprint || '');
    const currentFingerprint = currentRaw ? sha256(currentRaw) : '';
    if (currentFingerprint !== expectedPrevious || checkpoint.previousCheckpointSha256 !== currentFingerprint) {
      throw new Error('Focused parallel-wave checkpoint compare-and-swap rejected a stale writer.');
    }
    writeJsonAtomic(filePath, checkpoint, { fsImpl });
    const raw = JSON.stringify(checkpoint, null, 2) + '\n';
    return { path: filePath, fingerprint: sha256(raw), revision: checkpoint.revision };
  } finally {
    try { fsImpl.closeSync(lockHandle); } catch (_) { /* fail closed on the next writer */ }
    try { fsImpl.unlinkSync(lockPath); } catch (_) { /* fail closed on the next writer */ }
  }
}
module.exports = {
  LOCK_SERIALIZATION_CLASSES,
  buildFocusedParallelWaveCheckpoint,
  buildFocusedParallelWavePlan,
  buildPgProveWaveInvocation,
  buildPgProveWrapperSql,
  classifyFocusedGuardFailure,
  classifyLockSerialization,
  createFocusedParallelWaveState,
  deriveFocusedParallelWaveArtifact,
  focusedParallelWaveCheckpointPath,
  loadFocusedParallelWaveCheckpoint,
  normalizeContaminationCheck,
  parsePgProveCompletionMarker,
  parsePgProveWorkerMarker,
  prepareFocusedRepairState,
  reduceFocusedParallelWaveState,
  validateFocusedParallelWaveCheckpoint,
  writeFocusedParallelWaveCheckpointAtomic,
};
