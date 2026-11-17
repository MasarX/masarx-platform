#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { parseFlagArgs } = require('../../utils/cli-args');
const { classifyHostedUiFailure } = require('../gates/hosted-ui-state');

function die(message) {
  console.error(`[preview-suite-evidence] ${message}`);
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

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(normalizeString(value));
}

function normalizeFailureToken(value, fallback = '') {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || normalizeString(fallback);
}

function normalizeSuiteStatus(outcome) {
  const normalized = normalizeString(outcome).toLowerCase();
  if (!normalized) return 'failed';
  if (['success', 'passed', 'completed'].includes(normalized)) return 'passed';
  if (['skipped', 'skip', 'neutral'].includes(normalized)) return 'skipped';
  if (['failure', 'failed', 'cancelled', 'timed_out', 'timed-out', 'error'].includes(normalized)) {
    return 'failed';
  }
  return normalized;
}

function readJsonFile(targetPath) {
  const resolved = path.resolve(process.cwd(), normalizeString(targetPath));
  if (!resolved || !fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    return null;
  }
}

function readTextFile(targetPath) {
  const resolved = path.resolve(process.cwd(), normalizeString(targetPath));
  if (!resolved || !fs.existsSync(resolved)) return '';
  return fs.readFileSync(resolved, 'utf8');
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

function derivePreviewSuiteSignals({
  suiteId,
  summaryEntries,
  logEntries,
  explicitFailureClass = '',
  explicitRetryCount = 0,
  explicitSilentSkipCount = 0,
}) {
  const normalizedSuiteId = normalizeString(suiteId).toLowerCase();
  const summaries = Array.isArray(summaryEntries) ? summaryEntries : [];
  const logs = Array.isArray(logEntries) ? logEntries : [];
  const parsedSummaries = summaries
    .map((entry) => entry?.payload)
    .filter((payload) => payload && typeof payload === 'object' && !Array.isArray(payload));
  const combinedLogText = logs
    .map((entry) => normalizeString(entry?.text))
    .filter(Boolean)
    .join('\n');

  let failureClass = normalizeString(explicitFailureClass);
  let summaryStatus = '';
  let retryCount = parsePositiveInt(explicitRetryCount, 0);
  let silentSkipCount = parsePositiveInt(explicitSilentSkipCount, 0);

  if (retryCount === 0) {
    retryCount = parsedSummaries.reduce((sum, payload) => sum + parsePositiveInt(payload.retry_count, 0), 0);
  }
  if (silentSkipCount === 0) {
    silentSkipCount = parsedSummaries.reduce((sum, payload) => sum + parsePositiveInt(payload.silent_skip_count, 0), 0);
  }

  for (const payload of parsedSummaries) {
    const status = normalizeString(payload.status).toLowerCase();
    if (!summaryStatus && status) summaryStatus = status;
    if (!failureClass && normalizedSuiteId === 'ui') {
      if (normalizeString(payload.failure_class)) {
        failureClass = normalizeString(payload.failure_class);
      } else if (status && status !== 'passed' && normalizeString(payload.ui_state)) {
        failureClass = normalizeString(payload.ui_state);
      }
    }
    if (!failureClass && normalizeString(payload.failure_class)) {
      failureClass = normalizeString(payload.failure_class);
    }
    if (!failureClass && normalizedSuiteId === 'global_smoke' && Array.isArray(payload.failures) && payload.failures.length > 0) {
      failureClass = normalizeFailureToken(payload.failures[0], 'global-smoke-failed');
    }
    if (!failureClass && normalizedSuiteId === 'mobile' && normalizeString(payload.failed_step)) {
      failureClass = normalizeString(payload.failure_class) || `mobile-strict-${normalizeFailureToken(payload.failed_step)}`;
    }
  }

  if (!failureClass && normalizedSuiteId === 'ui' && combinedLogText) {
    const classification = classifyHostedUiFailure(combinedLogText);
    failureClass = normalizeString(classification.failure_class || classification.ui_state);
  }

  return {
    failureClass,
    retryCount,
    silentSkipCount,
    summaryStatus,
  };
}

function buildPreviewSuiteEvidence({
  workflowGroup,
  suiteId,
  sha,
  previewId = '',
  required = true,
  stepOutcome = '',
  summaryFiles = [],
  logFiles = [],
  explicitFailureClass = '',
  explicitRetryCount = 0,
  explicitSilentSkipCount = 0,
  authoritativeOwner = '',
}) {
  const requestedSummaryFiles = Array.isArray(summaryFiles) ? summaryFiles : [];
  const requestedLogFiles = Array.isArray(logFiles) ? logFiles : [];
  const summaryEntries = requestedSummaryFiles.map((filePath) => ({
    path: normalizeString(filePath),
    payload: readJsonFile(filePath),
  }));
  const logEntries = requestedLogFiles.map((filePath) => ({
    path: normalizeString(filePath),
    text: readTextFile(filePath),
  }));

  const missingSummaryFiles = summaryEntries
    .filter((entry) => !entry.payload)
    .map((entry) => entry.path);
  const missingLogFiles = logEntries
    .filter((entry) => !normalizeString(entry.text))
    .map((entry) => entry.path);

  let status = normalizeSuiteStatus(stepOutcome);
  const signals = derivePreviewSuiteSignals({
    suiteId,
    summaryEntries,
    logEntries,
    explicitFailureClass,
    explicitRetryCount,
    explicitSilentSkipCount,
  });

  if (signals.summaryStatus === 'failed' && status === 'passed') {
    status = 'failed';
  }
  if (status === 'passed' && (missingSummaryFiles.length > 0 || missingLogFiles.length > 0)) {
    status = 'failed';
  }
  if (status === 'skipped' && required) {
    status = 'failed';
  }

  let failureClass = normalizeString(signals.failureClass);
  if (!failureClass && (missingSummaryFiles.length > 0 || missingLogFiles.length > 0)) {
    failureClass = 'missing-evidence-file';
  }
  if (!failureClass && status === 'failed') {
    failureClass = `${normalizeFailureToken(suiteId, 'suite')}-verification-failed`;
  }

  const presentSummaryFiles = summaryEntries
    .filter((entry) => entry.payload)
    .map((entry) => entry.path);
  const presentLogFiles = logEntries
    .filter((entry) => normalizeString(entry.text))
    .map((entry) => entry.path);

  return {
    generated_at: new Date().toISOString(),
    workflow_group: normalizeString(workflowGroup),
    suite_id: normalizeString(suiteId),
    sha: normalizeString(sha),
    preview_id: normalizeString(previewId),
    workflow: normalizeString(process.env.GITHUB_WORKFLOW),
    run_id: normalizeString(process.env.GITHUB_RUN_ID),
    event_name: normalizeString(process.env.GITHUB_EVENT_NAME),
    required: Boolean(required),
    status,
    verify_success: status === 'passed',
    failure_class: failureClass,
    retry_count: parsePositiveInt(signals.retryCount, 0),
    silent_skip_count: parsePositiveInt(signals.silentSkipCount, 0),
    authoritative_owner: normalizeString(authoritativeOwner) || `${normalizeString(workflowGroup)}:${normalizeString(suiteId)}:${normalizeString(sha)}`,
    summary_files: presentSummaryFiles,
    log_files: presentLogFiles,
    missing_files: [...missingSummaryFiles, ...missingLogFiles],
  };
}

function validatePreviewSuiteEvidence(evidence, {
  workflowGroup = '',
  suiteId = '',
  sha = '',
  previewId = '',
  required = true,
  authoritativeOwner = '',
  requireSilentSkipZero = true,
} = {}) {
  const payload = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : null;
  const errors = [];
  if (!payload) {
    return { ok: false, errors: ['Evidence is not an object.'], evidence: null };
  }

  const expectedWorkflowGroup = normalizeString(workflowGroup);
  const expectedSuiteId = normalizeString(suiteId);
  const expectedSha = normalizeString(sha);
  const expectedPreviewId = normalizeString(previewId);
  const expectedOwner = normalizeString(authoritativeOwner) || `${expectedWorkflowGroup}:${expectedSuiteId}:${expectedSha}`;

  if (expectedWorkflowGroup && normalizeString(payload.workflow_group) !== expectedWorkflowGroup) {
    errors.push(`workflow_group mismatch: expected ${expectedWorkflowGroup}, got ${normalizeString(payload.workflow_group) || '<missing>'}`);
  }
  if (expectedSuiteId && normalizeString(payload.suite_id) !== expectedSuiteId) {
    errors.push(`suite_id mismatch: expected ${expectedSuiteId}, got ${normalizeString(payload.suite_id) || '<missing>'}`);
  }
  if (expectedSha && normalizeString(payload.sha) !== expectedSha) {
    errors.push(`sha mismatch: expected ${expectedSha}, got ${normalizeString(payload.sha) || '<missing>'}`);
  }
  if (expectedPreviewId && normalizeString(payload.preview_id) !== expectedPreviewId) {
    errors.push(`preview_id mismatch: expected ${expectedPreviewId}, got ${normalizeString(payload.preview_id) || '<missing>'}`);
  }
  if (expectedOwner && normalizeString(payload.authoritative_owner) !== expectedOwner) {
    errors.push(
      `authoritative_owner mismatch: expected ${expectedOwner}, got ${normalizeString(payload.authoritative_owner) || '<missing>'}`,
    );
  }
  if (required && normalizeString(payload.status) !== 'passed') {
    errors.push(`status must be passed for required suite (got ${normalizeString(payload.status) || '<missing>'})`);
  }
  if (required && payload.verify_success !== true) {
    errors.push(`verify_success must be true for required suite (got ${String(payload.verify_success)})`);
  }
  if (requireSilentSkipZero && parsePositiveInt(payload.silent_skip_count, 0) !== 0) {
    errors.push(`silent_skip_count must be 0 (got ${String(payload.silent_skip_count)})`);
  }
  if (Array.isArray(payload.missing_files) && payload.missing_files.length > 0) {
    errors.push(`missing required evidence files: ${payload.missing_files.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    evidence: payload,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseFlagArgs(argv);
  const mode = normalizeString(args.mode || 'emit').toLowerCase();
  const format = normalizeString(args.format).toLowerCase();
  const reportPath = normalizeString(args.report || '');
  const workflowGroup = normalizeString(args['workflow-group'] || args.workflowGroup);
  const suiteId = normalizeString(args['suite-id'] || args.suiteId);
  const sha = normalizeString(args.sha || process.env.GITHUB_SHA);
  const previewId = normalizeString(args['preview-id'] || args.previewId);
  const required = args.required == null ? true : isTruthy(args.required);
  const authoritativeOwner = normalizeString(args['authoritative-owner'] || args.authoritativeOwner);

  if (!workflowGroup || !suiteId || !sha) {
    throw new Error('Missing required args: --workflow-group --suite-id --sha');
  }
  if (!reportPath) {
    throw new Error('Missing required arg: --report <path>');
  }

  if (mode === 'validate') {
    const evidence = readJsonFile(reportPath);
    const validation = validatePreviewSuiteEvidence(evidence, {
      workflowGroup,
      suiteId,
      sha,
      previewId,
      required,
      authoritativeOwner,
      requireSilentSkipZero: args['require-silent-skip-zero'] == null ? true : isTruthy(args['require-silent-skip-zero']),
    });
    const payload = {
      ok: validation.ok ? '1' : '0',
      report_path: path.resolve(process.cwd(), reportPath),
      errors: validation.errors.join(' | '),
    };
    if (format === 'github-output') {
      writeGithubOutput(payload);
    } else {
      process.stdout.write(`${JSON.stringify({ ...payload, evidence: validation.evidence }, null, 2)}\n`);
    }
    if (!validation.ok) {
      throw new Error(validation.errors.join('; '));
    }
    return;
  }

  const evidence = buildPreviewSuiteEvidence({
    workflowGroup,
    suiteId,
    sha,
    previewId,
    required,
    stepOutcome: args['step-outcome'] || args.stepOutcome,
    summaryFiles: parseCsv(args['summary-files'] || args.summaryFiles),
    logFiles: parseCsv(args['log-files'] || args.logFiles),
    explicitFailureClass: args['failure-class'] || args.failureClass,
    explicitRetryCount: args['retry-count'] || args.retryCount,
    explicitSilentSkipCount: args['silent-skip-count'] || args.silentSkipCount,
    authoritativeOwner,
  });

  const writtenPath = writeJsonFile(reportPath, evidence);
  const payload = {
    report_path: writtenPath,
    status: evidence.status,
    verify_success: evidence.verify_success ? '1' : '0',
    failure_class: evidence.failure_class,
    missing_files: evidence.missing_files.join(','),
  };

  if (format === 'github-output') {
    writeGithubOutput(payload);
  } else {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
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
  buildPreviewSuiteEvidence,
  derivePreviewSuiteSignals,
  normalizeSuiteStatus,
  parseCsv,
  validatePreviewSuiteEvidence,
};
