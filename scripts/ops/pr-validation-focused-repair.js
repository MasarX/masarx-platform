#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const focused = require('./pr-validation-focused-collection');

const REPAIR_TRANSITION_REQUEST_SCHEMA = 'pr-validation-session.focused-repair-transition-request.v1';
const CHECKOUT_SNAPSHOT_SCHEMA = 'pr-validation-session.focused-checkout-status-snapshot.v1';
const MEASURED_CHECKOUT_DELTA_SCHEMA = 'pr-validation-session.focused-checkout-measured-delta.v1';
const ACTION_EVENT = Object.freeze({
  claim: 'repair_claimed',
  complete: 'repair_completed',
  integrate: 'repair_integrated',
});
const SHA256 = /^[a-f0-9]{64}$/u;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactSha(value, label) {
  const out = String(value || '');
  if (!SHA256.test(out)) throw new Error(label + ' must be a sha256 digest.');
  return out;
}

function canonicalAbsolute(value, label) {
  const raw = String(value || '');
  const resolved = path.resolve(raw);
  if (!path.isAbsolute(raw) || resolved !== raw) throw new Error(label + ' must be an absolute canonical path.');
  return resolved;
}

function readCanonicalJsonFile(filePathValue, rootValue, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = fsImpl.realpathSync(canonicalAbsolute(rootValue, 'Focused repair repository'));
  const filePath = canonicalAbsolute(filePathValue, 'Focused repair request file');
  const stat = fsImpl.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
    throw new Error('Focused repair request must be a regular non-symlink JSON file below 2 MiB.');
  }
  const realPath = fsImpl.realpathSync(filePath);
  if (!focused.isPathWithin(root, realPath)) throw new Error('Focused repair request resolves outside the explicit repository.');
  let value;
  try {
    const raw = fsImpl.readFileSync(realPath, 'utf8');
    focused.assertNoDuplicateJsonKeys(raw);
    value = JSON.parse(raw);
  } catch (_) { throw new Error('Focused repair request JSON is malformed or has duplicate keys.'); }
  return value;
}

function parseFocusedRepairTransitionArgs(argv = []) {
  if (argv[0] !== 'transition') throw new Error('Focused repair CLI requires the explicit transition subcommand.');
  const out = { requestPath: '', repoPath: '' };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length || !String(argv[index] || '').trim()) throw new Error(token + ' requires an explicit value.');
      return String(argv[index]);
    };
    if (token === '--request') out.requestPath = readValue();
    else if (token.startsWith('--request=')) out.requestPath = token.slice('--request='.length);
    else if (token === '--repo') out.repoPath = readValue();
    else if (token.startsWith('--repo=')) out.repoPath = token.slice('--repo='.length);
    else throw new Error('Unknown focused repair transition argument: ' + token);
  }
  if (!out.requestPath || !out.repoPath) throw new Error('Focused repair transition requires explicit --request and --repo values.');
  out.requestPath = canonicalAbsolute(out.requestPath, 'Focused repair request');
  out.repoPath = canonicalAbsolute(out.repoPath, 'Focused repair repository');
  return out;
}

function validateContentDigest(value, label) {
  const copy = clone(value || {});
  const digest = exactSha(copy.contentSha256, label);
  delete copy.contentSha256;
  if (focused.sha256(focused.canonicalJson(copy)) !== digest) throw new Error(label + ' content digest is invalid.');
  return value;
}

function runGit(repoPath, args, options = {}) {
  const runner = options.gitRunner || ((input) => spawnSync('git', input.args, {
    cwd: input.cwd,
    encoding: null,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }));
  const result = runner({ cwd: repoPath, args: [...args] }) || {};
  if (result.error || result.status !== 0) {
    throw new Error('Focused repair could not independently measure the validation checkout with Git.');
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout || ''), 'utf8');
}

function canonicalGitPath(value) {
  const raw = String(value || '');
  if (!raw || raw.includes('\\') || raw.includes('\0') || /[\u0000-\u001f\u007f]/u.test(raw)
    || path.posix.isAbsolute(raw) || raw.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Focused repair Git status contains a non-canonical repository path.');
  }
  return raw;
}

