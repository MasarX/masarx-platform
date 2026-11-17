#!/usr/bin/env node
/**
 * migrate-deploy-env-vars.js
 *
 * Purpose:
 *   Move non-sensitive deploy configuration from GitHub Environment *secrets*
 *   to GitHub Environment *variables* for dev/stg/prod.
 *
 * Why:
 *   - Secrets should be reserved for sensitive values (tokens/keys/passwords).
 *   - Non-sensitive identifiers (project ref, URL, region, org id, flags) belong in vars.
 *
 * What it does:
 *   - Resolves Supabase project refs by name: <prefix>-dev|stg|prod
 *   - Fetches the Supabase anon key via the Management API (token required).
 *   - Sets env-scoped GitHub variables:
 *       SUPABASE_PROJECT_ID, SUPABASE_URL, SUPABASE_ANON_KEY,
 *       SUPABASE_REGION, SUPABASE_ORG_ID, SUPABASE_POOLER_HOST, SUPABASE_POOLER_PORT,
 *       EDGE_REQUIRE_DB_JWT, (and PROD_DEPLOY_GUARD for prod)
 *   - Optionally deletes the old env-scoped secrets for those keys.
 *
 * Notes:
 *   - Secret values are never printed.
 *   - This does NOT change sensitive secrets (service role key, access token, DB password).
 *
 * Usage:
 *   node scripts/ops/migrate-deploy-env-vars.js --dry-run
 *   node scripts/ops/migrate-deploy-env-vars.js --delete-secrets
 *   node scripts/ops/migrate-deploy-env-vars.js --envs dev,stg,prod --project-prefix masarx_2.0
 */
/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const { loadEnv } = require('../utils/load-env');
const { listProjects, getApiKeys } = require('./workspace/supabase-api');

function die(msg) {
  console.error(`[migrate-env-vars] ${msg}`);
  process.exit(1);
}

function parseArgs() {
  const out = {
    repo: '',
    projectPrefix: '',
    envs: ['dev', 'stg', 'prod'],
    dryRun: false,
    deleteSecrets: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--repo') out.repo = argv[++i] || '';
    else if (a.startsWith('--repo=')) out.repo = a.split('=').slice(1).join('=');
    else if (a === '--project-prefix') out.projectPrefix = argv[++i] || '';
    else if (a.startsWith('--project-prefix=')) out.projectPrefix = a.split('=').slice(1).join('=');
    else if (a === '--envs') out.envs = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--envs=')) out.envs = a.split('=').slice(1).join('=').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dry-run' || a === '--dry') out.dryRun = true;
    else if (a === '--delete-secrets' || a === '--delete') out.deleteSecrets = true;
  }
  return out;
}

function gh(args, opts = {}) {
  return spawnSync('gh', args, { encoding: 'utf8', ...opts });
}

function ensureGhAuth() {
  const res = gh(['auth', 'status']);
  if (res.status === 0) return;
  die('gh auth status failed. Login with `gh auth login` (or set GH_TOKEN/GITHUB_TOKEN).');
}

function getRepoSlugFromGitRemote() {
  const res = spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
  if (res.status !== 0) die('Unable to read git remote origin URL');
  const url = String(res.stdout || '').trim();
  const m = url.match(/github\.com[:/](.+?)\/(.+?)(\.git)?$/i);
  if (!m) die(`Unsupported remote URL: ${url}`);
  return `${m[1]}/${m[2]}`;
}

