#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  assertKnownKeys,
  canonicalJson,
  compareAscii,
  isPlainObject,
  sha256,
} = require('./pr-validation-focused-common');

const HARD_STOP_PRECEDENCE = Object.freeze([
  'interruption', 'lifecycle', 'start', 'admission', 'host_red', 'migration',
  'fingerprint', 'dirty', 'isolation', 'security', 'governance', 'product',
  'api', 'sql', 'unknown',
]);

const FOCUSED_GUARD_SUMMARY_FIELDS = new Set([
  'allGreen', 'timestamp', 'hostGreen', 'dirtyGuardGreen',
  'migrationFingerprintDigest', 'migrationFingerprintStable',
  'policyFileFingerprint', 'focusedPolicyFingerprint', 'runnerFingerprint',
  'pgtapHarnessFingerprint', 'policyFingerprintStable', 'runnerFingerprintStable',
  'harnessFingerprintStable', 'fixtureBootstrapFingerprint',
  'fixtureBootstrapFingerprintStable', 'testFileDigest', 'testFileDigestStable',
  'leaseId', 'warmBaselineFingerprint', 'validationStackGeneration',
  'writerLockFingerprint', 'leaseGuardGreen', 'processGuardGreen',
  'heartbeatGuardGreen', 'overlayGuardGreen', 'heartbeatCount', 'runnerCount',
]);

const REQUIRED_FOCUSED_GUARD_FIELDS = Object.freeze([...FOCUSED_GUARD_SUMMARY_FIELDS]);
const FOCUSED_GUARD_BOOLEAN_FIELDS = Object.freeze([
  'allGreen', 'hostGreen', 'dirtyGuardGreen', 'migrationFingerprintStable',
  'policyFingerprintStable', 'runnerFingerprintStable', 'harnessFingerprintStable',
  'fixtureBootstrapFingerprintStable', 'testFileDigestStable', 'leaseGuardGreen',
  'processGuardGreen', 'heartbeatGuardGreen', 'overlayGuardGreen',
]);
const FOCUSED_GUARD_FINGERPRINT_FIELDS = Object.freeze([
  'migrationFingerprintDigest', 'policyFileFingerprint', 'focusedPolicyFingerprint',
  'runnerFingerprint', 'pgtapHarnessFingerprint', 'fixtureBootstrapFingerprint',
  'testFileDigest', 'warmBaselineFingerprint', 'validationStackGeneration',
  'writerLockFingerprint',
]);

function normalizeIsoUtcTimestamp(value, label) {
  const text = String(value == null ? '' : value);
  const parsed = new Date(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(text) || Number.isNaN(parsed.getTime())) {
    throw new Error(label + ' must be a real ISO UTC timestamp.');
  }
  const canonical = parsed.toISOString();
  if (text !== canonical && text !== canonical.replace('.000Z', 'Z')) throw new Error(label + ' must be canonical.');
  return text;
}

function normalizeFocusedGuardSummary(value) {
  if (value == null) return null;
  if (!isPlainObject(value)) throw new Error('Focused collection guard summary must be a flat object.');
  const unknown = Object.keys(value).filter((key) => !FOCUSED_GUARD_SUMMARY_FIELDS.has(key));
  if (unknown.length) throw new Error('Focused collection guard summary has unknown fields: ' + unknown.sort(compareAscii).join(', '));
  const missing = REQUIRED_FOCUSED_GUARD_FIELDS.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) throw new Error('Focused collection guard summary is missing fields: ' + missing.join(', '));
  const out = { ...value };
  for (const [key, item] of Object.entries(out)) {
    if (!['string', 'number', 'boolean'].includes(typeof item) && item !== null) throw new Error('Focused collection guard summary values must be scalar: ' + key);
    if (typeof item === 'string' && item.length > 256) throw new Error('Focused collection guard summary value is too long: ' + key);
  }
  for (const key of FOCUSED_GUARD_BOOLEAN_FIELDS) {
    if (typeof out[key] !== 'boolean') throw new Error('Focused collection guard summary field must be boolean: ' + key);
  }
  for (const key of FOCUSED_GUARD_FINGERPRINT_FIELDS) {
    if (typeof out[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(out[key])) throw new Error('Focused collection guard summary fingerprint is invalid: ' + key);
  }
  normalizeIsoUtcTimestamp(out.timestamp, 'Focused collection guard summary timestamp');
  if (typeof out.leaseId !== 'string' || !/^[A-Za-z0-9._:/-]{1,240}$/u.test(out.leaseId)) {
    throw new Error('Focused collection guard summary requires a canonical leaseId.');
  }
  if (!Number.isInteger(out.heartbeatCount) || out.heartbeatCount < 0 || !Number.isInteger(out.runnerCount) || out.runnerCount < 0) {
    throw new Error('Focused collection guard summary counts must be nonnegative integers.');
  }
  const expectedAllGreen = FOCUSED_GUARD_BOOLEAN_FIELDS
    .filter((key) => key !== 'allGreen')
    .every((key) => out[key] === true)
    && out.heartbeatCount === 1
    && out.runnerCount === 0;
  if (out.allGreen !== expectedAllGreen) throw new Error('Focused collection guard summary allGreen is inconsistent.');
  return out;
}