function parseGitPorcelainV2Z(output) {
  const records = Buffer.isBuffer(output) ? output.toString('utf8').split('\0') : String(output || '').split('\0');
  const entries = [];
  const seen = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.startsWith('# ')) continue;
    let entry;
    if (record.startsWith('? ')) {
      entry = { path: canonicalGitPath(record.slice(2)), recordType: '?', xy: '??', submodule: 'N...' };
    } else if (record.startsWith('! ')) {
      continue;
    } else if (record.startsWith('1 ')) {
      const match = /^1 ([^ ]{2}) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.+)$/u.exec(record);
      if (!match) throw new Error('Focused repair Git ordinary status record is malformed.');
      entry = {
        path: canonicalGitPath(match[8]), recordType: '1', xy: match[1], submodule: match[2],
        headMode: match[3], indexMode: match[4], worktreeMode: match[5], headObject: match[6], indexObject: match[7],
      };
    } else if (record.startsWith('2 ')) {
      const match = /^2 ([^ ]{2}) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.+)$/u.exec(record);
      const originalPath = records[index + 1];
      if (!match || !originalPath) throw new Error('Focused repair Git rename/copy status record is malformed.');
      index += 1;
      entry = {
        path: canonicalGitPath(match[9]), originalPath: canonicalGitPath(originalPath), recordType: '2',
        xy: match[1], submodule: match[2], headMode: match[3], indexMode: match[4], worktreeMode: match[5],
        headObject: match[6], indexObject: match[7], score: match[8],
      };
    } else if (record.startsWith('u ')) {
      const match = /^u ([^ ]{2}) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.+)$/u.exec(record);
      if (!match) throw new Error('Focused repair Git unmerged status record is malformed.');
      entry = { path: canonicalGitPath(match[10]), recordType: 'u', xy: match[1], submodule: match[2] };
    } else {
      throw new Error('Focused repair Git status record type is unsupported.');
    }
    if (seen.has(entry.path)) throw new Error('Focused repair Git status contains duplicate paths.');
    seen.add(entry.path);
    entries.push(entry);
  }
  return entries.sort((left, right) => focused.compareAscii(left.path, right.path));
}

