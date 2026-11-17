#!/usr/bin/env node
'use strict';

const AUDIT_VERDICT_OPTIONS = [
  { name: 'Pending', color: 'YELLOW', description: 'Awaiting deterministic done audit.' },
  { name: 'Pass', color: 'GREEN', description: 'Deterministic audit verified the item as truly done.' },
  { name: 'Repair Needed', color: 'ORANGE', description: 'Audit found missing deliverables that require automated repair.' },
  { name: 'Unsafe', color: 'RED', description: 'Audit found unsafe completion evidence or broken delivery proof.' },
  { name: 'Cannot Verify', color: 'GRAY', description: 'Audit could not prove completion from GitHub and repo evidence.' },
  { name: 'Excluded', color: 'BLUE', description: 'Rollup or execution artifact excluded from the primary delivery denominator.' },
];

const AUDIT_QUEUE_OPTIONS = [
  { name: 'None', color: 'GRAY', description: 'No active audit remediation workflow is in flight.' },
  { name: 'Ready for Repair', color: 'YELLOW', description: 'Audit failed and a remediation issue is queued for execution.' },
  { name: 'In Repair', color: 'BLUE', description: 'A remediation issue is claimed or in PR.' },
  { name: 'Awaiting Re-Audit', color: 'PURPLE', description: 'A remediation change merged and the original item is waiting for re-audit.' },
  { name: 'Escalated', color: 'RED', description: 'Automatic remediation exhausted retries or hit an unrecoverable condition.' },
  { name: 'Closed', color: 'GREEN', description: 'Audit cycle is complete for this item.' },
];

const AUDIT_FIELD_DEFINITIONS = [
  { name: 'Audit Verdict', kind: 'SINGLE_SELECT', options: AUDIT_VERDICT_OPTIONS },
  { name: 'Audit Queue', kind: 'SINGLE_SELECT', options: AUDIT_QUEUE_OPTIONS },
  { name: 'Audit Updated At', kind: 'TEXT' },
  { name: 'Audit Evidence', kind: 'TEXT' },
  { name: 'Audit Repair Issue', kind: 'TEXT' },
  { name: 'Audit Attempt Count', kind: 'TEXT' },
];

const AUDIT_VIEW_DEFINITIONS = [
  {
    name: 'Done Audit Queue',
    layout: 'table',
    filter: 'status:"Done" AND "Audit Verdict":"Pending"',
    visibleFieldNames: ['Title', 'Status', 'Work Key', 'Audit Verdict', 'Audit Queue', 'Audit Updated At', 'Audit Evidence', 'Linked pull requests'],
  },
  {
    name: 'Audit Failures',
    layout: 'table',
    filter: '"Audit Verdict":"Repair Needed" OR "Audit Verdict":"Unsafe" OR "Audit Verdict":"Cannot Verify"',
    visibleFieldNames: ['Title', 'Status', 'Audit Verdict', 'Audit Queue', 'Audit Repair Issue', 'Audit Attempt Count', 'Assignment Issue', 'Linked pull requests'],
  },
  {
    name: 'Awaiting Re-Audit',
    layout: 'table',
    filter: '"Audit Queue":"Awaiting Re-Audit"',
    visibleFieldNames: ['Title', 'Status', 'Audit Verdict', 'Audit Queue', 'Audit Repair Issue', 'Audit Attempt Count', 'Audit Updated At'],
  },
  {
    name: 'Escalated Audit Items',
    layout: 'table',
    filter: '"Audit Queue":"Escalated"',
    visibleFieldNames: ['Title', 'Status', 'Audit Verdict', 'Audit Queue', 'Audit Attempt Count', 'Audit Repair Issue', 'Audit Evidence'],
  },
];

const AUDIT_LABEL_DEFINITIONS = [
  { name: 'audit:pass', color: '0e8a16', description: 'Deterministic done audit passed.' },
  { name: 'audit:repair-needed', color: 'fbca04', description: 'Done audit found missing deliverables that need repair.' },
  { name: 'audit:unsafe', color: 'b60205', description: 'Done audit found unsafe completion evidence.' },
  { name: 'audit:cannot-verify', color: '6f42c1', description: 'Done audit could not verify completion.' },
  { name: 'audit:excluded', color: '1d76db', description: 'Excluded rollup or execution artifact.' },
  { name: 'audit:missing-tests', color: 'd4c5f9', description: 'Done audit found missing tests.' },
  { name: 'audit:missing-docs', color: 'c2e0c6', description: 'Done audit found missing documentation.' },
  { name: 'audit:missing-deliverables', color: 'fef2c0', description: 'Done audit found missing deliverables or surfaces.' },
  { name: 'audit:arch-noncompliant', color: '5319e7', description: 'Done audit found an architecture compliance gap.' },
  { name: 'audit:not-prod-ready', color: 'e99695', description: 'Done audit found production-readiness gaps.' },
  { name: 'kind:audit-remediation', color: 'd93f0b', description: 'Automatic remediation work item created by the done audit plane.' },
  { name: 'audit:escalated', color: 'b60205', description: 'Automatic remediation exhausted retries and escalated.' },
];

