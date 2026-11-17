function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function leaseMatchesLane(plan = {}, lease = {}) {
  const resourceClass = String(lease.resource_class || '');
  const workspaceId = String(lease.details?.workspace_id || '');
  if (workspaceId && workspaceId === plan.workspace_id) return true;
  if (resourceClass === 'backend-supabase') {
    return String(lease.details?.project_id || '') === String(plan.backend?.project_id || '')
      || String(lease.details?.compose_project_name || '') === String(plan.backend?.compose_project_name || '');
  }
  if (String(lease.owner || '') !== String(plan.owner || '')) return false;
  const ports = new Set(Object.values(plan.ports || {}).map((port) => Number(port)).filter(Boolean));
  const leasePort = Number(lease.details?.port || lease.details?.host_port || lease.details?.target_port || 0);
  return ports.has(leasePort);
}

function buildLaneLeaseDoctor(plan = {}, runtimeDoctor = {}) {
  const leases = arrayValue(runtimeDoctor.status_snapshot?.leases || runtimeDoctor.leases)
    .filter((lease) => leaseMatchesLane(plan, lease));
  const laneFailures = [];
  const laneWarnings = [];
  for (const lease of leases) {
    const common = {
      lease_id: lease.id || '',
      resource_class: lease.resource_class || '',
      resource_key: lease.resource_key || '',
      runtime_status: lease.runtime_status || '',
      proof_capacity_status: lease.proof_capacity_status || '',
      owner_next_action: lease.owner_next_action || '',
    };
    if (lease.runtime_missing) laneFailures.push({ code: 'lane_runtime_missing_lease', ...common });
    if (lease.runtime_status === 'startup_pending') laneFailures.push({ code: 'lane_startup_pending_lease', ...common });
    if (lease.expired) laneFailures.push({ code: 'lane_expired_lease', ...common });
    if (lease.stale && lease.runtime_busy) laneWarnings.push({ code: 'lane_stale_runtime_active_lease', ...common });
    else if (lease.stale) laneWarnings.push({ code: 'lane_stale_metadata_only_lease', ...common });
  }
  const hostAdvisories = [
    ...arrayValue(runtimeDoctor.warnings),
    ...arrayValue(runtimeDoctor.failures).map((failure) => `runtime_doctor_failure:${failure}`),
  ].filter((warning) => {
    const text = String(warning || '');
    return !leases.some((lease) => (
      text.includes(String(lease.resource_key || '')) ||
      text.includes(String(lease.id || '')) ||
      (lease.details?.workspace_id && text.includes(String(lease.details.workspace_id)))
    ));
  });
  return {
    status: laneFailures.length ? 'failed' : (laneWarnings.length ? 'warning' : 'ok'),
    lane_failures: laneFailures,
    lane_warnings: laneWarnings,
    host_advisories: hostAdvisories,
    lane_leases: leases.map((lease) => ({
      lease_id: lease.id || '',
      resource_class: lease.resource_class || '',
      resource_key: lease.resource_key || '',
      owner: lease.owner || '',
      heartbeat_at: lease.heartbeat_at || '',
      runtime_status: lease.runtime_status || '',
      runtime_busy: lease.runtime_busy === true,
      stale: lease.stale === true,
      expired: lease.expired === true,
      runtime_missing: lease.runtime_missing === true,
      proof_capacity_status: lease.proof_capacity_status || '',
    })),
    summary: {
      workspace_id: plan.workspace_id || '',
      owner: plan.owner || '',
      lane_lease_count: leases.length,
      stale_runtime_active_lane_leases: laneWarnings.filter((item) => item.code === 'lane_stale_runtime_active_lease').length,
      stale_metadata_only_lane_leases: laneWarnings.filter((item) => item.code === 'lane_stale_metadata_only_lease').length,
      runtime_missing_lane_leases: laneFailures.filter((item) => item.code === 'lane_runtime_missing_lease').length,
      startup_pending_lane_leases: laneFailures.filter((item) => item.code === 'lane_startup_pending_lease').length,
      host_advisory_count: hostAdvisories.length,
    },
  };
}

module.exports = {
  buildLaneLeaseDoctor,
  leaseMatchesLane,
};