function setEnvVariable(repo, envName, key, value, { dryRun }) {
  const v = String(value == null ? '' : value);
  if (!v.trim()) die(`Refusing to set empty variable: ${envName}:${key}`);
  if (dryRun) {
    console.log(`[migrate-env-vars] (dry-run) set variable ${envName}:${key}`);
    return;
  }
  const res = gh(['variable', 'set', key, '--repo', repo, '--env', envName], {
    input: v,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    die(`Failed to set variable ${envName}:${key}: ${(res.stderr || '').trim() || res.status}`);
  }
  console.log(`[migrate-env-vars] Set variable ${envName}:${key}`);
}

function deleteEnvSecretViaApi(repo, envName, key, { dryRun }) {
  const ownerRepo = String(repo || '').trim();
  if (!ownerRepo.includes('/')) die(`Invalid repo slug: ${repo}`);
  const [owner, repoName] = ownerRepo.split('/', 2);
  const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/environments/${encodeURIComponent(envName)}/secrets/${encodeURIComponent(key)}`;
  if (dryRun) {
    console.log(`[migrate-env-vars] (dry-run) delete secret ${envName}:${key}`);
    return;
  }
  const res = gh(['api', '-X', 'DELETE', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status === 0) {
    console.log(`[migrate-env-vars] Deleted secret ${envName}:${key}`);
    return;
  }
  const err = (res.stderr || res.stdout || '').trim();
  die(`Failed to delete secret ${envName}:${key}: ${err || res.status}`);
}

function expectedProjectName(projectPrefix, envName) {
  const prefix = String(projectPrefix || '').trim();
  if (!prefix) return '';
  if (envName === 'dev') return `${prefix}-dev`;
  if (envName === 'stg') return `${prefix}-stg`;
  if (envName === 'prod') return `${prefix}-prod`;
  return `${prefix}-${envName}`;
}

function resolveGitHubEnvironmentName(stage) {
  if (stage === 'dev') return 'db-dev';
  if (stage === 'stg') return 'db-stg';
  if (stage === 'prod') return 'db-prod';
  return stage;
}

async function main() {
  loadEnv();
  const args = parseArgs();
  ensureGhAuth();

  const repo = String(args.repo || '').trim() || getRepoSlugFromGitRemote();
  const repoName = repo.split('/').pop() || '';
  const projectPrefix = String(args.projectPrefix || '').trim() || repoName;

  const token = String(process.env.SUPABASE_ACCESS_TOKEN || '').trim();
  const orgId = String(process.env.SUPABASE_ORG_ID || '').trim();
  if (!token) die('Missing SUPABASE_ACCESS_TOKEN in ENV_FILE');
  if (!orgId) die('Missing SUPABASE_ORG_ID in ENV_FILE');

  const projects = await listProjects({ token, organizationId: orgId });

  const poolerHostFallback = String(process.env.SUPABASE_POOLER_HOST || '').trim();
  const poolerPort = String(process.env.SUPABASE_POOLER_PORT || '5432').trim();
  const edgeRequireDbJwt = String(process.env.EDGE_REQUIRE_DB_JWT || '1').trim();

  const envs = (Array.isArray(args.envs) ? args.envs : []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!envs.length) die('No environments specified (use --envs dev,stg,prod)');

  console.log(`[migrate-env-vars] Repo=${repo} Prefix=${projectPrefix} Envs=${envs.join(',')} DryRun=${args.dryRun ? '1' : '0'} DeleteSecrets=${args.deleteSecrets ? '1' : '0'}`);

  for (const envName of envs) {
    const ghEnvName = resolveGitHubEnvironmentName(envName);
    const expectedName = expectedProjectName(projectPrefix, envName);
    if (!expectedName) die('Unable to determine expected Supabase project name');

    const p = projects.find((proj) => String(proj?.name || '').trim() === expectedName) || null;
    if (!p) {
      const available = projects.map((proj) => String(proj?.name || '').trim()).filter(Boolean).sort();
      die(`Supabase project not found: name='${expectedName}'. Available sample: ${available.slice(0, 10).join(', ')}`);
    }

    const projectRef = String(p.ref || p.project_ref || p.id || '').trim();
    const region = String(p.region || process.env.SUPABASE_REGION || '').trim();
    if (!projectRef) die(`Missing project ref for ${envName} (${expectedName})`);
    if (!region) die(`Missing region for ${envName} (${expectedName})`);

    // objectives:allow SUPABASE_URL Justification: derive canonical Supabase URL from dynamic project ref during GitHub env migration
    const supabaseUrl = `https://${projectRef}.supabase.co`;
    const poolerHost = poolerHostFallback || `aws-1-${region}.pooler.supabase.com`;

    const keys = await getApiKeys(projectRef, token, { preferModern: true });
    const anonKey = String(keys?.anon || '').trim();
    if (!anonKey) die(`Unable to fetch anon key for ${envName} (${projectRef})`);

    setEnvVariable(repo, ghEnvName, 'SUPABASE_PROJECT_ID', projectRef, args);
    setEnvVariable(repo, ghEnvName, 'SUPABASE_URL', supabaseUrl, args);
    setEnvVariable(repo, ghEnvName, 'SUPABASE_ANON_KEY', anonKey, args);
    setEnvVariable(repo, ghEnvName, 'SUPABASE_REGION', region, args);
    setEnvVariable(repo, ghEnvName, 'SUPABASE_ORG_ID', orgId, args);
    setEnvVariable(repo, ghEnvName, 'SUPABASE_POOLER_HOST', poolerHost, args);
    setEnvVariable(repo, ghEnvName, 'SUPABASE_POOLER_PORT', poolerPort, args);
    setEnvVariable(repo, ghEnvName, 'EDGE_REQUIRE_DB_JWT', edgeRequireDbJwt, args);

    if (envName === 'prod') {
      setEnvVariable(repo, ghEnvName, 'PROD_DEPLOY_GUARD', 'enabled', args);
    }

    if (args.deleteSecrets) {
      const keysToDelete = [
        'SUPABASE_PROJECT_ID',
        'SUPABASE_URL',
        'SUPABASE_ANON_KEY',
        'SUPABASE_REGION',
        'SUPABASE_ORG_ID',
        'SUPABASE_POOLER_HOST',
        'SUPABASE_POOLER_PORT',
        'EDGE_REQUIRE_DB_JWT',
      ];
      if (envName === 'prod') keysToDelete.push('PROD_DEPLOY_GUARD');

      for (const k of keysToDelete) {
        deleteEnvSecretViaApi(repo, ghEnvName, k, args);
      }
    }
  }

  console.log('[migrate-env-vars] Done.');
}

main().catch((err) => die(err.message || String(err)));
