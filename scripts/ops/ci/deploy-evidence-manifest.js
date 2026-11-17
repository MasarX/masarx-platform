#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { parseFlagArgs } = require('../../utils/cli-args');

function die(message) {
  console.error(`[deploy-evidence-manifest] ${message}`);
  process.exit(1);
}

function normalizeString(value) {
  return String(value || '').trim();
}

function parsePositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(normalizeString(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseCsv(raw) {
  return normalizeString(raw)
    .split(',')
    .map((value) => normalizeString(value))
    .filter(Boolean);
}

function readJsonFile(filePath) {
  const resolved = path.resolve(process.cwd(), normalizeString(filePath));
  if (!resolved || !fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    return null;
  }
}

function normalizePhaseRecord(input, sourcePath = '') {
  const payload = input && typeof input === 'object' ? input : {};
  const phase = normalizeString(
    payload.phase ||
    payload.check ||
    payload.label ||
    path.basename(sourcePath, path.extname(sourcePath)),
  );
  const status = normalizeString(
    payload.status ||
    payload.result ||
    (payload.pass === true ? 'passed' : (payload.pass === false ? 'failed' : '')),
  ).toLowerCase() || 'unknown';
  const failureClass = normalizeString(
    payload.failure_class ||
    payload.ui_state ||
    (payload.failed_step && status !== 'passed' ? payload.failed_step : ''),
  );
  const durationSeconds = Number(payload.duration_seconds);
  return {
    phase,
    status,
    duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    failure_class: failureClass,
    source_path: normalizeString(sourcePath),
  };
}

function buildDeployEvidenceManifest({
  stage,
  surface,
  sha,
  workflow,
  environment,
  phases,
  retryCount = 0,
  attemptCount,
  rollbackCount = 0,
  silentSkipCount = 0,
  owner = '',
}) {
  const rows = Array.isArray(phases) ? phases.filter(Boolean) : [];
  const normalizedRetryCount = parsePositiveInt(retryCount);
  const normalizedAttemptCount = parsePositiveInt(attemptCount, normalizedRetryCount + 1);
  const failureClasses = Array.from(
    new Set(
      rows
        .map((row) => normalizeString(row.failure_class))
        .filter(Boolean),
    ),
  );
  const failedPhases = rows.filter((row) => ['failed', 'failure', 'timed_out', 'cancelled', 'missing'].includes(normalizeString(row.status).toLowerCase()));
  const skippedPhases = rows.filter((row) => normalizeString(row.status).startsWith('skipped'));
  const deployPhase = rows.find((row) => row.phase === 'deploy');
  const verificationRows = rows.filter((row) => row.phase !== 'deploy');
  const deploySuccess = Boolean(deployPhase && normalizeString(deployPhase.status) === 'passed');
  const verifySuccess = deploySuccess && verificationRows.every((row) => {
    const status = normalizeString(row.status);
    return status === 'passed' || status.startsWith('skipped');
  });
  const status = deploySuccess && verifySuccess && failedPhases.length === 0 ? 'passed' : 'failed';

  return {
    generated_at: new Date().toISOString(),
    stage: normalizeString(stage),
    surface: normalizeString(surface),
    sha: normalizeString(sha),
    workflow: normalizeString(workflow),
    environment: normalizeString(environment),
    authoritative_owner: normalizeString(owner) || `${normalizeString(stage)}:${normalizeString(surface)}:${normalizeString(sha)}`,
    status,
    deploy_success: deploySuccess,
    verify_success: verifySuccess,
    retry_count: normalizedRetryCount,
    attempt_count: normalizedAttemptCount,
    rollback_count: parsePositiveInt(rollbackCount),
    silent_skip_count: parsePositiveInt(silentSkipCount),
    failed_phase_count: failedPhases.length,
    skipped_phase_count: skippedPhases.length,
    failure_classes: failureClasses,
    phases: rows,
  };
}

function writeJsonFile(targetPath, payload) {
  const resolved = path.resolve(process.cwd(), normalizeString(targetPath));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

function writeGithubOutput(values) {
  const outputPath = normalizeString(process.env.GITHUB_OUTPUT);
  if (!outputPath) {
    throw new Error('GITHUB_OUTPUT not set.');
  }
  const lines = Object.entries(values || {}).map(([key, value]) => `${key}=${String(value == null ? '' : value)}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function validateDeployEvidenceManifest(manifest, {
  stage = '',
  surface = '',
  sha = '',
  workflow = '',
  authoritativeOwner = '',
  requireStatus = 'passed',
  requireDeploySuccess = true,
  requireVerifySuccess = true,
  requireSilentSkipZero = true,
} = {}) {
  const payload = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
  const errors = [];
  if (!payload) {
    return { ok: false, errors: ['Manifest is not an object.'], manifest: null };
  }

  const expectedStage = normalizeString(stage).toLowerCase();
  const expectedSurface = normalizeString(surface);
  const expectedSha = normalizeString(sha);
  const expectedWorkflow = normalizeString(workflow);
  const expectedOwner = normalizeString(authoritativeOwner);
  const expectedStatus = normalizeString(requireStatus).toLowerCase();

  if (expectedStage && normalizeString(payload.stage).toLowerCase() !== expectedStage) {
    errors.push(`stage mismatch: expected ${expectedStage}, got ${normalizeString(payload.stage) || '<missing>'}`);
  }
  if (expectedSurface && normalizeString(payload.surface) !== expectedSurface) {
    errors.push(`surface mismatch: expected ${expectedSurface}, got ${normalizeString(payload.surface) || '<missing>'}`);
  }
  if (expectedSha && normalizeString(payload.sha) !== expectedSha) {
    errors.push(`sha mismatch: expected ${expectedSha}, got ${normalizeString(payload.sha) || '<missing>'}`);
  }
  if (expectedWorkflow && normalizeString(payload.workflow) !== expectedWorkflow) {
    errors.push(`workflow mismatch: expected ${expectedWorkflow}, got ${normalizeString(payload.workflow) || '<missing>'}`);
  }
  if (expectedOwner && normalizeString(payload.authoritative_owner) !== expectedOwner) {
    errors.push(
      `authoritative_owner mismatch: expected ${expectedOwner}, got ${normalizeString(payload.authoritative_owner) || '<missing>'}`,
    );
  }
  if (expectedStatus && normalizeString(payload.status).toLowerCase() !== expectedStatus) {
    errors.push(`status mismatch: expected ${expectedStatus}, got ${normalizeString(payload.status) || '<missing>'}`);
  }
  if (requireDeploySuccess && payload.deploy_success !== true) {
    errors.push(`deploy_success must be true (got ${String(payload.deploy_success)})`);
  }
  if (requireVerifySuccess && payload.verify_success !== true) {
    errors.push(`verify_success must be true (got ${String(payload.verify_success)})`);
  }
  if (requireSilentSkipZero && Number(payload.silent_skip_count || 0) !== 0) {
    errors.push(`silent_skip_count must be 0 (got ${String(payload.silent_skip_count)})`);
  }
  if (Number(payload.failed_phase_count || 0) > 0) {
    errors.push(`failed_phase_count must be 0 (got ${String(payload.failed_phase_count)})`);
  }

  return {
    ok: errors.length === 0,
    errors,
    manifest: payload,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseFlagArgs(argv);
  const phaseFiles = parseCsv(args['phase-files'] || process.env.DEPLOY_EVIDENCE_PHASE_FILES || '');
  const phases = phaseFiles
    .map((filePath) => {
      const payload = readJsonFile(filePath);
      return payload ? normalizePhaseRecord(payload, filePath) : null;
    })
    .filter(Boolean);

  const manifest = buildDeployEvidenceManifest({
    stage: args.stage || process.env.DEPLOY_EVIDENCE_STAGE,
    surface: args.surface || process.env.DEPLOY_EVIDENCE_SURFACE,
    sha: args.sha || process.env.DEPLOY_EVIDENCE_SHA || process.env.GITHUB_SHA,
    workflow: args.workflow || process.env.DEPLOY_EVIDENCE_WORKFLOW || process.env.GITHUB_WORKFLOW,
    environment: args.environment || process.env.DEPLOY_EVIDENCE_ENVIRONMENT,
    phases,
    retryCount: args['retry-count'] || process.env.DEPLOY_EVIDENCE_RETRY_COUNT,
    attemptCount: args['attempt-count'] || process.env.DEPLOY_EVIDENCE_ATTEMPT_COUNT,
    rollbackCount: args['rollback-count'] || process.env.DEPLOY_EVIDENCE_ROLLBACK_COUNT,
    silentSkipCount: args['silent-skip-count'] || process.env.DEPLOY_EVIDENCE_SILENT_SKIP_COUNT,
    owner: args.owner || process.env.DEPLOY_EVIDENCE_OWNER,
  });

  const reportPath = normalizeString(args.report || process.env.DEPLOY_EVIDENCE_REPORT || 'tmp/deploy-evidence-manifest.json');
  const writtenPath = writeJsonFile(reportPath, manifest);
  const format = normalizeString(args.format).toLowerCase();
  const payload = {
    report_path: writtenPath,
    status: manifest.status,
    deploy_success: manifest.deploy_success ? '1' : '0',
    verify_success: manifest.verify_success ? '1' : '0',
    failure_classes: manifest.failure_classes.join(','),
    retry_count: String(manifest.retry_count),
    attempt_count: String(manifest.attempt_count),
    rollback_count: String(manifest.rollback_count),
    silent_skip_count: String(manifest.silent_skip_count),
  };
  if (format === 'github-output') {
    writeGithubOutput(payload);
  } else {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  }
}

module.exports = {
  buildDeployEvidenceManifest,
  normalizePhaseRecord,
  parseCsv,
  validateDeployEvidenceManifest,
};
