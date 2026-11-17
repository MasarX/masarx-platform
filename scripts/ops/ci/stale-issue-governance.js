#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'config', 'ci', 'stale-issues.json');
const DEFAULT_STALE_LABEL = {
  name: 'status:stale',
  color: 'fef2c0',
  description: 'Issue has had no recent activity and needs triage.',
};
const DEFAULT_STALE_COMMENT =
  'This issue has had no activity for {stale_after_days} days and was marked `{stale_label}`. If this work is still required, post an update (or remove `{stale_label}`) to keep it active.';
const DEFAULT_CLOSE_COMMENT =
  'Closing due to inactivity after {close_after_days} days while marked `{stale_label}`. Reopen with updated context/evidence if this still needs action.';

const STALE_COMMENT_MARKER = '<!-- masarx-issue-stale-governance -->';
const CLOSE_COMMENT_MARKER = '<!-- masarx-issue-stale-governance-close -->';

const TRUE_SET = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_SET = new Set(['0', 'false', 'no', 'off', 'disabled']);
const MODE_MARK_ONLY = 'mark_only';
const MODE_CLOSE_ONLY = 'close_only';
const MODE_MARK_AND_CLOSE = 'mark_and_close';
const MODE_SET = new Set([MODE_MARK_ONLY, MODE_CLOSE_ONLY, MODE_MARK_AND_CLOSE]);

function normalizeBool(raw, fallback) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value) return Boolean(fallback);
  if (TRUE_SET.has(value)) return true;
  if (FALSE_SET.has(value)) return false;
  return Boolean(fallback);
}

function normalizeInt(raw, fallback, min = 1) {
  const parsed = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function normalizeMode(raw, fallback = MODE_MARK_AND_CLOSE) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value) return fallback;
  return MODE_SET.has(value) ? value : fallback;
}

function parseCsv(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return [];
  return text
    .split(',')
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean);
}

function normalizeLabelSet(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = new Set();
  for (const item of list) {
    const value = String(item || '').trim().toLowerCase();
    if (value) out.add(value);
  }
  return out;
}

function listLabelNames(issue) {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  const out = [];
  for (const label of labels) {
    if (typeof label === 'string') {
      const value = String(label || '').trim().toLowerCase();
      if (value) out.push(value);
      continue;
    }
    const value = String(label?.name || '').trim().toLowerCase();
    if (value) out.push(value);
  }
  return out;
}

function daysSince(isoDate, now = new Date()) {
  const source = Date.parse(String(isoDate || ''));
  if (!Number.isFinite(source)) return Number.POSITIVE_INFINITY;
  const deltaMs = Math.max(0, now.getTime() - source);
  return Math.floor(deltaMs / 86400000);
}

function loadPolicyConfig(configPath = DEFAULT_CONFIG_PATH) {
  const sourcePath = String(configPath || '').trim() || DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing stale issue config file: ${sourcePath}`);
  }
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid stale issue config (expected object): ${sourcePath}`);
  }
  return parsed;
}

