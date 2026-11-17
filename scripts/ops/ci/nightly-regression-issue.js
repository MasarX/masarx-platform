#!/usr/bin/env node
/* eslint-disable no-console */

const ISSUE_MARKER = '<!-- masarx-nightly-dev-heavy -->';
const TRUE_SET = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const PASS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const FAILURE_FAMILY_PATTERNS = [
  { jobId: 'core', re: /nightly dev heavy\s*\/\s*core/i },
  { jobId: 'ui', re: /nightly dev heavy\s*\/\s*ui/i },
  { jobId: 'landing', re: /nightly dev heavy\s*\/\s*landing/i },
  { jobId: 'mobile', re: /nightly dev heavy\s*\/\s*mobile/i },
];

function normalizeBool(raw, fallback = false) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value) return Boolean(fallback);
  return TRUE_SET.has(value);
}

function normalizeText(raw, fallback = '') {
  const value = String(raw == null ? '' : raw).trim();
  return value || String(fallback || '').trim();
}

function buildPolicy(env = {}) {
  return {
    enabled: normalizeBool(env.NIGHTLY_REGRESSION_ISSUE_ENABLED, true),
    label: normalizeText(env.NIGHTLY_REGRESSION_ISSUE_LABEL, 'ops:nightly-regression'),
    marker: ISSUE_MARKER,
    workflowId: normalizeText(env.NIGHTLY_REGRESSION_WORKFLOW_ID, 'nightly-dev-heavy.yml'),
    branch: normalizeText(env.NIGHTLY_REGRESSION_BRANCH, 'dev'),
  };
}

function normalizeCurrentFailureFamilies(summary = {}) {
  return Array.from(new Set(
    (Array.isArray(summary.failures) ? summary.failures : [])
      .map((entry) => normalizeText(entry?.job_id || entry?.jobId || '').toLowerCase())
      .filter(Boolean),
  ));
}

function detectFailedFamiliesFromJobs(jobs = []) {
  const failures = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const conclusion = normalizeText(job?.conclusion || job?.status).toLowerCase();
    if (!conclusion || PASS_CONCLUSIONS.has(conclusion)) continue;
    const name = normalizeText(job?.name);
    for (const pattern of FAILURE_FAMILY_PATTERNS) {
      if (pattern.re.test(name)) {
        failures.add(pattern.jobId);
      }
    }
  }
  return Array.from(failures);
}

function evaluateRegressionThresholds({ currentFamilies = [], history = [] }) {
  const normalizedCurrent = Array.from(new Set((Array.isArray(currentFamilies) ? currentFamilies : []).map((value) => normalizeText(value).toLowerCase()).filter(Boolean)));
  const previous = Array.isArray(history) ? history.slice(0, 2) : [];

  if (!normalizedCurrent.length) {
    const previousPassed = previous[0]?.status === 'passed';
    return {
      openIssue: false,
      openReason: '',
      closeIssue: previousPassed,
      closeReason: previousPassed ? 'two_consecutive_green_runs' : '',
    };
  }

  const priorCounts = new Map();
  for (const run of previous) {
    for (const family of Array.isArray(run?.failedFamilies) ? run.failedFamilies : []) {
      const key = normalizeText(family).toLowerCase();
      if (!key) continue;
      priorCounts.set(key, Number(priorCounts.get(key) || 0) + 1);
    }
  }

  let openReason = '';
  for (const family of normalizedCurrent) {
    const previousCount = Number(priorCounts.get(family) || 0);
    if (previous[0] && Array.isArray(previous[0].failedFamilies) && previous[0].failedFamilies.includes(family)) {
      openReason = `consecutive_${family}_failure`;
      break;
    }
    if (previousCount >= 1) {
      openReason = `two_of_last_three_${family}_failure`;
      break;
    }
  }

  return {
    openIssue: Boolean(openReason),
    openReason,
    closeIssue: false,
    closeReason: '',
  };
}

function buildIssueTitle({ summary }) {
  return `Nightly dev heavy regression on ${normalizeText(summary?.ref, 'dev')}`;
}

function buildIssueBody({ summary = {}, history = [], openReason = '' }) {
  const failures = Array.isArray(summary.failures) ? summary.failures : [];
  const lines = [
    ISSUE_MARKER,
    '### Nightly Dev Heavy Regression',
    '',
    `- Repository: \`${normalizeText(summary.repo)}\``,
    `- Ref: \`${normalizeText(summary.ref, 'dev')}\``,
    `- Generated: \`${normalizeText(summary.generated_at)}\``,
    `- Status: \`${normalizeText(summary.status, 'unknown')}\``,
    `- Open Reason: \`${normalizeText(openReason, 'observed_regression')}\``,
    `- Run: ${summary.run_url ? `[${normalizeText(summary.run_id, 'current')}](${summary.run_url})` : `\`${normalizeText(summary.run_id, '<none>')}\``}`,
    '',
    '#### Current Failures',
  ];

  if (failures.length) {
    for (const failure of failures) {
      lines.push(`- \`${normalizeText(failure.job_id)}\`: \`${normalizeText(failure.failure_class || failure.result)}\``);
    }
  } else {
    lines.push('- <none>');
  }

  lines.push('');
  lines.push('#### Recent History');
  if (Array.isArray(history) && history.length) {
    for (const run of history) {
      lines.push(
        `- \`${normalizeText(run.generatedAt || run.createdAt)}\` status=\`${normalizeText(run.status, 'unknown')}\` failures=\`${(Array.isArray(run.failedFamilies) ? run.failedFamilies : []).join(',') || '<none>'}\`${run.runUrl ? ` run=${run.runUrl}` : ''}`,
      );
    }
  } else {
    lines.push('- <none>');
  }

  return `${lines.join('\n')}\n`;
}

