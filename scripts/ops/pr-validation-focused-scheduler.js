#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const {
  COLLECTION_SCHEMA,
  canonicalJson,
  compareAscii,
  sha256,
} = require('./pr-validation-focused-common');
const {
  normalizeRequestedFocusedFile,
  resolveFocusedRequestedJobsPromotion,
} = require('./pr-validation-focused-policy');
const { classifyFocusedFileDisposition } = require('./pr-validation-focused-state');

const SCHEDULER_SCHEMA = 'pr-validation-session.focused-repair-scheduler.v1';
const REPAIR_PATCH_SCHEMA = 'pr-validation-session.focused-repair-patch.v1';
const REPAIR_OWNER_EVIDENCE_SCHEMA = 'pr-validation-session.focused-repair-owner-terminal.v1';
const REPAIR_CHECKOUT_DIFF_SCHEMA = 'pr-validation-session.focused-repair-checkout-diff.v1';
const CHECKOUT_SNAPSHOT_SCHEMA = 'pr-validation-session.focused-checkout-status-snapshot.v1';
const MEASURED_CHECKOUT_DELTA_SCHEMA = 'pr-validation-session.focused-checkout-measured-delta.v1';
const QUEUE_STATES = Object.freeze([
  'untested', 'in_wave', 'failed_unconfirmed', 'confirmed_fixture_only',
  'repair_in_progress', 'repair_ready', 'passed', 'serial_quarantine',
  'hard_stop', 'skipped',
]);
const SHA256 = /^[a-f0-9]{64}$/u;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactSha(value, label) {
  const out = String(value || '');
  if (!SHA256.test(out)) throw new Error(label + ' must be a sha256 digest.');
  return out;
}

function exactTimestamp(value, label) {
  const out = String(value || '');
  const parsed = new Date(out);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== out) throw new Error(label + ' must be canonical ISO UTC.');
  return out;
}

function nowIso(options = {}) {
  return exactTimestamp(typeof options.now === 'function' ? options.now() : new Date().toISOString(), 'Focused scheduler timestamp');
}

function canonicalId(value, label, pattern = /^[A-Za-z0-9._:/-]{1,240}$/u) {
  const out = String(value || '');
  if (!pattern.test(out)) throw new Error('Focused scheduler ' + label + ' is invalid.');
  return out;
}

function canonicalWorktreePath(value, label) {
  const out = path.resolve(String(value || ''));
  if (!path.isAbsolute(String(value || '')) || out !== String(value || '')) {
    throw new Error('Focused scheduler ' + label + ' must be an absolute canonical path.');
  }
  return out;
}

function schedulerPayload(state) {
  const copy = clone(state);
  delete copy.contentSha256;
  return copy;
}

function seal(state) {
  state.contentSha256 = sha256(canonicalJson(schedulerPayload(state)));
  return state;
}

function buildFocusedSchedulerCheckpointBinding(options = {}) {
  const identity = options.identity || {};
  const manifest = options.plan?.focusedManifest || options.focusedManifest || {};
  return {
    repoId: canonicalId(identity.repoId, 'checkpoint repository id'),
    repoPath: canonicalWorktreePath(identity.repoPath, 'checkpoint repository path'),
    targetKind: canonicalId(identity.targetKind, 'checkpoint target kind'),
    targetId: canonicalId(identity.targetId, 'checkpoint target id'),
    worktreeId: canonicalId(identity.worktreeId, 'checkpoint worktree id'),
    worktreePath: canonicalWorktreePath(identity.worktreePath, 'checkpoint worktree path'),
    branch: canonicalId(identity.branch, 'checkpoint branch'),
    headSha: canonicalId(identity.headSha, 'checkpoint head', /^[a-f0-9]{40}$/u),
    ownerThreadId: canonicalId(identity.ownerThreadId, 'checkpoint owner thread', /^[a-f0-9-]{36}$/u),
    validationResource: canonicalId(identity.validationResource, 'checkpoint validation resource'),
    validationOwner: canonicalId(identity.validationOwner, 'checkpoint validation owner'),
    leaseId: canonicalId(identity.leaseId, 'checkpoint lease'),
    projectId: canonicalId(identity.projectId, 'checkpoint project id'),
    ports: clone(identity.ports),
    canonicalManifestDigest: exactSha(manifest.contentSha256, 'Focused scheduler canonical manifest'),
    canonicalManifestQueueDigest: exactSha(manifest.queueDigest, 'Focused scheduler canonical manifest queue'),
    selectedQueueDigest: exactSha(options.plan?.queueDigest, 'Focused scheduler selected queue'),
    migrationFingerprintDigest: exactSha(identity.migrationFingerprint?.digest, 'Focused scheduler migration fingerprint'),
    policyFileFingerprint: exactSha(identity.policyFileFingerprint, 'Focused scheduler policy file fingerprint'),
    focusedPolicyFingerprint: exactSha(identity.focusedPolicyFingerprint, 'Focused scheduler focused policy fingerprint'),
    focusedPolicySafetyFingerprint: exactSha(identity.focusedPolicySafetyFingerprint, 'Focused scheduler policy version fingerprint'),
    identityBindingFingerprint: exactSha(identity.bindingFingerprint, 'Focused scheduler identity binding'),
  };
}