function buildPolicy(config = {}, env = {}, inputs = {}) {
  const staleLabelConfig = (config.stale_label && typeof config.stale_label === 'object' && !Array.isArray(config.stale_label))
    ? config.stale_label
    : {};

  const staleLabelName = String(
    env.ISSUE_STALE_LABEL ||
      staleLabelConfig.name ||
      DEFAULT_STALE_LABEL.name,
  )
    .trim()
    .toLowerCase();

  const exemptFromConfig = normalizeLabelSet(config.exempt_labels);
  const neverCloseFromConfig = normalizeLabelSet(config.never_close_labels);
  for (const value of parseCsv(env.ISSUE_STALE_EXEMPT_LABELS_CSV || '')) exemptFromConfig.add(value);
  for (const value of parseCsv(env.ISSUE_STALE_NEVER_CLOSE_LABELS_CSV || '')) neverCloseFromConfig.add(value);

  const onlyIssueNumber = normalizeInt(inputs.issue_number || env.ISSUE_STALE_ONLY_ISSUE || '', 0, 1);

  return {
    enabled: normalizeBool(env.ISSUE_STALE_ENABLED, normalizeBool(config.enabled, true)),
    dryRun: normalizeBool(inputs.dry_run ?? env.ISSUE_STALE_DRY_RUN, false),
    mode: normalizeMode(inputs.mode ?? env.ISSUE_STALE_MODE, MODE_MARK_AND_CLOSE),
    staleAfterDays: normalizeInt(env.ISSUE_STALE_AFTER_DAYS, normalizeInt(config.stale_after_days, 30, 1), 1),
    closeAfterDays: normalizeInt(env.ISSUE_STALE_CLOSE_AFTER_DAYS, normalizeInt(config.close_after_days, 14, 1), 1),
    maxIssuesPerRun: normalizeInt(env.ISSUE_STALE_MAX_ISSUES_PER_RUN, normalizeInt(config.max_issues_per_run, 200, 1), 1),
    maxActionsPerRun: normalizeInt(env.ISSUE_STALE_MAX_ACTIONS_PER_RUN, normalizeInt(config.max_actions_per_run, 50, 1), 1),
    skipIfOpenPrReference: normalizeBool(
      env.ISSUE_STALE_SKIP_OPEN_PR_REFERENCE,
      normalizeBool(config.skip_if_open_pr_reference, true),
    ),
    skipIfAssigned: normalizeBool(env.ISSUE_STALE_SKIP_ASSIGNED, normalizeBool(config.skip_if_assigned, false)),
    onlyIssueNumber,
    staleLabel: {
      name: staleLabelName || DEFAULT_STALE_LABEL.name,
      color: String(env.ISSUE_STALE_LABEL_COLOR || staleLabelConfig.color || DEFAULT_STALE_LABEL.color).trim(),
      description: String(
        env.ISSUE_STALE_LABEL_DESCRIPTION ||
          staleLabelConfig.description ||
          DEFAULT_STALE_LABEL.description,
      ).trim(),
    },
    exemptLabels: exemptFromConfig,
    neverCloseLabels: neverCloseFromConfig,
    staleComment: String(config.stale_comment || DEFAULT_STALE_COMMENT).trim() || DEFAULT_STALE_COMMENT,
    closeComment: String(config.close_comment || DEFAULT_CLOSE_COMMENT).trim() || DEFAULT_CLOSE_COMMENT,
  };
}

function hasIntersection(labelSet, expectedSet) {
  for (const value of expectedSet) {
    if (labelSet.has(value)) return true;
  }
  return false;
}

function classifyIssue(issue, policy, now = new Date()) {
  const issueNumber = Number.parseInt(String(issue?.number || '').trim(), 10);
  if (!issueNumber) {
    return { action: 'skip', reason: 'invalid_issue_number', ageDays: Number.POSITIVE_INFINITY, labels: new Set() };
  }

  if (policy.onlyIssueNumber && issueNumber !== policy.onlyIssueNumber) {
    return { action: 'skip', reason: 'outside_scope', ageDays: Number.POSITIVE_INFINITY, labels: new Set() };
  }

  const labels = new Set(listLabelNames(issue));
  const ageDays = daysSince(issue?.updated_at, now);

  if (policy.skipIfAssigned && Array.isArray(issue?.assignees) && issue.assignees.length > 0) {
    return { action: 'skip', reason: 'assigned', ageDays, labels };
  }

  if (hasIntersection(labels, policy.exemptLabels)) {
    return { action: 'skip', reason: 'exempt_label', ageDays, labels };
  }

  const staleLabel = String(policy.staleLabel?.name || DEFAULT_STALE_LABEL.name).trim().toLowerCase();
  const hasStaleLabel = labels.has(staleLabel);

  if (hasStaleLabel) {
    if (hasIntersection(labels, policy.neverCloseLabels)) {
      return { action: 'none', reason: 'never_close_label', ageDays, labels };
    }
    if ((policy.mode === MODE_CLOSE_ONLY || policy.mode === MODE_MARK_AND_CLOSE) && ageDays >= policy.closeAfterDays) {
      return { action: 'close', reason: 'stale_timeout', ageDays, labels };
    }
    return { action: 'none', reason: 'stale_wait', ageDays, labels };
  }

  if ((policy.mode === MODE_MARK_ONLY || policy.mode === MODE_MARK_AND_CLOSE) && ageDays >= policy.staleAfterDays) {
    return { action: 'mark_stale', reason: 'inactive_timeout', ageDays, labels };
  }

  return { action: 'none', reason: 'fresh', ageDays, labels };
}

