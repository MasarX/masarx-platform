#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const {
  buildRuntimeLeaseDoctor,
  loadPolicy,
} = require('../runtime-leases/runtime-lease-system');

function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const [rawKey, ...inlineParts] = token.slice(2).split('=');
    const key = rawKey.trim();
    const alias = key.replace(/-/g, '_');
    let value = inlineParts.length ? inlineParts.join('=') : null;
    if (value == null) {
      const next = argv[index + 1];
      if (next == null || String(next).startsWith('--')) {
        value = '1';
      } else {
        value = String(next);
        index += 1;
      }
    }
    for (const target of Array.from(new Set([key, alias]))) {
      if (args[target] === undefined) args[target] = value;
      else if (Array.isArray(args[target])) args[target].push(value);
      else args[target] = [args[target], value];
    }
  }
  return args;
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isTruthy(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch (_) {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function resolveRegistryPath(cwd, options = {}) {
  const explicit = firstValue(options.registry || options['registry-path'] || options.registry_path);
  if (explicit) return path.resolve(cwd, explicit);
  const policyPath = path.resolve(cwd, 'config', 'ops', 'codex-os-v2-policy.json');
  const policy = readJsonSafe(policyPath) || {};
  const configured = String(policy.state_model?.local_registry_path || '.codex-local/masarx-os-v2/state.json').trim();
  return path.resolve(cwd, configured);
}

function runtimeSlotsFromDoctor(doctor = {}) {
  const lanes = doctor.summary?.parallel_capacity?.web_backend_lane_details;
  if (!Array.isArray(lanes)) return [];
  return lanes.map((lane) => ({
    owner: String(lane.owner || '').trim(),
    status: String(lane.status || '').trim(),
    backend_urls: Array.isArray(lane.backend_api_urls) ? lane.backend_api_urls : [],
    console_urls: Array.isArray(lane.console_urls) ? lane.console_urls : [],
    landing_urls: Array.isArray(lane.landing_urls) ? lane.landing_urls : [],
    wait_reasons: Array.isArray(lane.waiting_reasons) ? lane.waiting_reasons : [],
    runtime_classification: String(lane.runtime_classification || lane.status || '').trim(),
    full_runtime_ready: lane.full_runtime_ready === true,
    runtime_ready: lane.runtime_ready === true,
    proof_session_lease_ids: Array.isArray(lane.proof_session_lease_ids) ? lane.proof_session_lease_ids : [],
  }));
}

function liveRuntimeReadyCount(doctor = {}) {
  const summary = doctor.summary || {};
  const activeLeases = Number(summary.active_leases || 0);
  if (activeLeases <= 0) return 0;
  const runtimeReady = Number(summary.parallel_capacity?.runtime_ready_count || 0);
  if (Number.isFinite(runtimeReady) && runtimeReady > 0) return runtimeReady;
  const lanes = summary.parallel_capacity?.web_backend_lane_details;
  if (!Array.isArray(lanes)) return 0;
  return lanes.filter((lane) => lane.runtime_ready === true && lane.full_runtime_ready === true).length;
}

function buildRegistryRuntimeSnapshot(doctor = {}) {
  const runtimeReadyCount = liveRuntimeReadyCount(doctor);
  const activeLeases = Number(doctor.summary?.active_leases || 0);
  const expiredLeases = Number(doctor.summary?.expired_leases || 0);
  const staleLeases = Number(doctor.summary?.stale_leases || 0);
  const warnings = Array.isArray(doctor.warnings) ? doctor.warnings : [];
  const failures = Array.isArray(doctor.failures) ? doctor.failures : [];
  return {
    generated_at: String(doctor.generated_at || new Date().toISOString()),
    status: doctor.status || 'unknown',
    active_leases: activeLeases,
    expired_leases: expiredLeases,
    stale_leases: staleLeases,
    runtime_ready_count: runtimeReadyCount,
    host_allows_new_starts: doctor.summary?.parallel_capacity?.host_allows_new_starts !== false,
    proof_capacity_available: doctor.summary?.parallel_capacity?.proof_capacity_available === true,
    start_safety_blocker_count: Number(doctor.summary?.parallel_capacity?.start_safety_blocker_count || 0),
    warnings,
    failures,
    runtime_slots: runtimeSlotsFromDoctor(doctor),
  };
}

function reconcileRuntimeRegistry(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const registryPath = resolveRegistryPath(cwd, options);
  const init = isTruthy(firstValue(options.init));
  const dryRun = isTruthy(firstValue(options['dry-run'] || options.dry_run));
  const registryExists = fs.existsSync(registryPath);
  const existing = registryExists ? readJsonSafe(registryPath) : null;
  if (registryExists && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    return {
      command: 'runtime-registry-reconcile',
      generated_at: new Date().toISOString(),
      status: 'blocked',
      registry_path: registryPath,
      written: false,
      reason: 'registry_json_invalid',
    };
  }
  if (!registryExists && !init) {
    return {
      command: 'runtime-registry-reconcile',
      generated_at: new Date().toISOString(),
      status: 'missing_registry',
      registry_path: registryPath,
      written: false,
      next_action: 'registry missing; pass --init only when this checkout should own the local OS registry',
    };
  }
  const doctor = options.doctor || buildRuntimeLeaseDoctor(options.leasePolicy || loadPolicy({ cwd }), {
    cwd,
    'include-health': '1',
    'include-docker': '1',
    'include-process-pressure': '1',
  });
  const snapshot = buildRegistryRuntimeSnapshot(doctor);
  const previousReady = Number(existing?.runtime_ready_count || 0);
  const staleReadyInvalidated = previousReady > 0 && snapshot.runtime_ready_count === 0;
  const nextRegistry = {
    ...(existing || {
      version: 1,
      created_at: new Date().toISOString(),
      source: 'runtime-registry-reconcile',
    }),
    runtime_reconciled_at: snapshot.generated_at,
    runtime_doctor_latest: snapshot,
    runtime_ready_count: snapshot.runtime_ready_count,
    runtime_readiness_stale: staleReadyInvalidated,
    runtime_slots: snapshot.runtime_slots,
    current_runtime_slot_status: snapshot.runtime_ready_count > 0
      ? 'runtime_ready_live_doctor_verified'
      : 'runtime_not_ready_live_doctor_verified',
  };
  if (!dryRun) writeJson(registryPath, nextRegistry);
  return {
    command: 'runtime-registry-reconcile',
    generated_at: new Date().toISOString(),
    status: staleReadyInvalidated ? 'stale_ready_invalidated' : 'reconciled',
    registry_path: registryPath,
    written: !dryRun,
    dry_run: dryRun,
    previous_runtime_ready_count: previousReady,
    runtime_ready_count: snapshot.runtime_ready_count,
    runtime_doctor_latest: snapshot,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const payload = reconcileRuntimeRegistry(args);
  if (isTruthy(args.json)) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`[runtime-registry-reconcile] status=${payload.status} ready=${payload.runtime_ready_count ?? 'n/a'} registry=${payload.registry_path}`);
  }
  if (payload.status === 'blocked') process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  buildRegistryRuntimeSnapshot,
  liveRuntimeReadyCount,
  parseArgs,
  reconcileRuntimeRegistry,
  resolveRegistryPath,
  runtimeSlotsFromDoctor,
};
