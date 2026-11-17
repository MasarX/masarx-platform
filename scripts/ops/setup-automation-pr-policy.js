#!/usr/bin/env node
/**
 * setup-automation-pr-policy.js
 *
 * Configures repository variables required for the Automation PR Policy.
 *
 * Why:
 * - CI-generated PRs (plan archive, branch sync) are allowed to be planless, but
 *   only when strict policy checks pass.
 * - Main->dev sync PRs are risky (they can include any file changes), so they
 *   require an allowlisted PR author.
 *
 * This script keeps configuration dynamic and centralized via GitHub Actions vars.
 *
 * Usage:
 *   node scripts/ops/setup-automation-pr-policy.js
 *   node scripts/ops/setup-automation-pr-policy.js --actors "github-actions[bot],app/masarx-bot-app" --dry-run
 *   node scripts/ops/setup-automation-pr-policy.js --delete-legacy-keeper-var 1
 *
 * Token:
 *   Uses env GITHUB_TOKEN/GH_TOKEN (falls back to config/env/.env.cloud via loadEnv()).
 */
/* eslint-disable no-console */
const { loadEnv } = require('../utils/load-env');
const { toBool, autoDetectRepo, upsertVar, deleteVar, request } = require('./github-actions-vars');

loadEnv();

function parseArgs() {
  const out = {
    owner: '',
    repo: '',
    actors: '',
    includeTokenOwner: true,
    deleteLegacyKeeperVar: false,
    dryRun: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] || '');
    if (!a.startsWith('--')) continue;
    const k = a.replace(/^--/, '');
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    if (k === 'owner') out.owner = v;
    else if (k === 'repo') out.repo = v;
    else if (k === 'actors' || k === 'authors') out.actors = v;
    else if (k === 'include-token-owner') out.includeTokenOwner = toBool(v, true);
    else if (k === 'delete-legacy-keeper-var') out.deleteLegacyKeeperVar = toBool(v, false);
    else if (k === 'dry-run' || k === 'dry') out.dryRun = toBool(v, false);
  }
  return out;
}

function uniq(items) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const v = String(raw || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function parseAuthorsCsv(raw) {
  return String(raw || '')
    .split(/[,\s]+/g)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
}

async function fetchTokenOwnerLogin({ owner, repo, token }) {
  try {
    const res = await request('GET', '/user', null, token);
    if (res.status >= 200 && res.status < 300) {
      const data = JSON.parse(res.body || '{}');
      const login = String(data?.login || '').trim();
      if (login) return login;
    }
    // If token is an app token, /user may fail; treat as non-fatal.
    console.warn(`[automation-pr-policy:setup] Unable to resolve token owner login: ${res.status}`);
    return '';
  } catch (e) {
    console.warn(`[automation-pr-policy:setup] Token owner lookup failed: ${e.message}`);
    return '';
  }
}

async function main() {
  const args = parseArgs();
  const dryRun = Boolean(args.dryRun);

  let owner = String(args.owner || '').trim();
  let repo = String(args.repo || '').trim();
  if (!owner || !repo) {
    const inferred = autoDetectRepo();
    owner = owner || inferred.owner;
    repo = repo || inferred.repo;
  }

  if (!owner || !repo) {
    console.error('Usage: setup-automation-pr-policy --owner <owner> --repo <repo> [--dry-run]');
    process.exit(1);
  }

  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (!token && !dryRun) {
    console.error('[automation-pr-policy:setup] Missing GITHUB_TOKEN or GH_TOKEN in env (or config/env/.env.cloud).');
    process.exit(1);
  }

  const base = ['github-actions[bot]', ...parseAuthorsCsv(args.actors)];
  let tokenOwner = '';
  if (args.includeTokenOwner && token) {
    tokenOwner = await fetchTokenOwnerLogin({ owner, repo, token });
  }
  const authors = uniq([...base, tokenOwner]).sort((a, b) => a.localeCompare(b));
  const value = authors.join(',');

  console.log(`[automation-pr-policy:setup] Repo=${owner}/${repo}`);
  console.log(`[automation-pr-policy:setup] Setting AUTOMATION_PR_ALLOWED_ACTORS=${value}`);

  await upsertVar({ owner, repo, name: 'AUTOMATION_PR_ALLOWED_ACTORS', value, token, dryRun });
  // Backward-compat mirror for older workflows/scripts still reading *_AUTHORS.
  await upsertVar({ owner, repo, name: 'AUTOMATION_PR_ALLOWED_AUTHORS', value, token, dryRun });

  if (args.deleteLegacyKeeperVar) {
    await deleteVar({ owner, repo, name: 'PLAN_AUTOMATION_KEEPER_ID', token, dryRun });
  }

  console.log('[automation-pr-policy:setup] Done');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[automation-pr-policy:setup] Failed:', e && e.message ? e.message : String(e));
    process.exit(1);
  });
}

module.exports = {
  parseAuthorsCsv,
  uniq,
};
