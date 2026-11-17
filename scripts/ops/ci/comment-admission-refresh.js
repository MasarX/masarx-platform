#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const {
  LOCAL_GATE_MARKER,
} = require('./local-gate-attestation');
const {
  compileProtectedPolicy,
} = require('./control-plane-review-gate');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { format: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--format') out.format = String(argv[++i] || '').trim();
    else if (arg.startsWith('--format=')) out.format = arg.split('=').slice(1).join('=').trim();
  }
  return out;
}

function parseBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function detectAdmissionRefreshTargets({
  body,
  isPullRequest,
  localGateMarker = LOCAL_GATE_MARKER,
  controlPlaneApprovalMarker,
}) {
  const text = String(body || '');
  const normalized = text.trim().toLowerCase();
  const localMarker = String(localGateMarker || '').trim().toLowerCase();
  const approvalMarker = String(controlPlaneApprovalMarker || '').trim().toLowerCase();
  const refreshAssignmentIssuePrs =
    !Boolean(isPullRequest)
    && (
      /(?:^|\r?\n)\s*\/claim\b/i.test(text)
      || normalized.includes('<!-- masarx-worker-claim -->')
      || normalized.includes('<!-- masarx-worker-claim-status -->')
    );
  const refreshPlanCheck =
    Boolean(isPullRequest) &&
    Boolean(localMarker) &&
    normalized.includes(localMarker);
  const refreshReviewerGate = refreshPlanCheck;
  const refreshControlPlane =
    Boolean(isPullRequest) &&
    Boolean(approvalMarker) &&
    normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line.startsWith(approvalMarker));
  return {
    isPullRequest: Boolean(isPullRequest),
    refreshPlanCheck,
    refreshReviewerGate,
    refreshControlPlane,
    refreshAssignmentIssuePrs,
  };
}

function writeGithubOutput(payload) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) throw new Error('GITHUB_OUTPUT not set');
  const lines = Object.entries(payload).map(([key, value]) => `${key}=${String(value == null ? '' : value)}`);
  require('fs').appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const args = parseArgs();
  const policy = compileProtectedPolicy({});
  const result = detectAdmissionRefreshTargets({
    body: process.env.COMMENT_BODY || '',
    isPullRequest: parseBool(process.env.ISSUE_IS_PULL_REQUEST),
    controlPlaneApprovalMarker: policy.commentApprovalMarker,
  });
  const normalized = {
    is_pull_request: result.isPullRequest ? '1' : '0',
    refresh_plan_check: result.refreshPlanCheck ? '1' : '0',
    refresh_reviewer_gate: result.refreshReviewerGate ? '1' : '0',
    refresh_control_plane: result.refreshControlPlane ? '1' : '0',
    refresh_assignment_issue_prs: result.refreshAssignmentIssuePrs ? '1' : '0',
  };
  if (String(args.format || '').trim().toLowerCase() === 'github-output') {
    writeGithubOutput(normalized);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ...result, ...normalized }, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  detectAdmissionRefreshTargets,
};
