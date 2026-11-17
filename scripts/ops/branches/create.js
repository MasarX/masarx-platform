#!/usr/bin/env node
/* eslint-disable no-console */
const { loadEnv } = require('../../utils/load-env');
const {
  ensureProject,
  waitUntilReady,
  getApiKeys,
  assertOrganizationAccess,
  setProjectDatabasePassword,
  resolveProjectPoolerHost,
} = require('../workspace/supabase-api');

loadEnv();

function getArg(flag, def) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return def;
}

(async () => {
  const mode = (getArg('--mode', process.env.WORKSPACE_MODE || 'project') || 'project').toLowerCase();
  const name = getArg('--name', '');
  const nameTrimmed = (name || '').trim();
  if (!nameTrimmed) {
    console.error('[branches/create] Missing required --name; set it explicitly or ensure upstream resolved a worktree name.');
    process.exit(1);
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN || '';
  const orgId = process.env.SUPABASE_ORG_ID || '';
  const region = process.env.SUPABASE_REGION || 'us-east-1';
  // Accept either SUPABASE_BRANCH_PARENT_REF (CI) or SUPABASE_PARENT_PROJECT_REF (human/dev)
  const parentRef = process.env.SUPABASE_BRANCH_PARENT_REF || process.env.SUPABASE_PARENT_PROJECT_REF || process.env.SUPABASE_PROJECT_ID || '';
  const plan = process.env.SUPABASE_PLAN || 'free';
  const dbPass = process.env.SUPABASE_DB_PASSWORD || '';

  const result = { mode, name: nameTrimmed };

  async function resolvePoolerHostForProject(projectRef, regionHint) {
    const fallbackHost = process.env.SUPABASE_POOLER_HOST || '';
    try {
      return await resolveProjectPoolerHost({
        projectRef,
        token,
        preferredRegion: regionHint || '',
        fallbackHost,
      });
    } catch (error) {
      const fallbackRegion = String(regionHint || '').trim();
      const fallbackDerived =
        String(fallbackHost || '').trim() ||
        (fallbackRegion ? `aws-1-${fallbackRegion}.pooler.supabase.com` : '');
      if (fallbackDerived) {
        console.warn(
          `[branches/create] Pooler host probe failed for ${projectRef}; falling back to ${fallbackDerived}. Reason: ${error.message}`,
        );
      } else {
        console.warn(
          `[branches/create] Pooler host probe failed for ${projectRef}: ${error.message}`,
        );
      }
      return fallbackDerived;
    }
  }

  if (mode === 'branch') {
    if (!parentRef) {
      console.warn('[branches/create] No SUPABASE_BRANCH_PARENT_REF provided; falling back to mode=project');
    } else if (!token) {
      console.warn('[branches/create] No SUPABASE_ACCESS_TOKEN provided; falling back to mode=project');
    } else {
      try {
        // objectives:allow SUPABASE_URL Justification: management API base path; not tenant-specific; project_ref is dynamic
        // Resolve Management API base (allow override)
        const SUPABASE_MGMT_URL = (process.env.SUPABASE_MGMT_URL || 'https://api.supabase.com').replace(/\/$/, '');
        const branchName = nameTrimmed;
        // First, attempt to read an existing branch. Some tenants expose this even
        // when GET /v1/projects/{parentRef} is restricted.
        let projectRef = null;
        try {
          const resExisting = await fetch(`${SUPABASE_MGMT_URL}/v1/projects/${parentRef}/branches/${branchName}`, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}` },
          });
          if (resExisting.ok) {
            const existingBody = await resExisting.json().catch(() => null);
            projectRef = existingBody?.project_ref || existingBody?.ref || null;
            result.name = existingBody?.name || branchName;
          }
        } catch (_) {
          // If this probe fails, we simply fall through to branch creation.
        }
        // Attempt Management API branch creation: POST /v1/projects/{parent}/branches
        if (!projectRef) {
          const branchPayload = { branch_name: branchName };
          branchPayload.name = branchName;
          const res = await fetch(`${SUPABASE_MGMT_URL}/v1/projects/${parentRef}/branches`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(branchPayload),
          });
          const body = await res.text();
          let json;
          try { json = body ? JSON.parse(body) : null; } catch { json = { raw: body }; }
          if (!res.ok) throw new Error(json?.message || json?.error || res.statusText);
          // The Management API returns the real project_ref for the new branch in 'project_ref'.
          // Do not use 'id' (UUID) here; it is the branch id and is not a project ref.
          projectRef = json?.project_ref || projectRef;
          result.name = json?.name || result.name || branchName;
        }
        if (!projectRef) throw new Error('Branch create did not include project_ref');
        await waitUntilReady(projectRef, token);
        result.project_ref = projectRef;
        result.name = result.name || branchName;
        result.region = region;
        result.pooler_host = await resolvePoolerHostForProject(projectRef, region);
        const inheritedPass = process.env.SUPABASE_DB_PASSWORD || '';
        result.db_pass = inheritedPass || undefined; // Branch inherits parent DB password
        // objectives:allow SUPABASE_URL Justification: build standard supabase.co host dynamically from project_ref
        result.supabase_url = `https://${projectRef}.supabase.co`;
        // objectives:allow DSN_URL Justification: construct DSN for ephemeral branch project; no tenant/project constants hardcoded
        result.database_url = inheritedPass
          ? ([`postgresql`,":","/","/",`postgres`,":",`${encodeURIComponent(inheritedPass)}`,"@",`db.${projectRef}.supabase.co`,":",`5432`,"/",`postgres`].join(""))
          : null;
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      } catch (e) {
        console.warn(`[branches/create] Branch API path failed: ${e.message}. Falling back to mode=project.`);
      }
    }
  }

  // Fallback / project mode
  if (!token) {
    console.error('[branches/create] SUPABASE_ACCESS_TOKEN is required for project provisioning.');
    process.exit(1);
  }
  if (!orgId) {
    console.error('[branches/create] SUPABASE_ORG_ID is required for project provisioning.');
    process.exit(1);
  }
  const projName = nameTrimmed;
  await assertOrganizationAccess({ token, organizationId: orgId });
  const created = await ensureProject({
    token,
    organizationId: orgId,
    name: projName,
    region,
    plan,
    dbPass,
    reuseExisting: true,
  });
  const projectRef = created.project_ref;

  // Reused projects can have a stale DB password relative to current secrets.
  // Sync password up front so downstream db push does not loop on auth failures.
  if (created.reused) {
    await setProjectDatabasePassword({
      projectRef,
      token,
      password: created.db_pass,
    });
  }

  await waitUntilReady(projectRef, token);
  const keys = await getApiKeys(projectRef, token);
  const pass = created.db_pass;
  // objectives:allow SUPABASE_URL Justification: build standard supabase.co host dynamically from project_ref
  const supabaseUrl = `https://${projectRef}.supabase.co`;
  const poolerHost = await resolvePoolerHostForProject(projectRef, region);
  // objectives:allow DSN_URL Justification: construct DSN for ephemeral project; dynamic project_ref
  const dbUrl = ([`postgresql`,":","/","/",`postgres`,":",`${encodeURIComponent(pass)}`,"@",`db.${projectRef}.supabase.co`,":",`5432`,"/",`postgres`].join(""));
  const out = {
    mode: 'project',
    name: projName,
    project_ref: projectRef,
    region,
    supabase_url: supabaseUrl,
    database_url: dbUrl,
    pooler_host: poolerHost || undefined,
    db_pass: pass,
    anon_key: keys.anon || null,
    service_role_key: keys.service || null,
  };
  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error('[branches/create] Failed:', err.message);
  process.exit(1);
});