async function hasOpenPrReference({ github, owner, repo, issueNumber }) {
  const query = `repo:${owner}/${repo} is:pr is:open in:body \"#${issueNumber}\"`;
  const res = await github.rest.search.issuesAndPullRequests({ q: query, per_page: 1 });
  const total = Number(res?.data?.total_count || 0);
  return total > 0;
}

function renderComment(template, vars) {
  return String(template || '').replace(/\{([a-z0-9_]+)\}/gi, (_, key) => {
    const value = vars[key];
    return value == null ? '' : String(value);
  });
}

function formatSummary(summary) {
  return [
    `scanned=${summary.scanned}`,
    `marked=${summary.marked}`,
    `closed=${summary.closed}`,
    `skipped=${summary.skipped}`,
    `noop=${summary.noop}`,
    `dry_run=${summary.dryRun ? 'true' : 'false'}`,
  ].join(' ');
}

async function runStaleIssueGovernance({
  github,
  owner,
  repo,
  policy,
  helpers = {},
  now = new Date(),
  logger = console,
}) {
  if (!github || !github.rest || !github.paginate) throw new Error('runStaleIssueGovernance: missing github client');
  if (!owner || !repo) throw new Error('runStaleIssueGovernance: missing repo coordinates');

  const ensureLabel = helpers.ensureLabel || (async () => {});
  const upsertComment = helpers.upsertComment || (async () => {});

  const summary = {
    scanned: 0,
    marked: 0,
    closed: 0,
    skipped: 0,
    noop: 0,
    dryRun: Boolean(policy.dryRun),
    errors: [],
  };

  if (!policy.enabled) {
    logger.info?.('[issue-stale-governance] skipped (disabled)');
    return summary;
  }

  if (policy.mode !== MODE_CLOSE_ONLY) {
    await ensureLabel({
      github,
      owner,
      repo,
      name: policy.staleLabel.name,
      color: policy.staleLabel.color,
      description: policy.staleLabel.description,
    });
  }

  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    sort: 'updated',
    direction: 'asc',
    per_page: 100,
  });

  const allIssues = (Array.isArray(issues) ? issues : []).filter((item) => !!item && !item.pull_request);
  const scopedIssues = policy.onlyIssueNumber
    ? allIssues.filter((item) => Number(item.number || 0) === policy.onlyIssueNumber)
    : allIssues.slice(0, policy.maxIssuesPerRun);

  const openPrRefCache = new Map();

  for (const issue of scopedIssues) {
    if (summary.marked + summary.closed >= policy.maxActionsPerRun) {
      logger.info?.('[issue-stale-governance] action limit reached, stopping run early');
      break;
    }

    summary.scanned += 1;
    const issueNumber = Number(issue.number || 0);
    const decision = classifyIssue(issue, policy, now);

    if (decision.action === 'skip') {
      summary.skipped += 1;
      continue;
    }

    if (decision.action === 'none') {
      summary.noop += 1;
      continue;
    }

    try {
      if (policy.skipIfOpenPrReference) {
        let hasRef = openPrRefCache.get(issueNumber);
        if (typeof hasRef === 'undefined') {
          hasRef = await hasOpenPrReference({ github, owner, repo, issueNumber });
          openPrRefCache.set(issueNumber, hasRef);
        }
        if (hasRef) {
          summary.skipped += 1;
          continue;
        }
      }

      const vars = {
        issue_number: issueNumber,
        stale_after_days: policy.staleAfterDays,
        close_after_days: policy.closeAfterDays,
        stale_label: policy.staleLabel.name,
      };

      if (decision.action === 'mark_stale') {
        if (policy.dryRun) {
          summary.marked += 1;
          continue;
        }

        await github.rest.issues.addLabels({
          owner,
          repo,
          issue_number: issueNumber,
          labels: [policy.staleLabel.name],
        });

        await upsertComment({
          github,
          owner,
          repo,
          issueNumber,
          marker: STALE_COMMENT_MARKER,
          body: [
            STALE_COMMENT_MARKER,
            renderComment(policy.staleComment, vars),
          ].join('\n'),
        });

        summary.marked += 1;
        continue;
      }

      if (decision.action === 'close') {
        if (policy.dryRun) {
          summary.closed += 1;
          continue;
        }

        await upsertComment({
          github,
          owner,
          repo,
          issueNumber,
          marker: CLOSE_COMMENT_MARKER,
          body: [
            CLOSE_COMMENT_MARKER,
            renderComment(policy.closeComment, vars),
          ].join('\n'),
        });

        await github.rest.issues.update({
          owner,
          repo,
          issue_number: issueNumber,
          state: 'closed',
        });

        summary.closed += 1;
      }
    } catch (err) {
      const message = String(err?.message || err || 'unknown error');
      summary.errors.push(`#${issueNumber}: ${message}`);
    }
  }

  logger.info?.(`[issue-stale-governance] ${formatSummary(summary)}`);
  return summary;
}

