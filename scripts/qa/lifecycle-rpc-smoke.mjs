#!/usr/bin/env node
// lifecycle-rpc-smoke.mjs — minimal 12-phase RPC smoke probe via api.* wrappers.
//
// Runs the same probe set as the W40 lifecycle-rpc-smoke-v2.log evidence so
// W41-pivot-A can confirm:
//   - F5 (assign_pickup_wave_v1 404) is fixed by the api.* schema wrappers
//     introduced in commit e2a821690.
//   - All 12 RPCs are reachable through the api.* schema (200/4xx semantic).
//
// Usage:
//   ENV_FILE=config/env/.env.local node scripts/qa/lifecycle-rpc-smoke.mjs
//
// The script reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from env. RPCs are
// expected to fail with semantic 4xx (auth-required, validation, not-found by
// id) since we run anonymously without seeded fixtures — that's the live-wired
// signal we need.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const envFile = process.env.ENV_FILE || 'config/env/.env.local';
if (existsSync(envFile)) {
  const text = readFileSync(envFile, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL + service-role/anon key required');
  process.exit(2);
}

const phases = [
  ['marketing_landing_clients_list_v1', {}, 'public landing read'],
  ['ui_command_registry_v1', {}, 'command catalog read'],
  ['ui_dashboard_config_v1', {}, 'navigation config read'],
  ['ui_access_policy_v1', {}, 'RLS-driven access read'],
  ['ui_create_shipment_v1', { p_client_id: '00000000-0000-0000-0000-000000000000' }, 'shipment intake'],
  ['ui_create_workflow_template_v1', { p_name: 'W41-pivot-A Verify Template' }, 'workflow def'],
  ['ui_start_workflow_run_v1', { p_workflow_template_id: '00000000-0000-0000-0000-000000000000' }, 'workflow dispatch'],
  ['ui_apply_route_plan_v1', { p_input: { route_plan_id: '00000000-0000-0000-0000-000000000000' } }, 'route apply'],
  ['ui_confirm_route_run_departure_v1', { p_input: {} }, 'fleet dispatch'],
  // assign_pickup_wave_v1: W41 F5 wrapper signature is (p_input jsonb) — single
  // unnamed jsonb param. Underlying public.assign_pickup_wave_v1 also takes p_input.
  ['assign_pickup_wave_v1', { p_input: { wave_id: '00000000-0000-0000-0000-000000000000', driver_id: '00000000-0000-0000-0000-000000000000' } }, 'wave assignment (W41 F5 closure)'],
  ['ui_log_event_v1', { p_app: 'console', p_event: { kind: 'smoke' } }, 'telemetry'],
  ['ui_delete_resource_v1', { p_resource: 'shipments', p_id: '00000000-0000-0000-0000-000000000000' }, 'generic delete'],
];

const summary = { total: 0, live_wired: 0, not_found_404: 0, network_error: 0, by_http: {} };
const log = [];
function record(name, http, ms, body, hint) {
  summary.total++;
  summary.by_http[http] = (summary.by_http[http] || 0) + 1;
  if (http === 404) summary.not_found_404++;
  else if (typeof http === 'number') summary.live_wired++;
  else summary.network_error++;
  const idx = String(summary.total).padStart(2, '0');
  const line = [
    `Phase ${idx}: ${name} (${hint})`,
    `  http=${http} ms=${ms}`,
    `  body=${(body || '').slice(0, 320)}`,
    '',
  ].join('\n');
  log.push(line);
  console.log(line);
}

for (const [rpc, args, hint] of phases) {
  const t0 = Date.now();
  let http = 'ERR';
  let body = '';
  try {
    const res = await fetch(`${url}/rest/v1/rpc/${rpc}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(args),
    });
    http = res.status;
    body = await res.text();
  } catch (err) {
    body = String(err);
  }
  record(rpc, http, Date.now() - t0, body, hint);
}

const summaryBlock = '\n=== SUMMARY ===\n' + JSON.stringify(summary, null, 2) + '\n';
log.push(summaryBlock);
console.log(summaryBlock);

const out = process.env.LIFECYCLE_RPC_SMOKE_LOG;
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `[load-env] Using ENV_FILE=${envFile}\n\n` + log.join('\n'));
  console.log(`Wrote ${out}`);
}
