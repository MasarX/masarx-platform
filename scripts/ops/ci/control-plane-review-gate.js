#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadPolicy,
  normalizePathPattern,
} = require('./sync-control-plane-codeowners');
const {
  stripAt,
  normalizeApprovalMarker,
  latestReviewStateByLogin,
  summarizeApprovalStates,
} = require('./control-plane-approval');
const {
  githubRequestJson,
  githubPaginate,
} = require('./github-api');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const defaultPolicyPath = path.join(repoRoot, 'config', 'ci', 'control-plane-protected-paths.json');

function die(message) {
  console.error(`[control-plane-review-gate] ${message}`);
  process.exit(1);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(String(fs.readFileSync(filePath, 'utf8') || '').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    format: '',
    prNumber: '',
    policyPath: defaultPolicyPath,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--format') out.format = String(argv[++i] || '').trim();
    else if (arg.startsWith('--format=')) out.format = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--pr-number') out.prNumber = String(argv[++i] || '').trim();
    else if (arg.startsWith('--pr-number=')) out.prNumber = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--policy') out.policyPath = path.resolve(String(argv[++i] || '').trim());
    else if (arg.startsWith('--policy=')) out.policyPath = path.resolve(arg.split('=').slice(1).join('=').trim());
  }

  return out;
}

function writeGithubOutput(kv) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) throw new Error('GITHUB_OUTPUT not set');
  const lines = [];
  for (const [key, value] of Object.entries(kv)) {
    lines.push(`${key}=${String(value == null ? '' : value)}`);
  }
  fs.appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
}

function parseRepoSlug(value) {
  const match = String(value || '').trim().match(/^([^/]+)\/([^/]+)$/);
  if (!match) return { owner: '', repo: '' };
  return { owner: match[1], repo: match[2] };
}

function globToRegex(pattern) {
  const normalized = String(pattern || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function compileProtectedPolicy({ policyPath = defaultPolicyPath } = {}) {
  const policy = loadPolicy(policyPath);
  return {
    approverLogins: Array.from(new Set((policy.ownerHandles || []).map(stripAt).filter(Boolean))),
    commentApprovalMarker: normalizeApprovalMarker(
      policy.ownerCommentApprovalMarker || 'control-plane-approve:',
    ),
    protectedPatterns: Array.isArray(policy.protectedPatterns) ? policy.protectedPatterns : [],
    protectedRegexes: (policy.protectedPatterns || [])
      .map((pattern) => globToRegex(pattern))
      .filter(Boolean),
  };
}

function normalizeChangedPath(filePath) {
  return normalizePathPattern(String(filePath || '').trim()).replace(/^\/+/, '');
}

function listProtectedFiles({ changedFiles, compiledPolicy }) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const regexes = Array.isArray(compiledPolicy?.protectedRegexes) ? compiledPolicy.protectedRegexes : [];
  const out = [];
  for (const filePath of files) {
    const normalized = normalizeChangedPath(filePath);
    if (!normalized) continue;
    if (regexes.some((regex) => regex.test(normalized))) out.push(normalized);
  }
  return Array.from(new Set(out)).sort();
}

async function ghPaginate({ token, url, accept }) {
  return githubPaginate({
    token,
    url,
    accept,
    userAgent: 'masarx-control-plane-review-gate',
  });
}

async function listPullRequestFiles({ owner, repo, token, prNumber }) {
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${Number(prNumber)}/files`;
  const files = await ghPaginate({ token, url: baseUrl });
  return files
    .map((entry) => String(entry?.filename || '').trim())
    .filter(Boolean);
}

async function listPullRequestReviews({ owner, repo, token, prNumber }) {
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${Number(prNumber)}/reviews`;
  return ghPaginate({ token, url: baseUrl });
}

async function getPullRequest({ owner, repo, token, prNumber }) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${Number(prNumber)}`;
  return githubRequestJson({
    token,
    url,
    userAgent: 'masarx-control-plane-review-gate',
  });
}

async function listPullRequestComments({ owner, repo, token, prNumber }) {
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${Number(prNumber)}/comments`;
  return ghPaginate({ token, url: baseUrl });
}

async function listAssociatedPullRequestsForCommit({ owner, repo, token, sha }) {
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(String(sha || '').trim())}/pulls`;
  return ghPaginate({
    token,
    url: baseUrl,
    accept: 'application/vnd.github+json, application/vnd.github.groot-preview+json',
  });
}

async function listCompareFiles({ owner, repo, token, baseSha, headSha }) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(String(baseSha || '').trim())}...${encodeURIComponent(String(headSha || '').trim())}`;
  const payload = await githubRequestJson({
    token,
    url,
    userAgent: 'masarx-control-plane-review-gate',
  });
  return (Array.isArray(payload?.files) ? payload.files : [])
    .map((entry) => String(entry?.filename || '').trim())
    .filter(Boolean);
}