function readCheckoutFileFact(repoPath, relativePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const candidate = path.resolve(repoPath, relativePath.replace(/\//gu, path.sep));
  if (!focused.isPathWithin(repoPath, candidate)) throw new Error('Focused repair checkout path escapes its repository.');
  let stat;
  try { stat = fsImpl.lstatSync(candidate); } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', mode: 0, size: 0, sha256: '' };
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink_or_reparse', mode: Number(stat.mode || 0), size: Number(stat.size || 0), sha256: '' };
  if (stat.isDirectory()) return { kind: 'directory', mode: Number(stat.mode || 0), size: Number(stat.size || 0), sha256: '' };
  if (!stat.isFile()) return { kind: 'other', mode: Number(stat.mode || 0), size: Number(stat.size || 0), sha256: '' };
  const realPath = fsImpl.realpathSync(candidate);
  if (!focused.isPathWithin(repoPath, realPath)) return { kind: 'symlink_or_reparse', mode: Number(stat.mode || 0), size: Number(stat.size || 0), sha256: '' };
  const bytes = fsImpl.readFileSync(candidate);
  return { kind: 'regular', mode: Number(stat.mode || 0), size: bytes.length, sha256: focused.sha256(bytes) };
}

function captureValidationCheckoutSnapshot(repoPathValue, identity, claimFiles = [], options = {}) {
  const fsImpl = options.fsImpl || fs;
  const repoPath = fsImpl.realpathSync(canonicalAbsolute(repoPathValue, 'Focused repair repository'));
  const head = runGit(repoPath, ['rev-parse', '--verify', 'HEAD'], options).toString('utf8').trim();
  if (head !== identity.headSha) throw new Error('Focused repair Git checkout head does not match the bound live target.');
  const statusBytes = runGit(repoPath, [
    '-c', 'core.quotepath=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all',
  ], options);
  const statusEntries = parseGitPorcelainV2Z(statusBytes);
  const paths = new Set(statusEntries.map((entry) => entry.path));
  for (const file of claimFiles) paths.add(focused.normalizeRequestedFocusedFile(file));
  const files = [...paths].sort(focused.compareAscii).map((relativePath) => ({
    path: relativePath,
    status: statusEntries.find((entry) => entry.path === relativePath) || null,
    fact: readCheckoutFileFact(repoPath, relativePath, { fsImpl }),
  }));
  const payload = {
    schema: CHECKOUT_SNAPSHOT_SCHEMA,
    repoPath,
    identityBindingFingerprint: identity.bindingFingerprint,
    headSha: identity.headSha,
    statusSha256: focused.sha256(statusBytes),
    files,
  };
  return { ...payload, contentSha256: focused.sha256(focused.canonicalJson(payload)) };
}

function validateCheckoutSnapshot(snapshot, identity, label) {
  validateContentDigest(snapshot, label);
  if (snapshot.schema !== CHECKOUT_SNAPSHOT_SCHEMA || snapshot.repoPath !== identity.worktreePath
    || snapshot.identityBindingFingerprint !== identity.bindingFingerprint || snapshot.headSha !== identity.headSha
    || !Array.isArray(snapshot.files)) throw new Error(label + ' is not bound to the live validation target.');
  exactSha(snapshot.statusSha256, label + ' status');
  const paths = snapshot.files.map((entry) => canonicalGitPath(entry.path));
  if (focused.canonicalJson(paths) !== focused.canonicalJson([...paths].sort(focused.compareAscii))
    || new Set(paths).size !== paths.length) throw new Error(label + ' paths are not canonical and unique.');
  return snapshot;
}

function measureValidationCheckoutDelta(baselineValue, currentValue, claimFilesValue, expectedHashesValue, identity) {
  const baseline = validateCheckoutSnapshot(baselineValue, identity, 'Focused repair checkout baseline');
  const current = validateCheckoutSnapshot(currentValue, identity, 'Focused repair live checkout snapshot');
  const claimFiles = [...claimFilesValue].map(focused.normalizeRequestedFocusedFile).sort(focused.compareAscii);
  const expectedHashes = [...expectedHashesValue].map((entry) => ({
    path: focused.normalizeRequestedFocusedFile(entry.path), sha256: exactSha(entry.sha256, 'Focused repair expected terminal file'),
  })).sort((left, right) => focused.compareAscii(left.path, right.path));
  if (focused.canonicalJson(expectedHashes.map((entry) => entry.path)) !== focused.canonicalJson(claimFiles)) {
    throw new Error('Focused repair expected terminal hashes do not match the claimed file set.');
  }
  const before = new Map(baseline.files.map((entry) => [entry.path, entry]));
  const after = new Map(current.files.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...before.keys(), ...after.keys()])].sort(focused.compareAscii);
  const changedPaths = allPaths.filter((relativePath) => focused.canonicalJson(before.get(relativePath) || null)
    !== focused.canonicalJson(after.get(relativePath) || null));
  if (focused.canonicalJson(changedPaths) !== focused.canonicalJson(claimFiles)) {
    throw new Error('Focused repair independently measured checkout changes do not equal the exact claimed file set.');
  }
  for (const relativePath of claimFiles) {
    const entry = after.get(relativePath);
    const expected = expectedHashes.find((item) => item.path === relativePath);
    if (!entry || entry.fact?.kind !== 'regular' || entry.fact.sha256 !== expected.sha256
      || entry.status?.recordType === '2' || entry.status?.recordType === 'u'
      || /[DRCTU]/u.test(String(entry.status?.xy || ''))) {
      throw new Error('Focused repair claimed checkout file is missing, renamed, type-changed, non-regular, or hash-mismatched.');
    }
  }
  const payload = {
    schema: MEASURED_CHECKOUT_DELTA_SCHEMA,
    baselineSnapshotSha256: baseline.contentSha256,
    liveSnapshotSha256: current.contentSha256,
    statusBeforeSha256: baseline.statusSha256,
    statusAfterSha256: current.statusSha256,
    changedPaths,
    fileHashes: expectedHashes,
  };
  return { ...payload, contentSha256: focused.sha256(focused.canonicalJson(payload)) };
}

