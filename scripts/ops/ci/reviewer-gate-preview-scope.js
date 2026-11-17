#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const { parseFlagArgs } = require('../../utils/cli-args');

const TARGETED_SURFACES = new Set(['console', 'portal', 'landing', 'mobile']);

function die(message) {
  console.error(`[reviewer-gate-preview-scope] ${message}`);
  process.exit(1);
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function resolveReviewerGatePreviewScope(input = {}) {
  const eventName = String(input.eventName || '').trim();
  const planStep = String(input.planStep || '').trim();
  const runMode = String(input.runMode || '').trim().toLowerCase();
  const skipPreview = isTruthy(input.skipPreview);
  const suiteVerifyCloudCore = isTruthy(input.suiteVerifyCloudCore);
  const sameRepoPullRequest = isTruthy(input.sameRepoPullRequest);
  const prIsDraft = isTruthy(input.prIsDraft);
  const allowPullRequestPreview = isTruthy(input.allowPullRequestPreview);
  const allowMergeGroupPreview = isTruthy(input.allowMergeGroupPreview);
  const manualForcePreview = isTruthy(input.manualForcePreview);
  const impactSurfaces = parseCsv(input.impactSurfaces);
  const targetedSurfaceIds = impactSurfaces.filter((value) => TARGETED_SURFACES.has(value));
  const targetedPreviewRequired = suiteVerifyCloudCore || targetedSurfaceIds.length > 0;
  const prLikeEvent = eventName === 'pull_request' || (eventName === 'workflow_dispatch' && sameRepoPullRequest);

  let runPreviewValidation = false;
  let reason = 'fast_only';

  if (planStep === 'S00') {
    reason = 'plan_s00';
  } else if (skipPreview) {
    reason = 'change_skip_preview';
  } else if (eventName === 'merge_group') {
    runPreviewValidation = allowMergeGroupPreview && targetedPreviewRequired;
    reason = runPreviewValidation ? 'merge_group_changed_surface_smoke' : 'merge_group_fast_only';
  } else if (prLikeEvent && sameRepoPullRequest && prIsDraft) {
    reason = 'pr_draft_fast_only';
  } else if (eventName === 'pull_request' && sameRepoPullRequest) {
    if (!allowPullRequestPreview) {
      reason = 'pr_quick_only';
    } else {
      runPreviewValidation = targetedPreviewRequired;
      if (suiteVerifyCloudCore) reason = 'pr_targeted_verify_cloud_core';
      else if (targetedSurfaceIds.length > 0) reason = 'pr_targeted_surfaces';
      else reason = 'pr_fast_only';
    }
  } else if (prLikeEvent && sameRepoPullRequest) {
    if (manualForcePreview) {
      runPreviewValidation = true;
      reason = 'manual_force_preview';
    } else if (!allowPullRequestPreview) {
      reason = 'pr_quick_only';
    } else {
      runPreviewValidation = targetedPreviewRequired;
      if (suiteVerifyCloudCore) reason = 'pr_targeted_verify_cloud_core';
      else if (targetedSurfaceIds.length > 0) reason = 'pr_targeted_surfaces';
      else reason = 'pr_fast_only';
    }
  } else {
    reason = 'non_pr_fast_only';
  }

  return {
    runPreviewValidation,
    reason,
    targetedSurfaceIds,
  };
}

function formatOutputs(result) {
  return {
    run_preview_validation: result.runPreviewValidation ? '1' : '0',
    reason: String(result.reason || '').trim(),
    targeted_surface_ids: Array.isArray(result.targetedSurfaceIds) ? result.targetedSurfaceIds.join(',') : '',
  };
}

function writeGithubOutput(outputs) {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputPath) die('GITHUB_OUTPUT not set; use --format json for local runs.');
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value == null ? '' : value)}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function parseArgs(argv = process.argv.slice(2)) {
  const flags = parseFlagArgs(argv);
  return {
    format: String(flags.format || '').trim().toLowerCase(),
  };
}

function main(argv = process.argv.slice(2)) {
  const { format } = parseArgs(argv);
  const result = resolveReviewerGatePreviewScope({
    eventName: process.env.EVENT_NAME,
    planStep: process.env.PLAN_STEP,
    runMode: process.env.RUN_MODE,
    skipPreview: process.env.SKIP_PREVIEW,
    suiteVerifyCloudCore: process.env.SUITE_VERIFY_CLOUD_CORE,
    impactSurfaces: process.env.IMPACT_SURFACES,
    sameRepoPullRequest: process.env.SAME_REPO_PULL_REQUEST,
    prIsDraft: process.env.PR_IS_DRAFT,
    allowPullRequestPreview: process.env.ALLOW_PULL_REQUEST_PREVIEW,
    allowMergeGroupPreview: process.env.ALLOW_MERGE_GROUP_PREVIEW,
    manualForcePreview: process.env.MANUAL_FORCE_PREVIEW,
  });
  const outputs = formatOutputs(result);

  if (format === 'github-output') writeGithubOutput(outputs);
  else process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);

  console.log(
    `[reviewer-gate-preview-scope] event=${String(process.env.EVENT_NAME || '').trim() || '<unknown>'} ` +
    `run_preview_validation=${outputs.run_preview_validation} reason=${outputs.reason || '<none>'} ` +
    `targeted_surface_ids=${outputs.targeted_surface_ids || '<none>'}`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  TARGETED_SURFACES,
  formatOutputs,
  isTruthy,
  parseCsv,
  resolveReviewerGatePreviewScope,
};
