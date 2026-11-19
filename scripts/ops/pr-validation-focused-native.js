#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { readEnvFile } = require('../utils/env-file');
const focused = require('./pr-validation-focused-collection');
const pgProveToolchain = require('./pr-validation-pg-prove-toolchain');
const {
  captureContaminationSnapshot,
  compareContaminationSnapshots,
  confirmBackgroundOnlyContaminationQuiescence,
  establishContaminationBaseline,
} = require('./pr-validation-focused-probe');

const FOCUSED_BASELINE_DEADLINE_FAILURE_CLASS = 'focused_contamination_baseline_deadline_exceeded';

function resolveFocusedNativeAdmission(options = {}) {
  const requested = options.collectFocusedFailures === true
    || options.jobs != null
    || options.repairFocusedFailures === true;
  if (!requested) {
    return { requested: false, enabled: false, mode: { enabled: false, mode: 'fail_fast' } };
  }
  const policy = focused.loadFocusedCollectionPolicy(path.resolve(options.cwd || process.cwd()), options);
  const mode = focused.resolveFocusedCollectionMode(options, policy);
  if (options.repairFocusedFailures === true && mode.enabled !== true) {
    throw new Error('--repair-focused-failures requires the enabled focused parallel-wave mode.');
  }
  if (mode.pilotAuthorized !== true) {
    return {
      requested: true,
      enabled: false,
      mode,
      policy,
      blockReason: 'focused_parallel_wave_source_only_not_authorized',
    };
  }
  return { requested: true, enabled: true, mode, policy, blockReason: '' };
}

function resolveFocusedNativeQueue(options = {}) {
  return focused.buildSortedFocusedQueue({
    cwd: options.cwd,
    requestedFiles: options.files,
    policy: options.policy,
    fsImpl: options.fsImpl,
  });
}

function buildFocusedNativePlan(options = {}) {
  const queue = resolveFocusedNativeQueue({
    cwd: options.cwd,
    files: options.files,
    policy: options.policy,
    fsImpl: options.fsImpl,
  });
  const focusedManifest = focused.buildCanonicalFocusedManifest({
    cwd: options.cwd,
    policy: options.policy,
    identity: options.identity,
    fsImpl: options.fsImpl,
  });
  const isolationByFile = {};
  const parallelEligibilityByFile = {};
  for (const entry of queue.sortedQueue) {
    const source = (options.fsImpl || fs).readFileSync(entry.absolutePath, 'utf8');
    const isolation = focused.analyzeFocusedPgtapIsolation({ file: entry.path, source, policy: options.policy });
    isolationByFile[entry.path] = isolation;
    parallelEligibilityByFile[entry.path] = focused.analyzeFocusedPgtapParallelEligibility({
      file: entry.path,
      source,
      policy: options.policy,
      isolation,
    });
  }
  return focused.buildFocusedParallelWavePlan({
    mode: options.mode,
    identity: options.identity,
    focusedManifest,
    queue,
    isolationByFile,
    parallelEligibilityByFile,
  });
}

function normalizeStructuredSerializationEvidence(value = {}) {
  focused.assertKnownKeys(value, new Set(['source', 'observedCount', 'observations', 'sampleDigests', 'artifactSha256']), 'focused serialization evidence');
  const source = String(value.source || '');
  if (!new Set(['pre_admission_no_pg_prove_started', 'structured_pg_prove_output']).has(source)) {
    throw new Error('Focused native capacity evidence is missing because the serialization measurement source is unknown.');
  }
  const observedCount = Number(value.observedCount);
  const observations = Array.isArray(value.observations) ? value.observations.map((entry) => ({
    phase: String(entry.phase || ''),
    file: focused.normalizeRequestedFocusedFile(entry.file),
    sqlstate: String(entry.sqlstate || ''),
    outputDigest: String(entry.outputDigest || ''),
  })) : null;
  const sampleDigests = Array.isArray(value.sampleDigests) ? [...value.sampleDigests] : null;
  if (!Number.isInteger(observedCount) || observedCount < 0 || !observations
    || observations.length !== observedCount || !sampleDigests
    || sampleDigests.some((digest) => !/^[a-f0-9]{64}$/u.test(String(digest || '')))
    || observations.some((entry) => entry.sqlstate !== '40001' || !/^[a-f0-9]{64}$/u.test(entry.outputDigest))) {
    throw new Error('Focused serialization measurement is incomplete or inconsistent.');
  }
  if (source === 'pre_admission_no_pg_prove_started' && (observedCount !== 0 || sampleDigests.length !== 0)) {
    throw new Error('Focused pre-admission serialization evidence cannot report execution output.');
  }
  if (source === 'structured_pg_prove_output' && sampleDigests.length === 0) {
    throw new Error('Focused structured serialization evidence requires measured pg_prove output.');
  }
  const payload = { source, observedCount, observations, sampleDigests };
  const artifactSha256 = focused.sha256(focused.canonicalJson(payload));
  if (value.artifactSha256 && value.artifactSha256 !== artifactSha256) {
    throw new Error('Focused serialization evidence digest is invalid.');
  }
  return { ...payload, artifactSha256 };
}

function resolveFocusedNativeCapacityMode(mode, evidence = {}) {
  focused.assertKnownKeys(evidence, new Set([
    'hostGreen', 'hostPressure', 'databaseCapacityKnown',
    'immediateHostConnectionCap', 'databaseConnectionCap',
    'hostCpuGreen', 'hostMemoryGreen', 'activeRunnerPressureGreen',
    'lockWaitCount', 'deadlockCount', 'serializationFailureCount',
    'sampledAt', 'databaseCapacity', 'guard', 'hostMetrics', 'hostAdmission', 'serializationEvidence',
  ]), 'focused native capacity evidence');
  const serializationEvidence = normalizeStructuredSerializationEvidence(evidence.serializationEvidence);
  if (serializationEvidence.observedCount !== evidence.serializationFailureCount) {
    throw new Error('Focused native serialization evidence does not match its structured execution observations.');
  }
  if (evidence.hostGreen !== true || evidence.hostPressure !== false || evidence.databaseCapacityKnown !== true
    || evidence.hostCpuGreen !== true || evidence.hostMemoryGreen !== true
    || evidence.activeRunnerPressureGreen !== true || evidence.lockWaitCount !== 0
    || evidence.deadlockCount !== 0 || evidence.serializationFailureCount !== 0) {
    throw new Error('Focused native capacity evidence is missing, host-red, pressured, or DB-unknown.');
  }
  const hostCap = focused.requirePositiveInteger(evidence.immediateHostConnectionCap, 'immediate host connection cap');
  const databaseCap = focused.requirePositiveInteger(evidence.databaseConnectionCap, 'database connection cap');
  if (hostCap > mode.hostConnectionCap || databaseCap > mode.databaseConnectionCap) {
    throw new Error('Focused native capacity evidence exceeds policy connection caps.');
  }
  const effectiveJobs = Math.min(mode.requestedJobs, mode.batchSize, hostCap, databaseCap);
  return focused.validateResolvedFocusedCollectionMode({
    ...mode,
    eligibleIsolatedFiles: mode.requestedJobs,
    eligibilityResolved: false,
    hostConnectionCap: hostCap,
    databaseConnectionCap: databaseCap,
    effectiveJobs,
    maxFilesPerWave: Math.min(mode.batchSize, effectiveJobs),
    adaptationReason: 'awaiting_parallel_eligibility',
  });
}