function redactFocusedFailureExcerpt(value, maxLength = 1200) {
  let text = String(value == null ? '' : value);
  text = text
    .replace(/-----BEGIN [^-\r\n]*(?:PRIVATE KEY|SECRET|TOKEN)[\s\S]*?-----END [^-\r\n]*(?:PRIVATE KEY|SECRET|TOKEN)-----/giu, '[REDACTED_PEM]')
    .replace(/((?:['\x22])(?:[a-z0-9_]*(?:secret|token|password|key)[a-z0-9_]*)(?:['\x22])\s*:\s*)(['\x22])[^'\x22\r\n]*\2/giu, '$1$2[REDACTED]$2')
    .replace(/((?:apikey|api_key|service_role_key|secret|password|token)\s*[:=]\s*)(['\x22])[^'\x22\r\n]*\2/giu, '$1$2[REDACTED]$2')
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/(\b(?:apikey|api_key|service_role_key|secret|password|token)\b\s*[:=]\s*)[^\s,;&}]+/giu, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_JWT]')
    .replace(/\b[A-Z_][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Z0-9_]*=[^\s]+/giu, '[REDACTED_ENV]');
  text = text.replace(/\r\n/gu, '\n').trim();
  return text.length > maxLength ? text.slice(0, maxLength) + '...[TRUNCATED]' : text;
}

function hardStopRank(family) {
  const index = HARD_STOP_PRECEDENCE.indexOf(String(family || 'unknown'));
  return index < 0 ? HARD_STOP_PRECEDENCE.length : index;
}

function normalizeHardStopSignals(signals = []) {
  return signals.map((signal) => {
    const rawClass = String(signal?.failureClass || signal?.class || 'unknown_hard_stop');
    return {
      family: HARD_STOP_PRECEDENCE.includes(String(signal?.family || '')) ? String(signal.family) : 'unknown',
      failureClass: /^[a-z0-9_:-]{1,160}$/iu.test(rawClass) ? rawClass : 'unknown_hard_stop',
      reason: redactFocusedFailureExcerpt(signal?.reason || '', 240),
    };
  }).sort((left, right) => hardStopRank(left.family) - hardStopRank(right.family)
    || compareAscii(left.failureClass, right.failureClass));
}

function matchCollectibleFailures(text, policy) {
  const value = String(text || '').toLowerCase();
  return Object.values(policy.collectibleClasses || {})
    .filter((entry) => value.includes(String(entry.matcher?.value || '').toLowerCase()))
    .sort((left, right) => compareAscii(left.failure_class, right.failure_class));
}

