#!/usr/bin/env node
/* eslint-disable no-console */
const { loadEnv } = require('../../utils/load-env');
const { resolvePreviewSupabaseConfig } = require('./preview-supabase-config');
const { listProjects } = require('./supabase-api');

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

  const items = await listProjects({ token, organizationId: orgId });
  const active = items.filter(p => (p.name || '').toLowerCase().startsWith('wk-'));
  console.log(`[capacity-guard] active wk-* projects: ${active.length} (limit ${maxActive})`);
  if (active.length >= maxActive) {
    throw new Error(`Capacity exceeded: ${active.length} >= ${maxActive}`);
  }
})();
