#!/usr/bin/env node
'use strict';

const {
  DONE_AUDIT_MARKER,
  DONE_AUDIT_REPORT_MARKER,
  AUDIT_REMEDIATION_MARKER,
  AUDIT_ESCALATION_MARKER,
} = require('./config');

function normalizeArray(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  ));
}

function createAuditState(input = {}) {
  return {
    spec_issue_number: Number.parseInt(String(input.spec_issue_number || input.specIssueNumber || '0').trim(), 10) || 0,
    project_item_id: String(input.project_item_id || input.projectItemId || '').trim(),
    final_status: String(input.final_status || input.finalStatus || '').trim(),
    audit_verdict: String(input.audit_verdict || input.auditVerdict || '').trim(),
    audit_queue: String(input.audit_queue || input.auditQueue || '').trim(),
    target_branch: String(input.target_branch || input.targetBranch || '').trim(),
    remediation_issue_number: Number.parseInt(String(input.remediation_issue_number || input.remediationIssueNumber || '0').trim(), 10) || 0,
    attempt_count: Number.parseInt(String(input.attempt_count || input.attemptCount || '0').trim(), 10) || 0,
    required_suites: normalizeArray(input.required_suites || input.requiredSuites),
    observed_suites: normalizeArray(input.observed_suites || input.observedSuites),
    actual_surface_ids: normalizeArray(input.actual_surface_ids || input.actualSurfaceIds),
    expected_surface_ids: normalizeArray(input.expected_surface_ids || input.expectedSurfaceIds),
    linked_pull_requests: normalizeArray(input.linked_pull_requests || input.linkedPullRequests),
    missing_deliverables: normalizeArray(input.missing_deliverables || input.missingDeliverables),
    reason_labels: normalizeArray(input.reason_labels || input.reasonLabels),
    reasons: normalizeArray(input.reasons),
    evidence_url: String(input.evidence_url || input.evidenceUrl || '').trim(),
    generated_at: String(input.generated_at || input.generatedAt || '').trim(),
  };
}

function parseAuditCommentState(body) {
  const match = String(body || '').match(/^State:\s*(\{.*\})\s*$/m);
  if (!match) return createAuditState();
  try {
    return createAuditState(JSON.parse(match[1]));
  } catch {
    return createAuditState();
  }
}

function buildMachineAuditCommentBody({ state, summaryLines = [] }) {
  const nextState = createAuditState(state);
  return [
    DONE_AUDIT_MARKER,
    '### Done Audit',
    '',
    `Spec Issue: #${nextState.spec_issue_number || 0}`,
    `Final Status: ${nextState.final_status || '<unknown>'}`,
    `Audit Verdict: ${nextState.audit_verdict || '<unknown>'}`,
    `Audit Queue: ${nextState.audit_queue || '<unknown>'}`,
    `Target Branch: ${nextState.target_branch || '<unknown>'}`,
    `Attempt Count: ${String(nextState.attempt_count || 0)}`,
    `Required Suites: ${nextState.required_suites.join(', ') || '<none>'}`,
    `Observed Suites: ${nextState.observed_suites.join(', ') || '<none>'}`,
    `Expected Surfaces: ${nextState.expected_surface_ids.join(', ') || '<none>'}`,
    `Actual Surfaces: ${nextState.actual_surface_ids.join(', ') || '<none>'}`,
    `Linked PRs: ${nextState.linked_pull_requests.join(', ') || '<none>'}`,
    `Missing Deliverables: ${nextState.missing_deliverables.join(', ') || '<none>'}`,
    `Reason Labels: ${nextState.reason_labels.join(', ') || '<none>'}`,
    `Evidence: ${nextState.evidence_url || '<none>'}`,
    `Generated At: ${nextState.generated_at || '<unknown>'}`,
    '',
    ...normalizeArray(summaryLines),
    `State: ${JSON.stringify(nextState)}`,
  ].join('\n');
}

function buildDetailedAuditReportBody({ title, lines, state }) {
  const nextState = createAuditState(state);
  return [
    DONE_AUDIT_REPORT_MARKER,
    `### ${String(title || 'Detailed Done Audit Report').trim() || 'Detailed Done Audit Report'}`,
    '',
    ...normalizeArray(lines),
    '',
    `State: ${JSON.stringify(nextState)}`,
  ].join('\n');
}

function buildRemediationIssueTitle({ specIssueNumber, finalStatus }) {
  return `[Audit Remediation] Spec #${Number(specIssueNumber || 0)} - ${String(finalStatus || 'Repair Needed').trim()}`;
}

function buildRemediationIssueBody({
  originalIssueNumber,
  workKey,
  finalStatus,
  auditVerdict,
  evidenceUrl,
  missingDeliverables = [],
  requiredFixes = [],
  expectedSuites = [],
  expectedSurfaces = [],
  generatedAt,
}) {
  return [
    AUDIT_REMEDIATION_MARKER,
    `Original-Issue: #${Number(originalIssueNumber || 0)}`,
    `Work-Key: ${String(workKey || '').trim()}`,
    `Audit-Status: ${String(finalStatus || '').trim()}`,
    `Audit-Verdict: ${String(auditVerdict || '').trim()}`,
    `Audit-Evidence: ${String(evidenceUrl || '').trim()}`,
    `Generated-At: ${String(generatedAt || '').trim()}`,
    '',
    '## Required Fixes',
    ...(normalizeArray(requiredFixes).length ? normalizeArray(requiredFixes).map((line) => `- ${line}`) : ['- Implement the missing deliverables from the linked done audit.']),
    '',
    '## Missing Deliverables',
    ...(normalizeArray(missingDeliverables).length ? normalizeArray(missingDeliverables).map((line) => `- ${line}`) : ['- Audit output did not include an explicit missing-deliverables list.']),
    '',
    '## Required Test Coverage',
    ...(normalizeArray(expectedSuites).length ? normalizeArray(expectedSuites).map((line) => `- ${line}`) : ['- Reproduce the required suites from the deterministic audit evidence.']),
    '',
    '## Expected Surfaces',
    ...(normalizeArray(expectedSurfaces).length ? normalizeArray(expectedSurfaces).map((line) => `- ${line}`) : ['- No explicit cross-surface expectation was derived.']),
    '',
    '## Acceptance Criteria',
    '- The original delivery issue re-audits to `TRULY DONE`.',
    '- The remediation PR targets `dev` and goes through the standard Planning OS execution-card flow.',
    '- The remediation PR body keeps `Spec-Issue: #<remediation-issue>` and also includes `Original-Issue: #<original-issue>`.',
  ].join('\n');
}

function buildEscalationIssueBody({ items = [], generatedAt }) {
  const rows = Array.isArray(items) ? items : [];
  const details = rows.length
    ? rows.map((item) => `- Spec #${item.specIssueNumber}: ${item.reason} (${item.evidenceUrl || 'no evidence url'})`)
    : ['- No escalated items recorded.'];
  return [
    AUDIT_ESCALATION_MARKER,
    '## Dev Done-Audit Escalations',
    '',
    `Generated At: ${String(generatedAt || '').trim() || '<unknown>'}`,
    '',
    ...details,
  ].join('\n');
}

module.exports = {
  AUDIT_ESCALATION_MARKER,
  AUDIT_REMEDIATION_MARKER,
  DONE_AUDIT_MARKER,
  DONE_AUDIT_REPORT_MARKER,
  buildDetailedAuditReportBody,
  buildEscalationIssueBody,
  buildMachineAuditCommentBody,
  buildRemediationIssueBody,
  buildRemediationIssueTitle,
  createAuditState,
  parseAuditCommentState,
};