function validateCheckoutSnapshot(value, state, claimFiles = []) {
  const copy = clone(value || {});
  const contentSha256 = copy.contentSha256;
  delete copy.contentSha256;
  if (copy.schema !== CHECKOUT_SNAPSHOT_SCHEMA || sha256(canonicalJson(copy)) !== contentSha256
    || copy.repoPath !== state.validationOwner.worktreePath
    || copy.identityBindingFingerprint !== state.identityBindingFingerprint
    || copy.headSha !== state.immutableValidationSnapshot.headSha) {
    throw new Error('Focused repair checkout baseline is invalid or belongs to another live target.');
  }
  exactSha(copy.statusSha256, 'Focused repair checkout baseline status');
  if (!Array.isArray(copy.files)) throw new Error('Focused repair checkout baseline files are missing.');
  const paths = copy.files.map((entry) => {
    const relativePath = String(entry.path || '');
    if (!relativePath || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..')
      || /[\u0000-\u001f\u007f]/u.test(relativePath)) {
      throw new Error('Focused repair checkout baseline contains a non-canonical repository path.');
    }
    return relativePath;
  });
  if (canonicalJson(paths) !== canonicalJson([...paths].sort(compareAscii)) || new Set(paths).size !== paths.length) {
    throw new Error('Focused repair checkout baseline paths are not canonical and unique.');
  }
  for (const entry of copy.files) {
    if (!entry.fact || !new Set(['regular', 'missing', 'symlink_or_reparse', 'directory', 'other']).has(entry.fact.kind)) {
      throw new Error('Focused repair checkout baseline file fact is invalid.');
    }
    if (entry.fact.kind === 'regular') exactSha(entry.fact.sha256, 'Focused repair checkout baseline file');
  }
  for (const file of claimFiles) {
    const entry = copy.files.find((item) => item.path === file);
    if (!entry || entry.fact.kind !== 'regular') throw new Error('Focused repair checkout baseline must contain every claimed regular file.');
  }
  return value;
}

function validateMeasuredCheckoutDelta(value, claim) {
  const copy = clone(value || {});
  const contentSha256 = copy.contentSha256;
  delete copy.contentSha256;
  const changedPaths = [...(copy.changedPaths || [])].map(normalizeRequestedFocusedFile).sort(compareAscii);
  const fileHashes = [...(copy.fileHashes || [])].sort((left, right) => compareAscii(left.path, right.path));
  if (copy.schema !== MEASURED_CHECKOUT_DELTA_SCHEMA || sha256(canonicalJson(copy)) !== contentSha256
    || copy.baselineSnapshotSha256 !== claim.checkoutBaseline.contentSha256
    || canonicalJson(changedPaths) !== canonicalJson(claim.files)
    || canonicalJson(fileHashes) !== canonicalJson(claim.completion.fileHashes)) {
    throw new Error('Focused repair independently measured checkout delta is invalid.');
  }
  exactSha(copy.liveSnapshotSha256, 'Focused repair live checkout snapshot');
  exactSha(copy.statusBeforeSha256, 'Focused repair status before');
  exactSha(copy.statusAfterSha256, 'Focused repair status after');
  return value;
}

