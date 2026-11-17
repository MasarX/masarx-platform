const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runBoundedSyncCommand } = require('./bounded-sync-command');
const {
  readSectionPort,
  resolveWorkspaceProjectId,
} = require('./local-config');

const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BEGIN_MARKER = '# AUTO-OVERLAY-BEGIN: do not commit this file; use local:stop to restore baseline';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertPathHasNoLinks(root, target, fsImpl = fs) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`runtime overlay path escapes repository: ${resolvedTarget}`);
  }
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fsImpl.existsSync(current)) continue;
    const stat = fsImpl.lstatSync(current);
    if (stat.isSymbolicLink() || (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink())) {
      throw new Error(`runtime overlay path contains a link: ${current}`);
    }
    if (typeof stat.isReparsePoint === 'function' && stat.isReparsePoint()) {
      throw new Error(`runtime overlay path contains a reparse point: ${current}`);
    }
  }
}

function assertRegularNoLinkFile(cwd, filePath, label, fsImpl = fs) {
  assertPathHasNoLinks(cwd, filePath, fsImpl);
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${error.message || error}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-link file`);
  }
  return stat;
}


function canonicalOverlayPorts(raw) {
  let source = raw;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch (_) { return null; }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const ports = {};
  for (const key of ['api', 'db', 'studio', 'analytics']) {
    const value = Number(source[key]);
    if (!Number.isInteger(value) || value < 1 || value > 65535) return null;
    ports[key] = value;
  }
  return ports;
}


function expectedOverlayEndMarker(workspaceId, ports) {
  return `# AUTO-OVERLAY-END workspace=${workspaceId} ports=api:${ports.api},db:${ports.db},studio:${ports.studio},analytics:${ports.analytics}`;
}

function readSupabaseConfigGitIdentity(cwd, baseline, current, options = {}) {
  const run = (args, input) => {
    const result = runBoundedSyncCommand('git', args, {
      cwd, input, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' },
      spawnSyncImpl: (command, args, spawnOptions) => (options.gitSpawnSyncImpl ||
        require('child_process').spawnSync)(command, args, { ...spawnOptions, input }),
    });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error('unable to prove frozen Supabase config Git identity');
    }
    return String(result.stdout || '').trim().toLowerCase();
  };
  const target = 'supabase/config.toml';
  run(['diff', '--cached', '--quiet', '--', target]);
  const frozenBlob = run(['rev-parse', '--verify', `HEAD:${target}`]);
  const indexBlob = run(['rev-parse', '--verify', `:${target}`]);
  const baselineBlob = run(['hash-object', '--path', target, '--stdin'], baseline);
  const currentBlob = run(['hash-object', '--path', target, '--stdin'], current);
  if (!/^[0-9a-f]{40}$/.test(frozenBlob) || frozenBlob !== indexBlob ||
      frozenBlob !== baselineBlob || !/^[0-9a-f]{40}$/.test(currentBlob)) {
    throw new Error('saved Supabase config baseline does not match HEAD and index');
  }
  return { frozenBlob, currentBlob };
}

function assertOwnedCurrentSupabaseConfig({ current, currentBlob, frozenBlob, identity }) {
  const text = current.toString('utf8');
  const currentSha256 = sha256(current);
  if (currentBlob === frozenBlob) {
    if (/^# AUTO-OVERLAY-(?:BEGIN|END)(?:\s|:)/m.test(text)) {
      throw new Error('tracked supabase config matches the frozen blob but contains an overlay marker');
    }
    return { kind: 'marker-free-frozen-blob', current_sha256: currentSha256 };
  }
  const workspaceId = String(identity?.workspace_id || identity?.workspace || '').trim();
  const projectId = String(identity?.project_id || '').trim();
  const ports = canonicalOverlayPorts(identity?.ports);
  if (!SAFE_ID_RE.test(workspaceId) || !SAFE_ID_RE.test(projectId) || !ports) {
    throw new Error('owned supabase config overlay requires frozen workspace, project, and ports identity');
  }
  const binding = identity?.overlay_binding;
  if (!SHA256_RE.test(String(binding?.before?.sha256 || '')) ||
      !SHA256_RE.test(String(binding?.after?.sha256 || '')) ||
      !canonicalOverlayPorts(binding?.before?.ports) ||
      !canonicalOverlayPorts(binding?.after?.ports)) {
    throw new Error('owned supabase config overlay requires durable exact-byte binding');
  }
  if (JSON.stringify(canonicalOverlayPorts(binding.after.ports)) !== JSON.stringify(ports)) {
    throw new Error('owned supabase config overlay binding ports do not match allocation');
  }
  const admitted = [binding.after, binding.before].find((entry) => entry.sha256 === currentSha256);
  if (!admitted) throw new Error('tracked supabase config overlay exact-byte binding mismatch');
  const admittedPorts = canonicalOverlayPorts(admitted.ports);
  const lines = text.split(/\r?\n/);
  const endMarker = expectedOverlayEndMarker(workspaceId, admittedPorts);
  const markers = lines.filter((line) => /^# AUTO-OVERLAY-(?:BEGIN|END)(?:\s|:)/.test(line));
  const begins = lines.map((line, index) => line === BEGIN_MARKER ? index : -1).filter((index) => index >= 0);
  const ends = lines.map((line, index) => line === endMarker ? index : -1).filter((index) => index >= 0);
  const lastContent = lines.reduce((last, line, index) => line.trim() ? index : last, -1);
  if (markers.length !== 2 || begins.length !== 1 || ends.length !== 1
    || begins[0] !== 0 || ends[0] !== lastContent || begins[0] >= ends[0]) {
    throw new Error('tracked supabase config does not contain exactly one complete owned overlay marker pair');
  }
  const projectMatches = lines.map((line) => line.match(/^project_id\s*=\s*"([A-Za-z0-9._-]+)"\s*$/)).filter(Boolean);
  if (projectMatches.length !== 1 || projectMatches[0][1] !== projectId) {
    throw new Error('tracked supabase config overlay project identity does not match frozen workspace metadata');
  }
  for (const key of ['api', 'db', 'studio', 'analytics']) {
    if (readSectionPort(text, key, 'port') !== admittedPorts[key]) {
      throw new Error(`tracked supabase config overlay ${key} port does not match frozen workspace metadata`);
    }
  }
  return { kind: 'owned-overlay', current_sha256: currentSha256 };
}

module.exports = {
  assertOwnedCurrentSupabaseConfig,
  assertRegularNoLinkFile,
  readSupabaseConfigGitIdentity,
};