function classifyFocusedFileDisposition(facts = {}, policy) {
  if (!policy || !isPlainObject(policy.collectibleClasses)) throw new Error('Focused failure classification requires validated policy.');
  if (facts.hardStopSignals != null && !Array.isArray(facts.hardStopSignals)) throw new Error('Focused hard-stop signals must be an array.');
  const output = String(facts.output || '');
  const structured = [...(facts.hardStopSignals || [])];
  if (facts.interrupted !== false) structured.push({ family: 'interruption', failureClass: 'validation_session_interrupted_or_unconfirmed' });
  if (facts.spawnError !== false) structured.push({ family: 'start', failureClass: 'focused_child_spawn_failed_or_unconfirmed' });
  if (facts.closeObserved !== true) structured.push({ family: 'lifecycle', failureClass: 'focused_child_close_not_observed' });
  if (facts.timedOut !== false) structured.push({ family: 'lifecycle', failureClass: 'focused_child_timeout_or_unconfirmed' });
  if (typeof facts.signal !== 'string' || facts.signal) structured.push({ family: 'lifecycle', failureClass: 'focused_child_signal_or_unconfirmed' });
  if (facts.writerMayBeActive !== false) structured.push({ family: 'lifecycle', failureClass: 'focused_child_writer_state_not_clean' });
  if (facts.hostGreen !== true) structured.push({ family: 'host_red', failureClass: 'host_admission_missing_or_red' });
  if (facts.migrationFingerprintStable !== true) structured.push({ family: 'migration', failureClass: 'migration_fingerprint_missing_or_drifted' });
  if (facts.policyFingerprintStable !== true || facts.runnerFingerprintStable !== true || facts.harnessFingerprintStable !== true || facts.fixtureBootstrapFingerprintStable !== true) {
    structured.push({ family: 'fingerprint', failureClass: 'collector_contract_fingerprint_missing_or_drifted' });
  }
  if (facts.testFileDigestStable !== true) structured.push({ family: 'dirty', failureClass: 'selected_test_file_digest_missing_or_drifted' });
  if (facts.dirtyGuardGreen !== true) structured.push({ family: 'dirty', failureClass: 'focused_collection_dirty_guard_missing_or_failed' });
  if (facts.leaseGuardGreen !== true || facts.processGuardGreen !== true || facts.heartbeatGuardGreen !== true || facts.overlayGuardGreen !== true) {
    structured.push({ family: 'lifecycle', failureClass: 'focused_collection_lifecycle_guard_missing_or_failed' });
  }
  if (facts.isolationState !== 'logical_transaction_isolation_verified') structured.push({ family: 'isolation', failureClass: 'focused_file_isolation_not_verified' });
  const exit = facts.exit;
  if (!Number.isInteger(exit) || exit < 0 || exit > 1) structured.push({ family: 'lifecycle', failureClass: 'focused_child_exit_unexpected' });
  const matches = matchCollectibleFailures(output, policy);
  if (exit === 0 && /(?:^|\n)(?:\s*not ok\b|.*\[pgTAP\].*\bfailed:)/iu.test(output)) structured.push({ family: 'unknown', failureClass: 'focused_child_tap_failure_with_zero_exit' });
  const diagnosticLines = output.split(/\r?\n/u).filter((line) => /\b(?:ERROR|FATAL|PANIC|SQLSTATE)\b/iu.test(line));
  const hardDiagnostic = diagnosticLines.find((line) => {
    if (/\b(?:FATAL|PANIC|SQLSTATE)\b/iu.test(line)) return true;
    const lineMatches = matchCollectibleFailures(line, policy);
    return lineMatches.length !== 1 || matches.length !== 1 || lineMatches[0].failure_class !== matches[0].failure_class;
  });
  if (hardDiagnostic) structured.push({ family: 'sql', failureClass: 'focused_child_sql_diagnostic', reason: hardDiagnostic });
  const hardStops = normalizeHardStopSignals(structured);
  const excerpt = redactFocusedFailureExcerpt(output);
  const outputDigest = sha256(redactFocusedFailureExcerpt(output, Number.POSITIVE_INFINITY));
  if (hardStops.length) return { disposition: 'hard_stop', collectible: false, family: hardStops[0].family, failureClass: hardStops[0].failureClass, hardStops, excerpt, outputDigest };
  if (exit === 0) return { disposition: 'passed', collectible: false, family: '', failureClass: '', hardStops: [], excerpt: '', outputDigest };
  const pgtapFailureLines = output.split(/\r?\n/u).filter((line) => /^(?:\s*not ok\b|.*\[pgTAP\].*\bfailed:)/iu.test(line));
  const allowlistedEvidenceBound = matches.length === 1 && [...pgtapFailureLines, ...diagnosticLines]
    .some((line) => matchCollectibleFailures(line, policy).some((entry) => entry.failure_class === matches[0].failure_class));
  const ambiguous = pgtapFailureLines.some((line) => {
    const lineMatches = matchCollectibleFailures(line, policy);
    return lineMatches.length !== 1 || matches.length !== 1 || lineMatches[0].failure_class !== matches[0].failure_class;
  });
  if (exit === 1 && pgtapFailureLines.length && allowlistedEvidenceBound && !ambiguous && matches.length === 1) {
    const match = matches[0];
    const requirements = {
      pgtap_failure_evidence: true,
      logical_transaction_isolation_verified: facts.isolationState === 'logical_transaction_isolation_verified',
      all_pre_and_post_guards_green: [
        facts.hostGreen, facts.migrationFingerprintStable, facts.policyFingerprintStable,
        facts.runnerFingerprintStable, facts.harnessFingerprintStable,
        facts.fixtureBootstrapFingerprintStable, facts.testFileDigestStable,
        facts.dirtyGuardGreen, facts.leaseGuardGreen, facts.processGuardGreen,
        facts.heartbeatGuardGreen, facts.overlayGuardGreen,
      ].every((value) => value === true),
      no_hard_stop_signal: true,
    };
    if (match.requires.every((requirement) => requirements[requirement] === true)) {
      return { disposition: 'collected_failure', collectible: true, family: match.family, failureClass: match.failure_class, hardStops: [], excerpt, outputDigest };
    }
    return {
      disposition: 'hard_stop', collectible: false, family: 'governance',
      failureClass: 'collectible_policy_requirement_not_satisfied',
      hardStops: [{ family: 'governance', failureClass: 'collectible_policy_requirement_not_satisfied', reason: '' }],
      excerpt, outputDigest,
    };
  }
  return {
    disposition: 'hard_stop', collectible: false, family: 'unknown',
    failureClass: 'focused_pgtap_failed_unknown',
    hardStops: [{ family: 'unknown', failureClass: 'focused_pgtap_failed_unknown', reason: '' }],
    excerpt, outputDigest,
  };
}