function validateFocusedRepairSchedulerState(value, expected = null) {
  if (value?.schema !== SCHEDULER_SCHEMA) throw new Error('Focused repair scheduler schema is invalid.');
  if (sha256(canonicalJson(schedulerPayload(value))) !== value.contentSha256) throw new Error('Focused repair scheduler content digest is invalid.');
  if (!new Set(['source_only_not_authorized', 'cos_authorized']).has(value.sourceState) || !Number.isInteger(value.requestedJobs)
    || value.requestedJobs < 1 || value.requestedJobs > 60 || value.hardJobs !== 60) {
    throw new Error('Focused repair scheduler activation or ceiling is invalid.');
  }
  if (!new Set(['pilot_subset', 'complete_focused_chain']).has(value.queueScope)) throw new Error('Focused repair scheduler queue scope is invalid.');
  if (!Array.isArray(value.entries) || !value.entries.length) throw new Error('Focused repair scheduler queue is empty.');
  const checkpointBinding = value.checkpointBinding;
  if (!checkpointBinding || !value.validationOwner
    || canonicalJson(checkpointBinding.ports) !== canonicalJson(value.validationOwner.ports)) {
    throw new Error('Focused repair scheduler checkpoint binding is missing or inconsistent.');
  }
  exactSha(checkpointBinding.canonicalManifestDigest, 'Focused scheduler checkpoint manifest');
  exactSha(checkpointBinding.canonicalManifestQueueDigest, 'Focused scheduler checkpoint manifest queue');
  exactSha(checkpointBinding.selectedQueueDigest, 'Focused scheduler checkpoint selected queue');
  exactSha(checkpointBinding.migrationFingerprintDigest, 'Focused scheduler checkpoint migration');
  exactSha(checkpointBinding.policyFileFingerprint, 'Focused scheduler checkpoint policy file');
  exactSha(checkpointBinding.focusedPolicyFingerprint, 'Focused scheduler checkpoint focused policy');
  exactSha(checkpointBinding.focusedPolicySafetyFingerprint, 'Focused scheduler checkpoint policy version');
  exactSha(checkpointBinding.identityBindingFingerprint, 'Focused scheduler checkpoint identity');
  if (checkpointBinding.identityBindingFingerprint !== value.identityBindingFingerprint
    || checkpointBinding.selectedQueueDigest !== value.immutableValidationSnapshot?.queueDigest
    || checkpointBinding.migrationFingerprintDigest !== value.immutableValidationSnapshot?.migrationFingerprintDigest
    || checkpointBinding.ownerThreadId !== value.validationOwner.ownerThreadId
    || checkpointBinding.worktreeId !== value.validationOwner.worktreeId
    || checkpointBinding.worktreePath !== value.validationOwner.worktreePath
    || checkpointBinding.leaseId !== value.validationOwner.leaseId
    || checkpointBinding.projectId !== value.validationOwner.projectId
    || checkpointBinding.validationResource !== value.validationOwner.validationResource
    || checkpointBinding.validationOwner !== value.validationOwner.validationOwner) {
    throw new Error('Focused repair scheduler checkpoint binding is internally inconsistent.');
  }
  if (expected) {
    const expectedBinding = buildFocusedSchedulerCheckpointBinding(expected);
    if (canonicalJson(checkpointBinding) !== canonicalJson(expectedBinding)) {
      throw new Error('Focused repair scheduler checkpoint is stale or belongs to another live target.');
    }
  }
  const paths = new Set();
  for (const entry of value.entries) {
    if (normalizeRequestedFocusedFile(entry.path) !== entry.path || paths.has(entry.path)) throw new Error('Focused repair scheduler paths are not canonical and disjoint.');
    paths.add(entry.path);
    exactSha(entry.digest, 'Focused scheduler file digest');
    if (!QUEUE_STATES.includes(entry.state)) throw new Error('Focused repair scheduler queue state is invalid.');
  }
  if (!Array.isArray(value.transitionHistory)) throw new Error('Focused repair scheduler transition history is missing.');
  const transitionIds = new Set();
  for (const transition of value.transitionHistory) {
    exactSha(transition.eventId, 'Focused scheduler transition event id');
    exactSha(transition.requestDigest, 'Focused scheduler transition request');
    exactSha(transition.evidenceDigest, 'Focused scheduler transition evidence');
    exactSha(transition.checkpointBefore, 'Focused scheduler transition checkpoint before');
    if (!new Set(['claim', 'complete', 'integrate']).has(transition.action) || transitionIds.has(transition.eventId)) {
      throw new Error('Focused repair scheduler transition history is invalid or replayed.');
    }
    transitionIds.add(transition.eventId);
    exactTimestamp(transition.recordedAt, 'Focused scheduler transition timestamp');
  }
  const claimed = new Set();
  const worktrees = new Set();
  for (const claim of value.repairClaims) {
    if (!Array.isArray(claim.files) || !claim.files.length) throw new Error('Focused repair claim has no files.');
    validateCheckoutSnapshot(claim.checkoutBaseline, value, claim.files);
    if (new Set(['in_progress', 'ready_for_integration']).has(claim.state)) {
      for (const file of claim.files) {
        if (claimed.has(file)) throw new Error('Focused active repair claims overlap.');
        claimed.add(file);
      }
    }
    if (worktrees.has(claim.worktreePath)) throw new Error('Focused repair claims reuse a repair worktree.');
    worktrees.add(claim.worktreePath);
  }
  if (!Array.isArray(value.integrationHistory)) throw new Error('Focused repair integration history is missing.');
  for (const integration of value.integrationHistory) {
    const claim = value.repairClaims.find((entry) => entry.claimId === integration.claimId);
    if (!claim?.completion || integration.checkoutDiffDigest !== integration.measuredCheckoutDelta?.contentSha256) {
      throw new Error('Focused repair integration history is not bound to measured checkout evidence.');
    }
    validateMeasuredCheckoutDelta(integration.measuredCheckoutDelta, claim);
  }
  const inWave = value.entries.filter((entry) => entry.state === 'in_wave').map((entry) => entry.path);
  if (!value.activeWave) {
    if (inWave.length) throw new Error('Focused repair scheduler has in-wave files without an active wave.');
  } else {
    const plannedFiles = [...(value.activeWave.files || [])];
    const canonicalFiles = plannedFiles.map(normalizeRequestedFocusedFile);
    if (!plannedFiles.length || new Set(plannedFiles).size !== plannedFiles.length
      || canonicalJson(plannedFiles) !== canonicalJson(canonicalFiles)) {
      throw new Error('Focused repair scheduler active wave membership is not canonical and unique.');
    }
    const expectedWaveDigest = sha256(canonicalJson({
      iteration: value.activeWave.iteration,
      sampledAt: value.activeWave.sampledAt,
      files: plannedFiles,
      effectiveJobs: value.activeWave.effectiveJobs,
    }));
    if (value.activeWave.waveDigest !== expectedWaveDigest) {
      throw new Error('Focused repair scheduler active wave identity changed after planning.');
    }
    const planned = new Set(plannedFiles);
    if (inWave.some((file) => !planned.has(file))) {
      throw new Error('Focused repair scheduler contains an extra in-wave file.');
    }
    const remaining = [];
    const completed = [];
    for (const file of plannedFiles) {
      const entry = value.entries.find((item) => item.path === file);
      if (!entry) throw new Error('Focused repair scheduler active wave file is missing from the canonical queue.');
      const iterationRecords = entry.iterationHistory.filter((record) => record.iteration === value.activeWave.iteration);
      const starts = iterationRecords.filter((record) => record.phase === 'wave_started');
      const finishes = iterationRecords.filter((record) => new Set(['wave_passed', 'wave_failed_unconfirmed']).has(record.phase));
      if (starts.length !== 1 || finishes.length > 1) {
        throw new Error('Focused repair scheduler active wave history cannot resume deterministically.');
      }
      if (entry.state === 'in_wave') {
        if (finishes.length) throw new Error('Focused repair scheduler remaining partition already has a terminal result.');
        remaining.push(file);
      } else if (new Set(['passed', 'failed_unconfirmed']).has(entry.state)) {
        if (finishes.length !== 1) throw new Error('Focused repair scheduler completed partition lacks one terminal result.');
        completed.push(file);
      } else {
        throw new Error('Focused repair scheduler active wave file has an invalid queue state.');
      }
    }
    if (remaining.length + completed.length !== plannedFiles.length) {
      throw new Error('Focused repair scheduler active wave partitions are incomplete.');
    }
  }
  return value;
}

