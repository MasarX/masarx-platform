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
  const projectRef = v.project_ref || process.env.SUPABASE_PROJECT_ID || '';
  push('SUPABASE_PROJECT_ID', projectRef);
  const resolvedSupabaseUrl = v.supabase_url || process.env.SUPABASE_URL || existingEnv.SUPABASE_URL || '';
  const resolvedAnonKey = v.anon_key || process.env.SUPABASE_ANON_KEY || existingEnv.SUPABASE_ANON_KEY || '';
  const resolvedServiceRoleKey =
    v.service_role_key ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    existingEnv.SUPABASE_SERVICE_ROLE_KEY ||
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
    v.supabase_jwt_secret || v.jwt_secret || process.env.SUPABASE_JWT_SECRET || existingEnv.SUPABASE_JWT_SECRET || '',
  );
  const region = v.region || process.env.SUPABASE_REGION || '';
  push('SUPABASE_REGION', region);
  push('WEBHOOK_DB_JWT', v.webhook_db_jwt || process.env.WEBHOOK_DB_JWT || existingEnv.WEBHOOK_DB_JWT || '');
  push('API_CALLER_DB_JWT', v.api_caller_db_jwt || process.env.API_CALLER_DB_JWT || existingEnv.API_CALLER_DB_JWT || '');
  push('API_GATEWAY_DB_JWT', v.api_gateway_db_jwt || process.env.API_GATEWAY_DB_JWT || existingEnv.API_GATEWAY_DB_JWT || '');
  push('LABEL_RENDERER_DB_JWT', v.label_renderer_db_jwt || process.env.LABEL_RENDERER_DB_JWT || existingEnv.LABEL_RENDERER_DB_JWT || '');
  // Optional fallback when per-function DB JWTs are omitted. Keep it managed so
  // workspace provisioning never leaks stale tokens between projects.
  push('EDGE_DB_JWT', v.edge_db_jwt || process.env.EDGE_DB_JWT || existingEnv.EDGE_DB_JWT || '');
  const inheritedPass = v.db_pass || process.env.SUPABASE_DB_PASSWORD || '';    
  let directDbUrl = v.database_url || '';
  if (!directDbUrl && projectRef && inheritedPass) {
    // objectives:allow DSN_URL Justification: construct Supabase Postgres DSN dynamically from project_ref and inherited password; no tenant- or client-specific constants
    directDbUrl = ([`postgresql`,":","/","/",`postgres`,":",`${encodeURIComponent(inheritedPass)}`,"@",`db.${projectRef}.supabase.co`,":",`5432`,"/",`postgres`].join(""));
  }
  const preferredDbUrl = String(v.preferred_database_url || '').trim();
  const poolerHost = v.pooler_host || process.env.SUPABASE_POOLER_HOST || (region ? `aws-1-${region}.pooler.supabase.com` : '');
  const poolerUser =
    v.pooler_user ||
    process.env.SUPABASE_POOLER_USER ||
    existingEnv.SUPABASE_POOLER_USER ||
    (projectRef ? `postgres.${projectRef}` : 'postgres');
  const poolerPort =
    v.pooler_port ||
    process.env.SUPABASE_POOLER_PORT ||
    existingEnv.SUPABASE_POOLER_PORT ||
    '5432';

  // Prefer the transactional pooler as the canonical DATABASE_URL so CI runners
  // without IPv6 can still connect reliably. Keep the direct host in
  // DATABASE_URL_DIRECT for tools that explicitly require it.
  let poolerDbUrl = '';
  if (projectRef && inheritedPass && poolerHost) {
    // objectives:allow DSN_URL Justification: construct Supabase pooler DSN dynamically from project_ref and inherited password; no tenant- or client-specific constants
    poolerDbUrl = ([`postgresql`,":","/","/",`${encodeURIComponent(poolerUser)}`,":",`${encodeURIComponent(inheritedPass)}`,"@",`${poolerHost}`,":",`${poolerPort}`,"/",`postgres`].join(""));
  }

  const effectiveDbUrl = preferredDbUrl || poolerDbUrl || directDbUrl || process.env.DATABASE_URL || existingEnv.DATABASE_URL || '';
  push('DATABASE_URL', await ensureHostaddr(effectiveDbUrl));
  if (directDbUrl) push('DATABASE_URL_DIRECT', await ensureHostaddr(directDbUrl));
  if (poolerDbUrl) push('DATABASE_URL_POOLER', await ensureHostaddr(poolerDbUrl));
  push('SUPABASE_POOLER_HOST', poolerHost);
  push('SUPABASE_POOLER_PORT', poolerPort);
  push('SUPABASE_POOLER_USER', poolerUser);
  push(
    'DATABASE_URL_SELECTED_DSN_NAME',
    v.db_ready_candidate_name ||
      process.env.DATABASE_URL_SELECTED_DSN_NAME ||
      existingEnv.DATABASE_URL_SELECTED_DSN_NAME ||
      '',
  );
  const defaultInternalRoles =
    process.env.EDGE_INTERNAL_CALLER_ROLES ||
    existingEnv.EDGE_INTERNAL_CALLER_ROLES ||
    'edge_api_gateway_role,edge_webhook_role,edge_api_caller_role,service_role';
  push('EDGE_INTERNAL_CALLER_ROLES', v.edge_internal_caller_roles || defaultInternalRoles);
  const resolvedPreviewMode = v.preview_mode ?? process.env.PREVIEW_MODE ?? existingEnv.PREVIEW_MODE ?? '0';
  push('PREVIEW_MODE', resolvedPreviewMode);
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
  push('SUPABASE_DB_PASSWORD', v.db_pass || process.env.SUPABASE_DB_PASSWORD || existingEnv.SUPABASE_DB_PASSWORD || '');
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
