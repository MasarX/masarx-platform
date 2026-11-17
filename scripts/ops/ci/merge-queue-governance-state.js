#!/usr/bin/env node
/* eslint-disable no-console */

const COMMENT_MARKER = '<!-- masarx-merge-queue-governance -->';

function normalizeState(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const failureCount = Number.parseInt(String(source.failure_count ?? source.failureCount ?? 0).trim(), 10);
  return {
    head_sha: String(source.head_sha || '').trim(),
    failure_count: Number.isFinite(failureCount) && failureCount > 0 ? failureCount : 0,
    last_failed_step: String(source.last_failed_step || '').trim(),
    last_run_url: String(source.last_run_url || '').trim(),
    last_run_id: String(source.last_run_id || '').trim(),
    last_conclusion: String(source.last_conclusion || '').trim().toLowerCase(),
    auto_hold_applied: String(source.auto_hold_applied || '').trim().toLowerCase() === 'true' || source.auto_hold_applied === true,
    hold_reason: String(source.hold_reason || '').trim(),
    updated_at: String(source.updated_at || '').trim(),
  };
}

function createState(overrides = {}) {
  return normalizeState({
    head_sha: '',
    failure_count: 0,
    last_failed_step: '',
    last_run_url: '',
    last_run_id: '',
    last_conclusion: '',
    auto_hold_applied: false,
    hold_reason: '',
    updated_at: '',
    ...(overrides && typeof overrides === 'object' ? overrides : {}),
  });
}

function parseCommentState(body) {
  const text = String(body || '');
  const match = text.match(/^State:\s*(\{.+\})\s*$/m);
  if (!match) return createState();
  try {
    return normalizeState(JSON.parse(match[1]));
  } catch {
    return createState();
  }
}

function buildCommentBody({
  prNumber,
  state,
  autoHoldLabel = 'queue:auto-held',
  threshold = 2,
  status = 'tracking',
  notes = [],
}) {
  const normalized = normalizeState(state);
  const lines = [
    COMMENT_MARKER,
    '### Merge Queue Governance',
    '',
    `State: ${JSON.stringify(normalized)}`,
    '',
    `- PR: #${Number(prNumber || 0) || '<unknown>'}`,
    `- Status: \`${String(status || 'tracking').trim() || 'tracking'}\``,
    `- Current Head SHA: \`${normalized.head_sha || '<none>'}\``,
    `- Consecutive Merge-Group Failures: \`${normalized.failure_count}\``,
    `- Last Conclusion: \`${normalized.last_conclusion || '<none>'}\``,
    `- Last Failed Step: ${normalized.last_failed_step || '<none>'}`,
    `- Last Failed Run: ${normalized.last_run_url || '<none>'}`,
    `- Auto Hold Applied: \`${normalized.auto_hold_applied ? 'yes' : 'no'}\``,
    `- Auto Hold Label: \`${String(autoHoldLabel || 'queue:auto-held').trim() || 'queue:auto-held'}\``,
    `- Auto Hold Threshold: \`${Number(threshold || 0) || 2}\``,
  ];
  if (normalized.hold_reason) {
    lines.push(`- Hold Reason: \`${normalized.hold_reason}\``);
  }
  for (const note of Array.isArray(notes) ? notes : []) {
    const value = String(note || '').trim();
    if (value) lines.push(`- Note: ${value}`);
  }
  return lines.join('\n');
}

module.exports = {
  COMMENT_MARKER,
  normalizeState,
  createState,
  parseCommentState,
  buildCommentBody,
};