function parsePrNumberFromMergeGroupHeadRef(headRef) {
  const raw = String(headRef || '').trim();
  if (!raw) return 0;
  const match = raw.match(/pr-(\d+)-/i) || raw.match(/pr-(\d+)\b/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

async function resolveMergeGroupPrNumbers({ owner, repo, token, eventPayload }) {
  const numbers = new Set();
  const headRef = String(eventPayload?.merge_group?.head_ref || '').trim();
  const headSha = String(eventPayload?.merge_group?.head_sha || '').trim();
  const parsed = parsePrNumberFromMergeGroupHeadRef(headRef);
  if (parsed) numbers.add(parsed);

  if (headSha) {
    const prs = await listAssociatedPullRequestsForCommit({ owner, repo, token, sha: headSha });
    for (const pr of prs) {
      const number = Number(pr?.number || 0);
      if (number) numbers.add(number);
    }
  }

  return Array.from(numbers).sort((left, right) => left - right);
}

async function evaluateProtectedPullRequest({
  owner,
  repo,
  token,
  prNumber,
  compiledPolicy,
}) {
  const changedFiles = await listPullRequestFiles({ owner, repo, token, prNumber });
  const protectedFiles = listProtectedFiles({ changedFiles, compiledPolicy });
  if (protectedFiles.length === 0) {
    return {
      prNumber,
      protectedFiles,
      approvalRequired: false,
      approved: true,
      approvedBy: [],
      stateByApprover: {},
    };
  }

  const [pullRequest, reviews, comments] = await Promise.all([
    getPullRequest({ owner, repo, token, prNumber }),
    listPullRequestReviews({ owner, repo, token, prNumber }),
    listPullRequestComments({ owner, repo, token, prNumber }),
  ]);
  const approval = summarizeApprovalStates({
    reviews,
    comments,
    headSha: pullRequest?.head?.sha,
    commentApprovalMarker: compiledPolicy.commentApprovalMarker,
    approverLogins: compiledPolicy.approverLogins,
  });

  return {
    prNumber,
    protectedFiles,
    approvalRequired: true,
    approved: approval.approved,
    approvedBy: approval.approvedBy,
    stateByApprover: approval.stateByApprover,
  };
}

function buildFailureMessage({ results, approverLogins, protectedDiffFiles }) {
  const lines = [
    `Control-plane changes require explicit approval from: ${approverLogins.map((login) => `@${login}`).join(', ')}.`,
    'Accepted approval signals: GitHub APPROVED review, or an owner-authored PR comment `control-plane-approve: <current-head-sha>`.',
  ];

  if (Array.isArray(protectedDiffFiles) && protectedDiffFiles.length) {
    lines.push(`Protected merge diff files: ${protectedDiffFiles.join(', ')}`);
  }

  for (const result of Array.isArray(results) ? results : []) {
    if (!result.approvalRequired || result.approved) continue;
    const states = Object.entries(result.stateByApprover || {})
      .map(([login, state]) => `@${login}=${state}`)
      .join(', ') || '<none>';
    lines.push(
      `PR #${result.prNumber} changes protected files (${result.protectedFiles.join(', ')}) but lacks owner approval (${states}).`,
    );
  }

  return lines.join('\n');
}

async function evaluateGate({
  owner,
  repo,
  token,
  eventName,
  eventPayload,
  compiledPolicy,
  explicitPrNumber = '',
}) {
  const name = String(eventName || '').trim();
  const branchRef = String(eventPayload?.pull_request?.base?.ref || eventPayload?.merge_group?.base_ref || '').replace(/^refs\/heads\//, '');
  const result = {
    eventName: name,
    baseRef: branchRef,
    protectedFiles: [],
    protectedDiffFiles: [],
    prNumbers: [],
    approvalRequired: false,
    approved: true,
    approverLogins: compiledPolicy.approverLogins,
    results: [],
  };

  if (name === 'pull_request' || explicitPrNumber) {
    const prNumber = Number(explicitPrNumber || eventPayload?.pull_request?.number || 0);
    if (!prNumber) throw new Error('Missing pull request number for control-plane review gate.');
    result.prNumbers = [prNumber];
    const prResult = await evaluateProtectedPullRequest({
      owner,
      repo,
      token,
      prNumber,
      compiledPolicy,
    });
    result.results = [prResult];
    result.protectedFiles = prResult.protectedFiles;
    result.approvalRequired = prResult.approvalRequired;
    result.approved = !prResult.approvalRequired || prResult.approved;
    return result;
  }

  if (name !== 'merge_group') {
    throw new Error(`Unsupported event for control-plane review gate: ${name || '<missing>'}`);
  }

  const baseSha = String(eventPayload?.merge_group?.base_sha || '').trim();
  const headSha = String(eventPayload?.merge_group?.head_sha || '').trim();
  result.protectedDiffFiles = listProtectedFiles({
    changedFiles: await listCompareFiles({ owner, repo, token, baseSha, headSha }),
    compiledPolicy,
  });
  if (result.protectedDiffFiles.length === 0) {
    return result;
  }

  const prNumbers = await resolveMergeGroupPrNumbers({ owner, repo, token, eventPayload });
  result.prNumbers = prNumbers;
  if (prNumbers.length === 0) {
    result.approvalRequired = true;
    result.approved = false;
    return result;
  }

  const prResults = [];
  for (const prNumber of prNumbers) {
    // eslint-disable-next-line no-await-in-loop
    prResults.push(await evaluateProtectedPullRequest({
      owner,
      repo,
      token,
      prNumber,
      compiledPolicy,
    }));
  }

  result.results = prResults;
  result.protectedFiles = Array.from(new Set(
    prResults.flatMap((entry) => Array.isArray(entry.protectedFiles) ? entry.protectedFiles : []),
  )).sort();
  result.approvalRequired = prResults.some((entry) => entry.approvalRequired) || result.protectedDiffFiles.length > 0;
  result.approved = prResults.every((entry) => !entry.approvalRequired || entry.approved);

  if (result.protectedDiffFiles.length > 0 && result.protectedFiles.length === 0) {
    result.approved = false;
  }

  return result;
}

function buildOutputs(summary) {
  const protectedFiles = Array.isArray(summary.protectedFiles) ? summary.protectedFiles : [];
  return {
    control_plane_changed: protectedFiles.length > 0 || (Array.isArray(summary.protectedDiffFiles) && summary.protectedDiffFiles.length > 0) ? '1' : '0',
    approval_required: summary.approvalRequired ? '1' : '0',
    approved: summary.approved ? '1' : '0',
    protected_files: protectedFiles.join(','),
    protected_files_count: String(protectedFiles.length),
    pr_numbers: (summary.prNumbers || []).join(','),
    approver_logins: (summary.approverLogins || []).join(','),
  };
}

async function main() {
  const args = parseArgs();
  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (!token) die('Missing GITHUB_TOKEN or GH_TOKEN.');

  const { owner, repo } = parseRepoSlug(process.env.GITHUB_REPOSITORY);
  if (!owner || !repo) die('Missing or invalid GITHUB_REPOSITORY (expected owner/repo).');

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) die('GITHUB_EVENT_PATH missing or unreadable.');
  const eventPayload = readJsonSafe(eventPath);
  if (!eventPayload) die('Failed to parse GitHub event payload.');

  const compiledPolicy = compileProtectedPolicy({ policyPath: args.policyPath });
  if (!compiledPolicy.approverLogins.length) {
    die('Control-plane protected-path policy has no owner approvers configured.');
  }

  const summary = await evaluateGate({
    owner,
    repo,
    token,
    eventName: process.env.GITHUB_EVENT_NAME,
    eventPayload,
    compiledPolicy,
    explicitPrNumber: args.prNumber,
  });

  const outputs = buildOutputs(summary);
  if (String(args.format || '').trim().toLowerCase() === 'github-output') {
    writeGithubOutput(outputs);
  } else {
    process.stdout.write(`${JSON.stringify({ ...summary, ...outputs }, null, 2)}\n`);
  }

  if (summary.approvalRequired && !summary.approved) {
    die(buildFailureMessage({
      results: summary.results,
      approverLogins: compiledPolicy.approverLogins,
      protectedDiffFiles: summary.protectedDiffFiles,
    }));
  }

  if (summary.approvalRequired) {
    console.log(`[control-plane-review-gate] Approval OK from ${compiledPolicy.approverLogins.map((login) => `@${login}`).join(', ')}.`);
    return;
  }

  console.log('[control-plane-review-gate] No protected control-plane changes detected.');
}

if (require.main === module) {
  main().catch((error) => die(error && error.message ? error.message : String(error)));
}

module.exports = {
  parseArgs,
  stripAt,
  normalizeApprovalMarker,
  globToRegex,
  compileProtectedPolicy,
  listProtectedFiles,
  latestReviewStateByLogin,
  summarizeApprovalStates,
  parsePrNumberFromMergeGroupHeadRef,
  buildFailureMessage,
  buildOutputs,
  evaluateGate,
};
