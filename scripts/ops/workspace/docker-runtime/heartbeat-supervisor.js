const fs = require('fs');
const path = require('path');

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthy(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runHeartbeatSupervisor(plan, leasePolicy, heartbeatFn, options = {}) {
  const intervalMs = parsePositiveInteger(
    options.intervalMs || options['interval-ms'],
    parsePositiveInteger(leasePolicy?.defaults?.heartbeat_ms, 120000),
  );
  const defaultDurationMs = parsePositiveInteger(leasePolicy?.defaults?.ttl_ms, 28800000);
  const once = isTruthy(options.once || options['once']);
  const durationMs = once
    ? 0
    : parsePositiveInteger(options.durationMs || options['duration-ms'], defaultDurationMs);
  const maxCycles = parsePositiveInteger(
    options.cycles,
    once ? 1 : Math.max(1, Math.ceil(durationMs / intervalMs)),
  );
  const startedAt = Date.now();
  const cycles = [];
  let exitReason = '';
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const heartbeat = heartbeatFn(plan, leasePolicy, { allowStatusErrors: true });
    const refreshedResources = heartbeat.filter((entry) => entry.heartbeat).map((entry) => entry.resource);
    const failedResources = heartbeat.filter((entry) => !entry.heartbeat).map((entry) => entry.resource);
    cycles.push({
      cycle: cycle + 1,
      at: new Date().toISOString(),
      refreshed_resources: refreshedResources,
      failed_resources: failedResources,
      lease_entry_count: heartbeat.length,
    });
    if (heartbeat.length === 0) {
      exitReason = 'no_owned_lane_leases_found';
      break;
    }
    if (cycle + 1 >= maxCycles) break;
    const elapsed = Date.now() - startedAt;
    if (durationMs > 0 && elapsed + intervalMs > durationMs) break;
    await sleep(intervalMs);
  }
  const failed = cycles.some((cycle) => cycle.failed_resources.length);
  const summary = {
    generated_at: new Date().toISOString(),
    status: exitReason === 'no_owned_lane_leases_found'
      ? 'stopped'
      : (failed ? 'partial' : 'refreshed'),
    workspace_id: plan.workspace_id,
    owner: plan.owner,
    compose_project_name: plan.compose_project_name,
    backend_project_id: plan.backend?.project_id || '',
    interval_ms: intervalMs,
    duration_ms: durationMs,
    once,
    exit_reason: exitReason,
    cycle_count: cycles.length,
    cycles,
  };
  const file = path.join(plan.artifacts.root, 'heartbeat-supervisor-summary.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { ...summary, summary_file: file };
}

module.exports = {
  runHeartbeatSupervisor,
};
