#!/usr/bin/env node
/* eslint-disable no-console */
const { loadEnv } = require('../../utils/load-env');

loadEnv();

async function main() {
  // objectives:allow SUPABASE_URL Justification: default Supabase Management API URL for diagnostics; actual resources resolved via org/project configuration
  const SUPABASE_MGMT_URL = (process.env.SUPABASE_MGMT_URL || 'https://api.supabase.com').replace(/\/$/, '');
  const token = process.env.SUPABASE_ACCESS_TOKEN || '';
  const orgId = process.env.SUPABASE_ORG_ID || '';
  const parent = process.env.SUPABASE_BRANCH_PARENT_REF || process.env.SUPABASE_PARENT_PROJECT_REF || process.env.SUPABASE_PROJECT_ID || '';
  console.log('MGMT_URL =', SUPABASE_MGMT_URL);
  console.log('ORG_ID   =', orgId || '<empty>');
  console.log('PARENT   =', parent || '<empty>');
  if (!token) {
    console.error('Token missing: SUPABASE_ACCESS_TOKEN');
    process.exit(1);
  }
  if (!orgId) {
    console.error('Org missing: SUPABASE_ORG_ID');
    process.exit(1);
  }
  if (!parent) {
    console.error('Parent missing: SUPABASE_PARENT_PROJECT_REF or SUPABASE_BRANCH_PARENT_REF or SUPABASE_PROJECT_ID');
    process.exit(1);
  }
  const headers = { authorization: `Bearer ${token}` };
  try {
    const list = await fetch(`${SUPABASE_MGMT_URL}/v1/projects?organization_id=${encodeURIComponent(orgId)}`, { headers });
    const listTxt = await list.text();
    let listJson; try { listJson = listTxt ? JSON.parse(listTxt) : null; } catch { listJson = { raw: listTxt }; }
    let items = Array.isArray(listJson) ? listJson : (listJson?.projects || []);
    const ids = items.map(p => p.ref || p.id || p.project_ref).filter(Boolean);
    console.log('LIST_STATUS =', list.status, list.statusText, 'COUNT =', ids.length);
    console.log('LIST_SAMPLE =', ids.slice(0, 5));
    console.log('PARENT_IN_LIST =', ids.includes(parent));
  } catch (e) {
    console.error('LIST_ERROR:', e.message);
  }
  try {
    const pr = await fetch(`${SUPABASE_MGMT_URL}/v1/projects/${parent}`, { headers });
    const body = await pr.text();
    let j; try { j = body ? JSON.parse(body) : null; } catch { j = { raw: body }; }
    console.log('GET_PARENT_STATUS =', pr.status, pr.statusText);
    console.log('PARENT_NAME =', j?.name || '');
    console.log('PARENT_REGION =', j?.region || '');
    console.log('PARENT_STATUS =', (j?.status || j?.project_status || ''));
  } catch (e) {
    console.error('GET_PARENT_ERROR:', e.message);
  }
}

main().catch(err => { console.error('diag failed:', err.message); process.exit(1); });