function normalizeIdentityObject(value) {
  if (Array.isArray(value)) return value.map(normalizeIdentityObject);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort(compareAscii)) out[key] = normalizeIdentityObject(value[key]);
  return out;
}

function canonicalIdentityString(value, label, maxLength = 260) {
  const text = String(value || '');
  if (!text || text !== text.trim() || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error('Focused collection identity has invalid ' + label + '.');
  return text;
}

function buildFocusedCollectionIdentity(values = {}) {
  const targetKind = String(values.targetKind || (values.prNumber ? 'pr' : 'branch_candidate'));
  if (!new Set(['pr', 'branch_candidate']).has(targetKind)) throw new Error('Focused collection target kind is invalid.');
  const targetId = canonicalIdentityString(values.targetId || values.prNumber, 'targetId');
  if (targetKind === 'pr' && !/^\d+$/u.test(targetId)) throw new Error('Focused collection PR target id must be numeric.');
  if (targetKind !== 'pr' && !/^[A-Za-z0-9._:/-]{1,240}$/u.test(targetId)) throw new Error('Focused collection branch candidate target id is invalid.');
  const worktreePath = fs.realpathSync(canonicalIdentityString(values.worktreePath, 'worktreePath', 4096));
  const repoPath = fs.realpathSync(canonicalIdentityString(values.repoPath || worktreePath, 'repoPath', 4096));
  const identity = {
    targetKind,
    targetId,
    prNumber: targetKind === 'pr' ? targetId : '',
    repoId: canonicalIdentityString(values.repoId || path.basename(repoPath), 'repoId'),
    repoPath,
    ownerThreadId: canonicalIdentityString(values.ownerThreadId, 'ownerThreadId'),
    worktreeId: canonicalIdentityString(values.worktreeId, 'worktreeId'),
    worktreePath,
    branch: canonicalIdentityString(values.branch, 'branch'),
    headSha: canonicalIdentityString(values.headSha, 'headSha'),
    projectId: canonicalIdentityString(values.projectId, 'projectId'),
    validationResource: canonicalIdentityString(values.validationResource, 'validationResource'),
    validationOwner: canonicalIdentityString(values.validationOwner, 'validationOwner'),
    leaseId: canonicalIdentityString(values.leaseId, 'leaseId'),
    warmBaselineFingerprint: canonicalIdentityString(values.warmBaselineFingerprint, 'warmBaselineFingerprint'),
    validationStackGeneration: canonicalIdentityString(values.validationStackGeneration, 'validationStackGeneration'),
    policyFileFingerprint: canonicalIdentityString(values.policyFileFingerprint, 'policyFileFingerprint'),
    focusedPolicyFingerprint: canonicalIdentityString(values.focusedPolicyFingerprint, 'focusedPolicyFingerprint'),
    focusedPolicySafetyFingerprint: canonicalIdentityString(values.focusedPolicySafetyFingerprint, 'focusedPolicySafetyFingerprint'),
    runnerFingerprint: canonicalIdentityString(values.runnerFingerprint, 'runnerFingerprint'),
    pgtapHarnessFingerprint: canonicalIdentityString(values.pgtapHarnessFingerprint, 'pgtapHarnessFingerprint'),
    fixtureBootstrapFingerprint: canonicalIdentityString(values.fixtureBootstrapFingerprint, 'fixtureBootstrapFingerprint'),
    migrationFingerprint: normalizeIdentityObject(values.migrationFingerprint),
    ports: normalizeIdentityObject(values.ports || {}),
  };
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(identity.ownerThreadId)) throw new Error('Focused collection owner thread id is invalid.');
  if (!/^[a-f0-9]{40}$/u.test(identity.headSha)) throw new Error('Focused collection head SHA is invalid.');
  for (const key of ['repoId', 'worktreeId', 'projectId']) {
    if (!/^[A-Za-z0-9._-]{1,160}$/u.test(identity[key])) throw new Error('Focused collection identity has invalid ' + key + '.');
  }
  for (const key of ['validationResource', 'validationOwner', 'leaseId']) {
    if (!/^[A-Za-z0-9._:/-]{1,240}$/u.test(identity[key])) throw new Error('Focused collection runtime binding is invalid: ' + key);
  }
  for (const key of [
    'warmBaselineFingerprint', 'validationStackGeneration', 'policyFileFingerprint',
    'focusedPolicyFingerprint', 'focusedPolicySafetyFingerprint', 'runnerFingerprint',
    'pgtapHarnessFingerprint', 'fixtureBootstrapFingerprint',
  ]) {
    if (!/^[a-f0-9]{64}$/u.test(identity[key])) throw new Error('Focused collection identity fingerprint is invalid: ' + key);
  }
  if (!isPlainObject(identity.migrationFingerprint)) throw new Error('Focused collection migration fingerprint is invalid.');
  assertKnownKeys(identity.migrationFingerprint, new Set(['algorithm', 'file_count', 'digest']), 'focused collection migration fingerprint');
  if (identity.migrationFingerprint.algorithm !== 'sha256'
    || !Number.isInteger(identity.migrationFingerprint.file_count)
    || identity.migrationFingerprint.file_count < 0
    || !/^[a-f0-9]{64}$/u.test(String(identity.migrationFingerprint.digest || ''))) {
    throw new Error('Focused collection migration fingerprint is invalid.');
  }
  if (canonicalJson(Object.keys(identity.ports).sort(compareAscii)) !== canonicalJson(['api', 'db', 'studio'])) {
    throw new Error('Focused collection identity requires exactly api, db, and studio ports.');
  }
  const portValues = Object.values(identity.ports);
  if (portValues.some((port) => !Number.isInteger(port) || port <= 0 || port > 65535) || new Set(portValues).size !== portValues.length) {
    throw new Error('Focused collection identity ports must be unique valid TCP ports.');
  }
  identity.lineageFingerprint = sha256(canonicalJson({
    repoId: identity.repoId,
    repoPath: identity.repoPath,
    targetKind: identity.targetKind,
    targetId: identity.targetId,
    worktreeId: identity.worktreeId,
    worktreePath: identity.worktreePath,
    branch: identity.branch,
    headSha: identity.headSha,
  }));
  identity.bindingFingerprint = sha256(canonicalJson(identity));
  return identity;
}