function printHelp() {
  console.log(
    [
      'Usage: stale-issue-governance.js [--config path] [--dry-run] [--mode mark_and_close|mark_only|close_only] [--issue <number>]',
      '',
      'Environment overrides:',
      '  ISSUE_STALE_ENABLED=1|0',
      '  ISSUE_STALE_DRY_RUN=1|0',
      '  ISSUE_STALE_MODE=mark_and_close|mark_only|close_only',
      '  ISSUE_STALE_AFTER_DAYS=<int>',
      '  ISSUE_STALE_CLOSE_AFTER_DAYS=<int>',
    ].join('\n'),
  );
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) continue;
    const key = token.replace(/^--/, '');
    const next = String(argv[i + 1] || '').trim();
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = '1';
  }
  return out;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help || flags.h) {
    printHelp();
    return;
  }

  const configPath = String(flags.config || DEFAULT_CONFIG_PATH).trim();
  const config = loadPolicyConfig(configPath);
  const policy = buildPolicy(config, process.env, {
    dry_run: flags['dry-run'] || '',
    mode: flags.mode || '',
    issue_number: flags.issue || '',
  });

  const ownerRepo = String(process.env.GITHUB_REPOSITORY || '').trim();
  if (!ownerRepo.includes('/')) {
    throw new Error('GITHUB_REPOSITORY must be set as owner/repo for CLI execution.');
  }

  const [owner, repo] = ownerRepo.split('/');
  const { Octokit } = require('@octokit/rest');
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (!token) throw new Error('GITHUB_TOKEN is required for CLI execution.');
  const github = new Octokit({ auth: token });

  const result = await runStaleIssueGovernance({
    github,
    owner,
    repo,
    policy,
    helpers: {},
    now: new Date(),
    logger: console,
  });

  if (result.errors.length) {
    throw new Error(`Issue stale governance completed with ${result.errors.length} error(s): ${result.errors.join('; ')}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[issue-stale-governance] ${err.message || err}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  MODE_MARK_ONLY,
  MODE_CLOSE_ONLY,
  MODE_MARK_AND_CLOSE,
  STALE_COMMENT_MARKER,
  CLOSE_COMMENT_MARKER,
  normalizeBool,
  normalizeInt,
  normalizeMode,
  parseCsv,
  normalizeLabelSet,
  listLabelNames,
  daysSince,
  loadPolicyConfig,
  buildPolicy,
  classifyIssue,
  hasOpenPrReference,
  renderComment,
  formatSummary,
  runStaleIssueGovernance,
};
