#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const { parseFlagArgs } = require('../../utils/cli-args');

const UI_SURFACES = new Set(['console', 'portal']);

function die(message) {
  console.error(`[release-verify-scope] ${message}`);
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

function resolveReleaseVerifyScope(input = {}) {
  const eventName = String(input.eventName || '').trim();
  const skipPreview = isTruthy(input.skipPreview);
  const skipFullPreview = isTruthy(input.skipFullPreview);
  const hasLanding = isTruthy(input.hasLanding);
  const suiteVerifyCloudCore = isTruthy(input.suiteVerifyCloudCore);
  const allowPullRequestPreview = isTruthy(input.allowPullRequestPreview);
  const allowMergeGroupPreview = String(input.allowMergeGroupPreview || '').trim() === ''
    ? true
    : isTruthy(input.allowMergeGroupPreview);
  const surfaceIds = parseCsv(input.surfaceIds);

  const uiProjects = surfaceIds.filter((surfaceId) => UI_SURFACES.has(surfaceId));
  const runUiGate = uiProjects.length > 0;
  const runMobileGate = surfaceIds.includes('mobile_fieldops');
  const runLandingGate = hasLanding || surfaceIds.includes('landing');
  const runDocsGate = surfaceIds.includes('docs');
  const previewRequirementReason = suiteVerifyCloudCore
    ? 'verify_cloud_core'
    : runUiGate
      ? 'ui_surface'
      : runMobileGate
        ? 'mobile_surface'
        : '';

  let runPreviewValidation = false;
  let previewRequested = false;
  let reason = 'fast_only';

  if (skipPreview) {
    reason = 'skip_preview_fast_only';
  } else if (skipFullPreview && runLandingGate && !previewRequirementReason) {
    reason = 'landing_fast_only';
  } else if (!previewRequirementReason) {
    reason = 'preview_not_required';
  } else if (eventName === 'pull_request') {
    runPreviewValidation = true;
    if (!allowPullRequestPreview) {
      reason = 'pr_quick_only';
    } else {
      previewRequested = true;
      reason = previewRequirementReason;
    }
  } else if (eventName === 'merge_group') {
    runPreviewValidation = true;
    if (!allowMergeGroupPreview) {
      reason = 'merge_group_fast_only';
    } else {
      previewRequested = true;
      reason = previewRequirementReason;
    }
  } else {
    runPreviewValidation = true;
    previewRequested = true;
    reason = previewRequirementReason;
  }

  return {
    runPreviewValidation,
    previewRequested,
    reason,
    runUiGate,
    runMobileGate,
    runLandingGate,
    runDocsGate,
    uiProjects,
  };
}

function formatOutputs(result) {
  return {
    run_preview_validation: result.runPreviewValidation ? '1' : '0',
    preview_requested: result.previewRequested ? '1' : '0',
    reason: String(result.reason || '').trim(),
    run_ui_gate: result.runUiGate ? '1' : '0',
    run_mobile_gate: result.runMobileGate ? '1' : '0',
    run_landing_gate: result.runLandingGate ? '1' : '0',
    run_docs_gate: result.runDocsGate ? '1' : '0',
    ui_projects: Array.isArray(result.uiProjects) ? result.uiProjects.join(',') : '',
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
  const result = resolveReleaseVerifyScope({
    eventName: process.env.EVENT_NAME,
    skipPreview: process.env.SKIP_PREVIEW,
    skipFullPreview: process.env.SKIP_FULL_PREVIEW,
    hasLanding: process.env.HAS_LANDING,
    suiteVerifyCloudCore: process.env.SUITE_VERIFY_CLOUD_CORE,
    allowPullRequestPreview: process.env.ALLOW_PULL_REQUEST_PREVIEW,
    allowMergeGroupPreview: process.env.ALLOW_MERGE_GROUP_PREVIEW,
    surfaceIds: process.env.SURFACE_IDS,
  });
  const outputs = formatOutputs(result);

  if (format === 'github-output') writeGithubOutput(outputs);
  else process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);

  console.log(
    `[release-verify-scope] event=${String(process.env.EVENT_NAME || '').trim() || '<unknown>'} ` +
    `run_preview_validation=${outputs.run_preview_validation} ` +
    `reason=${outputs.reason || '<none>'} ui_projects=${outputs.ui_projects || '<none>'} ` +
    `run_landing_gate=${outputs.run_landing_gate} run_docs_gate=${outputs.run_docs_gate}`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  UI_SURFACES,
  formatOutputs,
  isTruthy,
  parseCsv,
  resolveReleaseVerifyScope,
};