function createFocusedRepairScheduler(options = {}) {
  const plan = options.plan;
  const identity = options.identity;
  const policy = options.policy?.repairScheduler;
  if (plan?.schema !== COLLECTION_SCHEMA || !identity?.bindingFingerprint
    || !new Set(['source_only_not_authorized', 'cos_authorized']).has(policy?.state)) {
    throw new Error('Focused repair scheduler requires the canonical plan, identity, and explicit scheduler policy state.');
  }
  if (policy.state === 'cos_authorized' && options.authorized !== true) {
    throw new Error('Focused repair scheduler authorization must be explicit at the session seam.');
  }
  if (!Number.isInteger(plan.mode?.requestedJobs) || plan.mode.requestedJobs < 1
    || plan.mode.requestedJobs > 60 || plan.mode?.hardJobs !== 60 || policy.max_requested_files !== 60) {
    throw new Error('Focused repair scheduler requested jobs must remain within the hard ceiling of 60.');
  }
  const state = {
    schema: SCHEDULER_SCHEMA,
    sourceState: policy.state,
    revision: 0,
    createdAt: nowIso(options),
    updatedAt: nowIso(options),
    requestedJobs: plan.mode.requestedJobs,
    hardJobs: 60,
    queueScope: plan.queueScope,
    identityBindingFingerprint: identity.bindingFingerprint,
    checkpointBinding: buildFocusedSchedulerCheckpointBinding({ plan, identity }),
    validationOwner: {
      ownerThreadId: identity.ownerThreadId,
      worktreeId: identity.worktreeId,
      worktreePath: identity.worktreePath,
      leaseId: identity.leaseId,
      projectId: identity.projectId,
      validationResource: identity.validationResource,
      validationOwner: identity.validationOwner,
      ports: clone(identity.ports),
      oneStack: true,
      oneWriter: true,
      parallelDbWritersOutsidePgProve: false,
    },
    immutableValidationSnapshot: {
      headSha: identity.headSha,
      queueDigest: plan.queueDigest,
      checkoutDiffDigest: plan.queueDigest,
      migrationFingerprintDigest: identity.migrationFingerprint.digest,
    },
    entries: plan.records.map((entry) => ({
      path: entry.path,
      digest: entry.digest,
      queueIndex: entry.queueIndex,
      state: entry.lane === 'parallel_wave' ? 'untested' : 'serial_quarantine',
      iterationHistory: [],
    })),
    activeWave: null,
    waveHistory: [],
    repairClaims: [],
    integrationOwnerThreadId: '',
    integrationHistory: [],
    promotionHistory: [],
    transitionHistory: [],
    hardStop: null,
    finalGates: { state: 'pending', aToZRunCount: 0, localCandidateRunCount: 0 },
  };
  seal(state);
  return validateFocusedRepairSchedulerState(state, { plan, identity });
}

function queueCandidates(state) {
  return state.entries
    .filter((entry) => entry.state === 'repair_ready' || entry.state === 'untested')
    .sort((left, right) => {
      const priority = (left.state === 'repair_ready' ? 0 : 1) - (right.state === 'repair_ready' ? 0 : 1);
      return priority || compareAscii(left.path, right.path);
    });
}

function buildFocusedSchedulerWave(stateValue, capacity = {}) {
  const state = validateFocusedRepairSchedulerState(stateValue);
  if (state.hardStop || state.activeWave) throw new Error('Focused repair scheduler cannot plan while stopped or a wave is active.');
  if (state.entries.some((entry) => entry.state === 'failed_unconfirmed')) {
    throw new Error('Focused repair scheduler must isolate every wave failure before planning another wave.');
  }
  const candidates = queueCandidates(state);
  if (!candidates.length) return null;
  const sampledAt = exactTimestamp(capacity.sampledAt, 'Focused scheduler capacity sample');
  const hostCap = Number(capacity.immediateHostConnectionCap);
  const databaseCap = Number(capacity.databaseConnectionCap);
  const serializationEvidence = capacity.serializationEvidence;
  const serializationPayload = serializationEvidence ? clone(serializationEvidence) : null;
  if (serializationPayload) delete serializationPayload.artifactSha256;
  const serializationEvidenceValid = serializationPayload
    && new Set(['pre_admission_no_pg_prove_started', 'structured_pg_prove_output']).has(serializationPayload.source)
    && Number.isInteger(serializationPayload.observedCount)
    && Array.isArray(serializationPayload.observations)
    && serializationPayload.observations.length === serializationPayload.observedCount
    && Array.isArray(serializationPayload.sampleDigests)
    && (serializationPayload.source !== 'structured_pg_prove_output' || serializationPayload.sampleDigests.length > 0)
    && serializationEvidence.artifactSha256 === sha256(canonicalJson(serializationPayload));
  if (serializationEvidenceValid !== true || serializationPayload.observedCount !== capacity.serializationFailureCount) {
    throw new Error('Focused repair scheduler serialization measurement is missing, unknown, or inconsistent.');
  }
  if (capacity.hostGreen !== true || capacity.hostPressure !== false || capacity.databaseCapacityKnown !== true
    || capacity.hostCpuGreen !== true || capacity.hostMemoryGreen !== true
    || capacity.activeRunnerPressureGreen !== true
    || capacity.lockWaitCount !== 0 || capacity.deadlockCount !== 0 || capacity.serializationFailureCount !== 0
    || !Number.isInteger(hostCap) || hostCap < 1 || hostCap > 60
    || !Number.isInteger(databaseCap) || databaseCap < 1 || databaseCap > 60) {
    throw new Error('Focused repair scheduler capacity evidence is contended, unknown, or above 60.');
  }
  const effectiveJobs = Math.min(state.requestedJobs, candidates.length, hostCap, databaseCap);
  const selected = candidates.slice(0, effectiveJobs);
  const files = selected.map((entry) => entry.path);
  return {
    iteration: state.waveHistory.length + 1,
    sampledAt,
    requestedJobs: state.requestedJobs,
    effectiveJobs,
    immediateHostConnectionCap: hostCap,
    databaseConnectionCap: databaseCap,
    files,
    repairReadyFiles: selected.filter((entry) => entry.state === 'repair_ready').map((entry) => entry.path),
    untestedFiles: selected.filter((entry) => entry.state === 'untested').map((entry) => entry.path),
    waveDigest: sha256(canonicalJson({ iteration: state.waveHistory.length + 1, sampledAt, files, effectiveJobs })),
  };
}

function hardStop(state, failureClass, family, file, timestamp) {
  state.hardStop = { failureClass, family, file: file || '', at: timestamp };
  for (const entry of state.entries) {
    if (entry.path === file) entry.state = 'hard_stop';
    else if (!new Set(['passed', 'hard_stop']).has(entry.state)) entry.state = 'skipped';
  }
  state.activeWave = null;
}