function resolvePgProveConnection(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const fsImpl = options.fsImpl || fs;
  let env = options.env;
  let sourcePrefix = 'explicit_env';
  if (!env) {
    const localEnvPath = path.resolve(cwd, 'config', 'env', '.env.local');
    let stat;
    try { stat = fsImpl.lstatSync(localEnvPath); } catch (_) {
      throw new Error('Owner-bound local database credential file is missing.');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Owner-bound local database credential file must be a regular non-symlink file.');
    }
    const parsed = readEnvFile(localEnvPath);
    if (!parsed) throw new Error('Owner-bound local database credential file is unreadable.');
    env = { ...(options.processEnv || process.env), ...parsed };
    sourcePrefix = 'config/env/.env.local';
  }
  const expectedPort = Number(options.expectedPort || 0);
  const candidates = ['PG_CONN_STRING', 'DATABASE_URL_DIRECT', 'DATABASE_URL']
    .map((name) => ({ name, value: String(env[name] || '').trim() }))
    .filter((entry) => entry.value);
  const matches = [];
  for (const candidate of candidates) {
    let parsed;
    try { parsed = new URL(candidate.value); } catch (_) { continue; }
    if (!new Set(['postgres:', 'postgresql:']).has(parsed.protocol)) continue;
    const port = Number(parsed.port || 5432);
    const host = String(parsed.hostname || '').toLowerCase();
    if (port !== expectedPort || !new Set(['127.0.0.1', 'localhost', '::1']).has(host)) continue;
    matches.push({ candidate, parsed, port, host });
  }
  const unique = [...new Map(matches.map((entry) => [entry.candidate.value, entry])).values()];
  if (unique.length !== 1) {
    throw new Error('Exactly one local database credential must match the owner-bound validation DB port.');
  }
  const selected = unique[0];
  const database = decodeURIComponent(selected.parsed.pathname.replace(/^\//u, ''));
  const username = decodeURIComponent(selected.parsed.username || '');
  if (!database || !username) throw new Error('Focused pg_prove database or username is missing.');
  const childEnv = {};
  if (selected.parsed.password) childEnv.PGPASSWORD = decodeURIComponent(selected.parsed.password);
  const sslmode = selected.parsed.searchParams.get('sslmode');
  if (sslmode) childEnv.PGSSLMODE = sslmode;
  return {
    public: { database, host: selected.host, port: String(selected.port), username },
    childEnv,
    connectionString: selected.candidate.value,
    source: `${sourcePrefix}:${selected.candidate.name}`,
  };
}

async function captureFocusedDatabaseCapacityEvidence(options = {}) {
  const policy = options.policy;
  const connectionString = String(options.connectionString || '');
  if (!connectionString || !policy?.databaseConnectionReserve) {
    throw new Error('Focused database capacity measurement is missing its bound connection or policy reserve.');
  }
  const ClientCtor = options.ClientCtor || require('pg').Client;
  const client = new ClientCtor({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
    application_name: 'masarx-focused-capacity-probe',
  });
  try {
    await client.connect();
    const response = await client.query(`
      SELECT
        current_setting('max_connections')::integer AS max_connections,
        current_setting('superuser_reserved_connections')::integer AS reserved_connections,
        count(*) FILTER (
          WHERE backend_type = 'client backend'
            AND pid <> pg_backend_pid()
            AND application_name !~ '^masarx-focused-'
        )::integer AS non_test_connections,
        count(*) FILTER (
          WHERE backend_type = 'client backend'
            AND (pid = pg_backend_pid() OR application_name ~ '^masarx-focused-control')
        )::integer AS control_connections,
        count(*) FILTER (
          WHERE backend_type = 'client backend'
            AND pid <> pg_backend_pid()
            AND application_name ~ '^masarx-focused-'
            AND application_name !~ '^masarx-focused-control'
        )::integer AS active_test_connections,
        count(*) FILTER (WHERE backend_type = 'client backend')::integer AS current_connections,
        count(*) FILTER (WHERE wait_event_type = 'Lock')::integer AS lock_wait_count,
        (SELECT deadlocks::bigint FROM pg_stat_database WHERE datname = current_database()) AS deadlock_count
      FROM pg_stat_activity
    `);
    const row = response?.rows?.[0] || {};
    const measuredKeys = [
      'max_connections', 'reserved_connections', 'non_test_connections', 'control_connections',
      'active_test_connections', 'current_connections', 'lock_wait_count', 'deadlock_count',
    ];
    if (measuredKeys.some((key) => row[key] == null || row[key] === '')) {
      throw new Error('Focused database capacity measurement returned unknown values.');
    }
    const maxConnections = Number(row.max_connections);
    const reservedConnections = Number(row.reserved_connections);
    const nonTestConnections = Number(row.non_test_connections);
    const controlConnections = Number(row.control_connections);
    const activeTestConnections = Number(row.active_test_connections);
    const currentConnections = Number(row.current_connections);
    const lockWaitCount = Number(row.lock_wait_count);
    const deadlockCount = Number(row.deadlock_count);
    const serializationEvidence = normalizeStructuredSerializationEvidence(options.serializationEvidence);
    const observedSerializationFailureCount = serializationEvidence.observedCount;
    if (![maxConnections, reservedConnections, nonTestConnections, controlConnections, activeTestConnections, currentConnections,
      lockWaitCount, deadlockCount, observedSerializationFailureCount].every(Number.isInteger)) {
      throw new Error('Focused database capacity measurement returned unknown values.');
    }
    if (activeTestConnections !== 0) throw new Error('Focused database capacity found an active test writer before the next wave.');
    const reservePolicy = policy.databaseConnectionReserve;
    const dynamicOperationalReserve = Math.max(
      reservePolicy.minimum_connections,
      Math.ceil(maxConnections * reservePolicy.minimum_fraction),
    );
    const availableConnections = maxConnections - reservedConnections - dynamicOperationalReserve
      - nonTestConnections - controlConnections;
    if (availableConnections < 1) throw new Error('Focused database capacity is red after the policy reserve.');
    const previousDeadlockCount = options.previousDeadlockCount == null ? deadlockCount : Number(options.previousDeadlockCount);
    const previousSerializationFailureCount = options.previousSerializationFailureCount == null
      ? observedSerializationFailureCount
      : Number(options.previousSerializationFailureCount);
    if (!Number.isInteger(previousDeadlockCount) || !Number.isInteger(previousSerializationFailureCount)
      || deadlockCount < previousDeadlockCount || observedSerializationFailureCount < previousSerializationFailureCount) {
      throw new Error('Focused database contention counters are unknown or regressed.');
    }
    return {
      measured: true,
      maxConnections,
      reservedConnections,
      nonTestConnections,
      controlConnections,
      activeTestConnections,
      currentConnections,
      dynamicOperationalReserve,
      minimumReserveConnections: reservePolicy.minimum_connections,
      minimumReserveFraction: reservePolicy.minimum_fraction,
      availableConnections,
      databaseConnectionCap: Math.min(policy.databaseConnectionCap, availableConnections),
      lockWaitCount,
      deadlockCount,
      deadlockDelta: deadlockCount - previousDeadlockCount,
      serializationFailureCount: observedSerializationFailureCount,
      serializationFailureCountBefore: previousSerializationFailureCount,
      serializationFailureCountAfter: observedSerializationFailureCount,
      serializationFailureDelta: observedSerializationFailureCount - previousSerializationFailureCount,
      serializationEvidence,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

function fileSha256(filePath, fsImpl = fs) {
  return focused.sha256(fsImpl.readFileSync(filePath));
}

function buildFocusedNativeIdentity(options = {}) {
  const cwd = path.resolve(options.cwd || options.worktreePath || options.repoPath);
  const migration = options.migrationFingerprint || {};
  const validationStackPorts = options.ports || {};
  const focusedIdentityPorts = {
    api: validationStackPorts.api,
    db: validationStackPorts.db,
    studio: validationStackPorts.studio,
  };
  return focused.buildFocusedCollectionIdentity({
    targetKind: options.targetKind || (options.prNumber ? 'pr' : 'branch_candidate'),
    targetId: options.targetId || String(options.prNumber || options.branch),
    prNumber: options.prNumber == null ? '' : String(options.prNumber),
    repoId: options.repoId || path.basename(cwd),
    repoPath: options.repoPath || cwd,
    ownerThreadId: options.ownerThreadId,
    worktreeId: options.worktreeId,
    worktreePath: cwd,
    branch: options.branch,
    headSha: options.headSha,
    projectId: options.projectId,
    validationResource: options.validationResource,
    validationOwner: options.validationOwner,
    leaseId: options.leaseId,
    warmBaselineFingerprint: options.warmBaselineFingerprint,
    validationStackGeneration: focused.sha256(focused.canonicalJson({
      leaseId: options.leaseId,
      projectId: options.projectId,
      ports: validationStackPorts,
      warmBaselineFingerprint: options.warmBaselineFingerprint,
    })),
    policyFileFingerprint: options.policy.policyFileFingerprint,
    focusedPolicyFingerprint: options.policy.focusedPolicyFingerprint,
    focusedPolicySafetyFingerprint: options.policy.focusedPolicySafetyFingerprint,
    runnerFingerprint: focused.sha256(focused.canonicalJson({
      session: fileSha256(path.join(cwd, 'scripts', 'ops', 'pr-validation-session.js')),
      native: fileSha256(path.join(cwd, 'scripts', 'ops', 'pr-validation-focused-native.js')),
      wave: fileSha256(path.join(cwd, 'scripts', 'ops', 'pr-validation-focused-wave.js')),
      toolchain: fileSha256(path.join(cwd, 'scripts', 'ops', 'pr-validation-pg-prove-toolchain.js')),
      toolchainCli: fileSha256(path.join(cwd, 'scripts', 'ops', 'pr-validation-pg-prove-toolchain-cli.js')),
      toolchainPolicy: fileSha256(path.join(cwd, 'config', 'ops', 'pr-validation-pg-prove-toolchain.json')),
      toolchainDockerfile: fileSha256(path.join(cwd, 'config', 'ops', 'images', 'pr-validation-pg-prove', 'Dockerfile')),
    })),
    pgtapHarnessFingerprint: fileSha256(path.join(cwd, 'scripts', 'tests', 'run-pgtap-cloud.js')),
    fixtureBootstrapFingerprint: fileSha256(path.join(cwd, 'scripts', 'tests', 'bootstrap', 'seed-pgtap-fixtures.js')),
    migrationFingerprint: {
      algorithm: migration.algorithm,
      file_count: migration.file_count,
      digest: migration.digest,
    },
    ports: focusedIdentityPorts,
  });
}

function writePgProveWrappers(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const requestedDirectory = String(options.directory || '');
  const directory = path.resolve(requestedDirectory);
  if (!path.isAbsolute(requestedDirectory) || requestedDirectory !== directory) {
    throw new Error('Focused pg_prove wrapper directory must be an absolute canonical path.');
  }
  focused.ensureSafeDirectoryWithin(options.cwd, directory, fsImpl);
  return options.records.map((record, index) => {
    const name = String(index + 1).padStart(3, '0') + '-' + record.digest.slice(0, 16) + '.sql';
    const target = path.join(directory, name);
    const temporary = target + '.' + process.pid + '.tmp';
    if (!focused.isPathWithin(directory, target) || path.dirname(target) !== directory) {
      throw new Error('Focused pg_prove wrapper path escapes its canonical directory.');
    }
    if (fsImpl.existsSync(target) || fsImpl.existsSync(temporary)) {
      throw new Error('Focused pg_prove wrapper target already exists.');
    }
    const sql = focused.buildPgProveWrapperSql({
      cwd: options.cwd,
      file: record.path,
      sourceSha256: record.digest,
      jobOrdinal: index + 1,
      sourcePath: options.sourceRoot
        ? `${String(options.sourceRoot).replace(/\/$/u, '')}/${record.path}`
        : '',
    });
    fsImpl.writeFileSync(temporary, sql, { encoding: 'utf8', flag: 'wx' });
    fsImpl.renameSync(temporary, target);
    const stat = fsImpl.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Focused pg_prove wrapper must be a regular non-symlink file.');
    return {
      file: record.path,
      fileKey: focused.sha256(record.path),
      digest: record.digest,
      path: target,
      name,
      jobOrdinal: index + 1,
    };
  });
}

function childFacts(child, exit, output, hardStopSignals = []) {
  return {
    interrupted: false,
    spawnError: child.close_observed !== true && child.timed_out !== true,
    closeObserved: child.close_observed === true,
    timedOut: child.timed_out === true,
    signal: String(child.signal || ''),
    writerMayBeActive: child.writer_may_be_active === true,
    exit,
    output,
    hardStopSignals,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function parsePgProveWrapperResultBlock(output, wrapper, wrappers) {
  const lines = String(output || '').split(/\r?\n/u);
  const wrapperPattern = new RegExp('(?:^|[\\\\/])' + escapeRegExp(wrapper.name) + '(?=\\s|$)', 'u');
  const anyWrapperPattern = new RegExp(
    '(?:^|[\\\\/])(?:' + wrappers.map((entry) => escapeRegExp(entry.name)).join('|') + ')(?=\\s|$)',
    'u',
  );
  const matches = lines
    .map((line, index) => ({ line, index, match: wrapperPattern.exec(line) }))
    .filter((entry) => entry.match);
  if (matches.length !== 1) return { lines: matches.map((entry) => entry.line), failure: false, passed: false };

  const entry = matches[0];
  const suffix = entry.line.slice(entry.match.index + entry.match[0].length);
  if (/^\s*\.\.\s*ok\b/iu.test(suffix)) return { lines: [entry.line], failure: false, passed: true };
  if (/^\s*\.\.\s*(?:not ok|dubious|failed)\b/iu.test(suffix)) {
    return { lines: [entry.line], failure: true, passed: false };
  }
  if (!/^\s*\.\.\s*$/u.test(suffix)) return { lines: [entry.line], failure: false, passed: false };

  const continuation = lines[entry.index + 1];
  if (continuation === undefined || anyWrapperPattern.test(continuation)) {
    return { lines: [entry.line], failure: false, passed: false };
  }
  if (/^\s*ok\b/iu.test(continuation)) return { lines: [entry.line, continuation], failure: false, passed: true };
  if (/^\s*(?:not ok|dubious|failed)\b/iu.test(continuation)) {
    return { lines: [entry.line, continuation], failure: true, passed: false };
  }
  const blockLines = [entry.line];
  const jobPattern = new RegExp(
    '^#\\s*MASARX_PG_PROVE_JOB job=' + wrapper.jobOrdinal
      + ' backend_pid=(\\d+) file_key=' + wrapper.fileKey
      + ' file_sha256=' + wrapper.digest + '\\s*$',
    'u',
  );
  const donePattern = new RegExp(
    '^#\\s*MASARX_PG_PROVE_DONE job=' + wrapper.jobOrdinal
      + ' backend_pid=(\\d+) file_key=' + wrapper.fileKey
      + ' file_sha256=' + wrapper.digest + ' elapsed_ms=\\d+\\s*$',
    'u',
  );
  let backendPid = null;
  let doneObserved = false;
  for (let index = entry.index + 1; index < lines.length && blockLines.length <= 2048; index += 1) {
    const line = lines[index];
    if (anyWrapperPattern.test(line)) return { lines: blockLines, failure: false, passed: false };
    const jobMatch = jobPattern.exec(line);
    if (jobMatch) {
      if (backendPid !== null || doneObserved) return { lines: blockLines, failure: false, passed: false };
      backendPid = Number(jobMatch[1]);
      blockLines.push(line);
      continue;
    }
    const doneMatch = donePattern.exec(line);
    if (doneMatch) {
      if (backendPid === null || doneObserved || Number(doneMatch[1]) !== backendPid) {
        return { lines: blockLines, failure: false, passed: false };
      }
      doneObserved = true;
      blockLines.push(line);
      continue;
    }
    if (/MASARX_PG_PROVE_(?:JOB|DONE)/u.test(line)) {
      return { lines: blockLines, failure: false, passed: false };
    }
    if (doneObserved && /^\s*ok\s+\d+(?:\.\d+)?\s+ms\b/iu.test(line)) {
      return { lines: [...blockLines, line], failure: false, passed: true };
    }
    if (doneObserved && /^\s*(?:not ok|dubious|failed)\b/iu.test(line)) {
      return { lines: [...blockLines, line], failure: true, passed: false };
    }
    if (/^\s*(?:Result:|All tests|Files=|MASARX_PG_PROVE_TOOLCHAIN_DONE)/iu.test(line)) {
      return { lines: blockLines, failure: false, passed: false };
    }
    blockLines.push(line);
  }
  return { lines: blockLines, failure: false, passed: false };
}

function parsePgProveWaveResults(options = {}) {
  const child = options.child || {};
  const output = String(child.stdout || '') + '\n' + String(child.stderr || '');
  const wrappers = options.wrappers || [];
  const summary = new Map();
  for (const wrapper of wrappers) {
    summary.set(wrapper.file, parsePgProveWrapperResultBlock(output, wrapper, wrappers));
  }
  const globalLockClass = focused.classifyLockSerialization(output);
  return wrappers.map((wrapper) => {
    let worker = null;
    let completion = null;
    const hardStopSignals = [];
    const expectedMarker = { jobOrdinal: wrapper.jobOrdinal, fileKey: wrapper.fileKey, sourceSha256: wrapper.digest };
    try { worker = focused.parsePgProveWorkerMarker(output, expectedMarker); } catch (error) {
      hardStopSignals.push({ family: 'lifecycle', failureClass: 'parallel_file_worker_marker_missing_or_ambiguous', reason: error.message });
    }
    try { completion = focused.parsePgProveCompletionMarker(output, expectedMarker); } catch (error) {
      hardStopSignals.push({ family: 'lifecycle', failureClass: 'parallel_file_completion_marker_missing_or_ambiguous', reason: error.message });
    }
    if (worker && completion && (worker.jobOrdinal !== completion.jobOrdinal || worker.backendPid !== completion.backendPid)) {
      hardStopSignals.push({ family: 'lifecycle', failureClass: 'parallel_file_worker_completion_identity_mismatch' });
    }
    const recordSummary = summary.get(wrapper.file);
    let attributedOutput = recordSummary.lines.join('\n');
    if (worker && completion) {
      const startPattern = new RegExp('MASARX_PG_PROVE_JOB job=' + wrapper.jobOrdinal + ' backend_pid=\\d+ file_key=' + wrapper.fileKey + ' file_sha256=' + wrapper.digest, 'u');
      const donePattern = new RegExp('MASARX_PG_PROVE_DONE job=' + wrapper.jobOrdinal + ' backend_pid=\\d+ file_key=' + wrapper.fileKey + ' file_sha256=' + wrapper.digest + ' elapsed_ms=\\d+', 'u');
      const startMatch = startPattern.exec(output);
      const doneMatch = donePattern.exec(output);
      if (!startMatch || !doneMatch || doneMatch.index < startMatch.index) {
        hardStopSignals.push({ family: 'lifecycle', failureClass: 'parallel_file_output_segment_missing_or_ambiguous' });
      } else {
        const segment = output.slice(startMatch.index, doneMatch.index + doneMatch[0].length);
        if ((segment.match(/MASARX_PG_PROVE_JOB/gu) || []).length !== 1) {
          hardStopSignals.push({ family: 'lifecycle', failureClass: 'parallel_file_output_cross_attribution_detected' });
        } else {
          attributedOutput = segment + (recordSummary.lines.length ? '\n' + recordSummary.lines.join('\n') : '');
        }
      }
    }
    if (globalLockClass !== 'none_observed') {
      hardStopSignals.push({ family: 'lifecycle', failureClass: 'parallel_wave_' + globalLockClass + '_hard_stop' });
    }
    let exit = 0;
    if (child.exit === 1) {
      if (recordSummary.failure) exit = 1;
      else if (!recordSummary.passed) hardStopSignals.push({ family: 'unknown', failureClass: 'pg_prove_per_file_result_ambiguous' });
    } else if (child.exit === 0 && !recordSummary.passed) {
      hardStopSignals.push({ family: 'unknown', failureClass: 'pg_prove_per_file_result_ambiguous' });
    } else if (child.exit !== 0) {
      hardStopSignals.push({ family: 'lifecycle', failureClass: 'pg_prove_wave_exit_unexpected' });
    }
    return {
      file: wrapper.file,
      worker,
      elapsedMs: completion?.elapsedMs ?? 0,
      facts: childFacts(child, exit, attributedOutput, hardStopSignals),
    };
  });
}

function buildFinalSerializedCommands(options = {}) {
  const targetKind = options.identity?.targetKind;
  const policy = options.policy?.finalGates;
  const localPolicy = policy?.localCandidateByTargetKind?.[targetKind];
  if (!policy?.aToZ || !localPolicy) throw new Error('Focused final-gate policy is unavailable for target kind: ' + targetKind);
  const substitutions = {
    '{spec_issue}': String(options.specIssue || ''),
    '{target_id}': String(options.identity.targetId || ''),
    '{branch}': String(options.identity.branch || ''),
    '{head_sha}': String(options.identity.headSha || ''),
  };
  const renderArgs = (args) => args.map((value) => substitutions[value] ?? value);
  if (localPolicy.args.includes('{spec_issue}') && !substitutions['{spec_issue}']) throw new Error('Focused PR final gates require --spec-issue.');
  return {
    aToZ: {
      label: 'focused parallel-wave final serialized A-to-Z',
      command: process.execPath,
      args: [path.normalize(policy.aToZ.script), ...renderArgs(policy.aToZ.args)],
      env: { ...policy.aToZ.env },
    },
    localCandidate: {
      label: 'focused parallel-wave final local-candidate',
      command: process.execPath,
      args: [path.normalize(localPolicy.script), ...renderArgs(localPolicy.args)],
      env: {},
    },
  };
}

function pgProveStateEvidence(invocation, fsImpl = fs) {
  const exists = fsImpl.existsSync(invocation.stateFile);
  const raw = exists ? fsImpl.readFileSync(invocation.stateFile) : Buffer.alloc(0);
  return {
    saved: exists,
    fileSha256: focused.sha256(raw),
    toolchain: invocation.toolchainEvidence || null,
  };
}

function checkpointWriter(options = {}) {
  let previousRaw = String(options.previousRaw || '');
  let previousFingerprint = previousRaw ? focused.sha256(previousRaw) : '';
  return (state) => {
    const checkpoint = focused.buildFocusedParallelWaveCheckpoint(state, previousRaw, {
      writerLockFingerprint: options.writerLockFingerprint,
    });
    const written = focused.writeFocusedParallelWaveCheckpointAtomic(options.filePath, checkpoint, {
      identity: options.identity,
      writerLockFingerprint: options.writerLockFingerprint,
      expectedPreviousFingerprint: previousFingerprint,
    });
    previousRaw = JSON.stringify(checkpoint, null, 2) + '\n';
    previousFingerprint = written.fingerprint;
    return written;
  };
}

const CHECKPOINT_TRANSITION_FAILURE_CLASS = 'focused_checkpoint_transition_lifecycle_failed';
const CHECKPOINT_TRANSITION_EVIDENCE_SCHEMA = 'pr-validation-session.focused-checkpoint-transition.v1';

function checkpointTransitionFailure(reason) {
  const error = new Error('Focused checkpoint transition lifecycle failed: ' + reason);
  error.failureClass = CHECKPOINT_TRANSITION_FAILURE_CLASS;
  return error;
}

function checkpointTransitionLeaseState(lease) {
  return String(lease?.validation_stack_state || lease?.details?.state || '').trim();
}

function canonicalTransitionPorts(value, label) {
  const ports = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!ports || !Object.keys(ports).length) throw checkpointTransitionFailure(label + ' ports are missing.');
  const normalized = {};
  for (const key of Object.keys(ports).sort(focused.compareAscii)) {
    const port = Number(ports[key]);
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key) || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw checkpointTransitionFailure(label + ' ports are invalid.');
    }
    normalized[key] = port;
  }
  if (new Set(Object.values(normalized)).size !== Object.keys(normalized).length) {
    throw checkpointTransitionFailure(label + ' ports are not unique.');
  }
  return normalized;
}

function checkpointTransitionPath(value, platform = process.platform) {
  const raw = String(value || '');
  if (!raw || raw !== raw.trim() || !path.isAbsolute(raw)) {
    throw checkpointTransitionFailure('validation worktree path is missing or noncanonical.');
  }
  const normalized = path.normalize(path.resolve(raw));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function checkpointTransitionLeaseMatchesIdentity(lease, identity, fullPorts, includeLeaseId = true) {
  const details = lease?.details || {};
  const leasePorts = canonicalTransitionPorts(details.ports, 'validation lease');
  return lease?.resource_class === identity.validationResource
    && lease?.owner === identity.validationOwner
    && (!includeLeaseId || String(lease?.id || '') === identity.leaseId)
    && String(details.project_id || '') === identity.projectId
    && String(details.pr_number || '') === identity.prNumber
    && String(details.owner_thread_id || '') === identity.ownerThreadId
    && String(details.worktree_id || '') === identity.worktreeId
    && checkpointTransitionPath(details.worktree_path) === checkpointTransitionPath(identity.worktreePath)
    && String(details.branch || '') === identity.branch
    && String(details.head_sha || '').toLowerCase() === identity.headSha
    && focused.canonicalJson(leasePorts) === focused.canonicalJson(fullPorts);
}

function loadFocusedCheckpointForTransition(checkpointPath, fsImpl) {
  const stat = fsImpl.lstatSync(checkpointPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) {
    throw checkpointTransitionFailure('predecessor checkpoint is not a safe local file.');
  }
  const observedRaw = fsImpl.readFileSync(checkpointPath, 'utf8');
  let observed;
  try {
    observed = JSON.parse(observedRaw);
  } catch (_) {
    throw checkpointTransitionFailure('predecessor checkpoint JSON is malformed.');
  }
  let loaded;
  try {
    loaded = focused.loadFocusedParallelWaveCheckpoint(checkpointPath, observed?.identity, { fsImpl });
  } catch (error) {
    throw checkpointTransitionFailure(error?.message || String(error));
  }
  if (loaded.raw !== observedRaw) {
    throw checkpointTransitionFailure('predecessor checkpoint changed while its embedded identity was validated.');
  }
  return loaded;
}

function assertSuccessfulCheckpointTransitionPredecessor(checkpoint) {
  if (checkpoint.status !== 'focused_subset_terminal_passed') {
    throw checkpointTransitionFailure('predecessor is not a successful terminal subset checkpoint.');
  }
  if (!Number.isInteger(checkpoint.revision) || checkpoint.revision < 0) {
    throw checkpointTransitionFailure('predecessor revision is invalid.');
  }
  if (
    (checkpoint.revision === 0 && checkpoint.previousCheckpointSha256 !== '')
    || (checkpoint.revision > 0 && !/^[a-f0-9]{64}$/u.test(String(checkpoint.previousCheckpointSha256 || '')))
  ) {
    throw checkpointTransitionFailure('predecessor checkpoint chain is invalid.');
  }
  const sets = checkpoint.sets || {};
  const counts = checkpoint.counts || {};
  const passedStatuses = new Set(['parallel_passed', 'serial_passed', 'repaired_serial_passed']);
  const repairedPasses = Array.isArray(checkpoint.perFile)
    ? checkpoint.perFile.filter((entry) => entry?.status === 'repaired_serial_passed').map((entry) => entry.path).sort(focused.compareAscii)
    : [];
  const historicalFailures = Array.isArray(sets.completeFailureSet)
    ? [...sets.completeFailureSet].sort(focused.compareAscii)
    : [];
  if (
    checkpoint.hardStop
    || !Array.isArray(sets.unresolvedFailureSet)
    || !Array.isArray(sets.completeFailureSet)
    || sets.unresolvedFailureSet.length
    || Number(counts.unresolvedFailures || 0) !== 0
    || Number(counts.completeFailures || 0) !== historicalFailures.length
    || focused.canonicalJson(historicalFailures) !== focused.canonicalJson(repairedPasses)
    || !Number.isInteger(counts.selected)
    || counts.selected < 1
    || !Array.isArray(checkpoint.perFile)
    || checkpoint.perFile.length !== counts.selected
    || checkpoint.perFile.some((entry) => !passedStatuses.has(entry?.status))
    || !checkpoint.scheduler
    || checkpoint.scheduler.hardStop
    || checkpoint.scheduler.activeWave
    || !Array.isArray(checkpoint.scheduler.repairClaims)
    || checkpoint.scheduler.repairClaims.some((claim) => new Set(['in_progress', 'ready_for_integration']).has(claim?.state))
    || !Array.isArray(checkpoint.scheduler.entries)
    || checkpoint.scheduler.entries.length !== counts.selected
    || checkpoint.scheduler.entries.some((entry) => entry?.state !== 'passed')
  ) {
    throw checkpointTransitionFailure('predecessor contains a hard stop, failure, or pending selected work.');
  }
}

function assertCheckpointTransitionIdentity(previousIdentity, currentIdentity) {
  const immutableKeys = [
    'targetKind', 'targetId', 'prNumber', 'repoId', 'repoPath', 'ownerThreadId',
    'worktreeId', 'worktreePath', 'branch', 'headSha', 'projectId',
    'validationResource', 'validationOwner', 'warmBaselineFingerprint',
    'focusedPolicySafetyFingerprint', 'runnerFingerprint', 'pgtapHarnessFingerprint',
    'fixtureBootstrapFingerprint', 'migrationFingerprint', 'ports',
  ];
  const previousImmutable = Object.fromEntries(immutableKeys.map((key) => [key, previousIdentity[key]]));
  const currentImmutable = Object.fromEntries(immutableKeys.map((key) => [key, currentIdentity[key]]));
  if (focused.canonicalJson(previousImmutable) !== focused.canonicalJson(currentImmutable)) {
    throw checkpointTransitionFailure('immutable target, runtime baseline, policy safety, or harness identity changed.');
  }
  if (previousIdentity.lineageFingerprint !== currentIdentity.lineageFingerprint) {
    throw checkpointTransitionFailure('target lineage changed.');
  }
}

function validateCheckpointManifestContinuity(checkpoint, plan, currentIdentity, options = {}) {
  if (plan?.schema !== checkpoint.schema || !plan.focusedManifest || !Array.isArray(plan.records)) {
    throw checkpointTransitionFailure('current selected queue plan is missing or unsupported.');
  }
  try {
    focused.validateCanonicalFocusedManifest(plan.focusedManifest, currentIdentity);
  } catch (error) {
    throw checkpointTransitionFailure(error?.message || String(error));
  }
  const previousManifest = checkpoint.focusedManifest || {};
  const currentManifest = plan.focusedManifest || {};
  const allowedDigestChanges = new Set(options.allowedDigestChanges || []);
  if (!Array.isArray(previousManifest.files) || !Array.isArray(currentManifest.files)) {
    throw checkpointTransitionFailure('canonical focused manifest files are missing.');
  }
  const previousEntries = new Map(previousManifest.files.map((entry) => [entry.path, entry.digest]));
  const currentEntries = new Map(currentManifest.files.map((entry) => [entry.path, entry.digest]));
  const previousManifestPaths = previousManifest.files.map((entry) => entry.path);
  const currentManifestPaths = currentManifest.files.map((entry) => entry.path);
  if (
    previousManifest.fileCount !== currentManifest.fileCount
    || focused.canonicalJson(previousManifestPaths) !== focused.canonicalJson(currentManifestPaths)
    || currentManifestPaths.some((file) => (
      previousEntries.get(file) !== currentEntries.get(file) && !allowedDigestChanges.has(file)
    ))
    || [...allowedDigestChanges].some((file) => !currentEntries.has(file))
  ) {
    throw checkpointTransitionFailure('canonical focused manifest changed across sequential subsets.');
  }
  if (!allowedDigestChanges.size && previousManifest.queueDigest !== currentManifest.queueDigest) {
    throw checkpointTransitionFailure('canonical focused manifest digest changed across sequential subsets.');
  }
  const fullFiles = previousManifestPaths;
  const previousFiles = checkpoint.perFile
    .slice()
    .sort((left, right) => left.queueIndex - right.queueIndex)
    .map((entry) => entry.path);
  const previousRemainder = checkpoint.manifestRemainder;
  const consumedCount = fullFiles.length - (Array.isArray(previousRemainder) ? previousRemainder.length : 0);
  const consumedPrefix = fullFiles.slice(0, consumedCount);
  const previousBatchPrefix = consumedPrefix.slice(consumedPrefix.length - previousFiles.length);
  if (
    new Set(fullFiles).size !== fullFiles.length
    || new Set(previousFiles).size !== previousFiles.length
    || !Array.isArray(previousRemainder)
    || new Set(previousRemainder).size !== previousRemainder.length
    || consumedCount < previousFiles.length
    || focused.canonicalJson(previousBatchPrefix) !== focused.canonicalJson(previousFiles)
    || focused.canonicalJson(previousRemainder) !== focused.canonicalJson(fullFiles.slice(consumedCount))
  ) {
    throw checkpointTransitionFailure('predecessor selected queue and manifest remainder are not continuous.');
  }
  return { consumedPrefix, previousFiles, previousRemainder };
}

function assertCheckpointTransitionContinuity(checkpoint, plan, currentIdentity) {
  const continuity = validateCheckpointManifestContinuity(checkpoint, plan, currentIdentity);
  const { consumedPrefix, previousFiles, previousRemainder } = continuity;
  const previousPasses = checkpoint.sets.orderedPassSet || [];
  if (focused.canonicalJson(previousPasses) !== focused.canonicalJson(previousFiles)) {
    throw checkpointTransitionFailure('predecessor successful batch pass set is not exact.');
  }
  const selected = plan.records
    .slice()
    .sort((left, right) => left.queueIndex - right.queueIndex)
    .map((entry) => ({ path: entry.path, digest: entry.digest }));
  const selectedPaths = selected.map((entry) => entry.path);
  if (
    !selectedPaths.length
    || new Set(selectedPaths).size !== selectedPaths.length
    || selectedPaths.some((file, index) => index > 0 && focused.compareAscii(selectedPaths[index - 1], file) >= 0)
    || plan.queueDigest !== focused.sha256(focused.canonicalJson(selected))
  ) {
    throw checkpointTransitionFailure('current selected queue is empty, duplicated, reordered, or digest-invalid.');
  }
  if (selectedPaths.some((file) => consumedPrefix.includes(file))) {
    throw checkpointTransitionFailure('current selected queue replays or overlaps predecessor files.');
  }
  const expectedPrefix = previousRemainder.slice(0, selectedPaths.length);
  if (focused.canonicalJson(selectedPaths) !== focused.canonicalJson(expectedPrefix)) {
    throw checkpointTransitionFailure('current selected queue skips or reorders the next canonical remainder prefix.');
  }
  const manifestByPath = new Map(checkpoint.focusedManifest.files.map((entry) => [entry.path, entry.digest]));
  if (selected.some((entry) => manifestByPath.get(entry.path) !== entry.digest)) {
    throw checkpointTransitionFailure('current selected queue digest differs from the predecessor manifest.');
  }
  return previousRemainder.slice(selectedPaths.length);
}

function resolveFocusedRepairCheckpointRemainder(checkpoint, plan, currentIdentity, selectedFiles) {
  const selected = [...(selectedFiles || [])].sort(focused.compareAscii);
  if (!selected.length || new Set(selected).size !== selected.length) {
    throw checkpointTransitionFailure('repair checkpoint selection is empty or duplicated.');
  }
  const continuity = validateCheckpointManifestContinuity(checkpoint, plan, currentIdentity, {
    allowedDigestChanges: selected,
  });
  const planFiles = plan.records
    .slice()
    .sort((left, right) => left.queueIndex - right.queueIndex)
    .map((entry) => entry.path);
  const unresolved = new Set(checkpoint.sets?.unresolvedFailureSet || []);
  if (
    focused.canonicalJson(planFiles) !== focused.canonicalJson(selected)
    || selected.some((file) => !continuity.previousFiles.includes(file) || !unresolved.has(file))
  ) {
    throw checkpointTransitionFailure('repair selection is not an exact unresolved subset of the current checkpoint batch.');
  }
  return [...continuity.previousRemainder];
}

function assertCheckpointTransitionLifecycle(previousIdentity, currentIdentity, evidence) {
  if (evidence?.schema !== CHECKPOINT_TRANSITION_EVIDENCE_SCHEMA) {
    throw checkpointTransitionFailure('lifecycle evidence is missing or unsupported.');
  }
  const fullPorts = canonicalTransitionPorts(evidence.fullPorts, 'current validation stack');
  const currentGeneration = focused.sha256(focused.canonicalJson({
    leaseId: currentIdentity.leaseId,
    projectId: currentIdentity.projectId,
    ports: fullPorts,
    warmBaselineFingerprint: currentIdentity.warmBaselineFingerprint,
  }));
  const previousGeneration = focused.sha256(focused.canonicalJson({
    leaseId: previousIdentity.leaseId,
    projectId: previousIdentity.projectId,
    ports: fullPorts,
    warmBaselineFingerprint: previousIdentity.warmBaselineFingerprint,
  }));
  if (
    currentGeneration !== currentIdentity.validationStackGeneration
    || previousGeneration !== previousIdentity.validationStackGeneration
  ) {
    throw checkpointTransitionFailure('validation stack generation is not canonical.');
  }
  if (
    previousIdentity.leaseId === currentIdentity.leaseId
    && previousIdentity.validationStackGeneration !== currentIdentity.validationStackGeneration
  ) {
    throw checkpointTransitionFailure('same-lease rollover changed validation stack generation.');
  }
  if (
    previousIdentity.leaseId !== currentIdentity.leaseId
    && previousIdentity.validationStackGeneration === currentIdentity.validationStackGeneration
  ) {
    throw checkpointTransitionFailure('changed lease did not change validation stack generation.');
  }
  if (!Array.isArray(evidence.validationLeases)) {
    throw checkpointTransitionFailure('authoritative validation lease inventory is missing.');
  }
  const validationLeases = evidence.validationLeases.filter((lease) => (
    lease?.resource_class === currentIdentity.validationResource
    && lease?.owner === currentIdentity.validationOwner
  ));
  const liveLeases = validationLeases.filter((lease) => new Set(['active', 'starting']).has(checkpointTransitionLeaseState(lease)));
  if (liveLeases.length !== 1) {
    throw checkpointTransitionFailure('validation lease inventory does not prove exactly one live owner-bound stack.');
  }
  const currentLease = validationLeases.find((lease) => String(lease?.id || '') === currentIdentity.leaseId);
  if (
    !currentLease
    || checkpointTransitionLeaseState(currentLease) !== 'active'
    || currentLease.stale === true
    || currentLease.expired === true
    || !checkpointTransitionLeaseMatchesIdentity(currentLease, currentIdentity, fullPorts)
  ) {
    throw checkpointTransitionFailure('current active validation lease is not exact and fresh.');
  }
  if (!checkpointTransitionLeaseMatchesIdentity(liveLeases[0], currentIdentity, fullPorts, false)) {
    throw checkpointTransitionFailure('live validation lease is bound to another target or runtime.');
  }
  if (previousIdentity.leaseId !== currentIdentity.leaseId) {
    const priorLease = validationLeases.find((lease) => String(lease?.id || '') === previousIdentity.leaseId);
    if (priorLease && !new Set(['released', 'terminal_stop_required']).has(checkpointTransitionLeaseState(priorLease))) {
      throw checkpointTransitionFailure('prior validation lease is not proven terminal or released.');
    }
  }
  const processGuard = evidence.processGuard || {};
  if (
    processGuard.scan_ok !== true
    || Number(processGuard.exact_heartbeat_count || 0) !== 1
    || Number(processGuard.runner_count || 0) !== 0
    || Number(processGuard.unbound_heartbeat_count || 0) !== 0
    || Number(processGuard.ambiguous_process_count || 0) !== 0
  ) {
    throw checkpointTransitionFailure('current heartbeat or runner evidence is not exact.');
  }
  if (
    evidence.currentGuard?.allGreen !== true
    || evidence.currentGuard?.leaseId !== currentIdentity.leaseId
    || evidence.currentGuard?.validationStackGeneration !== currentIdentity.validationStackGeneration
    || evidence.currentGuard?.leaseGuardGreen !== true
    || evidence.currentGuard?.processGuardGreen !== true
    || evidence.currentGuard?.heartbeatGuardGreen !== true
    || evidence.currentGuard?.overlayGuardGreen !== true
    || evidence.currentGuard?.migrationFingerprintStable !== true
    || evidence.overlayAllowed !== true
    || evidence.migrationMatches !== true
  ) {
    throw checkpointTransitionFailure('current lifecycle, overlay, or migration guard is not green.');
  }
}

function resolveFocusedNativeCheckpointPredecessor(options = {}) {
  const fsImpl = options.fsImpl || fs;
  if (!fsImpl.existsSync(options.checkpointPath)) {
    return { previousRaw: '', previousFingerprint: '', nextRevision: 0 };
  }
  if (fsImpl.existsSync(options.checkpointPath + '.writer.lock')) {
    throw checkpointTransitionFailure('predecessor checkpoint has an active writer lock.');
  }
  const loaded = loadFocusedCheckpointForTransition(options.checkpointPath, fsImpl);
  assertSuccessfulCheckpointTransitionPredecessor(loaded.checkpoint);
  const previousIdentity = focused.buildFocusedCollectionIdentity(loaded.checkpoint.identity || {});
  const currentIdentity = focused.buildFocusedCollectionIdentity(options.identity || {});
  assertCheckpointTransitionIdentity(previousIdentity, currentIdentity);
  const futureManifestRemainder = assertCheckpointTransitionContinuity(
    loaded.checkpoint,
    options.plan,
    currentIdentity,
  );
  const canonicalCurrentPath = focused.focusedParallelWaveCheckpointPath(path.dirname(options.checkpointPath), currentIdentity);
  if (path.resolve(options.checkpointPath) !== canonicalCurrentPath) {
    throw checkpointTransitionFailure('checkpoint path is not canonical for the current target lineage.');
  }
  assertCheckpointTransitionLifecycle(
    previousIdentity,
    currentIdentity,
    options.checkpointTransitionLifecycleEvidence,
  );
  return {
    previousRaw: loaded.raw,
    previousFingerprint: loaded.fingerprint,
    nextRevision: loaded.checkpoint.revision + 1,
    previousIdentity,
    futureManifestRemainder,
  };
}

function serializedChildFacts(child, output, guard, isolationState, attributedFacts = null) {
  return {
    ...(attributedFacts || childFacts(child, child.exit, output)),
    hostGreen: guard.hostGreen,
    migrationFingerprintStable: guard.migrationFingerprintStable,
    policyFingerprintStable: guard.policyFingerprintStable,
    runnerFingerprintStable: guard.runnerFingerprintStable,
    harnessFingerprintStable: guard.harnessFingerprintStable,
    fixtureBootstrapFingerprintStable: guard.fixtureBootstrapFingerprintStable,
    testFileDigestStable: guard.testFileDigestStable,
    dirtyGuardGreen: guard.dirtyGuardGreen,
    leaseGuardGreen: guard.leaseGuardGreen,
    processGuardGreen: guard.processGuardGreen,
    heartbeatGuardGreen: guard.heartbeatGuardGreen,
    overlayGuardGreen: guard.overlayGuardGreen,
    isolationState,
  };
}

function buildFocusedPgProveStep(options = {}) {
  const focusedTimeoutMs = focused.validateFocusedHostTimeoutMs(options.focusedTimeoutMs);
  const execution = pgProveToolchain.buildToolchainCommand({
    cwd: options.cwd,
    stateDirectory: options.stateDirectory,
    phase: options.phase,
    timeoutMs: focusedTimeoutMs,
    logicalArgs: options.logicalArgs,
  });
  return {
    execution,
    step: {
      label: 'focused pg_prove ' + options.phase,
      command: execution.command,
      args: execution.args,
      env: { ...(options.connectionEnv || {}), PGAPPNAME: 'masarx-focused-pg-prove' },
      timeoutMs: focusedTimeoutMs,
    },
  };
}

async function captureFinalGuardAfterContamination(contamination, captureGuard) {
  if (contamination?.stable !== true) return null;
  if (typeof captureGuard !== 'function') throw new Error('Focused final guard capture is required.');
  return captureGuard();
}

async function executeAfterStableContaminationBaseline(options = {}) {
  if (typeof options.execute !== 'function') {
    throw new Error('Focused contamination baseline gate requires an execution callback.');
  }
  let baseline;
  try {
    baseline = await establishContaminationBaseline({
      captureSnapshot: options.captureSnapshot,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      sleep: options.sleep,
      now: options.now,
    });
  } catch (error) {
    if (error?.code !== 'FOCUSED_CONTAMINATION_DEADLINE_EXCEEDED') throw error;
    return {
      baseline: null,
      baselineDeadline: {
        failureClass: FOCUSED_BASELINE_DEADLINE_FAILURE_CLASS,
        reason: error?.message || String(error),
      },
      executed: false,
      preExecution: null,
      result: null,
    };
  }
  if (baseline.accepted !== true) {
    return { baseline, executed: false, preExecution: null, result: null };
  }
  const preExecution = typeof options.beforeExecution === 'function'
    ? await options.beforeExecution(baseline)
    : null;
  if (preExecution?.accepted === false) {
    return { baseline, executed: false, preExecution, result: null };
  }
  return {
    baseline,
    executed: true,
    preExecution,
    result: await options.execute(baseline.snapshot),
  };
}

function terminalizeFocusedBaselineDeadlineState(stateValue, options = {}) {
  const files = [...(options.files || [])];
  const deadline = options.deadline || {};
  let state = focused.reduceFocusedParallelWaveState(stateValue, {
    type: 'capacity_sample_failed',
    phase: options.phase,
    files,
    family: 'lifecycle',
    failureClass: deadline.failureClass || FOCUSED_BASELINE_DEADLINE_FAILURE_CLASS,
    reason: deadline.reason || 'Focused contamination baseline exceeded its absolute deadline.',
  }, { policy: options.policy });
  state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
    type: 'hard_stop',
    family: 'lifecycle',
    failureClass: deadline.failureClass || FOCUSED_BASELINE_DEADLINE_FAILURE_CLASS,
    file: files[0] || '',
  }, { policy: options.policy });
  return state;
}
async function executeFocusedNativeSession(options = {}) {
  const focusedTimeoutMs = focused.validateFocusedHostTimeoutMs(options.focusedTimeoutMs);
  if (options.admission?.enabled !== true || options.admission.mode?.pilotAuthorized !== true) {
    throw new Error('Focused native execution is disabled until policy authorization is explicit.');
  }
  if (typeof options.runStep !== 'function' || typeof options.captureGuard !== 'function' || typeof options.sampleCapacity !== 'function') {
    throw new Error('Focused native execution requires owner-bound runner, guard, and capacity callbacks.');
  }
  if (options.preAdmissionGuard?.allGreen !== true) {
    throw new Error('Focused native execution requires a fresh green pre-admission lifecycle guard.');
  }
  const capacityMode = resolveFocusedNativeCapacityMode(options.admission.mode, options.capacityEvidence);
  const connection = options.connection || resolvePgProveConnection({
    expectedPort: options.ports.db,
    cwd: options.cwd,
  });
  const plan = buildFocusedNativePlan({
    cwd: options.cwd,
    files: options.files,
    policy: options.admission.policy,
    mode: capacityMode,
    identity: options.identity,
  });
  const identity = options.identity;
  const checkpointPath = focused.focusedParallelWaveCheckpointPath(options.outDir, identity);
  const writerLockFingerprint = options.writerLockFingerprint;
  let state;
  let scheduler;
  let previousRaw = '';
  if (options.repairFocusedFailures === true) {
    const loaded = focused.loadFocusedParallelWaveCheckpoint(checkpointPath, identity);
    previousRaw = loaded.raw;
    const preservedManifestRemainder = resolveFocusedRepairCheckpointRemainder(
      loaded.checkpoint,
      plan,
      identity,
      options.files,
    );
    scheduler = focused.validateFocusedRepairSchedulerState(loaded.checkpoint.scheduler, {
      identity,
      plan: {
        focusedManifest: plan.focusedManifest,
        queueDigest: loaded.checkpoint.scheduler.checkpointBinding.selectedQueueDigest,
      },
    });
    state = focused.prepareFocusedRepairState(loaded.checkpoint, plan, options.files);
    state.focusedManifest = JSON.parse(JSON.stringify(plan.focusedManifest));
    state.manifestRemainder = preservedManifestRemainder;
    state.queueDigest = focused.sha256(focused.canonicalJson([...state.perFile]
      .sort((left, right) => left.queueIndex - right.queueIndex)
      .map((entry) => ({ path: entry.path, digest: entry.digest }))));
    if (state.queueDigest !== scheduler.checkpointBinding.selectedQueueDigest) {
      throw new Error('Focused repaired-failed checkout queue does not match scheduler integration evidence.');
    }
  } else {
    const predecessor = resolveFocusedNativeCheckpointPredecessor({
      checkpointPath,
      identity,
      plan,
      fsImpl: options.fsImpl,
      checkpointTransitionLifecycleEvidence: options.checkpointTransitionLifecycleEvidence,
    });
    previousRaw = predecessor.previousRaw;
    state = focused.createFocusedParallelWaveState(plan, identity);
    state.revision = predecessor.nextRevision;
    if (predecessor.futureManifestRemainder) {
      state.manifestRemainder = predecessor.futureManifestRemainder;
    }
    scheduler = focused.createFocusedRepairScheduler({
      plan,
      identity,
      policy: options.admission.policy,
      authorized: options.admission.mode.pilotAuthorized === true,
    });
  }
  state.scheduler = scheduler;
  const persist = checkpointWriter({
    filePath: checkpointPath,
    identity,
    writerLockFingerprint,
    previousRaw,
  });
  persist(state);
  const probe = options.captureProbe || ((budget = {}) => captureContaminationSnapshot({
    connection,
    expectedPort: options.ports.db,
    ...budget,
  }));
  const stateDirectory = path.join(options.outDir, 'focused-pg-prove-' + identity.lineageFingerprint.slice(0, 16));
  let serializationEvidence = normalizeStructuredSerializationEvidence(options.capacityEvidence.serializationEvidence);

  function observeStructuredSerialization(results, phase, child) {
    const observations = [...serializationEvidence.observations];
    const sampleDigests = [...serializationEvidence.sampleDigests];
    for (const result of results) {
      if (focused.classifyLockSerialization(result.facts.output) !== 'serialization_failure') continue;
      observations.push({
        phase,
        file: result.file,
        sqlstate: '40001',
        outputDigest: focused.sha256(String(result.facts.output || '')),
      });
    }
    const combinedOutput = String(child?.stdout || '') + '\n' + String(child?.stderr || '');
    sampleDigests.push(focused.sha256(combinedOutput));
    if (focused.classifyLockSerialization(combinedOutput) === 'serialization_failure'
      && !observations.slice(serializationEvidence.observations.length).length && results[0]) {
      observations.push({
        phase,
        file: results[0].file,
        sqlstate: '40001',
        outputDigest: focused.sha256(combinedOutput),
      });
    }
    serializationEvidence = normalizeStructuredSerializationEvidence({
      source: 'structured_pg_prove_output',
      observedCount: observations.length,
      observations,
      sampleDigests,
    });
  }

  async function recordCapacity(records, phase, waveNumber = null) {
    const files = records.map((entry) => entry.path);
    try {
      const evidence = await options.sampleCapacity({
        phase, files, waveNumber, revision: state.revision,
        serializationEvidence: JSON.parse(JSON.stringify(serializationEvidence)),
      });
      const capacity = resolveFocusedNativeCapacityMode(options.admission.mode, evidence);
      const adapted = focused.adaptFocusedCollectionModeToEligibility(capacity, files.length);
      state = focused.reduceFocusedParallelWaveState(state, {
        type: 'capacity_sample_recorded',
        sample: {
          sampledAt: String(evidence.sampledAt || new Date().toISOString()),
          phase,
          waveNumber,
          files,
          requestedJobs: adapted.requestedJobs,
          batchSize: adapted.batchSize,
          hostConnectionCap: adapted.hostConnectionCap,
          databaseConnectionCap: adapted.databaseConnectionCap,
          effectiveJobs: adapted.effectiveJobs,
          hostGreen: evidence.hostGreen,
          hostPressure: evidence.hostPressure,
          databaseCapacityKnown: evidence.databaseCapacityKnown,
          hostCpuGreen: evidence.hostCpuGreen,
          hostMemoryGreen: evidence.hostMemoryGreen,
          activeRunnerPressureGreen: evidence.activeRunnerPressureGreen,
          lockWaitCount: evidence.lockWaitCount,
          deadlockCount: evidence.deadlockCount,
          serializationFailureCount: evidence.serializationFailureCount,
          serializationFailureCountBefore: evidence.databaseCapacity.serializationFailureCountBefore,
          serializationFailureCountAfter: evidence.databaseCapacity.serializationFailureCountAfter,
          serializationFailureDelta: evidence.databaseCapacity.serializationFailureDelta,
          serializationEvidence: evidence.serializationEvidence,
        },
      }, { policy: options.admission.policy });
      persist(state);
      const schedulerCapacity = {
        ...evidence,
        immediateHostConnectionCap: Math.min(evidence.immediateHostConnectionCap, files.length),
        databaseConnectionCap: Math.min(evidence.databaseConnectionCap, files.length),
      };
      return { adapted, evidence, schedulerCapacity };
    } catch (error) {
      const databaseFailure = /database|connection cap|DB/iu.test(String(error?.message || error));
      const failureClass = databaseFailure
        ? 'focused_database_capacity_sample_missing_or_red'
        : 'focused_host_capacity_sample_missing_or_red';
      state = focused.reduceFocusedParallelWaveState(state, {
        type: 'capacity_sample_failed',
        phase,
        files,
        family: 'host_red',
        failureClass,
        reason: error?.message || String(error),
      }, { policy: options.admission.policy });
      state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
        type: 'hard_stop', family: 'host_red', failureClass, file: files[0] || '',
      }, { policy: options.admission.policy });
      persist(state);
      return null;
    }
  }

  function terminalizeBaselineDeadline(records, phase, deadline) {
    const files = records.map((entry) => entry.path);
    state = terminalizeFocusedBaselineDeadlineState(state, {
      phase,
      files,
      deadline,
      policy: options.admission.policy,
    });
    persist(state);
  }

  async function runPgProve(records, phase, sampledMode) {
    const phaseDirectory = path.join(stateDirectory, phase + '-' + String(state.revision + 1).padStart(5, '0'));
    const toolchainPolicy = pgProveToolchain.loadPolicy(options.cwd);
    const wrappers = writePgProveWrappers({
      cwd: options.cwd,
      directory: phaseDirectory,
      records,
      sourceRoot: toolchainPolicy.policy.runner.workspace_mount,
    });
    const invocation = focused.buildPgProveWaveInvocation({
      mode: sampledMode,
      phase,
      files: records.map((entry) => entry.path),
      executionFiles: wrappers.map((entry) => entry.path),
      cwd: options.cwd,
      stateDirectory,
      connection: connection.public,
      executionPlatform: 'linux',
    });
    const { execution, step } = buildFocusedPgProveStep({
      cwd: options.cwd,
      stateDirectory,
      phase,
      focusedTimeoutMs,
      logicalArgs: invocation.args,
      connectionEnv: connection.childEnv,
    });
    invocation.stateFile = execution.stateFile;
    const child = await options.runStep(step);
    try {
      invocation.toolchainEvidence = pgProveToolchain.assertToolchainEvidence(
        `${child.stdout || ''}\n${child.stderr || ''}`,
        { cwd: options.cwd },
      );
    } catch (error) {
      throw new Error(`focused_pg_prove_toolchain_evidence_missing_or_invalid: ${error?.message || String(error)}`);
    }
    const results = parsePgProveWaveResults({ child, wrappers });
    observeStructuredSerialization(results, phase, child);
    return { invocation, child, results };
  }

  async function runSerialized(record, eventType, phase) {
    const samplePhase = eventType === 'repaired_failed_file_finished' ? 'repaired_failed' : phase;
    const capacitySample = await recordCapacity([record], samplePhase);
    if (!capacitySample || state.status === 'hard_stopped') return;
    const sampledMode = capacitySample.adapted;
    const guardBefore = await options.captureGuard({ file: record.path, digest: record.digest });
    let facts;
    let contamination;
    let markerBound = false;
    let finalGuard = guardBefore;
    if (guardBefore.allGreen !== true) {
      const before = await probe();
      contamination = compareContaminationSnapshots(before, before);
      facts = serializedChildFacts({
        exit: 1,
        close_observed: true,
        timed_out: false,
        signal: '',
        writer_may_be_active: false,
      }, '', guardBefore, record.isolation.isolationState);
    } else {
      const gated = await executeAfterStableContaminationBaseline({
        captureSnapshot: probe,
        timeoutMs: options.contaminationQuiescenceTimeoutMs,
        intervalMs: options.contaminationQuiescenceIntervalMs,
        sleep: options.contaminationQuiescenceSleep,
        now: options.contaminationQuiescenceNow,
        beforeExecution: async () => {
          const refreshedGuard = await options.captureGuard({ file: record.path, digest: record.digest });
          finalGuard = refreshedGuard;
          return { accepted: refreshedGuard.allGreen === true, guard: refreshedGuard };
        },
        execute: () => runPgProve([record], phase, sampledMode),
      });
      if (gated.baselineDeadline) {
        terminalizeBaselineDeadline([record], `${samplePhase}_contamination_baseline`, gated.baselineDeadline);
        return;
      }
      if (gated.executed !== true) {
        contamination = gated.baseline.comparison;
        finalGuard = gated.preExecution?.guard || guardBefore;
        facts = serializedChildFacts({
          exit: 1,
          close_observed: true,
          timed_out: false,
          signal: '',
          writer_may_be_active: false,
        }, '', finalGuard, record.isolation.isolationState);
      } else {
        const execution = gated.result;
        contamination = await confirmBackgroundOnlyContaminationQuiescence({
          before: gated.baseline.snapshot,
          captureSnapshot: probe,
          timeoutMs: options.contaminationQuiescenceTimeoutMs,
          intervalMs: options.contaminationQuiescenceIntervalMs,
          sleep: options.contaminationQuiescenceSleep,
          now: options.contaminationQuiescenceNow,
        });
        const guard = await captureFinalGuardAfterContamination(
          contamination,
          () => options.captureGuard({ file: record.path, digest: record.digest }),
        );
        finalGuard = guard;
        const attributed = execution.results.find((entry) => entry.file === record.path);
        if (!attributed) throw new Error('Focused serialized pg_prove result is not marker-bound to its exact file.');
        markerBound = attributed.worker?.markerObserved === true
          && !(attributed.facts.hardStopSignals || []).some((entry) => /marker|identity|attribution/iu.test(String(entry.failureClass || '')));
        facts = serializedChildFacts(
          execution.child,
          attributed.facts.output,
          guard || guardBefore,
          record.isolation.isolationState,
          attributed.facts,
        );
      }
    }
    state = focused.reduceFocusedParallelWaveState(state, {
      type: eventType,
      file: record.path,
      jobs: 1,
      guard: finalGuard,
      contamination,
      facts,
    }, { policy: options.admission.policy });
    if (contamination.stable !== true) persist(state);
    if (eventType === 'isolated_rerun_finished') {
      state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
        type: 'isolated_rerun_finished',
        file: record.path,
        jobs: 1,
        explicitCanonicalFile: record.path,
        markerBound,
        transactionIsolationVerified: record.isolation.isolationState === 'logical_transaction_isolation_verified',
        facts,
      }, { policy: options.admission.policy });
    } else if (eventType === 'repaired_failed_file_finished') {
      state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
        type: 'repaired_file_finished',
        file: record.path,
        jobs: 1,
        explicitCanonicalFile: record.path,
        markerBound,
        transactionIsolationVerified: record.isolation.isolationState === 'logical_transaction_isolation_verified',
        facts,
      }, { policy: options.admission.policy });
    } else if (eventType === 'serial_quarantine_finished') {
      const finalRecord = state.perFile.find((entry) => entry.path === record.path);
      state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
        type: 'serial_quarantine_finished',
        file: record.path,
        jobs: 1,
        result: finalRecord?.status === 'serial_passed' ? 'passed' : 'failed',
        contaminationStable: contamination?.stable === true,
        failureClass: finalRecord?.finalSerializedResult?.failureClass || 'serial_quarantine_failed',
        family: finalRecord?.finalSerializedResult?.family || 'unknown',
      }, { policy: options.admission.policy });
    }
    persist(state);
  }

  if (options.repairFocusedFailures === true) {
    const repairReady = new Set(state.scheduler.entries
      .filter((entry) => entry.state === 'repair_ready')
      .map((entry) => entry.path));
    if (state.repairSelection.some((file) => !repairReady.has(file))) {
      throw new Error('Focused repaired-failed execution requires exact scheduler repair_ready integration evidence.');
    }
    for (const file of [...state.repairSelection]) {
      if (state.status === 'hard_stopped') break;
      const record = state.perFile.find((entry) => entry.path === file);
      await runSerialized(record, 'repaired_failed_file_finished', 'serial_quarantine');
    }
  } else {
    while (state.scheduler.entries.some((entry) => new Set(['untested', 'repair_ready']).has(entry.state))) {
      if (state.status === 'hard_stopped' || state.scheduler.hardStop) break;
      const nextPredecessorWave = state.waves.find((entry) => entry.status === 'pending');
      if (!nextPredecessorWave) throw new Error('Focused scheduler has work but the execution queue has no pending wave.');
      const schedulerCandidates = nextPredecessorWave.files
        .map((file) => state.perFile.find((record) => record.path === file));
      const capacitySample = await recordCapacity(schedulerCandidates, 'parallel_wave', nextPredecessorWave.number);
      if (!capacitySample || state.status === 'hard_stopped') break;
      const schedulerWave = focused.buildFocusedSchedulerWave(state.scheduler, capacitySample.schedulerCapacity);
      if (!schedulerWave) break;
      const wave = state.waves.find((entry) => entry.status === 'pending');
      if (!wave || focused.canonicalJson(wave.files) !== focused.canonicalJson(schedulerWave.files)) {
        throw new Error('Focused scheduler wave diverged from the checkpointed execution queue.');
      }
      const records = wave.files.map((file) => state.perFile.find((entry) => entry.path === file));
      state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
        type: 'wave_started', files: wave.files, capacity: capacitySample.schedulerCapacity,
      }, { policy: options.admission.policy });
      const guardBefore = await options.captureGuard({ file: records[0].path, digest: records[0].digest });
      if (guardBefore.allGreen !== true) {
        const before = await probe();
        state = focused.reduceFocusedParallelWaveState(state, {
          type: 'wave_started',
          waveNumber: wave.number,
          guardBefore,
          contaminationBefore: compareContaminationSnapshots(before, before),
        }, { policy: options.admission.policy });
        state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
          type: 'hard_stop',
          family: state.hardStop?.family || 'lifecycle',
          failureClass: state.hardStop?.failureClass || 'focused_parallel_guard_failed_before_baseline',
          file: records[0].path,
        }, { policy: options.admission.policy });
        persist(state);
        break;
      }
      const gated = await executeAfterStableContaminationBaseline({
        captureSnapshot: probe,
        timeoutMs: options.contaminationQuiescenceTimeoutMs,
        intervalMs: options.contaminationQuiescenceIntervalMs,
        sleep: options.contaminationQuiescenceSleep,
        now: options.contaminationQuiescenceNow,
        beforeExecution: async (baseline) => {
          const refreshedGuard = await options.captureGuard({
            file: records[0].path,
            digest: records[0].digest,
          });
          state = focused.reduceFocusedParallelWaveState(state, {
            type: 'wave_started',
            waveNumber: wave.number,
            guardBefore: refreshedGuard,
            contaminationBefore: baseline.comparison,
          }, { policy: options.admission.policy });
          if (state.status === 'hard_stopped') {
            state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
              type: 'hard_stop',
              family: state.hardStop?.family || 'lifecycle',
              failureClass: state.hardStop?.failureClass || 'focused_parallel_guard_failed_after_baseline',
              file: records[0].path,
            }, { policy: options.admission.policy });
          }
          persist(state);
          return { accepted: state.status !== 'hard_stopped', guard: refreshedGuard };
        },
        execute: () => runPgProve(records, 'parallel_wave', capacitySample.adapted),
      });
      if (gated.baselineDeadline) {
        terminalizeBaselineDeadline(records, 'parallel_wave_contamination_baseline', gated.baselineDeadline);
        break;
      }
      if (gated.executed !== true) {
        if (gated.baseline.accepted !== true) {
          state = focused.reduceFocusedParallelWaveState(state, {
            type: 'wave_started',
            waveNumber: wave.number,
            guardBefore,
            contaminationBefore: gated.baseline.comparison,
          }, { policy: options.admission.policy });
          state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
            type: 'hard_stop',
            family: state.hardStop?.family || 'lifecycle',
            failureClass: state.hardStop?.failureClass || 'parallel_wave_contaminated_baseline',
            file: records[0].path,
          }, { policy: options.admission.policy });
        }
        persist(state);
        break;
      }
      const execution = gated.result;
      for (const result of execution.results) {
        if (state.status === 'hard_stopped' || state.scheduler.hardStop) break;
        state = focused.reduceFocusedParallelWaveState(state, {
          type: 'parallel_file_finished',
          file: result.file,
          worker: result.worker,
          elapsedMs: result.elapsedMs,
          facts: result.facts,
        }, { policy: options.admission.policy });
        const record = records.find((entry) => entry.path === result.file);
        const hardSignal = (result.facts.hardStopSignals || [])[0];
        state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
          type: 'wave_file_finished',
          file: result.file,
          markerBound: result.worker?.markerObserved === true,
          transactionIsolationVerified: record.isolation.isolationState === 'logical_transaction_isolation_verified',
          result: hardSignal ? 'hard_stop' : (result.facts.exit === 0 ? 'passed' : 'failed_unconfirmed'),
          failureClass: hardSignal?.failureClass,
          family: hardSignal?.family,
        }, { policy: options.admission.policy });
        persist(state);
      }
      if (state.status === 'hard_stopped' || state.scheduler.hardStop) break;
      const contaminationAfter = await confirmBackgroundOnlyContaminationQuiescence({
        before: gated.baseline.snapshot,
        captureSnapshot: probe,
        timeoutMs: options.contaminationQuiescenceTimeoutMs,
        intervalMs: options.contaminationQuiescenceIntervalMs,
        sleep: options.contaminationQuiescenceSleep,
        now: options.contaminationQuiescenceNow,
      });
      const guardAfter = await captureFinalGuardAfterContamination(contaminationAfter, async () => {
        const captured = [];
        for (const record of records) {
          captured.push({
            file: record.path,
            guard: await options.captureGuard({ file: record.path, digest: record.digest }),
          });
        }
        return captured;
      });
      state = focused.reduceFocusedParallelWaveState(state, {
        type: 'wave_finished',
        waveNumber: wave.number,
        guardAfter,
        contaminationAfter,
        pgProveState: pgProveStateEvidence(execution.invocation),
      }, { policy: options.admission.policy });
      if (contaminationAfter.stable !== true) persist(state);
      state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, { type: 'wave_finished' }, { policy: options.admission.policy });
      persist(state);
      const isolated = wave.files
        .map((file) => state.perFile.find((entry) => entry.path === file))
        .filter((entry) => entry.status === 'pending_isolated_rerun');
      for (const record of isolated) {
        if (state.status === 'hard_stopped' || state.scheduler.hardStop) break;
        await runSerialized(record, 'isolated_rerun_finished', 'isolated_rerun');
      }
    }
    for (const file of plan.serialQuarantine) {
      if (state.status === 'hard_stopped') break;
      const record = state.perFile.find((entry) => entry.path === file);
      await runSerialized(record, 'serial_quarantine_finished', 'serial_quarantine');
    }
  }

  if (state.status === 'focused_complete_final_serial_required' && state.queueScope === 'complete_focused_chain'
    && focused.deriveFocusedSchedulerArtifact(state.scheduler).finalGatesReachable !== true) {
    state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
      type: 'hard_stop', family: 'governance', failureClass: 'focused_scheduler_final_gate_queue_not_closed', file: '',
    }, { policy: options.admission.policy });
    state = focused.reduceFocusedParallelWaveState(state, {
      type: 'capacity_sample_failed', phase: 'scheduler_final_gate_admission', files: [],
      family: 'governance', failureClass: 'focused_scheduler_final_gate_queue_not_closed',
      reason: 'Canonical scheduler queue is not closed for final serialized gates.',
    }, { policy: options.admission.policy });
    persist(state);
  }

  if (state.status === 'focused_complete_final_serial_required' && state.queueScope !== 'complete_focused_chain') {
    state = focused.reduceFocusedParallelWaveState(state, { type: 'focused_subset_completed' }, { policy: options.admission.policy });
    persist(state);
  }

  if (state.status === 'focused_complete_final_serial_required') {
    const lastRecord = [...state.perFile].sort((a, b) => a.queueIndex - b.queueIndex).at(-1);
    const preGateGuard = await options.captureGuard({ file: lastRecord.path, digest: lastRecord.digest });
    state = focused.reduceFocusedParallelWaveState(state, {
      type: 'final_serialized_gates_guard_recorded',
      file: lastRecord.path,
      guard: preGateGuard,
    }, { policy: options.admission.policy });
    persist(state);
  }

  if (state.status === 'focused_complete_final_serial_required') {
    const commands = buildFinalSerializedCommands({ specIssue: options.specIssue, identity, policy: options.admission.policy });
    const aToZ = await options.runStep({ ...commands.aToZ, timeoutMs: options.finalGateTimeoutMs });
    const aToZOutput = String(aToZ.stdout || '') + '\n' + String(aToZ.stderr || '');
    const aToZArtifactSha256 = focused.sha256(aToZOutput);
    if (aToZ.exit !== 0) {
      state = focused.reduceFocusedParallelWaveState(state, {
        type: 'final_serialized_gates_failed',
        gate: 'a_to_z',
        serial: true,
        jobs: 1,
        runCount: 1,
        artifactSha256: aToZArtifactSha256,
      }, { policy: options.admission.policy });
      state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
        type: 'hard_stop', family: 'governance', failureClass: 'focused_final_a_to_z_failed', file: '',
      }, { policy: options.admission.policy });
      persist(state);
    } else {
      const localCandidate = await options.runStep({ ...commands.localCandidate, timeoutMs: options.finalGateTimeoutMs });
      const localOutput = String(localCandidate.stdout || '') + '\n' + String(localCandidate.stderr || '');
      const localArtifactSha256 = focused.sha256(localOutput);
      if (localCandidate.exit !== 0) {
        state = focused.reduceFocusedParallelWaveState(state, {
          type: 'final_serialized_gates_failed',
          gate: 'local_candidate',
          serial: true,
          jobs: 1,
          runCount: 1,
          artifactSha256: localArtifactSha256,
          aToZArtifactSha256,
        }, { policy: options.admission.policy });
        state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
          type: 'hard_stop', family: 'governance', failureClass: 'focused_final_local_candidate_failed', file: '',
        }, { policy: options.admission.policy });
      } else {
        state = focused.reduceFocusedParallelWaveState(state, {
          type: 'final_serialized_gates_recorded',
          aToZ: { state: 'passed', serial: true, jobs: 1, runCount: 1, artifactSha256: aToZArtifactSha256 },
          localCandidate: { state: 'passed', serial: true, jobs: 1, runCount: 1, artifactSha256: localArtifactSha256 },
        }, { policy: options.admission.policy });
        state.scheduler = focused.reduceFocusedRepairScheduler(state.scheduler, {
          type: 'final_serialized_gates_recorded',
          aToZSerial: true,
          aToZRunCount: 1,
          localCandidateSerial: true,
          localCandidateRunCount: 1,
        }, { policy: options.admission.policy });
      }
      persist(state);
    }
  }

  const artifact = focused.deriveFocusedParallelWaveArtifact(state);
  return {
    exitCode: new Set(['final_serial_passed', 'focused_subset_terminal_passed']).has(state.status) ? 0 : 1,
    state,
    artifact,
    schedulerArtifact: focused.deriveFocusedSchedulerArtifact(state.scheduler),
    checkpointPath,
    passedFiles: artifact.sets.orderedPassSet,
    failedFiles: artifact.sets.unresolvedFailureSet,
    connection: connection.public,
  };
}

module.exports = {
  buildFocusedPgProveStep,
  buildFinalSerializedCommands,
  buildFocusedNativeIdentity,
  buildFocusedNativePlan,
  captureFinalGuardAfterContamination,
  executeAfterStableContaminationBaseline,
  FOCUSED_BASELINE_DEADLINE_FAILURE_CLASS,
  terminalizeFocusedBaselineDeadlineState,
  captureFocusedDatabaseCapacityEvidence,
  childFacts,
  executeFocusedNativeSession,
  normalizeStructuredSerializationEvidence,
  parsePgProveWaveResults,
  resolveFocusedNativeAdmission,
  checkpointTransitionPath,
  resolveFocusedNativeCheckpointPredecessor,
  resolveFocusedNativeCapacityMode,
  resolveFocusedNativeQueue,
  resolveFocusedRepairCheckpointRemainder,
  resolvePgProveConnection,
  serializedChildFacts,
  writePgProveWrappers,
};
