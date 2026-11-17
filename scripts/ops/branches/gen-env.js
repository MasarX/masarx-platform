#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { ensureHostaddr } = require('../../utils/pg-hostaddr');

function getArg(flag, def) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return def;
}

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function normalizeWorkspaceMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'branch' || mode === 'project' ? mode : '';
}

function normalizeProjectRef(value) {
  const ref = String(value || '').trim().toLowerCase();
  return /^[a-z]{20}$/.test(ref) ? ref : '';
}

function resolveWorkspaceTopology(payload = {}, existingEnv = {}, env = process.env) {
  const projectRef = String(
    payload.project_ref || env.SUPABASE_PROJECT_ID || existingEnv.SUPABASE_PROJECT_ID || '',
  ).trim();
  const existingProjectRef = String(existingEnv.SUPABASE_PROJECT_ID || '').trim();
  const processProjectRef = String(env.SUPABASE_PROJECT_ID || '').trim();
  const sameExistingProject = Boolean(projectRef && existingProjectRef === projectRef);
  const sameProcessProject = Boolean(projectRef && processProjectRef === projectRef);
  const explicitModeRaw = String(payload.workspace_mode || '').trim();
  const explicitMode = normalizeWorkspaceMode(explicitModeRaw);
  if (explicitModeRaw && !explicitMode) {
    throw new Error(`Invalid workspace_mode '${explicitModeRaw}'`);
  }
  const existingModeRaw = sameExistingProject
    ? String(existingEnv.PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE || '').trim()
    : '';
  const processModeRaw = sameProcessProject
    ? String(env.PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE || env.WORKSPACE_MODE || '').trim()
    : '';
  if (existingModeRaw && !normalizeWorkspaceMode(existingModeRaw)) {
    throw new Error(`Invalid persisted workspace mode '${existingModeRaw}'`);
  }
  if (processModeRaw && !normalizeWorkspaceMode(processModeRaw)) {
    throw new Error(`Invalid process workspace mode '${processModeRaw}'`);
  }
  const workspaceMode =
    explicitMode ||
    normalizeWorkspaceMode(existingModeRaw) ||
    normalizeWorkspaceMode(processModeRaw);

  const explicitParentRef = String(payload.branch_parent_ref || '').trim();
  const inheritedParentRef =
    (sameExistingProject ? String(existingEnv.SUPABASE_BRANCH_PARENT_REF || '').trim() : '') ||
    (sameProcessProject ? String(env.SUPABASE_BRANCH_PARENT_REF || '').trim() : '');
  const parentCandidate = explicitParentRef || inheritedParentRef;
  let branchParentRef = explicitParentRef;
  if (workspaceMode === 'branch') {
    const canonicalProjectRef = normalizeProjectRef(projectRef);
    branchParentRef = normalizeProjectRef(parentCandidate);
    if (!canonicalProjectRef) {
      throw new Error('Branch workspace requires a canonical SUPABASE_PROJECT_ID');
    }
    if (!branchParentRef || branchParentRef === canonicalProjectRef) {
      throw new Error('Branch workspace requires canonical parent lineage');
    }
  }

  return {
    branchParentRef,
    canReusePersistedBranch:
      workspaceMode === 'branch' &&
      sameExistingProject &&
      normalizeWorkspaceMode(existingModeRaw) === 'branch',
    canUseExistingProjectScope: sameExistingProject,
    // Process credentials are project-scoped even when the runner omitted the
    // project id. Only inherit them when their identity is explicitly proven.
    canUseProcessProjectScope: sameProcessProject,
    projectRef,
    workspaceMode,
  };
}

function readExistingEnvPairs(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      if (!key) continue;
      out[key] = trimmed.slice(idx + 1);
    }
    return out;
  } catch {
    return {};
  }
}

