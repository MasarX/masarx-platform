const fs = require('fs');
const path = require('path');

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function hasAutoOverlayMarkers(toml = '') {
  return /^# AUTO-OVERLAY-BEGIN/m.test(String(toml || ''))
    && /^# AUTO-OVERLAY-END /m.test(String(toml || ''));
}

function overlayWorkspaceId(toml = '') {
  const match = String(toml || '').match(/^# AUTO-OVERLAY-END workspace=([^\s]+)\b/m);
  return match ? match[1] : '';
}

function restoreOwnedSupabaseConfigOverlay(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const workspaceId = String(options.workspaceId || options.workspace || '').trim();
  const configPath = path.join(cwd, 'supabase', 'config.toml');
  const baselinePath = path.join(cwd, 'supabase', '.temp', 'config.baseline.toml');
  const current = readTextSafe(configPath);
  if (!current) {
    return { status: 'skipped', reason: 'config_missing', config_path: configPath };
  }
  if (!hasAutoOverlayMarkers(current)) {
    return { status: 'not_needed', config_path: configPath };
  }
  const overlayWorkspace = overlayWorkspaceId(current);
  if (workspaceId && overlayWorkspace && overlayWorkspace !== workspaceId) {
    return {
      status: 'skipped',
      reason: 'foreign_workspace_overlay',
      workspace_id: workspaceId,
      overlay_workspace_id: overlayWorkspace,
      config_path: configPath,
    };
  }
  const baseline = readTextSafe(baselinePath);
  if (!baseline || hasAutoOverlayMarkers(baseline)) {
    return {
      status: 'failed',
      reason: baseline ? 'baseline_contains_overlay' : 'baseline_missing',
      workspace_id: workspaceId,
      overlay_workspace_id: overlayWorkspace,
      config_path: configPath,
      baseline_path: baselinePath,
    };
  }
  fs.writeFileSync(configPath, baseline, 'utf8');
  return {
    status: 'restored',
    workspace_id: workspaceId,
    overlay_workspace_id: overlayWorkspace,
    config_path: configPath,
    baseline_path: baselinePath,
  };
}

function removeWorkspaceLocalConfig(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const workspaceId = String(options.workspaceId || options.workspace || '').trim();
  if (!workspaceId) return { status: 'skipped', reason: 'missing_workspace_id' };
  const filePath = path.join(cwd, 'supabase', '.temp', `local_config_${workspaceId}.json`);
  if (!fs.existsSync(filePath)) return { status: 'not_needed', file: filePath };
  fs.unlinkSync(filePath);
  return { status: 'removed', file: filePath };
}

module.exports = {
  hasAutoOverlayMarkers,
  overlayWorkspaceId,
  removeWorkspaceLocalConfig,
  restoreOwnedSupabaseConfigOverlay,
};