function entryFor(state, file) {
  const normalized = normalizeRequestedFocusedFile(file);
  const entry = state.entries.find((item) => item.path === normalized);
  if (!entry) throw new Error('Focused repair scheduler file is outside its canonical queue.');
  return entry;
}

function finish(state, timestamp) {
  state.revision += 1;
  state.updatedAt = timestamp;
  seal(state);
  return validateFocusedRepairSchedulerState(state);
}

function appendFocusedRepairTransitionHistory(stateValue, transition = {}, options = {}) {
  validateFocusedRepairSchedulerState(stateValue);
  const state = clone(stateValue);
  const eventId = exactSha(transition.eventId, 'Focused scheduler transition event id');
  if (state.transitionHistory.some((entry) => entry.eventId === eventId)) {
    throw new Error('Focused repair transition event replay is rejected.');
  }
  const action = String(transition.action || '');
  if (!new Set(['claim', 'complete', 'integrate']).has(action)) throw new Error('Focused repair transition action is invalid.');
  state.transitionHistory.push({
    eventId,
    action,
    requestDigest: exactSha(transition.requestDigest, 'Focused scheduler transition request'),
    evidenceDigest: exactSha(transition.evidenceDigest, 'Focused scheduler transition evidence'),
    checkpointBefore: exactSha(transition.checkpointBefore, 'Focused scheduler transition checkpoint before'),
    schedulerRevision: state.revision,
    recordedAt: nowIso(options),
  });
  seal(state);
  return validateFocusedRepairSchedulerState(state);
}

