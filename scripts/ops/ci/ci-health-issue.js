#!/usr/bin/env node
/* eslint-disable no-console */

const ISSUE_MARKER = '<!-- masarx-ci-health-issue -->';
const TRUE_SET = new Set(['1', 'true', 'yes', 'on', 'enabled']);

function normalizeBool(raw, fallback = false) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value) return Boolean(fallback);
  return TRUE_SET.has(value);
}

function buildPolicy(env = {}) {
  return {
    enabled: normalizeBool(env.CI_HEALTH_ISSUE_ENABLED, true),
    label: String(env.CI_HEALTH_ISSUE_LABEL || 'ops:ci-health').trim() || 'ops:ci-health',
    marker: ISSUE_MARKER,
  };
}

function buildIssueTitle({ queueHealth }) {
  return `CI health regression on ${String(queueHealth?.target_base || 'dev').trim() || 'dev'}`;
}

function buildIssueBody({ queueHealth }) {
  const thresholds = queueHealth?.thresholds || {};
  const violations = Array.isArray(thresholds.violations) ? thresholds.violations : [];
  const lines = [
    ISSUE_MARKER,
    '### CI Health Regression',
    '',
    `- Repository: \`${queueHealth?.repo || ''}\``,
    `- Generated: \`${queueHealth?.generated_at || ''}\``,
    `- Target Base: \`${queueHealth?.target_base || 'dev'}\``,
    `- Ready But Not Auto-Enqueued: \`${Number(queueHealth?.ready_but_not_enqueued_total || 0)}\``,
    `- Auto-Held PRs: \`${Number(queueHealth?.autoheld_total || 0)}\``,
    `- Non-Code GitHub/API Queue Failures: \`${Number(queueHealth?.non_code_github_api_failures_total || 0)}\``,
    '',
    '#### Threshold Violations',
  ];

  if (violations.length) {
    for (const violation of violations) {
      lines.push(`- ${String(violation?.message || 'unknown violation').trim()}`);
    }
  } else {
    lines.push('- <none>');
  }

  if (Array.isArray(queueHealth?.ready_but_not_enqueued) && queueHealth.ready_but_not_enqueued.length) {
    lines.push('');
    lines.push('#### Ready But Not Auto-Enqueued');
    for (const row of queueHealth.ready_but_not_enqueued) {
      lines.push(
        `- #${Number(row?.pr_number || 0)} wait=${Number(row?.wait_seconds || 0)}s author=${String(row?.author || 'unknown').trim() || 'unknown'}`,
      );
    }
  }

  if (Array.isArray(queueHealth?.autoheld_prs) && queueHealth.autoheld_prs.length) {
    lines.push('');
    lines.push('#### Auto-Held PRs');
    for (const row of queueHealth.autoheld_prs) {
      lines.push(
        `- #${Number(row?.pr_number || 0)} failures=${Number(row?.failure_count || 0)} reason=${String(row?.hold_reason || 'unknown').trim() || 'unknown'} step=${String(row?.last_failed_step || '<none>').trim() || '<none>'}`,
      );
    }
  }

  if (Array.isArray(queueHealth?.top_queue_burners) && queueHealth.top_queue_burners.length) {
    lines.push('');
    lines.push('#### Top Queue Burners');
    for (const row of queueHealth.top_queue_burners) {
      lines.push(
        `- #${Number(row?.pr_number || 0)} failed_runs=${Number(row?.failed_runs || 0)} wasted_duration_seconds=${Number(row?.wasted_duration_seconds || 0)}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

async function findExistingIssueByMarker({ github, owner, repo, marker, label }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    labels: String(label || '').trim(),
    per_page: 100,
  });
  return (Array.isArray(issues) ? issues : []).find(
    (issue) => !issue?.pull_request && String(issue?.body || '').includes(String(marker || '').trim()),
  ) || null;
}

async function closeExistingIssueIfHealthy({ github, owner, repo, policy, queueHealth }) {
  if (!github?.paginate || !github?.rest?.issues?.listForRepo || !github?.rest?.issues?.update) {
    return { action: 'skip', reason: 'healthy' };
  }

  const existing = await findExistingIssueByMarker({
    github,
    owner,
    repo,
    marker: policy?.marker,
    label: policy?.label,
  });
  if (!existing?.number) {
    return { action: 'skip', reason: 'healthy' };
  }

  await github.rest.issues.update({
    owner,
    repo,
    issue_number: existing.number,
    title: buildIssueTitle({ queueHealth }),
    body: buildIssueBody({ queueHealth }),
    state: 'closed',
    labels: Array.from(
      new Set([
        ...(existing.labels || [])
          .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
          .filter(Boolean),
        policy.label,
      ]),
    ),
  });
  return { action: 'closed', issueNumber: existing.number };
}

async function upsertCiHealthIssue({
  github,
  owner,
  repo,
  queueHealth,
  policy,
  helpers = {},
}) {
  if (!policy?.enabled) {
    return { action: 'disabled' };
  }

  const thresholds = queueHealth?.thresholds || {};
  if (!thresholds.open_issue) {
    return closeExistingIssueIfHealthy({ github, owner, repo, policy, queueHealth });
  }

  const ensureLabel = helpers.ensureLabel || (async () => {});
  await ensureLabel({
    github,
    owner,
    repo,
    name: policy.label,
    color: 'd73a4a',
    description: 'Automation-tracked CI/CD health regression.',
  });

  const body = buildIssueBody({ queueHealth });
  const title = buildIssueTitle({ queueHealth });
  const existing = await findExistingIssueByMarker({
    github,
    owner,
    repo,
    marker: policy.marker,
    label: policy.label,
  });

  if (existing?.number) {
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: existing.number,
      title,
      body,
      labels: Array.from(new Set([...(existing.labels || []).map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter(Boolean), policy.label])),
    });
    return { action: 'updated', issueNumber: existing.number };
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
  buildPolicy,
  buildIssueTitle,
  buildIssueBody,
  findExistingIssueByMarker,
  closeExistingIssueIfHealthy,
  upsertCiHealthIssue,
};