async function findTrackedIssueByMarker({ github, owner, repo, marker, label, state = 'open' }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state,
    labels: normalizeText(label),
    per_page: 100,
  });
  return (Array.isArray(issues) ? issues : []).find(
    (issue) => !issue?.pull_request && String(issue?.body || '').includes(normalizeText(marker)),
  ) || null;
}

async function collectNightlyRegressionHistory({
  github,
  owner,
  repo,
  workflowId,
  branch,
  currentRunId,
  maxRuns = 3,
}) {
  const res = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: workflowId,
    branch,
    per_page: 10,
    status: 'completed',
  });
  const runs = Array.isArray(res?.data?.workflow_runs) ? res.data.workflow_runs : [];
  const history = [];

  for (const run of runs) {
    const runId = Number(run?.id || 0);
    if (!runId || runId === Number(currentRunId || 0)) continue;
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      owner,
      repo,
      run_id: runId,
      per_page: 100,
    });
    const failedFamilies = detectFailedFamiliesFromJobs(jobs);
    history.push({
      runId,
      runUrl: normalizeText(run?.html_url),
      createdAt: normalizeText(run?.created_at),
      generatedAt: normalizeText(run?.created_at),
      status: failedFamilies.length > 0 ? 'failed' : 'passed',
      failedFamilies,
    });
    if (history.length >= maxRuns) break;
  }

  return history;
}

async function upsertNightlyRegressionIssue({
  github,
  owner,
  repo,
  summary,
  history = [],
  policy,
  helpers = {},
}) {
  if (!policy?.enabled) return { action: 'disabled' };

  const currentFamilies = normalizeCurrentFailureFamilies(summary);
  const thresholds = evaluateRegressionThresholds({ currentFamilies, history });
  const existingOpen = await findTrackedIssueByMarker({
    github,
    owner,
    repo,
    marker: policy.marker,
    label: policy.label,
    state: 'open',
  });

  if (!thresholds.openIssue && !existingOpen?.number) {
    return { action: 'skip', reason: thresholds.closeReason || 'threshold_not_met' };
  }

  const ensureLabel = helpers.ensureLabel || (async () => {});
  await ensureLabel({
    github,
    owner,
    repo,
    name: policy.label,
    color: 'd73a4a',
    description: 'Automation-tracked nightly regression.',
  });

  const title = buildIssueTitle({ summary });
  const body = buildIssueBody({ summary, history, openReason: thresholds.openReason });

  if (existingOpen?.number) {
    if (!thresholds.openIssue && thresholds.closeIssue) {
      await github.rest.issues.update({
        owner,
        repo,
        issue_number: existingOpen.number,
        title,
        body,
        state: 'closed',
        labels: Array.from(new Set([...(existingOpen.labels || []).map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter(Boolean), policy.label])),
      });
      return { action: 'closed', issueNumber: existingOpen.number };
    }

    await github.rest.issues.update({
      owner,
      repo,
      issue_number: existingOpen.number,
      title,
      body,
      state: 'open',
      labels: Array.from(new Set([...(existingOpen.labels || []).map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter(Boolean), policy.label])),
    });
    return { action: 'updated', issueNumber: existingOpen.number };
  }

  if (!thresholds.openIssue) {
    return { action: 'skip', reason: 'waiting_for_second_signal' };
  }

  const existingAny = await findTrackedIssueByMarker({
    github,
    owner,
    repo,
    marker: policy.marker,
    label: policy.label,
    state: 'all',
  });

  if (existingAny?.number) {
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: existingAny.number,
      title,
      body,
      state: 'open',
      labels: Array.from(new Set([...(existingAny.labels || []).map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter(Boolean), policy.label])),
    });
    return { action: 'reopened', issueNumber: existingAny.number };
  }

  const { data } = await github.rest.issues.create({
    owner,
    repo,
    title,
    body,
    labels: [policy.label],
  });
  return { action: 'created', issueNumber: Number(data?.number || 0) };
}

module.exports = {
  ISSUE_MARKER,
  FAILURE_FAMILY_PATTERNS,
  buildPolicy,
  buildIssueTitle,
  buildIssueBody,
  collectNightlyRegressionHistory,
  detectFailedFamiliesFromJobs,
  evaluateRegressionThresholds,
  findTrackedIssueByMarker,
  normalizeCurrentFailureFamilies,
  upsertNightlyRegressionIssue,
};