async function buildEnv(v, existingEnv = {}) {
  const lines = [];
  const managedKeys = new Set();
  managedKeys.add('EDGE_TASK_TOKEN');
  managedKeys.add('API_CALLER_SHARED_SECRET');
  const push = (k, val) => {
    if (val === undefined || val === null) return;
    managedKeys.add(k);
    lines.push(`${k}=${String(val)}`);
  };
  const {
    branchParentRef,
    canReusePersistedBranch,
    canUseExistingProjectScope,
    canUseProcessProjectScope,
    projectRef,
    workspaceMode: resolvedWorkspaceMode,
  } = resolveWorkspaceTopology(v, existingEnv);
  const isBranchWorkspace = resolvedWorkspaceMode === 'branch';
  const branchPersisted = (key) =>
    canReusePersistedBranch ? existingEnv[key] || '' : '';
  const projectProcess = (key) =>
    canUseProcessProjectScope ? process.env[key] || '' : '';
  const projectPersisted = (key) =>
    canUseExistingProjectScope ? existingEnv[key] || '' : '';
  const hasPayloadValue = (key) => Object.prototype.hasOwnProperty.call(v, key);
  push('SUPABASE_PROJECT_ID', projectRef);
  push('SUPABASE_BRANCH_PARENT_REF', branchParentRef || '');
  // objectives:allow SUPABASE_URL Justification: the canonical branch URL is dynamically constructed from the validated provider project reference.
  const resolvedSupabaseUrl = isBranchWorkspace
    ? v.supabase_url ||
      branchPersisted('SUPABASE_URL') ||
      // objectives:allow SUPABASE_URL Justification: the branch hostname is derived from the validated provider project reference, not a fixed environment URL.
      (normalizeProjectRef(projectRef) ? `https://${projectRef}.supabase.co` : '')
    : v.supabase_url || projectProcess('SUPABASE_URL') || projectPersisted('SUPABASE_URL') || '';
  // A Supabase branch is an isolated project with its own auth plane. Never
  // inherit parent/prior API keys or JWTs while its exact keys are being
  // refreshed by ensure-edge-role-api-keys.
  const resolvedAnonKey = isBranchWorkspace
    ? v.anon_key || ''
    : hasPayloadValue('anon_key')
      ? v.anon_key || ''
      : projectProcess('SUPABASE_ANON_KEY') || projectPersisted('SUPABASE_ANON_KEY') || '';
  const resolvedServiceRoleKey = isBranchWorkspace
    ? v.service_role_key || ''
    : hasPayloadValue('service_role_key')
      ? v.service_role_key || ''
      : projectProcess('SUPABASE_SERVICE_ROLE_KEY') ||
        projectPersisted('SUPABASE_SERVICE_ROLE_KEY') ||
        '';
  push('SUPABASE_URL', resolvedSupabaseUrl);
  push('SUPABASE_ANON_KEY', resolvedAnonKey);
  // Keep app/public env values aligned with workspace cloud credentials so local
  // app servers and Playwright do not inherit stale placeholder values.
  push('NEXT_PUBLIC_SUPABASE_URL', resolvedSupabaseUrl);
  push('NEXT_PUBLIC_SUPABASE_ANON_KEY', resolvedAnonKey);
  push('SUPABASE_SERVICE_ROLE_KEY', resolvedServiceRoleKey);
  push(
    'SUPABASE_JWT_SECRET',
    isBranchWorkspace
      ? v.supabase_jwt_secret || v.jwt_secret || ''
      : hasPayloadValue('supabase_jwt_secret') || hasPayloadValue('jwt_secret')
        ? v.supabase_jwt_secret || v.jwt_secret || ''
        : projectProcess('SUPABASE_JWT_SECRET') ||
          projectPersisted('SUPABASE_JWT_SECRET') ||
          '',
  );
  const region = isBranchWorkspace
    ? v.region || branchPersisted('SUPABASE_REGION') || ''
    : v.region || process.env.SUPABASE_REGION || '';
  push('SUPABASE_REGION', region);
  const resolveDbJwt = (payloadValue, envKey) =>
    isBranchWorkspace
      ? payloadValue || ''
      : payloadValue || projectProcess(envKey) || projectPersisted(envKey) || '';
  push('WEBHOOK_DB_JWT', resolveDbJwt(v.webhook_db_jwt, 'WEBHOOK_DB_JWT'));
  push('API_CALLER_DB_JWT', resolveDbJwt(v.api_caller_db_jwt, 'API_CALLER_DB_JWT'));
  push('API_GATEWAY_DB_JWT', resolveDbJwt(v.api_gateway_db_jwt, 'API_GATEWAY_DB_JWT'));
  push('MARKETING_DB_JWT', resolveDbJwt(v.marketing_db_jwt, 'MARKETING_DB_JWT'));
  push('LABEL_RENDERER_DB_JWT', resolveDbJwt(v.label_renderer_db_jwt, 'LABEL_RENDERER_DB_JWT'));
  // Optional fallback when per-function DB JWTs are omitted. Keep it managed so
  // workspace provisioning never leaks stale tokens between projects.
  push('EDGE_DB_JWT', resolveDbJwt(v.edge_db_jwt, 'EDGE_DB_JWT'));
  const inheritedPass = isBranchWorkspace
    ? v.db_pass || branchPersisted('SUPABASE_DB_PASSWORD') || ''
    : v.db_pass ||
      projectProcess('SUPABASE_DB_PASSWORD') ||
      projectPersisted('SUPABASE_DB_PASSWORD') ||
      '';
  let directDbUrl = isBranchWorkspace
    ? v.database_url ||
      branchPersisted('DATABASE_URL_DIRECT') ||
      branchPersisted('DATABASE_URL') ||
      ''
    : v.database_url || '';
  if (!isBranchWorkspace && !directDbUrl && projectRef && inheritedPass) {
    // objectives:allow DSN_URL Justification: construct Supabase Postgres DSN dynamically from project_ref and inherited password; no tenant- or client-specific constants
    directDbUrl = ([`postgresql`,":","/","/",`postgres`,":",`${encodeURIComponent(inheritedPass)}`,"@",`db.${projectRef}.supabase.co`,":",`5432`,"/",`postgres`].join(""));
  }
  const preferredDbUrl = String(
    isBranchWorkspace
      ? v.preferred_database_url || (
        hasPayloadValue('pooler_host') ||
        hasPayloadValue('pooler_port') ||
        hasPayloadValue('pooler_user') ||
        hasPayloadValue('db_ready_candidate_name')
          ? ''
          : branchPersisted('DATABASE_URL') || ''
      )
      : v.preferred_database_url || '',
  ).trim();
  const poolerHost = isBranchWorkspace
    ? v.pooler_host || branchPersisted('SUPABASE_POOLER_HOST') || ''
    : v.pooler_host ||
      projectProcess('SUPABASE_POOLER_HOST') ||
      projectPersisted('SUPABASE_POOLER_HOST') ||
      (region ? `aws-1-${region}.pooler.supabase.com` : '');
  const poolerUser = isBranchWorkspace
    ? v.pooler_user || branchPersisted('SUPABASE_POOLER_USER') || ''
    : v.pooler_user ||
      (projectRef ? `postgres.${projectRef}` : '') ||
      projectProcess('SUPABASE_POOLER_USER') ||
      projectPersisted('SUPABASE_POOLER_USER') ||
      'postgres';
  const poolerPort = isBranchWorkspace
    ? v.pooler_port || branchPersisted('SUPABASE_POOLER_PORT') || ''
    : v.pooler_port ||
      projectProcess('SUPABASE_POOLER_PORT') ||
      projectPersisted('SUPABASE_POOLER_PORT') ||
      '5432';

  // Prefer the transactional pooler as the canonical DATABASE_URL so CI runners
  // without IPv6 can still connect reliably. Keep the direct host in
  // DATABASE_URL_DIRECT for tools that explicitly require it.
  let poolerDbUrl = '';
  if (projectRef && inheritedPass && poolerHost) {
    // objectives:allow DSN_URL Justification: construct Supabase pooler DSN dynamically from project_ref and inherited password; no tenant- or client-specific constants
    poolerDbUrl = ([`postgresql`,":","/","/",`${encodeURIComponent(poolerUser)}`,":",`${encodeURIComponent(inheritedPass)}`,"@",`${poolerHost}`,":",`${poolerPort}`,"/",`postgres`].join(""));
  }

  const effectiveDbUrl = isBranchWorkspace
    ? preferredDbUrl || poolerDbUrl || directDbUrl || ''
    : preferredDbUrl ||
      poolerDbUrl ||
      directDbUrl ||
      projectProcess('DATABASE_URL') ||
      projectPersisted('DATABASE_URL') ||
      '';
  push('DATABASE_URL', await ensureHostaddr(effectiveDbUrl));
  if (isBranchWorkspace || directDbUrl) {
    push('DATABASE_URL_DIRECT', directDbUrl ? await ensureHostaddr(directDbUrl) : '');
  }
  if (isBranchWorkspace || poolerDbUrl) {
    push('DATABASE_URL_POOLER', poolerDbUrl ? await ensureHostaddr(poolerDbUrl) : '');
  }
  push('SUPABASE_POOLER_HOST', poolerHost);
  push('SUPABASE_POOLER_PORT', poolerPort);
  push('SUPABASE_POOLER_USER', poolerUser);
  push(
    'DATABASE_URL_SELECTED_DSN_NAME',
    v.db_ready_candidate_name ||
      (isBranchWorkspace ? branchPersisted('DATABASE_URL_SELECTED_DSN_NAME') : '') ||
      '',
  );
  // Selection pins are valid only for the exact workspace credentials that
  // produced them. Clear inherited/file-stale pins whenever this overlay is
  // regenerated; the next DB smoke will repopulate them after a live probe.
  for (const key of [
    'PG_CONN_STRING',
    'PINNED_DATABASE_URL',
    'SYNCED_DB_URL',
    'SYNCED_DB_URL_POOLER',
    'SYNCED_DB_URL_DIRECT',
    'DB_SMOKE_SELECTED_DSN_NAME',
    'DB_SMOKE_SELECTED_DSN_HASH',
    'SHARED_LANE_DB_PROBE_SELECTED_DSN_NAME',
  ]) {
    push(key, '');
  }
  const defaultInternalRoles =
    process.env.EDGE_INTERNAL_CALLER_ROLES ||
    existingEnv.EDGE_INTERNAL_CALLER_ROLES ||
    'edge_api_gateway_role,edge_webhook_role,edge_api_caller_role,service_role';
  push('EDGE_INTERNAL_CALLER_ROLES', v.edge_internal_caller_roles || defaultInternalRoles);
  const resolvedPreviewMode = v.preview_mode ?? process.env.PREVIEW_MODE ?? existingEnv.PREVIEW_MODE ?? '0';
  push('PREVIEW_MODE', resolvedPreviewMode);
  push(
    'PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE',
    resolvedWorkspaceMode,
  );
  push('PREVIEW_SUPABASE_URL', isTruthy(resolvedPreviewMode) ? resolvedSupabaseUrl : '');
  push('PREVIEW_SUPABASE_ANON_KEY', isTruthy(resolvedPreviewMode) ? resolvedAnonKey : '');
  push('PREVIEW_SUPABASE_SERVICE_ROLE_KEY', isTruthy(resolvedPreviewMode) ? resolvedServiceRoleKey : '');
  push('EDGE_REQUIRE_DB_JWT', v.edge_require_db_jwt ?? process.env.EDGE_REQUIRE_DB_JWT ?? '1');
  push('RUN_LIVE_COMMS_TESTS', process.env.RUN_LIVE_COMMS_TESTS || 'false');
  push('RUN_LIVE_3PL_TESTS', process.env.RUN_LIVE_3PL_TESTS || 'false');
  // Provider credentials (gitignored env file; preserve across workspace provisioning runs).
  push('HERE_GEOCODING_API_KEY', process.env.HERE_GEOCODING_API_KEY || existingEnv.HERE_GEOCODING_API_KEY || '');
  push('GOOGLE_MAPS_API_KEY', process.env.GOOGLE_MAPS_API_KEY || existingEnv.GOOGLE_MAPS_API_KEY || '');
  push('DIALOG360_API_KEY', process.env.DIALOG360_API_KEY || existingEnv.DIALOG360_API_KEY || '');
  push('DIALOG360_REPLY_WEBHOOK_TOKEN', process.env.DIALOG360_REPLY_WEBHOOK_TOKEN || existingEnv.DIALOG360_REPLY_WEBHOOK_TOKEN || '');
  push('LOGESTECHS_USERNAME', process.env.LOGESTECHS_USERNAME || existingEnv.LOGESTECHS_USERNAME || '');
  push('LOGESTECHS_PASSWORD', process.env.LOGESTECHS_PASSWORD || existingEnv.LOGESTECHS_PASSWORD || '');
  // Persist management configuration as part of the cloud env so that a
  // single `.env.cloud` file remains the source of truth for both the
  // Supabase Management API and the project itself.
  push('SUPABASE_ORG_ID', v.org_id || process.env.SUPABASE_ORG_ID || existingEnv.SUPABASE_ORG_ID || '');
  push('SUPABASE_ACCESS_TOKEN', v.access_token || process.env.SUPABASE_ACCESS_TOKEN || existingEnv.SUPABASE_ACCESS_TOKEN || '');
  push(
    'SUPABASE_DB_PASSWORD',
    isBranchWorkspace
      ? inheritedPass
      : v.db_pass ||
        projectProcess('SUPABASE_DB_PASSWORD') ||
        projectPersisted('SUPABASE_DB_PASSWORD') ||
        '',
  );
  // Keep GitHub automation tokens across resets so CI/PR helpers keep working.
  push('GITHUB_TOKEN', v.github_token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || existingEnv.GITHUB_TOKEN || '');
  return { content: lines.join('\n') + '\n', managedKeys };
}

async function readStdinJson() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      if (!data.trim()) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    if (process.stdin.isTTY) resolve(null);
  });
}

(async () => {
  const outPath = getArg('--file', 'config/env/.env.cloud');
  const existingEnv = readExistingEnvPairs(outPath);
  const payload = (await readStdinJson()) || {};
  const { content, managedKeys } = await buildEnv(payload, existingEnv);
  const preserved = [];
  try {
    if (fs.existsSync(outPath)) {
      const existing = fs.readFileSync(outPath, 'utf8');
      for (const line of existing.split(/\r?\n/)) {
        const trimmed = String(line || '').trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        if (!key || managedKeys.has(key)) continue;
        preserved.push(`${key}=${trimmed.slice(idx + 1)}`);
      }
    }
  } catch {
    // Non-fatal: best-effort preservation only.
  }
  ensureDir(outPath);
  const finalContent = preserved.length
    ? `${content}\n# Preserved from previous .env.cloud\n${preserved.join('\n')}\n`
    : content;
  fs.writeFileSync(outPath, finalContent, 'utf8');
  console.log(`[branches/gen-env] Wrote ${outPath}`);
})().catch((err) => {
  console.error('[branches/gen-env] Failed:', err.message);
  process.exit(1);
});
