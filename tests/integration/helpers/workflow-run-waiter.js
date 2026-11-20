const { setTimeout: delay } = require('node:timers/promises');
const { getWorkflowRunStatus, progressWorkflowRun } = require('./workflow-test-utils');

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

function normalizePositiveInteger(value, fallback, label) {
  const normalized = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }

  return normalized;
}

function normalizeStatusList(statuses, fallback) {
  const list = Array.isArray(statuses) ? statuses : fallback;
  const normalized = list
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error('terminalStatuses must include at least one status');
  }

  return new Set(normalized);
}

function shouldDriveProgress(options) {
  return (
    options.driveProgress === true ||
    Object.prototype.hasOwnProperty.call(options, 'progressInput') ||
    typeof options.progressInputFactory === 'function'
  );
}

async function resolveProgressInput(options, workflowRun, attempt) {
  if (typeof options.progressInputFactory === 'function') {
    const nextInput = await options.progressInputFactory({
      attempt,
      workflowRun,
    });

    return nextInput && typeof nextInput === 'object' && !Array.isArray(nextInput)
      ? nextInput
      : {};
  }

  const nextInput = options.progressInput;
  return nextInput && typeof nextInput === 'object' && !Array.isArray(nextInput)
    ? nextInput
    : {};
}

function resolveSleepMs(pollIntervalMs, lastProgress) {
  const nextRunAt = lastProgress?.nextRunAt ? new Date(lastProgress.nextRunAt).getTime() : Number.NaN;
  if (!Number.isFinite(nextRunAt)) {
    return pollIntervalMs;
  }

  const remainingUntilNextRun = nextRunAt - Date.now();
  if (remainingUntilNextRun <= 0) {
    return Math.min(pollIntervalMs, 50);
  }

  return Math.min(pollIntervalMs, remainingUntilNextRun);
}

async function waitForWorkflowRunTerminal(queryable, workflowRunId, options = {}) {
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const pollIntervalMs = normalizePositiveInteger(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    'pollIntervalMs',
  );
  const terminalStatuses = normalizeStatusList(options.terminalStatuses, DEFAULT_TERMINAL_STATUSES);
  const driveProgress = shouldDriveProgress(options);

  const deadline = Date.now() + timeoutMs;
  let lastWorkflowRun = null;
  let lastProgress = null;
  let attempt = 0;

  while (Date.now() <= deadline) {
    attempt += 1;
    lastWorkflowRun = await getWorkflowRunStatus(queryable, workflowRunId);

    if (terminalStatuses.has(String(lastWorkflowRun.status || '').toLowerCase())) {
      return lastWorkflowRun;
    }

    if (driveProgress) {
      const progressInput = await resolveProgressInput(options, lastWorkflowRun, attempt);
      lastProgress = await progressWorkflowRun(queryable, workflowRunId, progressInput);

      if (terminalStatuses.has(String(lastProgress.status || '').toLowerCase())) {
        lastWorkflowRun = await getWorkflowRunStatus(queryable, workflowRunId);
        if (terminalStatuses.has(String(lastWorkflowRun.status || '').toLowerCase())) {
          return lastWorkflowRun;
        }
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    const sleepMs = Math.max(1, resolveSleepMs(pollIntervalMs, lastProgress));
    await delay(Math.min(sleepMs, remainingMs), undefined, { ref: false });
  }

  const lastStatus = lastWorkflowRun?.status ?? 'unknown';
  const lastStepSummary = Array.isArray(lastWorkflowRun?.steps) && lastWorkflowRun.steps.length > 0
    ? lastWorkflowRun.steps.map((step) => `${step.sequenceOrder}:${step.name}:${step.status}`).join(', ')
    : 'none';

  throw new Error(
    `Timed out waiting for workflow run ${workflowRunId} to reach a terminal state after ${timeoutMs}ms. last_status=${lastStatus} steps=[${lastStepSummary}]`,
  );
}

module.exports = {
  waitForWorkflowRunTerminal,
};
