#!/usr/bin/env node
'use strict';

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

function buildLocalGateCommentBody({ prNumber, state }) {
  const nextState = createLocalGateState(state);
  return [
    LOCAL_GATE_MARKER,
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

async function findCommentByMarker({
  github,
  owner,
  repo,
  issueNumber,
  marker = LOCAL_GATE_MARKER,
}) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return (Array.isArray(comments) ? comments : [])
    .filter((entry) => commentHasExactMarker(entry?.body, marker))
    .sort((left, right) => commentRecencyKey(right) - commentRecencyKey(left))[0] || null;
}

async function resolveLocalGateAttestation({
  github,
  owner,
  repo,
  prNumber,
  currentHeadSha,
  currentBaseSha,
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
  const comment = await selectComment({
    github,
    owner,
    repo,
    issueNumber,
    marker: LOCAL_GATE_MARKER,
  });
  if (!comment?.body) {
    return { present: false, fresh: false, reason: 'missing', state: createLocalGateState() };
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
  return { present: true, fresh: true, reason: 'fresh', state };
}

module.exports = {
  LOCAL_GATE_MARKER,
  normalizeSha,
  createLocalGateState,
  parseLocalGateCommentState,
  buildLocalGateCommentBody,
  commentRecencyKey,
  commentHasExactMarker,
  findCommentByMarker,
  resolveLocalGateAttestation,
};