function reduceFocusedRepairScheduler(stateValue, event = {}, options = {}) {
  validateFocusedRepairSchedulerState(stateValue);
  const state = clone(stateValue);
  const timestamp = nowIso(options);
  const type = String(event.type || '');
  if (state.finalGates.state === 'passed') throw new Error('Focused repair scheduler is terminal.');

  if (type === 'wave_started') {
    const plan = buildFocusedSchedulerWave(stateValue, event.capacity);
    if (!plan || canonicalJson(event.files) !== canonicalJson(plan.files)) throw new Error('Focused scheduler wave does not match deterministic repair-ready plus untested fill.');
    for (const file of plan.files) {
      const entry = entryFor(state, file);
      entry.state = 'in_wave';
      entry.iterationHistory.push({ phase: 'wave_started', iteration: plan.iteration, at: timestamp, digest: entry.digest });
    }
    state.activeWave = plan;
  } else if (type === 'wave_file_finished') {
    const entry = entryFor(state, event.file);
    if (!state.activeWave?.files.includes(entry.path) || entry.state !== 'in_wave') throw new Error('Focused scheduler result is not bound to the active wave.');
    if (event.markerBound !== true || event.transactionIsolationVerified !== true) {
      hardStop(state, 'focused_wave_marker_or_transaction_isolation_missing', 'isolation', entry.path, timestamp);
    } else if (event.result === 'passed') {
      entry.state = 'passed';
      entry.iterationHistory.push({ phase: 'wave_passed', iteration: state.activeWave.iteration, at: timestamp, digest: entry.digest });
    } else if (event.result === 'failed_unconfirmed') {
      entry.state = 'failed_unconfirmed';
      entry.iterationHistory.push({ phase: 'wave_failed_unconfirmed', iteration: state.activeWave.iteration, at: timestamp, digest: entry.digest });
    } else {
      hardStop(state, String(event.failureClass || 'focused_wave_unknown_hard_stop'), String(event.family || 'unknown'), entry.path, timestamp);
    }
  } else if (type === 'wave_finished') {
    if (!state.activeWave || state.activeWave.files.some((file) => entryFor(state, file).state === 'in_wave')) {
      throw new Error('Focused scheduler wave cannot finish before every exact file reports.');
    }
    state.waveHistory.push({ ...state.activeWave, finishedAt: timestamp });
    state.activeWave = null;
  } else if (type === 'isolated_rerun_finished') {
    const entry = entryFor(state, event.file);
    if (state.activeWave || entry.state !== 'failed_unconfirmed' || event.jobs !== 1 || event.explicitCanonicalFile !== entry.path) {
      throw new Error('Focused scheduler isolated rerun must be one exact failed file at a wave boundary.');
    }
    const disposition = classifyFocusedFileDisposition(event.facts, options.policy);
    if (disposition.disposition === 'collected_failure' && disposition.collectible === true
      && disposition.family === 'fixture_test_only' && event.markerBound === true
      && event.transactionIsolationVerified === true) {
      entry.state = 'confirmed_fixture_only';
      entry.iterationHistory.push({
        phase: 'isolated_fixture_confirmed', at: timestamp, digest: entry.digest,
        failureClass: disposition.failureClass, outputDigest: disposition.outputDigest,
      });
    } else {
      hardStop(state, disposition.failureClass || 'isolated_failure_not_confirmed_fixture_only', disposition.family || 'unknown', entry.path, timestamp);
    }
  } else if (type === 'repaired_file_finished') {
    const entry = entryFor(state, event.file);
    if (state.activeWave || entry.state !== 'repair_ready' || event.jobs !== 1
      || event.explicitCanonicalFile !== entry.path) {
      throw new Error('Focused repaired-file result must be one exact scheduler-authorized repair-ready file.');
    }
    const disposition = classifyFocusedFileDisposition(event.facts, options.policy);
    if (event.markerBound !== true || event.transactionIsolationVerified !== true) {
      hardStop(state, 'focused_repaired_file_marker_or_transaction_isolation_missing', 'isolation', entry.path, timestamp);
    } else if (disposition.disposition === 'passed') {
      entry.state = 'passed';
      entry.iterationHistory.push({ phase: 'repaired_file_passed', at: timestamp, digest: entry.digest, outputDigest: disposition.outputDigest });
    } else if (disposition.disposition === 'collected_failure' && disposition.family === 'fixture_test_only') {
      entry.state = 'confirmed_fixture_only';
      entry.iterationHistory.push({
        phase: 'repaired_file_failed_isolated', at: timestamp, digest: entry.digest,
        failureClass: disposition.failureClass, outputDigest: disposition.outputDigest,
      });
    } else {
      hardStop(state, disposition.failureClass || 'repaired_file_failed_unknown', disposition.family || 'unknown', entry.path, timestamp);
    }
  } else if (type === 'repair_claimed') {
    if (state.activeWave) throw new Error('Focused repairs may be claimed only from a completed wave boundary.');
    const files = [...(event.files || [])].map(normalizeRequestedFocusedFile).sort(compareAscii);
    if (!files.length || new Set(files).size !== files.length) throw new Error('Focused repair claim must contain a unique nonempty file set.');
    if (event.ownsRuntime !== false || event.runsValidation !== false || event.mutatesValidationCheckout !== false) {
      throw new Error('Focused repair owner cannot own runtime, run validation, or mutate the validation checkout.');
    }
    const ownerThreadId = canonicalId(event.ownerThreadId, 'repair owner thread', /^[a-f0-9-]{36}$/u);
    if (ownerThreadId === state.validationOwner.ownerThreadId) {
      throw new Error('Focused repair owner cannot be the validation/runtime owner.');
    }
    const worktreeId = canonicalId(event.worktreeId, 'repair worktree id');
    const worktreePath = canonicalWorktreePath(event.worktreePath, 'repair worktree path');
    if (worktreePath.toLowerCase() === state.validationOwner.worktreePath.toLowerCase()) throw new Error('Focused repair worktree must be separate from the validation checkout.');
    if (state.repairClaims.some((claim) => claim.worktreePath.toLowerCase() === worktreePath.toLowerCase())) throw new Error('Focused repair worktree is already claimed.');
    const checkoutBaseline = validateCheckoutSnapshot(event.checkoutBaseline, state, files);
    for (const file of files) {
      const entry = entryFor(state, file);
      if (entry.state !== 'confirmed_fixture_only' || state.repairClaims.some((claim) => (
        new Set(['in_progress', 'ready_for_integration']).has(claim.state) && claim.files.includes(file)
      ))) {
        throw new Error('Focused repair claims must be disjoint confirmed fixture-only files.');
      }
      entry.state = 'repair_in_progress';
      entry.iterationHistory.push({
        phase: 'repair_claimed', at: timestamp, ownerThreadId, worktreeId,
        checkoutBaselineSha256: checkoutBaseline.contentSha256,
      });
    }
    state.repairClaims.push({
      claimId: sha256(canonicalJson({
        ownerThreadId, worktreeId, worktreePath, files,
        checkoutBaselineSha256: checkoutBaseline.contentSha256, at: timestamp,
      })),
      ownerThreadId, worktreeId, worktreePath, files, state: 'in_progress', claimedAt: timestamp, completion: null,
      baseValidationSnapshot: clone(state.immutableValidationSnapshot),
      checkoutBaseline: clone(checkoutBaseline),
    });
  } else if (type === 'repair_completed') {
    const claim = state.repairClaims.find((item) => item.claimId === event.claimId);
    if (!claim || claim.state !== 'in_progress' || claim.ownerThreadId !== event.ownerThreadId || claim.worktreeId !== event.worktreeId) {
      throw new Error('Focused repair completion is not bound to its exact owner/worktree claim.');
    }
    const hashes = [...(event.fileHashes || [])].sort((left, right) => compareAscii(left.path, right.path));
    if (canonicalJson(hashes.map((entry) => entry.path)) !== canonicalJson(claim.files)) throw new Error('Focused repair completion file hashes do not match its disjoint claim.');
    for (const hash of hashes) exactSha(hash.sha256, 'Focused repaired file hash');
    const patchManifest = clone(event.patchManifest || {});
    const patchManifestDigest = patchManifest.contentSha256;
    delete patchManifest.contentSha256;
    const terminalOwnerEvidence = clone(patchManifest.terminalOwnerEvidence || {});
    const ownerEvidenceDigest = terminalOwnerEvidence.contentSha256;
    delete terminalOwnerEvidence.contentSha256;
    const changedPaths = [...(patchManifest.changedPaths || [])].map(normalizeRequestedFocusedFile).sort(compareAscii);
    if (patchManifest.schema !== REPAIR_PATCH_SCHEMA
      || sha256(canonicalJson(patchManifest)) !== patchManifestDigest
      || terminalOwnerEvidence.schema !== REPAIR_OWNER_EVIDENCE_SCHEMA
      || sha256(canonicalJson(terminalOwnerEvidence)) !== ownerEvidenceDigest
      || terminalOwnerEvidence.ownerThreadId !== claim.ownerThreadId
      || terminalOwnerEvidence.worktreeId !== claim.worktreeId
      || terminalOwnerEvidence.worktreePath !== claim.worktreePath
      || terminalOwnerEvidence.status !== 'terminal'
      || terminalOwnerEvidence.ownsRuntime !== false
      || terminalOwnerEvidence.runsValidation !== false
      || terminalOwnerEvidence.mutatesValidationCheckout !== false
      || canonicalJson(changedPaths) !== canonicalJson(claim.files)
      || canonicalJson(patchManifest.fileHashes) !== canonicalJson(hashes)
      || patchManifest.claimId !== claim.claimId
      || patchManifest.baseCheckoutDiffDigest !== claim.checkoutBaseline.contentSha256
      || !Array.isArray(patchManifest.domainChangeClasses)
      || patchManifest.domainChangeClasses.length !== 0) {
      throw new Error('Focused repair completion patch manifest or terminal owner evidence is invalid.');
    }
    const patchSha256 = exactSha(patchManifest.patchSha256, 'Focused repair patch');
    const worktreeDiffDigest = exactSha(patchManifest.worktreeDiffDigest, 'Focused repair worktree diff');
    const completionMigrationFingerprint = exactSha(patchManifest.migrationFingerprintDigest, 'Focused repair migration fingerprint');
    if (completionMigrationFingerprint !== state.immutableValidationSnapshot.migrationFingerprintDigest) {
      hardStop(state, 'repair_worktree_migration_fingerprint_changed', 'migration', claim.files[0], timestamp);
      claim.state = 'hard_stopped';
      return finish(state, timestamp);
    }
    claim.state = 'ready_for_integration';
    claim.completion = {
      patchManifest: { ...patchManifest, terminalOwnerEvidence: { ...terminalOwnerEvidence, contentSha256: ownerEvidenceDigest }, contentSha256: patchManifestDigest },
      patchManifestDigest,
      patchSha256,
      worktreeDiffDigest,
      baseCheckoutDiffDigest: patchManifest.baseCheckoutDiffDigest,
      changedPaths,
      fileHashes: hashes,
      migrationFingerprintDigest: completionMigrationFingerprint,
      completedAt: timestamp,
    };
    for (const file of claim.files) {
      entryFor(state, file).iterationHistory.push({
        phase: 'repair_completed_terminal', at: timestamp, ownerThreadId: claim.ownerThreadId,
        patchManifestDigest, patchSha256, digest: hashes.find((entry) => entry.path === file).sha256,
      });
    }
  } else if (type === 'repair_integrated') {
    if (state.activeWave) throw new Error('Focused repair integration is serialized at a wave boundary.');
    const claim = state.repairClaims.find((item) => item.claimId === event.claimId);
    if (!claim || claim.state !== 'ready_for_integration') throw new Error('Focused repair integration requires one terminal repair claim.');
    const integrationOwner = canonicalId(event.integrationOwnerThreadId, 'integration owner thread', /^[a-f0-9-]{36}$/u);
    if (integrationOwner !== state.validationOwner.ownerThreadId) throw new Error('Focused repair integration requires the sole validation/PR Chief owner.');
    if (state.integrationOwnerThreadId && state.integrationOwnerThreadId !== integrationOwner) throw new Error('Focused repair integration owner changed mid-checkpoint.');
    if (canonicalWorktreePath(event.validationWorktreePath, 'validation worktree path').toLowerCase() !== state.validationOwner.worktreePath.toLowerCase()) {
      throw new Error('Focused repair integration must bind the sole validation checkout.');
    }
    const migrationBefore = exactSha(event.migrationFingerprintBefore, 'Focused integration migration fingerprint before');
    const migrationAfter = exactSha(event.migrationFingerprintAfter, 'Focused integration migration fingerprint after');
    if (migrationBefore !== state.immutableValidationSnapshot.migrationFingerprintDigest || migrationAfter !== migrationBefore) {
      hardStop(state, 'migration_fingerprint_change_requires_controlled_rebuild', 'migration', claim.files[0], timestamp);
      claim.state = 'hard_stopped';
      return finish(state, timestamp);
    }
    const newHashes = [...(event.fileHashes || [])].sort((left, right) => compareAscii(left.path, right.path));
    if (canonicalJson(newHashes) !== canonicalJson(claim.completion.fileHashes)) throw new Error('Focused integrated file hashes differ from the terminal repair handoff.');
    const allowedPaths = [...(event.allowedPaths || [])].map(normalizeRequestedFocusedFile).sort(compareAscii);
    const changedPaths = [...(event.changedPaths || [])].map(normalizeRequestedFocusedFile).sort(compareAscii);
    const patchSha256 = exactSha(event.patchSha256, 'Focused integrated repair patch');
    if (canonicalJson(allowedPaths) !== canonicalJson(claim.files)
      || canonicalJson(changedPaths) !== canonicalJson(claim.completion.changedPaths)
      || patchSha256 !== claim.completion.patchSha256) {
      throw new Error('Focused integrated paths or patch digest differ from the terminal repair handoff.');
    }
    const measuredCheckoutDelta = validateMeasuredCheckoutDelta(event.measuredCheckoutDelta, claim);
    const checkoutDiffManifest = clone(event.checkoutDiffManifest || {});
    const callerCheckoutDiffDigest = checkoutDiffManifest.contentSha256;
    const checkoutDiffDigest = measuredCheckoutDelta.contentSha256;
    delete checkoutDiffManifest.contentSha256;
    if (checkoutDiffManifest.schema !== REPAIR_CHECKOUT_DIFF_SCHEMA
      || sha256(canonicalJson(checkoutDiffManifest)) !== callerCheckoutDiffDigest
      || checkoutDiffManifest.baseCheckoutDiffDigest !== claim.checkoutBaseline.contentSha256
      || canonicalJson(checkoutDiffManifest.changedPaths) !== canonicalJson(changedPaths)
      || canonicalJson(checkoutDiffManifest.fileHashes) !== canonicalJson(newHashes)) {
      throw new Error('Focused integration refreshed checkout diff manifest is invalid.');
    }
    const reboundManifestDigest = exactSha(event.canonicalManifestDigest, 'Focused integrated canonical manifest');
    const reboundManifestQueueDigest = exactSha(event.canonicalManifestQueueDigest, 'Focused integrated canonical manifest queue');
    const reboundEntries = state.entries.map((entry) => {
      const replacement = newHashes.find((hash) => hash.path === entry.path);
      return { path: entry.path, digest: replacement ? replacement.sha256 : entry.digest };
    });
    const queueDigest = sha256(canonicalJson(reboundEntries));
    const expectedLiveBinding = {
      ...state.checkpointBinding,
      canonicalManifestDigest: reboundManifestDigest,
      canonicalManifestQueueDigest: reboundManifestQueueDigest,
      selectedQueueDigest: queueDigest,
    };
    if (canonicalJson(event.liveCheckpointBinding) !== canonicalJson(expectedLiveBinding)) {
      throw new Error('Focused integration live target, lease, manifest, migration, or policy binding is stale.');
    }
    state.integrationOwnerThreadId = integrationOwner;
    for (const hash of newHashes) {
      const entry = entryFor(state, hash.path);
      entry.digest = exactSha(hash.sha256, 'Focused integrated file hash');
      entry.state = 'repair_ready';
      entry.iterationHistory.push({ phase: 'repair_integrated_rebound', at: timestamp, patchSha256, digest: entry.digest, checkoutDiffDigest });
    }
    claim.state = 'integrated';
    state.immutableValidationSnapshot.queueDigest = queueDigest;
    state.checkpointBinding.selectedQueueDigest = queueDigest;
    state.checkpointBinding.canonicalManifestDigest = reboundManifestDigest;
    state.checkpointBinding.canonicalManifestQueueDigest = reboundManifestQueueDigest;
    state.immutableValidationSnapshot.checkoutDiffDigest = checkoutDiffDigest;
    state.integrationHistory.push({
      claimId: claim.claimId, integrationOwnerThreadId: integrationOwner, files: claim.files,
      patchSha256, patchManifestDigest: claim.completion.patchManifestDigest,
      fileHashes: newHashes, changedPaths, allowedPaths, checkoutDiffDigest,
      measuredCheckoutDelta: clone(measuredCheckoutDelta), callerCheckoutDiffDigest,
      queueDigest, canonicalManifestDigest: reboundManifestDigest,
      canonicalManifestQueueDigest: reboundManifestQueueDigest,
      migrationFingerprintDigest: migrationAfter, migrationsReplayed: false, integratedAt: timestamp,
    });
  } else if (type === 'serial_quarantine_finished') {
    const entry = entryFor(state, event.file);
    if (state.activeWave || entry.state !== 'serial_quarantine' || event.jobs !== 1) throw new Error('Focused serial quarantine result is not exact or wave-boundary serialized.');
    if (event.result === 'passed' && event.contaminationStable === true) entry.state = 'passed';
    else hardStop(state, String(event.failureClass || 'serial_quarantine_failed'), String(event.family || 'unknown'), entry.path, timestamp);
  } else if (type === 'promotion_recorded') {
    if (state.activeWave || state.entries.some((entry) => entry.state === 'failed_unconfirmed')) {
      throw new Error('Focused requested-job promotion requires a clean wave boundary.');
    }
    const promotion = resolveFocusedRequestedJobsPromotion({
      policy: options.policy,
      currentRequestedJobs: state.requestedJobs,
      requestedJobs: event.requestedJobs,
      evidence: event.evidence,
      futureStablePr: event.futureStablePr === true,
    });
    state.requestedJobs = promotion.requestedJobs;
    state.promotionHistory.push({ ...promotion, recordedAt: timestamp });
  } else if (type === 'hard_stop') {
    hardStop(state, String(event.failureClass || 'focused_scheduler_hard_stop'), String(event.family || 'unknown'), String(event.file || ''), timestamp);
  } else if (type === 'final_serialized_gates_recorded') {
    const artifact = deriveFocusedSchedulerArtifact(state);
    if (artifact.finalGatesReachable !== true || event.aToZSerial !== true || event.aToZRunCount !== 1
      || event.localCandidateSerial !== true || event.localCandidateRunCount !== 1) {
      throw new Error('Focused scheduler final gates require empty canonical queues and exactly one serialized run each.');
    }
    state.finalGates = { state: 'passed', aToZRunCount: 1, localCandidateRunCount: 1, recordedAt: timestamp };
  } else {
    throw new Error('Unknown focused repair scheduler event: ' + type);
  }
  return finish(state, timestamp);
}

