#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function die(message) {
  console.error(`[reviewer-gate-execution-evidence] ${message}`);
  process.exit(1);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    format: 'json',
    artifactPath: path.join('artifacts', 'ci', 'reviewer-gate-execution-evidence.json'),
    projectNumber: '',
    syncProjectValidationNotes: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--format') out.format = String(argv[++i] || '').trim() || out.format;
    else if (arg.startsWith('--format=')) out.format = arg.split('=').slice(1).join('=').trim() || out.format;
    else if (arg === '--artifact-path') out.artifactPath = String(argv[++i] || '').trim() || out.artifactPath;
    else if (arg.startsWith('--artifact-path=')) out.artifactPath = arg.split('=').slice(1).join('=').trim() || out.artifactPath;
    else if (arg === '--execution-anchor') out.executionAnchor = String(argv[++i] || '').trim();
    else if (arg.startsWith('--execution-anchor=')) out.executionAnchor = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--execution-anchor-slug') out.executionAnchorSlug = String(argv[++i] || '').trim();
    else if (arg.startsWith('--execution-anchor-slug=')) out.executionAnchorSlug = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--spec-issue') out.specIssue = String(argv[++i] || '').trim();
    else if (arg.startsWith('--spec-issue=')) out.specIssue = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--assignment-issue') out.assignmentIssue = String(argv[++i] || '').trim();
    else if (arg.startsWith('--assignment-issue=')) out.assignmentIssue = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--step') out.step = String(argv[++i] || '').trim();
    else if (arg.startsWith('--step=')) out.step = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--pr-number') out.prNumber = String(argv[++i] || '').trim();
    else if (arg.startsWith('--pr-number=')) out.prNumber = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--head-sha') out.headSha = String(argv[++i] || '').trim();
    else if (arg.startsWith('--head-sha=')) out.headSha = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--merge-sha') out.mergeSha = String(argv[++i] || '').trim();
    else if (arg.startsWith('--merge-sha=')) out.mergeSha = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--preview-manifest') out.previewManifest = String(argv[++i] || '').trim();
    else if (arg.startsWith('--preview-manifest=')) out.previewManifest = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--ci-logs') out.ciLogs = String(argv[++i] || '').trim();
    else if (arg.startsWith('--ci-logs=')) out.ciLogs = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--core-verify') out.coreVerify = String(argv[++i] || '').trim();
    else if (arg.startsWith('--core-verify=')) out.coreVerify = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--tests-gate') out.testsGate = String(argv[++i] || '').trim();
    else if (arg.startsWith('--tests-gate=')) out.testsGate = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--project-number') out.projectNumber = String(argv[++i] || '').trim();
    else if (arg.startsWith('--project-number=')) out.projectNumber = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--sync-project-validation-notes') out.syncProjectValidationNotes = true;
  }
  return out;
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveGithubRunUrl() {
  const base = String(process.env.GITHUB_SERVER_URL || '').trim();
  const repo = String(process.env.GITHUB_REPOSITORY || '').trim();
  const runId = String(process.env.GITHUB_RUN_ID || '').trim();
  if (!base || !repo || !runId) return '';
  return `${base}/${repo}/actions/runs/${runId}`;
}

function ensureFilesExist(files) {
  const missing = [];
  for (const file of Array.isArray(files) ? files : []) {
    const target = String(file || '').trim();
    if (!target) continue;
    const full = path.isAbsolute(target) ? target : path.join(process.cwd(), target);
    if (!fs.existsSync(full)) missing.push(target);
  }
  if (missing.length) {
    die(`Evidence files missing: ${missing.join(', ')}`);
  }
}

function writeGithubOutput(values) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) die('GITHUB_OUTPUT not set; use --format json locally.');
  const lines = [];
  for (const [key, value] of Object.entries(values)) {
    lines.push(`${key}=${String(value == null ? '' : value)}`);
  }
  fs.appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
}

function suggestedArtifactName(slug) {
  const normalized = String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `reviewer-gate-evidence-${normalized || 'unknown'}`;
}

