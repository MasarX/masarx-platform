const fs = require('fs');
const path = require('path');

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runHeartbeatSupervisor(plan, leasePolicy, heartbeatFn, options = {}) {
  const intervalMs = parsePositiveInteger(options.intervalMs || options['interval-ms'], 120000);
  const durationMs = parsePositiveInteger(options.durationMs || options['duration-ms'], 0);
  const maxCycles = parsePositiveInteger(options.cycles, durationMs > 0 ? Math.max(1, Math.ceil(durationMs / intervalMs)) : 1);
  const startedAt = Date.now();
  const cycles = [];
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const heartbeat = heartbeatFn(plan, leasePolicy, { allowStatusErrors: true });
    cycles.push({
      cycle: cycle + 1,
      at: new Date().toISOString(),
      refreshed_resources: heartbeat.filter((entry) => entry.heartbeat).map((entry) => entry.resource),
      failed_resources: heartbeat.filter((entry) => !entry.heartbeat).map((entry) => entry.resource),
    });
    if (cycle + 1 >= maxCycles) break;
    const elapsed = Date.now() - startedAt;
    if (durationMs > 0 && elapsed + intervalMs > durationMs) break;
    await sleep(intervalMs);
  }
  const summary = {
    generated_at: new Date().toISOString(),
    status: cycles.some((cycle) => cycle.failed_resources.length) ? 'partial' : 'refreshed',
    workspace_id: plan.workspace_id,
    owner: plan.owner,
    compose_project_name: plan.compose_project_name,
    backend_project_id: plan.backend?.project_id || '',
    interval_ms: intervalMs,
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
