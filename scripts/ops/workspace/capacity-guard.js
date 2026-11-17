#!/usr/bin/env node
/* eslint-disable no-console */
const { loadEnv } = require('../../utils/load-env');
const { resolvePreviewSupabaseConfig } = require('./preview-supabase-config');
function getSupabaseMgmtUrl() {
  // objectives:allow SUPABASE_URL Justification: default management endpoint; override via SUPABASE_MGMT_URL when needed
  return (process.env.SUPABASE_MGMT_URL || 'https://api.supabase.com').replace(/\/$/, '');
}

async function http(method, path, token) {
  const url = `${getSupabaseMgmtUrl()}${path}`;
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
  const txt = await res.text();
  let json; try { json = txt ? JSON.parse(txt) : null; } catch { json = { raw: txt }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}`);
  return json;
}

(async () => {
  loadEnv();
  const requirePreviewSecrets = process.env.GITHUB_ACTIONS === 'true' || process.env.REQUIRE_PREVIEW_SECRETS === '1';
  const cfg = resolvePreviewSupabaseConfig({ requirePreviewSecrets, required: ['token', 'orgId'] });
  if (cfg.missing.length) throw new Error(`Missing required preview Supabase config: ${cfg.missing.join(', ')}`);

  const token = cfg.token;
  const orgId = cfg.orgId;
  const maxActive = parseInt(process.env.WORKSPACE_MAX_ACTIVE || '0', 10); // 0 disables guard
  if (!maxActive) {
    console.log('[capacity-guard] WORKSPACE_MAX_ACTIVE unset or 0; skipping');
    return;
  }

  const all = await http('GET', `/v1/projects?organization_id=${encodeURIComponent(orgId)}`, token);
  const items = Array.isArray(all) ? all : (all?.projects || []);
  const active = items.filter(p => (p.name || '').toLowerCase().startsWith('wk-'));
  console.log(`[capacity-guard] active wk-* projects: ${active.length} (limit ${maxActive})`);
  if (active.length >= maxActive) {
    throw new Error(`Capacity exceeded: ${active.length} >= ${maxActive}`);
  }
})();