function normalizeShortText(value, maxLength = 240) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function buildValidationNotes({
  executionAnchor,
  step,
  testsGate,
  runUrl,
  artifactName,
  validatedAt,
}) {
  return normalizeShortText(
    [
      `Reviewer gate ${String(testsGate || 'recorded').trim() || 'recorded'}`,
      executionAnchor ? `anchor=${executionAnchor}` : '',
      step ? `step=${step}` : '',
      artifactName ? `artifact=${artifactName}` : '',
      runUrl ? `run=${runUrl}` : '',
      validatedAt ? `at=${validatedAt}` : '',
    ].filter(Boolean).join('; '),
  );
}

function writeArtifact(artifactPath, payload) {
  const target = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.join(process.cwd(), artifactPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

function syncProjectValidationNotes({
  token,
  specIssue,
  projectNumber,
  assignmentIssue,
  step,
  validationNotes,
}) {
  if (!specIssue) return;
  if (!token) die('Project validation sync requested but GITHUB_TOKEN is not set.');
  const scriptPath = path.join(process.cwd(), 'scripts', 'ops', 'planning-os', 'update-project-state.js');
  const args = [
    scriptPath,
    '--spec-issue',
    specIssue,
    '--validation-notes',
    validationNotes,
  ];
  if (projectNumber) {
    args.push('--project-number', projectNumber);
  }
  if (assignmentIssue) {
    args.push('--assignment-issue', `#${String(assignmentIssue).replace(/^#/, '').trim()}`);
  }
  if (step) {
    args.push('--current-step', step);
  }
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error) {
    die(`Failed to sync project validation notes: ${result.error.message}`);
  }
  if (result.status !== 0) {
    die(`Project validation notes sync exited with status ${result.status}.`);
  }
}

function main() {
  const args = parseArgs();
  const ciLogs = splitCsv(args.ciLogs);
  ensureFilesExist(ciLogs);

  const validatedAt = new Date().toISOString();
  const artifactName = suggestedArtifactName(args.executionAnchorSlug);
  const runUrl = resolveGithubRunUrl();
  const payload = {
    kind: 'reviewer_gate_execution_evidence',
    execution_anchor: String(args.executionAnchor || '').trim(),
    execution_anchor_slug: String(args.executionAnchorSlug || '').trim(),
    spec_issue_number: String(args.specIssue || '').replace(/^#/, '').trim(),
    assignment_issue_number: String(args.assignmentIssue || '').replace(/^#/, '').trim(),
    step: String(args.step || '').trim(),
    pr_number: String(args.prNumber || '').trim(),
    head_sha: String(args.headSha || '').trim(),
    merge_sha: String(args.mergeSha || '').trim(),
    preview_manifest: String(args.previewManifest || '').trim(),
    ci_logs: ciLogs,
    core_verify: String(args.coreVerify || '').trim() || 'skipped',
    tests_gate: String(args.testsGate || '').trim() || 'recorded',
    workflow: String(process.env.GITHUB_WORKFLOW || '').trim(),
    run_id: String(process.env.GITHUB_RUN_ID || '').trim(),
    run_attempt: String(process.env.GITHUB_RUN_ATTEMPT || '').trim(),
    run_url: runUrl,
    validated_at: validatedAt,
  };
  const validationNotes = buildValidationNotes({
    executionAnchor: payload.execution_anchor,
    step: payload.step,
    testsGate: payload.tests_gate,
    runUrl,
    artifactName,
    validatedAt,
  });
  payload.validation_notes = validationNotes;

  const writtenPath = writeArtifact(args.artifactPath, payload);
  if (args.syncProjectValidationNotes) {
    syncProjectValidationNotes({
      token: String(process.env.GITHUB_TOKEN || '').trim(),
      specIssue: payload.spec_issue_number,
      projectNumber: String(args.projectNumber || '').trim(),
      assignmentIssue: payload.assignment_issue_number,
      step: payload.step,
      validationNotes,
    });
  }

  const output = {
    artifact_path: path.relative(process.cwd(), writtenPath).replace(/\\/g, '/'),
    artifact_name: artifactName,
    run_url: runUrl,
    validation_notes: validationNotes,
  };
  if (String(args.format || '').trim().toLowerCase() === 'github-output') {
    writeGithubOutput(output);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ...payload, ...output }, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildValidationNotes,
  normalizeShortText,
  parseArgs,
  resolveGithubRunUrl,
  splitCsv,
  suggestedArtifactName,
};
