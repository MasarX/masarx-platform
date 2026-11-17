#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const { isWorkflowActionVersionOnlyPatch } = require('./automation-pr-policy');

function die(message) {
  console.error(`[dependency-fast-lane-integrity] ${message}`);
  process.exit(1);
}

function parseRepo(full) {
  const raw = String(full || '').trim();
  const match = /^([^/]+)\/([^/]+)$/.exec(raw);
  return match ? { owner: match[1], repo: match[2] } : { owner: '', repo: '' };
}

function readEventJson() {
  const file = String(process.env.GITHUB_EVENT_PATH || '').trim();
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function resolvePrNumber(evt) {
  const envValue = Number.parseInt(String(process.env.PR_NUMBER || '').trim(), 10);
  if (Number.isFinite(envValue) && envValue > 0) return envValue;
  const payloadValue = Number.parseInt(String(evt?.pull_request?.number || evt?.number || '').trim(), 10);
  if (Number.isFinite(payloadValue) && payloadValue > 0) return payloadValue;
  return 0;
}

async function ghRequestJson({ token, url }) {
  const bearer = String(token || '').trim();
  if (!bearer) throw new Error('GITHUB_TOKEN missing');
  const response = await fetch(String(url || '').trim(), {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${bearer}`,
      'user-agent': 'masarx-dependency-fast-lane-integrity',
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub API ${response.status} (${url}): ${text || response.statusText}`);
  }
  return response.json();
}

async function listPullRequestFiles({ owner, repo, prNumber, token }) {
  const out = [];
  let page = 1;
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const data = await ghRequestJson({
      token,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    });
    const batch = Array.isArray(data) ? data : [];
    for (const row of batch) {
      const filename = String(row?.filename || '').trim();
      if (!filename) continue;
      out.push({
        filename,
        status: String(row?.status || '').trim(),
        patch: typeof row?.patch === 'string' ? row.patch : '',
      });
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

function isPackageManifest(fileName) {
  return /(^|\/)package\.json$/i.test(String(fileName || '').trim());
}

function isLockFile(fileName) {
  return /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?)$/i.test(
    String(fileName || '').trim(),
  );
}

function isWorkflowFile(fileName) {
  return /^\.github\/workflows\/.+\.ya?ml$/i.test(String(fileName || '').trim());
}

function parseChangedWorkflowUses(patch) {
  const entries = [];
  const lines = String(patch || '').split('\n');
  for (const rawLine of lines) {
    const line = String(rawLine || '');
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const value = String(line.slice(1) || '').trim().replace(/\s+#.*$/, '');
    const match = /^uses:\s*['"]?([^'"\s]+)['"]?$/i.exec(value);
    if (!match) continue;
    entries.push(match[1]);
  }
  return entries;
}

function isPinnedWorkflowActionReference(reference) {
  const value = String(reference || '').trim();
  if (!value) return false;
  if (value.startsWith('./')) return true;
  if (value.startsWith('docker://')) {
    return /@sha256:[a-f0-9]{64}$/i.test(value);
  }
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[a-f0-9]{40}$/i.test(value);
}

function validateDependencyIntegrity(files) {
  const list = Array.isArray(files) ? files : [];
  const packageManifests = list.filter((row) => isPackageManifest(row.filename));
  const lockFiles = list.filter((row) => isLockFile(row.filename));
  const workflowViolations = [];
  const unpinnedWorkflowUses = [];

  for (const row of list) {
    if (!isWorkflowFile(row.filename)) continue;
    if (!isWorkflowActionVersionOnlyPatch(row.patch || '')) {
      workflowViolations.push(row.filename);
      continue;
    }
    const changedUses = parseChangedWorkflowUses(row.patch || '');
    if (changedUses.some((entry) => !isPinnedWorkflowActionReference(entry))) {
      unpinnedWorkflowUses.push(row.filename);
    }
  }

  const errors = [];
  if (packageManifests.length > 0 && lockFiles.length === 0) {
    errors.push('package.json changed without a lockfile update.');
  }
  if (workflowViolations.length > 0) {
    errors.push(`workflow changes are not action-version-only: ${workflowViolations.join(', ')}`);
  }
  if (unpinnedWorkflowUses.length > 0) {
    errors.push(
      `workflow action updates must pin external actions to full SHAs or docker digests: ${unpinnedWorkflowUses.join(', ')}`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    package_manifest_count: packageManifests.length,
    lock_file_count: lockFiles.length,
    workflow_file_count: list.filter((row) => isWorkflowFile(row.filename)).length,
  };
}

function writeGithubOutput(summary) {
  const outputFile = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputFile) return;
  const rows = [
    ['ok', summary.ok ? '1' : '0'],
    ['package_manifest_count', String(summary.package_manifest_count)],
    ['lock_file_count', String(summary.lock_file_count)],
    ['workflow_file_count', String(summary.workflow_file_count)],
  ];
  fs.appendFileSync(outputFile, rows.map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 'utf8');
}

async function main() {
  const event = readEventJson() || {};
  const prNumber = resolvePrNumber(event);
  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  const repoFull = String(process.env.GITHUB_REPOSITORY || '').trim();
  const { owner, repo } = parseRepo(repoFull);

  if (!prNumber || !owner || !repo || !token) {
    die('Missing PR context (pr_number/repository/token).');
  }

  const files = await listPullRequestFiles({ owner, repo, prNumber, token });
  const summary = validateDependencyIntegrity(files);
  writeGithubOutput(summary);

  if (!summary.ok) {
    die(summary.errors.join(' '));
  }
}

if (require.main === module) {
  // eslint-disable-next-line promise/catch-or-return
  main().catch((error) => die(error && error.message ? error.message : String(error)));
}

module.exports = {
  validateDependencyIntegrity,
  isPackageManifest,
  isLockFile,
  isWorkflowFile,
  parseChangedWorkflowUses,
  isPinnedWorkflowActionReference,
};
