/**
 * scripts/utils/gh-cli.js
 *
 * Shared helper for GitHub CLI-backed environment/variable setup scripts.
 * Keep this as SSOT to avoid copy/pasting fragile `gh` invocation logic across ops scripts.
 */
/* eslint-disable no-console */
const { spawnSync } = require('child_process');

function gh(args, opts = {}) {
  return spawnSync('gh', args, { encoding: 'utf8', ...opts });
}

function ensureGhAuth() {
  const res = gh(['auth', 'status']);
  if (res.status === 0) return;

  // `gh auth status` can fail on workstations with stale keyring metadata even
  // though the CLI can still execute authenticated API calls via another valid
  // credential source. Fall back to a cheap authenticated probe before failing
  // closed so audit/ops scripts key off real API capability, not keyring drift.
  const probe = gh(['api', 'user', '--jq', '.login']);
  if (probe.status === 0) return;

  throw new Error('gh auth status failed. Login with `gh auth login` (or set GH_TOKEN/GITHUB_TOKEN).');
}

function getRepoSlugFromGitRemote() {
  const res = spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error('Unable to read git remote origin URL');
  const url = String(res.stdout || '').trim();
  const m = url.match(/github\.com[:/](.+?)\/(.+?)(\.git)?$/i);
  if (!m) throw new Error(`Unsupported remote URL: ${url}`);
  return `${m[1]}/${m[2]}`;
}