const DONE_AUDIT_MARKER = '<!-- masarx-done-audit -->';
const DONE_AUDIT_REPORT_MARKER = '<!-- masarx-done-audit-report -->';
const AUDIT_REMEDIATION_MARKER = '<!-- masarx-audit-remediation -->';
const AUDIT_ESCALATION_MARKER = '<!-- masarx-audit-escalation -->';
const DEFAULT_AUDIT_TARGET_BRANCH = 'dev';

const FINAL_AUDIT_STATUSES = Object.freeze([
  'TRULY DONE',
  'PARTIALLY DONE',
  'NOT DONE',
  'DONE BUT UNSAFE',
  'DONE IN CODE ONLY',
  'DONE BUT MISSING TESTS',
  'DONE BUT MISSING DOCS',
  'DONE BUT MISSING DELIVERABLES',
  'DONE BUT ARCHITECTURALLY NON-COMPLIANT',
  'DONE BUT NOT PRODUCTION-READY',
  'CANNOT VERIFY',
]);

const CLASSIFICATION_TO_RUNTIME = Object.freeze({
  'TRULY DONE': { auditVerdict: 'Pass', auditQueue: 'Closed', labels: ['audit:pass'] },
  'PARTIALLY DONE': {
    auditVerdict: 'Repair Needed',
    auditQueue: 'Ready for Repair',
    labels: ['audit:repair-needed', 'audit:missing-deliverables'],
  },
  'NOT DONE': {
    auditVerdict: 'Repair Needed',
    auditQueue: 'Ready for Repair',
    labels: ['audit:repair-needed', 'audit:missing-deliverables'],
  },
  'DONE BUT UNSAFE': {
    auditVerdict: 'Unsafe',
    auditQueue: 'Ready for Repair',
    labels: ['audit:unsafe'],
  },
  'DONE IN CODE ONLY': {
    auditVerdict: 'Repair Needed',
    auditQueue: 'Ready for Repair',
    labels: ['audit:repair-needed', 'audit:missing-tests', 'audit:missing-docs'],
  },
  'DONE BUT MISSING TESTS': {
    auditVerdict: 'Repair Needed',
    auditQueue: 'Ready for Repair',
    labels: ['audit:repair-needed', 'audit:missing-tests'],
  },
  'DONE BUT MISSING DOCS': {
    auditVerdict: 'Repair Needed',
    auditQueue: 'Ready for Repair',
    labels: ['audit:repair-needed', 'audit:missing-docs'],
  },
  'DONE BUT MISSING DELIVERABLES': {
    auditVerdict: 'Repair Needed',
    auditQueue: 'Ready for Repair',
    labels: ['audit:repair-needed', 'audit:missing-deliverables'],
  },
  'DONE BUT ARCHITECTURALLY NON-COMPLIANT': {
    auditVerdict: 'Repair Needed',
    auditQueue: 'Ready for Repair',
    labels: ['audit:repair-needed', 'audit:arch-noncompliant'],
  },
  'DONE BUT NOT PRODUCTION-READY': {
    auditVerdict: 'Repair Needed',
    auditQueue: 'Ready for Repair',
    labels: ['audit:repair-needed', 'audit:not-prod-ready'],
  },
  'CANNOT VERIFY': {
    auditVerdict: 'Cannot Verify',
    auditQueue: 'Ready for Repair',
    labels: ['audit:cannot-verify'],
  },
});

const EXCLUDED_RUNTIME = Object.freeze({
  auditVerdict: 'Excluded',
  auditQueue: 'Closed',
  labels: ['audit:excluded'],
});

const MAX_AUTOMATIC_REPAIR_ATTEMPTS = 2;
const ESCALATION_ISSUE_TITLE = '[Automation] Dev done-audit escalations';

module.exports = {
  AUDIT_ATTEMPT_FIELD: 'Audit Attempt Count',
  AUDIT_EVIDENCE_FIELD: 'Audit Evidence',
  AUDIT_ESCALATION_MARKER,
  AUDIT_FIELD_DEFINITIONS,
  AUDIT_LABEL_DEFINITIONS,
  AUDIT_QUEUE_FIELD: 'Audit Queue',
  AUDIT_QUEUE_OPTIONS,
  AUDIT_REMEDIATION_MARKER,
  AUDIT_REPAIR_FIELD: 'Audit Repair Issue',
  AUDIT_UPDATED_AT_FIELD: 'Audit Updated At',
  AUDIT_VERDICT_FIELD: 'Audit Verdict',
  AUDIT_VERDICT_OPTIONS,
  AUDIT_VIEW_DEFINITIONS,
  CLASSIFICATION_TO_RUNTIME,
  DEFAULT_AUDIT_TARGET_BRANCH,
  DONE_AUDIT_MARKER,
  DONE_AUDIT_REPORT_MARKER,
  ESCALATION_ISSUE_TITLE,
  EXCLUDED_RUNTIME,
  FINAL_AUDIT_STATUSES,
  MAX_AUTOMATIC_REPAIR_ATTEMPTS,
};