function deriveFocusedSchedulerArtifact(stateValue) {
  const state = validateFocusedRepairSchedulerState(stateValue);
  const queue = {};
  for (const queueState of QUEUE_STATES) queue[queueState] = [];
  for (const entry of state.entries) queue[entry.state].push(entry.path);
  for (const values of Object.values(queue)) values.sort(compareAscii);
  const unresolvedStates = [
    'untested', 'in_wave', 'failed_unconfirmed', 'confirmed_fixture_only',
    'repair_in_progress', 'repair_ready', 'serial_quarantine',
  ];
  const finalGatesReachable = state.queueScope === 'complete_focused_chain' && !state.hardStop
    && !state.activeWave
    && unresolvedStates.every((queueState) => queue[queueState].length === 0)
    && queue.hard_stop.length === 0
    && queue.skipped.length === 0
    && queue.passed.length === state.entries.length;
  return {
    schema: SCHEDULER_SCHEMA,
    sourceState: state.sourceState,
    revision: state.revision,
    requestedJobs: state.requestedJobs,
    hardJobs: state.hardJobs,
    queueScope: state.queueScope,
    effectiveJobsExpression: 'min(requested_jobs_lte_60,eligible_transactionally_isolated_files,fresh_host_cap,fresh_db_cap)',
    identityBindingFingerprint: state.identityBindingFingerprint,
    checkpointBinding: state.checkpointBinding,
    validationOwner: state.validationOwner,
    immutableValidationSnapshot: state.immutableValidationSnapshot,
    queue,
    entries: state.entries,
    activeWave: state.activeWave,
    waveHistory: state.waveHistory,
    repairClaims: state.repairClaims,
    integrationHistory: state.integrationHistory,
    promotionHistory: state.promotionHistory,
    transitionHistory: state.transitionHistory,
    hardStop: state.hardStop,
    finalGates: state.finalGates,
    finalGatesReachable,
    contentSha256: state.contentSha256,
  };
}

module.exports = {
  CHECKOUT_SNAPSHOT_SCHEMA,
  MEASURED_CHECKOUT_DELTA_SCHEMA,
  QUEUE_STATES,
  REPAIR_CHECKOUT_DIFF_SCHEMA,
  REPAIR_OWNER_EVIDENCE_SCHEMA,
  REPAIR_PATCH_SCHEMA,
  SCHEDULER_SCHEMA,
  appendFocusedRepairTransitionHistory,
  buildFocusedSchedulerCheckpointBinding,
  buildFocusedSchedulerWave,
  createFocusedRepairScheduler,
  deriveFocusedSchedulerArtifact,
  reduceFocusedRepairScheduler,
  validateFocusedRepairSchedulerState,
};