function parseTabList(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);

  const out = {};
  for (const line of lines) {
    // Format: NAME<TAB>VALUE<TAB>UPDATED_AT
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const key = String(parts[0] || '').trim();
    const value = String(parts[1] || '').trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

function listRepoVariables(repo) {
  const res = gh(['variable', 'list', '--repo', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    throw new Error(`Failed to list repo variables: ${(res.stderr || '').trim() || res.status}`);
  }
  return parseTabList(res.stdout);
}

function listEnvVariables(repo, envName) {
  const res = gh(['variable', 'list', '--repo', repo, '--env', envName], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    throw new Error(`Failed to list variables for env=${envName}: ${(res.stderr || '').trim() || res.status}`);
  }
  return parseTabList(res.stdout);
}

function setRepoVariable(repo, key, value, { dryRun }) {
  const v = String(value == null ? '' : value);
  if (!v.trim()) throw new Error(`Refusing to set empty repo variable: ${key}`);
  if (dryRun) {
    console.log(`[gh-cli] (dry-run) set repo variable ${key}`);
    return;
  }
  const res = gh(['variable', 'set', key, '--repo', repo], {
    input: v,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(`Failed to set repo variable ${key}: ${(res.stderr || '').trim() || res.status}`);
  }
  console.log(`[gh-cli] Set repo variable ${key}`);
}

function setEnvVariable(repo, envName, key, value, { dryRun }) {
  const v = String(value == null ? '' : value);
  if (!v.trim()) throw new Error(`Refusing to set empty variable: ${envName}:${key}`);
  if (dryRun) {
    console.log(`[gh-cli] (dry-run) set variable ${envName}:${key}`);
    return;
  }
  const res = gh(['variable', 'set', key, '--repo', repo, '--env', envName], {
    input: v,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(`Failed to set variable ${envName}:${key}: ${(res.stderr || '').trim() || res.status}`);
  }
  console.log(`[gh-cli] Set variable ${envName}:${key}`);
}

function parseReviewerLogins(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return text
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('@') ? s.slice(1) : s))
    .filter(Boolean);
}

function resolveUserReviewerEntries(logins, { dryRun }) {
  const uniq = Array.from(new Set((Array.isArray(logins) ? logins : []).filter(Boolean)));
  if (uniq.length === 0) return [];

  if (dryRun) return uniq.map((login) => ({ type: 'User', id: 0, login }));

  const out = [];
  for (const login of uniq) {
    const res = gh(['api', `users/${login}`, '--jq', '.id']);
    if (res.status !== 0) {
      throw new Error(
        `Failed to resolve GitHub user id for @${login}: ${(res.stderr || res.stdout || '').trim() || res.status}`,
      );
    }
    const id = parseInt(String(res.stdout || '').trim(), 10);
    if (!id) throw new Error(`Invalid GitHub user id for @${login}`);
    out.push({ type: 'User', id });
  }
  return out;
}

function normalizeAllowedBranches(input) {
  const raw = Array.isArray(input) ? input : [];
  return raw
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}

function buildEnvironmentUpsertBody({
  reviewers,
  allowedBranches = [],
  canAdminsBypass,
  preventSelfReview,
} = {}) {
  const allow = normalizeAllowedBranches(allowedBranches);

  // GitHub requires exactly one of: protected_branches=true OR custom_branch_policies=true.
  // Use custom branch policies when explicit allowed branches are provided (e.g., allow `dev` for dev envs).
  const deploymentBranchPolicy =
    allow.length > 0
      ? { protected_branches: false, custom_branch_policies: true }
      : { protected_branches: true, custom_branch_policies: false };

  const body = {
    deployment_branch_policy: deploymentBranchPolicy,
    ...(Array.isArray(reviewers) ? { reviewers } : {}),
  };

  if (typeof canAdminsBypass === 'boolean') {
    body.can_admins_bypass = canAdminsBypass;
  }
  if (Array.isArray(reviewers) && reviewers.length && typeof preventSelfReview === 'boolean') {
    body.prevent_self_review = preventSelfReview;
  }

  return body;
}

function listDeploymentBranchPolicies(repo, envName) {
  const res = gh(['api', `repos/${repo}/environments/${envName}/deployment-branch-policies`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    throw new Error(
      `Failed to list deployment branch policies for env=${envName}: ${(res.stderr || res.stdout || '').trim() || res.status}`,
    );
  }
  try {
    const parsed = JSON.parse(String(res.stdout || '').trim() || '{}');
    return Array.isArray(parsed.branch_policies) ? parsed.branch_policies : [];
  } catch {
    return [];
  }
}

function ensureDeploymentBranchPolicies(repo, envName, allowedBranches, { dryRun }) {
  const allow = normalizeAllowedBranches(allowedBranches);
  if (allow.length === 0) return;

  if (dryRun) {
    console.log(`[gh-cli] (dry-run) ensure ${envName} deployment branches: ${allow.join(', ')}`);
    return;
  }

  const existing = listDeploymentBranchPolicies(repo, envName).map((p) => String(p?.name || '').trim()).filter(Boolean);
  const existingSet = new Set(existing);

  for (const branch of allow) {
    if (existingSet.has(branch)) continue;
    const res = gh(
      ['api', '-X', 'POST', `repos/${repo}/environments/${envName}/deployment-branch-policies`, '--input', '-'],
      {
        input: JSON.stringify({ name: branch, type: 'branch' }),
      },
    );
    if (res.status !== 0) {
      throw new Error(
        `Failed to create deployment branch policy env=${envName} name=${branch}: ${(res.stderr || res.stdout || '').trim() || res.status}`,
      );
    }
    console.log(`[gh-cli] Ensured deployment branch policy: ${envName}:${branch}`);
  }
}

function ensureGithubEnvironment(
  repo,
  envName,
  {
    dryRun,
    reviewers = [],
    allowedBranches = [],
    canAdminsBypass,
    preventSelfReview,
  } = {},
) {
  const body = buildEnvironmentUpsertBody({
    reviewers,
    allowedBranches,
    canAdminsBypass,
    preventSelfReview,
  });
  const allow = normalizeAllowedBranches(allowedBranches);

  if (dryRun) {
    console.log(
      `[gh-cli] (dry-run) ensure GitHub environment: ${envName}${Array.isArray(reviewers) && reviewers.length ? ` (reviewers=${reviewers.length})` : ''}`,
    );
    return;
  }

  const res = gh(['api', '-X', 'PUT', `repos/${repo}/environments/${envName}`, '--input', '-'], {
    input: JSON.stringify(body),
  });
  if (res.status !== 0) {
    throw new Error(
      `Failed to ensure GitHub environment '${envName}': ${(res.stderr || res.stdout || '').trim() || res.status}`,
    );
  }
  console.log(`[gh-cli] Ensured GitHub environment: ${envName}`);

  if (allow.length > 0) {
    ensureDeploymentBranchPolicies(repo, envName, allow, { dryRun });
  }
}

module.exports = {
  gh,
  ensureGhAuth,
  getRepoSlugFromGitRemote,
  listRepoVariables,
  listEnvVariables,
  setRepoVariable,
  setEnvVariable,
  parseReviewerLogins,
  resolveUserReviewerEntries,
  buildEnvironmentUpsertBody,
  ensureGithubEnvironment,
};