function writeJsonAtomic(filePath, payload, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, '.' + path.basename(filePath) + '.' + process.pid + '.' + Date.now() + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  let handle = null;
  try {
    handle = fsImpl.openSync(tempPath, 'wx', 0o600);
    fsImpl.writeFileSync(handle, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fsImpl.fsyncSync(handle);
    fsImpl.closeSync(handle);
    handle = null;
    fsImpl.renameSync(tempPath, filePath);
  } catch (error) {
    if (handle !== null) {
      try { fsImpl.closeSync(handle); } catch (_) { /* best effort */ }
    }
    try { fsImpl.unlinkSync(tempPath); } catch (_) { /* best effort */ }
    throw error;
  }
  return filePath;
}

function decideMigrationRebuild(options = {}) {
  if (canonicalJson(options.before || {}) === canonicalJson(options.after || {})) {
    return { required: false, allowed: false, reason: 'migration_fingerprint_exact_match' };
  }
  const attemptCount = Number(options.attemptCount || 0);
  if (!Number.isInteger(attemptCount) || attemptCount < 0) throw new Error('Controlled migration rebuild attempt count is invalid.');
  const limit = Number(options.policy?.section?.migration_drift?.controlled_rebuild_limit || 0);
  if (!Number.isInteger(limit) || limit <= 0 || attemptCount >= limit) {
    return {
      required: true, allowed: false, reason: 'controlled_migration_rebuild_limit_reached',
      authorizationColdStartReason: options.policy?.section?.migration_drift?.authorization_cold_start_reason || '',
      attemptCount,
    };
  }
  return {
    required: true, allowed: false,
    reason: 'controlled_migration_rebuild_requires_pr_chief_authorization',
    authorizationColdStartReason: options.policy.section.migration_drift.authorization_cold_start_reason,
    attemptCount, nextAttemptCount: attemptCount + 1,
  };
}

module.exports = {
  HARD_STOP_PRECEDENCE,
  buildFocusedCollectionIdentity,
  classifyFocusedFileDisposition,
  decideMigrationRebuild,
  normalizeFocusedGuardSummary,
  redactFocusedFailureExcerpt,
  writeJsonAtomic,
};
