#!/usr/bin/env node
/* eslint-disable no-console */
const { loadEnv } = require('../../utils/load-env');

loadEnv();

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return '';
}

function die(msg) {
  console.error(`[delete-branch] ${msg}`);
  process.exit(1);
}

async function main() {
  // objectives:allow SUPABASE_URL Justification: default Supabase Management API URL for operational cleanup; actual resources resolved via configuration
  const base = (process.env.SUPABASE_MGMT_URL || 'https://api.supabase.com').replace(/\/$/, '');
  const token = String(process.env.SUPABASE_ACCESS_TOKEN || '').trim();
  const id = String(getArg('--id') || '').trim();

  if (!token) die('Missing SUPABASE_ACCESS_TOKEN');
  if (!id) die('Missing --id');

  const res = await fetch(`${base}/v1/branches/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });

  if (res.ok || res.status === 404) {
    console.log(`[delete-branch] Deleted (or already missing) branch id=${id} status=${res.status}`);
    return;
  }

  const text = await res.text().catch(() => '');
  die(`HTTP ${res.status} ${res.statusText}: ${text}`.trim());
}

main().catch((err) => die(err.message));

