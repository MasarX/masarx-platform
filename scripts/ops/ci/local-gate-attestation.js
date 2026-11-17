#!/usr/bin/env node
'use strict';

const {
  validateLocalGateAttestationState,
  resolveAcceptedCandidatePolicy,
  loadCandidatePolicyFromGithub,
  validateLocalGateManifestPolicyObject,
  evaluateBootstrapPolicy,
} = require('./local-gate-manifest');

const LOCAL_GATE_MARKER = '<!-- masarx-local-gate -->';

function normalizeSha(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(value) ? value : '';
}

function createLocalGateState(input = {}) {
  return {
    status: String(input.status || 'passed').trim().toLowerCase() || 'passed',
    head_sha: normalizeSha(input.head_sha || input.sha),
    base_sha: normalizeSha(input.base_sha),
    manifest_path: String(input.manifest_path || '').trim(),
    surface_ids: Array.from(
      new Set(
        (Array.isArray(input.surface_ids) ? input.surface_ids : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    ),
    suite_ids: Array.from(
      new Set(
        (Array.isArray(input.suite_ids) ? input.suite_ids : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    ),
    local_mode: String(input.local_mode || 'impact').trim().toLowerCase() || 'impact',
    strict_mode:
      input.strict_mode === true ||
      /^(1|true|yes|on)$/i.test(String(input.strict_mode || '').trim()),
    risk_reasons: Array.from(
      new Set(
        (Array.isArray(input.risk_reasons) ? input.risk_reasons : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    ),
    duration_ms: Number.parseInt(String(input.duration_ms || '0').trim(), 10) || 0,
    generated_at: String(input.generated_at || '').trim(),
    manifest_contract_version: String(input.manifest_contract_version || '').trim(),
    policy_sha256: String(input.policy_sha256 || '').trim().toLowerCase(),
    manifest_sha256: String(input.manifest_sha256 || '').trim().toLowerCase(),
    changed_files_sha256: String(input.changed_files_sha256 || '').trim().toLowerCase(),
    surface_ids_sha256: String(input.surface_ids_sha256 || '').trim().toLowerCase(),
    suite_ids_sha256: String(input.suite_ids_sha256 || '').trim().toLowerCase(),
    command_plan_sha256: String(input.command_plan_sha256 || '').trim().toLowerCase(),
    command_results_sha256: String(input.command_results_sha256 || '').trim().toLowerCase(),
    repository_clean: input.repository_clean === true,
  };
}

function parseLocalGateCommentState(body) {
  const text = String(body || '');
  const match = text.match(/^State:\s*(\{.*\})\s*$/m);
  if (!match) return createLocalGateState();
  try {
    return createLocalGateState(JSON.parse(match[1]));
  } catch {
    return createLocalGateState();
  }
}

function buildLocalGateCommentBody({ prNumber, state, marker = LOCAL_GATE_MARKER }) {
  const nextState = createLocalGateState(state);
  return [
    String(marker || '').trim() || LOCAL_GATE_MARKER,
    '### Local Admission Gate',
    '',
    `PR: #${prNumber}`,
    `Status: ${nextState.status || 'passed'}`,
    `Head SHA: ${nextState.head_sha || '<missing>'}`,
    `Base SHA: ${nextState.base_sha || '<missing>'}`,
    `Manifest: ${nextState.manifest_path || '<missing>'}`,
    `Surfaces: ${nextState.surface_ids.join(', ') || '<none>'}`,
    `Suites: ${nextState.suite_ids.join(', ') || '<none>'}`,
    `Local Mode: ${nextState.local_mode || 'impact'}`,
    `Strict Mode: ${nextState.strict_mode ? 'yes' : 'no'}`,
    `Risk Reasons: ${nextState.risk_reasons.join(', ') || '<none>'}`,
    `Duration (ms): ${String(nextState.duration_ms || 0)}`,
    `Generated At: ${nextState.generated_at || '<unknown>'}`,
    `Manifest Contract: ${nextState.manifest_contract_version || '<missing>'}`,
    `Policy SHA256: ${nextState.policy_sha256 || '<missing>'}`,
    `Manifest SHA256: ${nextState.manifest_sha256 || '<missing>'}`,
    `Changed Files SHA256: ${nextState.changed_files_sha256 || '<missing>'}`,
    `Surface IDs SHA256: ${nextState.surface_ids_sha256 || '<missing>'}`,
    `Suite IDs SHA256: ${nextState.suite_ids_sha256 || '<missing>'}`,
    `Command Plan SHA256: ${nextState.command_plan_sha256 || '<missing>'}`,
    `Command Results SHA256: ${nextState.command_results_sha256 || '<missing>'}`,
    `Repository Clean: ${nextState.repository_clean ? 'yes' : 'no'}`,
    `State: ${JSON.stringify(nextState)}`,
  ].join('\n');
}

function commentRecencyKey(entry) {
  const parsed = Date.parse(String(entry?.updated_at || entry?.created_at || ''));
  if (Number.isFinite(parsed)) return parsed;
  const fallbackId = Number.parseInt(String(entry?.id || '0').trim(), 10);
  return Number.isFinite(fallbackId) ? fallbackId : 0;
}

function commentHasExactMarker(body, marker = LOCAL_GATE_MARKER) {
  const text = String(body || '');
  const normalizedMarker = String(marker || '').trim();
  if (!normalizedMarker) return false;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === normalizedMarker);
}

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase();
}

function commentHasAuthorizedAuthor(entry, { expectedAuthorLogin } = {}) {
  const login = normalizeLogin(entry?.user?.login);
  const expected = normalizeLogin(expectedAuthorLogin);
  if (!login || !expected) return false;
  return login === expected && String(entry?.user?.type || '').trim().toLowerCase() === 'user';
}

async function findCommentByMarker({
  github,
  owner,
  repo,
  issueNumber,
  marker = LOCAL_GATE_MARKER,
  expectedAuthorLogin,
}) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return (Array.isArray(comments) ? comments : [])
    .filter((entry) => commentHasExactMarker(entry?.body, marker))
    .filter((entry) => commentHasAuthorizedAuthor(entry, { expectedAuthorLogin }))
    .sort((left, right) => commentRecencyKey(right) - commentRecencyKey(left))[0] || null;
}

async function resolveLocalGateAttestation({
  github,
  owner,
  repo,
  prNumber,
  currentHeadSha,
  currentBaseSha,
  expectedAuthorLogin,
  bootstrapHeadSha = '',
  bootstrapPolicySha256 = '',
  requireManifestContract = true,
  nowMs = Date.now(),
  helpers = {},
}) {
  const selectComment = helpers.findCommentByMarker || findCommentByMarker;
  const issueNumber = Number.parseInt(String(prNumber || '').trim(), 10);
  if (!issueNumber) {
    return {
      present: false,
      fresh: false,
      reason: 'missing_pr_number',
      state: createLocalGateState(),
    };
  }
  const normalizedExpectedAuthor = normalizeLogin(expectedAuthorLogin);
  if (!normalizedExpectedAuthor) {
    return { present: false, fresh: false, reason: 'missing_expected_author', state: createLocalGateState() };
  }
  const loadCandidatePolicy = helpers.loadCandidatePolicyFromGithub || loadCandidatePolicyFromGithub;
  let exactCandidatePolicy;
  try {
    exactCandidatePolicy = await loadCandidatePolicy({
      github,
      owner,
      repo,
      headSha: currentHeadSha,
    });
  } catch (error) {
    return {
      present: false,
      fresh: false,
      reason: /404|not found|missing/i.test(String(error?.message || error))
        ? 'candidate_policy_missing'
        : 'candidate_policy_malformed',
      policy_errors: [String(error?.message || error)],
      state: createLocalGateState(),
    };
  }
  const candidateShapeErrors = validateLocalGateManifestPolicyObject(exactCandidatePolicy);
  if (candidateShapeErrors.length) {
    return {
      present: false,
      fresh: false,
      reason: candidateShapeErrors.some((error) => /max_age_minutes_invalid/.test(error))
        ? 'candidate_policy_deadlock'
        : 'candidate_policy_weakened',
      policy_errors: candidateShapeErrors,
      state: createLocalGateState(),
    };
  }
  const loadBasePolicy = helpers.loadBasePolicyFromGithub || loadCandidatePolicyFromGithub;
  let basePolicy;
  let bootstrap = false;
  try {
    basePolicy = await loadBasePolicy({
      github,
      owner,
      repo,
      headSha: currentBaseSha,
    });
  } catch (error) {
    const baseMissing = /404|not found|missing/i.test(String(error?.message || error));
    if (!baseMissing) {
      return {
        present: false,
        fresh: false,
        reason: 'base_policy_malformed',
        policy_errors: [String(error?.message || error)],
        state: createLocalGateState(),
      };
    }
    const bootstrapResult = evaluateBootstrapPolicy({
      candidateHeadSha: currentHeadSha,
      candidatePolicy: exactCandidatePolicy,
      expectedHeadSha: bootstrapHeadSha,
      expectedPolicySha256: bootstrapPolicySha256,
    });
    if (!bootstrapResult.ok) {
      return {
        present: false,
        fresh: false,
        reason: 'base_policy_missing',
        policy_errors: bootstrapResult.errors,
        state: createLocalGateState(),
      };
    }
    basePolicy = bootstrapResult.policy;
    bootstrap = true;
  }
  const basePolicyErrors = validateLocalGateManifestPolicyObject(basePolicy);
  if (basePolicyErrors.length) {
    return {
      present: false,
      fresh: false,
      reason: 'base_policy_malformed',
      policy_errors: basePolicyErrors,
      state: createLocalGateState(),
    };
  }
  const candidatePolicy = await resolveAcceptedCandidatePolicy({
    github,
    owner,
    repo,
    headSha: currentHeadSha,
    basePolicy,
    loadCandidatePolicyImpl: async () => exactCandidatePolicy,
  });
  if (!candidatePolicy.ok) {
    return {
      present: false,
      fresh: false,
      reason: candidatePolicy.reason,
      policy_errors: candidatePolicy.errors,
      state: createLocalGateState(),
    };
  }
  const comment = await selectComment({
    github,
    owner,
    repo,
    issueNumber,
    marker: LOCAL_GATE_MARKER,
    expectedAuthorLogin: normalizedExpectedAuthor,
  });
  if (!comment?.body) {
    return { present: false, fresh: false, reason: 'missing', state: createLocalGateState() };
  }
  if (!commentHasAuthorizedAuthor(comment, {
    expectedAuthorLogin: normalizedExpectedAuthor,
  })) {
    return { present: true, fresh: false, reason: 'unauthorized_author', state: createLocalGateState() };
  }
  const state = parseLocalGateCommentState(comment.body);
  if (!state.head_sha || !state.base_sha) {
    return { present: true, fresh: false, reason: 'invalid', state };
  }
  if (state.status !== 'passed') {
    return { present: true, fresh: false, reason: 'failed', state };
  }
  if (normalizeSha(currentHeadSha) && state.head_sha !== normalizeSha(currentHeadSha)) {
    return { present: true, fresh: false, reason: 'stale_head', state };
  }
  if (normalizeSha(currentBaseSha) && state.base_sha !== normalizeSha(currentBaseSha)) {
    return { present: true, fresh: false, reason: 'stale_base', state };
  }
  if (requireManifestContract) {
    const contract = validateLocalGateAttestationState(state, { nowMs, policy: candidatePolicy.policy });
    if (!contract.ok) {
      const expired = contract.errors.length === 1 && contract.errors.includes('proof_expired');
      return {
        present: true,
        fresh: false,
        reason: expired ? 'expired' : 'invalid_contract',
        contract_errors: contract.errors,
        state,
      };
    }
  }
  return {
    present: true,
    fresh: true,
    reason: 'fresh',
    state,
    policy_sha256: candidatePolicy.policy_sha256,
    policy_bootstrap: bootstrap,
  };
}

module.exports = {
  LOCAL_GATE_MARKER,
  normalizeSha,
  createLocalGateState,
  parseLocalGateCommentState,
  buildLocalGateCommentBody,
  commentRecencyKey,
  commentHasExactMarker,
  normalizeLogin,
  commentHasAuthorizedAuthor,
  findCommentByMarker,
  resolveLocalGateAttestation,
};
