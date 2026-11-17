const fs = require('fs');
const path = require('path');
const { resolveGitMetadata } = require('./git-metadata');

function splitList(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => splitList(entry));
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildMatrixLaneSpecs(args = {}) {
  const explicit = splitList(args['workspace-ids'] || args.workspace_ids);
  const laneCount = explicit.length || parsePositiveInteger(args.lanes, 3);
  const workspacePrefix = String(args['workspace-prefix'] || args.workspace_prefix || 'wk-docker-matrix').trim();
  const ownerPrefix = String(args['owner-prefix'] || args.owner_prefix || args.owner || 'codex/docker-matrix').trim();
  return Array.from({ length: laneCount }, (_entry, index) => {
    const suffix = String.fromCharCode(97 + index);
    const workspace = explicit[index] || `${workspacePrefix}-${suffix}`;
    return {
      index,
      workspace,
      owner: `${ownerPrefix}-${suffix}`,
      peer_workspaces: [],
    };
  }).map((lane, _index, lanes) => ({
    ...lane,
    peer_workspaces: lanes.filter((peer) => peer.workspace !== lane.workspace).map((peer) => peer.workspace),
  }));
}

function matrixCommand(baseCommand, lane, args = {}) {
  const common = [
    '--',
    '--owner', lane.owner,
    '--workspace-id', lane.workspace,
    '--web', String(args.web || 'console,landing,portal'),
    '--mobile-v2-web',
  ];
  if (lane.peer_workspaces.length && ['test', 'doctor'].includes(baseCommand)) {
    common.push('--peer-workspaces', lane.peer_workspaces.join(','));
  }
  if (args['artifact-root'] || args.artifact_root) {
    common.push('--artifact-root', String(args['artifact-root'] || args.artifact_root));
  }
  const backendTimeoutMs = args['backend-timeout-ms'] || args.backend_timeout_ms;
  if (backendTimeoutMs && ['up', 'down'].includes(baseCommand)) {
    common.push('--backend-timeout-ms', String(backendTimeoutMs));
  }
  return `npm run runtime:docker:${baseCommand} ${common.join(' ')}`;
}

function buildDockerRuntimeMatrixPlan(args = {}) {
  const lanes = buildMatrixLaneSpecs(args);
  const lifecycle = splitList(args.lifecycle || 'up,test,doctor,down');
  const gitMetadata = resolveGitMetadata(process.cwd());
  return {
    generated_at: new Date().toISOString(),
    status: 'planned',
    ...gitMetadata,
    lane_count: lanes.length,
    lanes,
    lifecycle,
    commands: lanes.map((lane) => ({
      workspace: lane.workspace,
      owner: lane.owner,
      peer_workspaces: lane.peer_workspaces,
      up: matrixCommand('up', lane, args),
      test: matrixCommand('test', lane, args),
      doctor: matrixCommand('doctor', lane, args),
      down: `${matrixCommand('down', lane, args)} --backend ${String(args.backend || 'stop')} --volumes`,
    })),
    acceptance: {
      deterministic_lane_ids: true,
      peer_isolation_wired: lanes.every((lane) => lane.peer_workspaces.length === lanes.length - 1),
      fieldops_service_name: 'fieldops-metro',
      native_android_out_of_scope: true,
    },
  };
}

function writeDockerRuntimeMatrixPlan(args = {}) {
  const summary = buildDockerRuntimeMatrixPlan(args);
  const root = path.resolve(String(args['artifact-root'] || args.artifact_root || path.join('.tmp', 'docker-runtime')));
  const file = path.join(root, 'matrix', `matrix-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { ...summary, summary_file: file };
}

module.exports = {
  buildDockerRuntimeMatrixPlan,
  buildMatrixLaneSpecs,
  writeDockerRuntimeMatrixPlan,
};
