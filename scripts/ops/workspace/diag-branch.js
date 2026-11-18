#!/usr/bin/env node
/* eslint-disable no-console */
const { loadEnv } = require('../../utils/load-env');

loadEnv();

async function main() {
  // objectives:allow SUPABASE_URL Justification: default Supabase Management API URL for diagnostics; actual projects/orgs resolved via configuration (org_id/project_ref)
  const base = (process.env.SUPABASE_MGMT_URL || 'https://api.supabase.com').replace(/\/$/, '');
  const token = process.env.SUPABASE_ACCESS_TOKEN || '';
  const parent = process.env.SUPABASE_BRANCH_PARENT_REF || process.env.SUPABASE_PARENT_PROJECT_REF || process.env.SUPABASE_PROJECT_ID || '';
  if (!token || !parent) {
    console.error('Missing token or parent');
    process.exit(1);
  }
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const name = `wk-diag-${Date.now()}`;
  console.log('Attempting branch create under', parent, 'as', name);
  const res = await fetch(`${base}/v1/projects/${parent}/branches`, { method: 'POST', headers, body: JSON.stringify({ branch_name: name }) });
  const body = await res.text();
  let j; try { j = body ? JSON.parse(body) : null; } catch { j = { raw: body }; }
  console.log('CREATE_STATUS =', res.status, res.statusText);
  console.log('CREATE_BODY =', (body || '').slice(0, 2000));
  if (!res.ok) {
    process.exit(1);
  }
  const branchId = String(j?.id || j?.branch_id || j?.branchId || '').trim();
  const projectRef = String(j?.project_ref || j?.projectRef || j?.ref || '').trim();
  console.log('BRANCH_ID =', branchId || '<missing>');
  console.log('PROJECT_REF =', projectRef || '<missing>');

  async function deleteWithRetries(fn, opts = {}) {
    const attempts = Math.max(1, Number(opts.attempts ?? 6));
    const intervalMs = Math.max(250, Number(opts.intervalMs ?? 10000));
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const ok = await fn({ attempt });
        if (ok) return true;
      } catch (e) {
        last = e;
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    if (last) throw last;
    return false;
  }

  let deleted = false;
  if (branchId) {
    try {
      deleted = await deleteWithRetries(async () => {
        const del = await fetch(`${base}/v1/branches/${encodeURIComponent(branchId)}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        });
        console.log('DELETE_BRANCH_STATUS =', del.status, del.statusText);
        if (del.ok) return true;
        if (del.status === 404) return true; // already gone
        if ([409, 425, 429, 500, 502, 503, 504].includes(del.status)) return false;
        const text = await del.text().catch(() => '');
        throw new Error(`delete branch failed: HTTP ${del.status} ${del.statusText} ${text}`.trim());
      });
    } catch (e) {
      console.warn('DELETE_BRANCH_ERROR =', e.message);
    }
  }

  // Fallback: attempt to delete the project directly when branch deletion is unavailable.
  if (!deleted && projectRef) {
    try {
      deleted = await deleteWithRetries(async () => {
        const del = await fetch(`${base}/v1/projects/${encodeURIComponent(projectRef)}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        });
        console.log('DELETE_PROJECT_STATUS =', del.status, del.statusText);
        if (del.ok) return true;
        if (del.status === 404) return true; // already gone
        if ([409, 425, 429, 500, 502, 503, 504].includes(del.status)) return false;
        const text = await del.text().catch(() => '');
        throw new Error(`delete project failed: HTTP ${del.status} ${del.statusText} ${text}`.trim());
      });
    } catch (e) {
      console.warn('DELETE_PROJECT_ERROR =', e.message);
    }
  }

  if (!deleted) {
    console.error('Cleanup failed: branch/project not deleted.');
    process.exit(1);
  }
}

main().catch(err => { console.error('diag-branch failed:', err.message); process.exit(1); });