function validateActualFileHashes(rootValue, fileHashesValue, allowedPathsValue, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = fsImpl.realpathSync(canonicalAbsolute(rootValue, 'Focused repair file root'));
  const hashes = [...(fileHashesValue || [])]
    .map((entry) => ({ path: focused.normalizeRequestedFocusedFile(entry.path), sha256: exactSha(entry.sha256, 'Focused repair file') }))
    .sort((left, right) => focused.compareAscii(left.path, right.path));
  const allowed = [...(allowedPathsValue || [])].map(focused.normalizeRequestedFocusedFile).sort(focused.compareAscii);
  if (!hashes.length || focused.canonicalJson(hashes.map((entry) => entry.path)) !== focused.canonicalJson(allowed)) {
    throw new Error('Focused repair file hashes must match the exact allowed path set.');
  }
  for (const entry of hashes) {
    const candidate = path.resolve(root, entry.path.replace(/\//gu, path.sep));
    if (!focused.isPathWithin(root, candidate)) throw new Error('Focused repair file escapes its owner worktree.');
    const stat = fsImpl.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Focused repair file must be a regular non-symlink file.');
    if (focused.sha256(fsImpl.readFileSync(candidate)) !== entry.sha256) throw new Error('Focused repair file hash does not match live bytes: ' + entry.path);
  }
  return hashes;
}

function validatePatchArtifact(patchManifest, repairWorktreePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = fsImpl.realpathSync(repairWorktreePath);
  const artifactPath = canonicalAbsolute(patchManifest.patchArtifactPath, 'Focused repair patch artifact');
  const stat = fsImpl.lstatSync(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink() || !focused.isPathWithin(root, fsImpl.realpathSync(artifactPath))) {
    throw new Error('Focused repair patch artifact must be a regular file inside its repair worktree.');
  }
  if (focused.sha256(fsImpl.readFileSync(artifactPath)) !== patchManifest.patchSha256) {
    throw new Error('Focused repair patch artifact digest does not match its manifest.');
  }
}

function validateTransitionRequest(value) {
  focused.assertKnownKeys(value, new Set([
    'schema', 'action', 'eventId', 'checkpointPath', 'expectedCheckpointSha256',
    'writerLockFingerprint', 'identity', 'event',
  ]), 'focused repair transition request');
  if (value.schema !== REPAIR_TRANSITION_REQUEST_SCHEMA || !Object.prototype.hasOwnProperty.call(ACTION_EVENT, value.action)) {
    throw new Error('Focused repair transition request schema or action is invalid.');
  }
  exactSha(value.eventId, 'Focused repair transition event id');
  exactSha(value.expectedCheckpointSha256, 'Focused repair expected checkpoint');
  exactSha(value.writerLockFingerprint, 'Focused repair writer lock');
  canonicalAbsolute(value.checkpointPath, 'Focused repair checkpoint');
  if (!value.event || typeof value.event !== 'object' || Array.isArray(value.event)) throw new Error('Focused repair transition event is missing.');
  return value;
}

function executeFocusedRepairTransition(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const repoPath = fsImpl.realpathSync(canonicalAbsolute(options.repoPath, 'Focused repair repository'));
  const request = validateTransitionRequest(clone(options.request));
  const identity = focused.buildFocusedCollectionIdentity(request.identity);
  if (repoPath !== identity.worktreePath) throw new Error('Focused repair explicit repository must equal the bound validation worktree.');
  const policy = focused.loadFocusedCollectionPolicy(repoPath, { fsImpl });
  if (policy.policyFileFingerprint !== identity.policyFileFingerprint
    || policy.focusedPolicyFingerprint !== identity.focusedPolicyFingerprint
    || policy.focusedPolicySafetyFingerprint !== identity.focusedPolicySafetyFingerprint) {
    throw new Error('Focused repair policy identity is stale or belongs to another target.');
  }
  const checkpointPath = canonicalAbsolute(request.checkpointPath, 'Focused repair checkpoint');
  const loaded = focused.loadFocusedParallelWaveCheckpoint(checkpointPath, identity, { fsImpl });
  if (loaded.fingerprint !== request.expectedCheckpointSha256) {
    throw new Error('Focused repair transition expected checkpoint digest is stale.');
  }
  if (loaded.checkpoint.writerLockFingerprint !== request.writerLockFingerprint) {
    throw new Error('Focused repair transition writer lock is not owner-bound to the checkpoint.');
  }
  let scheduler = focused.validateFocusedRepairSchedulerState(loaded.checkpoint.scheduler);
  if (scheduler.transitionHistory.some((entry) => entry.eventId === request.eventId)) {
    throw new Error('Focused repair transition event replay is rejected.');
  }
  const event = { ...clone(request.event), type: ACTION_EVENT[request.action] };

  if (request.action === 'claim') {
    focused.assertKnownKeys(event, new Set([
      'type', 'files', 'ownerThreadId', 'worktreeId', 'worktreePath',
      'ownsRuntime', 'runsValidation', 'mutatesValidationCheckout',
    ]), 'focused repair claim event');
    const claimedWorktree = fsImpl.realpathSync(canonicalAbsolute(event.worktreePath, 'Focused repair owner worktree'));
    if (claimedWorktree !== event.worktreePath) throw new Error('Focused repair owner worktree must resolve canonically.');
    event.checkoutBaseline = captureValidationCheckoutSnapshot(repoPath, identity, event.files, { fsImpl, gitRunner: options.gitRunner });
  } else if (request.action === 'complete') {
    focused.assertKnownKeys(event, new Set([
      'type', 'claimId', 'ownerThreadId', 'worktreeId', 'fileHashes', 'patchManifest',
    ]), 'focused repair complete event');
    const claim = scheduler.repairClaims.find((entry) => entry.claimId === event.claimId);
    if (!claim) throw new Error('Focused repair completion claim is missing.');
    validateContentDigest(event.patchManifest, 'Focused repair patch manifest');
    validateContentDigest(event.patchManifest.terminalOwnerEvidence, 'Focused repair terminal owner evidence');
    focused.assertKnownKeys(event.patchManifest.terminalOwnerEvidence, new Set([
      'schema', 'ownerThreadId', 'worktreeId', 'worktreePath', 'status',
      'ownsRuntime', 'runsValidation', 'mutatesValidationCheckout', 'contentSha256',
    ]), 'focused repair terminal owner evidence');
    focused.assertKnownKeys(event.patchManifest, new Set([
      'schema', 'claimId', 'patchArtifactPath', 'patchSha256', 'worktreeDiffDigest',
      'baseCheckoutDiffDigest', 'migrationFingerprintDigest', 'changedPaths',
      'fileHashes', 'domainChangeClasses', 'terminalOwnerEvidence', 'contentSha256',
    ]), 'focused repair patch manifest');
    validateActualFileHashes(claim.worktreePath, event.fileHashes, claim.files, { fsImpl });
    validatePatchArtifact(event.patchManifest, claim.worktreePath, { fsImpl });
  } else {
    focused.assertKnownKeys(event, new Set([
      'type', 'claimId', 'integrationOwnerThreadId', 'validationWorktreePath',
      'migrationFingerprintBefore', 'migrationFingerprintAfter', 'patchSha256',
      'fileHashes', 'allowedPaths', 'changedPaths', 'checkoutDiffManifest',
      'canonicalManifestDigest', 'canonicalManifestQueueDigest', 'liveCheckpointBinding',
    ]), 'focused repair integrate event');
    const claim = scheduler.repairClaims.find((entry) => entry.claimId === event.claimId);
    if (!claim?.completion) throw new Error('Focused repair integration requires terminal completion evidence.');
    if (event.integrationOwnerThreadId !== identity.ownerThreadId) throw new Error('Focused repair integration requires the sole validation/PR Chief owner.');
    const hashes = validateActualFileHashes(identity.worktreePath, event.fileHashes, claim.files, { fsImpl });
    const liveCheckoutSnapshot = captureValidationCheckoutSnapshot(repoPath, identity, claim.files, { fsImpl, gitRunner: options.gitRunner });
    event.measuredCheckoutDelta = measureValidationCheckoutDelta(
      claim.checkoutBaseline, liveCheckoutSnapshot, claim.files, hashes, identity,
    );
    validateContentDigest(event.checkoutDiffManifest, 'Focused repair checkout diff manifest');
    focused.assertKnownKeys(event.checkoutDiffManifest, new Set([
      'schema', 'baseCheckoutDiffDigest', 'changedPaths', 'fileHashes', 'contentSha256',
    ]), 'focused repair checkout diff manifest');
    const focusedManifest = focused.buildCanonicalFocusedManifest({ cwd: repoPath, policy, identity, fsImpl });
    if (event.canonicalManifestDigest !== focusedManifest.contentSha256
      || event.canonicalManifestQueueDigest !== focusedManifest.queueDigest) {
      throw new Error('Focused repair integration canonical manifest does not match live validation checkout bytes.');
    }
    const reboundEntries = scheduler.entries.map((entry) => {
      const replacement = hashes.find((hash) => hash.path === entry.path);
      return { path: entry.path, digest: replacement ? replacement.sha256 : entry.digest };
    });
    const selectedQueueDigest = focused.sha256(focused.canonicalJson(reboundEntries));
    const expectedLiveBinding = focused.buildFocusedSchedulerCheckpointBinding({
      identity,
      plan: { focusedManifest, queueDigest: selectedQueueDigest },
    });
    if (focused.canonicalJson(event.liveCheckpointBinding) !== focused.canonicalJson(expectedLiveBinding)) {
      throw new Error('Focused repair integration live target binding does not match the active checkpoint.');
    }
  }

  scheduler = focused.reduceFocusedRepairScheduler(scheduler, event, { policy, now });
  const requestDigest = focused.sha256(focused.canonicalJson(request));
  const evidenceDigest = request.action === 'claim'
    ? event.checkoutBaseline.contentSha256
    : request.action === 'complete'
      ? event.patchManifest.contentSha256
      : event.measuredCheckoutDelta.contentSha256;
  scheduler = focused.appendFocusedRepairTransitionHistory(scheduler, {
    eventId: request.eventId,
    action: request.action,
    requestDigest,
    evidenceDigest,
    checkpointBefore: loaded.fingerprint,
  }, { now });

  const state = clone(loaded.checkpoint);
  delete state.contentSha256;
  delete state.previousCheckpointSha256;
  delete state.writerLockFingerprint;
  state.scheduler = scheduler;
  state.revision += 1;
  state.updatedAt = now();
  if (request.action === 'integrate') {
    const hashes = event.fileHashes;
    for (const hash of hashes) {
      const record = state.perFile.find((entry) => entry.path === hash.path);
      if (!record) throw new Error('Focused repair integration file is outside the execution checkpoint.');
      const priorDigest = record.digest;
      record.digest = hash.sha256;
      record.status = 'collected_failure';
      record.failedHistory = [...(record.failedHistory || []), {
        phase: 'repair_integrated_rebound',
        at: state.updatedAt,
        priorDigest,
        repairedDigest: hash.sha256,
        patchSha256: event.patchSha256,
        checkoutDiffDigest: event.measuredCheckoutDelta.contentSha256,
      }];
    }
    const liveManifest = focused.buildCanonicalFocusedManifest({ cwd: repoPath, policy, identity, fsImpl });
    state.focusedManifest = liveManifest;
    state.queueDigest = scheduler.checkpointBinding.selectedQueueDigest;
    state.manifestRemainder = liveManifest.files
      .filter((entry) => !state.perFile.some((record) => record.path === entry.path))
      .map((entry) => entry.path);
  }
  const checkpoint = focused.buildFocusedParallelWaveCheckpoint(state, loaded.raw, {
    writerLockFingerprint: request.writerLockFingerprint,
  });
  const written = focused.writeFocusedParallelWaveCheckpointAtomic(checkpointPath, checkpoint, {
    identity,
    writerLockFingerprint: request.writerLockFingerprint,
    expectedPreviousFingerprint: request.expectedCheckpointSha256,
    fsImpl,
  });
  const claim = scheduler.repairClaims.at(-1) || null;
  return {
    schema: REPAIR_TRANSITION_REQUEST_SCHEMA,
    action: request.action,
    eventId: request.eventId,
    checkpointPath,
    previousCheckpointSha256: loaded.fingerprint,
    checkpointSha256: written.fingerprint,
    schedulerRevision: scheduler.revision,
    checkpointRevision: written.revision,
    claimId: request.action === 'claim' ? claim?.claimId || '' : event.claimId,
    queueState: focused.deriveFocusedSchedulerArtifact(scheduler).queue,
  };
}

function runFocusedRepairTransitionCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseFocusedRepairTransitionArgs(argv);
  const request = readCanonicalJsonFile(parsed.requestPath, parsed.repoPath, options);
  if (path.dirname(parsed.requestPath) !== path.dirname(canonicalAbsolute(request.checkpointPath, 'Focused repair checkpoint'))) {
    throw new Error('Focused repair request file must live beside its bound checkpoint artifact.');
  }
  return executeFocusedRepairTransition({ ...options, repoPath: parsed.repoPath, request });
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runFocusedRepairTransitionCli(), null, 2));
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  CHECKOUT_SNAPSHOT_SCHEMA,
  MEASURED_CHECKOUT_DELTA_SCHEMA,
  REPAIR_TRANSITION_REQUEST_SCHEMA,
  captureValidationCheckoutSnapshot,
  executeFocusedRepairTransition,
  measureValidationCheckoutDelta,
  parseGitPorcelainV2Z,
  parseFocusedRepairTransitionArgs,
  readCanonicalJsonFile,
  runFocusedRepairTransitionCli,
  validateActualFileHashes,
};