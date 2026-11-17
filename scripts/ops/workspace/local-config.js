#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { computeWorkspaceId } = require('./id');
const { ensureWorkspaceEnv } = require('./env-bootstrap');

const LOCAL_CONFIG_DIR = path.join('supabase', '.temp');
const LOCAL_CONFIG_PREFIX = 'local_config_';
const SUPABASE_LOCAL_PROJECT_ID_MAX_LENGTH = 40;

function getWorkspaceId() {
  const explicit = process.env.WORKSPACE_NAME || '';
  return explicit || computeWorkspaceId();
}

function getWorkspaceLocalConfigPath(workspaceId, cwd = process.cwd()) {
  return path.join(path.resolve(cwd), LOCAL_CONFIG_DIR, `${LOCAL_CONFIG_PREFIX}${workspaceId}.json`);
}

function hashToOffset(id) {
  const h = crypto.createHash('sha256').update(id).digest();
  const n = (h[0] << 8) + h[1];
  return n % 200;
}

function hashToBlockIndex(id, count) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const h = crypto.createHash('sha256').update(`${id}:block`).digest();
  const n = (h[2] << 8) + h[3];
  return n % count;
}

const DEFAULT_PORT_BLOCKS = Object.freeze([
  { shadowBase: 56320, inspectorBase: 56803 },
  { shadowBase: 57320, inspectorBase: 57803 },
  { shadowBase: 58320, inspectorBase: 58803 },
  { shadowBase: 55320, inspectorBase: 55803 },
]);

function buildPortsFromOffset(off, block = DEFAULT_PORT_BLOCKS[0]) {
  const shadowBase = Number(block.shadowBase);
  const inspectorBase = Number(block.inspectorBase);
  return {
    api: shadowBase + 1 + off,
    db: shadowBase + 2 + off,
    shadow: shadowBase + off,
    studio: shadowBase + 3 + off,
    inbucket: shadowBase + 4 + off,
    inbucketSmtp: shadowBase + 5 + off,
    inbucketPop3: shadowBase + 6 + off,
    analytics: shadowBase + 7 + off,
    pooler: shadowBase + 9 + off,
    inspector: inspectorBase + off,
  };
}

function buildPorts(off) {
  return buildPortsFromOffset(off, DEFAULT_PORT_BLOCKS[0]);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSupabaseProjectId(projectId) {
  return String(projectId || '').trim().slice(0, SUPABASE_LOCAL_PROJECT_ID_MAX_LENGTH);
}

function resolveWorkspaceProjectId(workspaceId) {
  return normalizeSupabaseProjectId(`masarx-${String(workspaceId || '').trim()}`);
}

function normalizeWorkspacePorts(ports) {
  const templateKeys = Object.keys(buildPortsFromOffset(0, DEFAULT_PORT_BLOCKS[0]));
  if (!ports || typeof ports !== 'object') return null;

  const normalized = {};
  for (const key of templateKeys) {
    const parsed = Number.parseInt(String(ports[key] ?? '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    normalized[key] = parsed;
  }
  return normalized;
}

function readSectionPort(toml, section, key) {
  const lines = String(toml || '').split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      inSection = line.trim().toLowerCase() === `[${section}]`;
      continue;
    }
    if (inSection) {
      const match = line.match(new RegExp(`^\\s*#?\\s*${escapeRegExp(key)}\\s*=\\s*(\\d+)\\s*$`, 'i'));
      if (match) {
        return Number.parseInt(match[1], 10);
      }
    }
  }
  return null;
}

function readWorkspacePortsFromConfigToml(workspaceId, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const fsImpl = options.fsImpl || fs;
  const configPath = path.join(cwd, 'supabase', 'config.toml');
  if (!fsImpl.existsSync(configPath)) return null;

  const toml = fsImpl.readFileSync(configPath, 'utf8');
  const hasOverlayMarker = new RegExp(`^# AUTO-OVERLAY-BEGIN`, 'm').test(toml)
    && new RegExp(`^# AUTO-OVERLAY-END workspace=${escapeRegExp(workspaceId)}\\b`, 'm').test(toml);
  if (!hasOverlayMarker) return null;

  const ports = {
    api: readSectionPort(toml, 'api', 'port'),
    db: readSectionPort(toml, 'db', 'port'),
    shadow: readSectionPort(toml, 'db', 'shadow_port'),
    studio: readSectionPort(toml, 'studio', 'port'),
    inbucket: readSectionPort(toml, 'inbucket', 'port'),
    inbucketSmtp: readSectionPort(toml, 'inbucket', 'smtp_port'),
    inbucketPop3: readSectionPort(toml, 'inbucket', 'pop3_port'),
    analytics: readSectionPort(toml, 'analytics', 'port'),
    pooler: readSectionPort(toml, 'db.pooler', 'port'),
    inspector: readSectionPort(toml, 'edge_runtime', 'inspector_port'),
  };

  return normalizeWorkspacePorts(ports);
}

function readWorkspacePortsFromJson(workspaceId, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const fsImpl = options.fsImpl || fs;
  const configPath = getWorkspaceLocalConfigPath(workspaceId, cwd);
  if (!fsImpl.existsSync(configPath)) return null;

  try {
    const parsed = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
    if (String(parsed.workspace || '').trim() !== String(workspaceId).trim()) {
      return null;
    }
    const ports = normalizeWorkspacePorts(parsed.ports);
    if (!ports) return null;
    return {
      workspace: String(parsed.workspace || workspaceId).trim(),
      project_id: normalizeSupabaseProjectId(parsed.project_id || resolveWorkspaceProjectId(workspaceId)),
      ports,
      path: configPath,
    };
  } catch (_) {
    return null;
  }
}

function resolveWorkspacePorts(workspaceId, options = {}) {
  const fromJson = readWorkspacePortsFromJson(workspaceId, options);
  if (fromJson) {
    return allowPersistedWorkspacePorts(fromJson.ports, workspaceId, {
      ...options,
      projectId: fromJson.project_id,
    });
  }
  const fromConfigToml = readWorkspacePortsFromConfigToml(workspaceId, options);
  if (!fromConfigToml) return null;
  return allowPersistedWorkspacePorts(fromConfigToml, workspaceId, options);
}

function writeWorkspaceLocalConfig(workspaceId, ports, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const fsImpl = options.fsImpl || fs;
  const normalizedPorts = normalizeWorkspacePorts(ports);
  if (!normalizedPorts) {
    throw new Error(`Invalid workspace ports for ${workspaceId}`);
  }

  const target = getWorkspaceLocalConfigPath(workspaceId, cwd);
  fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  fsImpl.writeFileSync(
    target,
    `${JSON.stringify(
      {
        workspace: workspaceId,
        ports: normalizedPorts,
        project_id: resolveWorkspaceProjectId(workspaceId),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`[workspace/local-config] Wrote ${target}`);
  return target;
}

function parseExcludedPortRanges(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)(?:\s+\*)?\s*$/))
    .filter(Boolean)
    .map((match) => ({
      start: Number.parseInt(match[1], 10),
      end: Number.parseInt(match[2], 10),
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end >= range.start);
}

function parseExcludedTcpRanges(output) {
  return parseExcludedPortRanges(output);
}

function resolveExcludedPortRanges(platform = process.platform) {
  if (platform !== 'win32') return [];
  try {
    const result = spawnSync('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    return parseExcludedPortRanges(result.stdout);
  } catch (_) {
    return [];
  }
}

function readExcludedTcpRanges() {
  return resolveExcludedPortRanges();
}

function rangeContainsPort(range, port) {
  return port >= range.start && port <= range.end;
}

function portsConflictWithRanges(ports, ranges) {
  const candidates = Object.values(ports).filter((value) => Number.isFinite(value));
  return candidates.some((port) => ranges.some((range) => rangeContainsPort(range, port)));
}

function parseAllocatedPorts(output, platform = process.platform) {
  const lines = String(output || '').split(/\r?\n/);
  if (platform === 'win32') {
    return lines
      .map((line) => (
        line.match(/^\s*(\d+)\s*$/) ||
        line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+(?:LISTENING|BOUND)\s+\d+\s*$/i)
      ))
      .filter(Boolean)
      .map((match) => Number.parseInt(match[1], 10))
      .filter((port) => Number.isFinite(port));
  }
  return lines
    .map((line) => line.match(/[:.](\d+)\s+/))
    .filter(Boolean)
    .map((match) => Number.parseInt(match[1], 10))
    .filter((port) => Number.isFinite(port));
}

function parseDockerPublishedPorts(output, projectId) {
  const text = String(output || '');
  const trimmedProjectId = String(projectId || '').trim();
  if (!trimmedProjectId) {
    const matches = text.matchAll(/:(\d+)->/g);
    return Array.from(matches)
      .map((match) => Number.parseInt(match[1], 10))
      .filter((port) => Number.isFinite(port));
  }

  const escapedProjectId = escapeRegExp(trimmedProjectId);
  const projectPattern = new RegExp(`^supabase_.*_${escapedProjectId}$`, 'i');
  const publishedPorts = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const [name, ...rest] = rawLine.split('\t');
    if (!projectPattern.test(String(name || '').trim())) continue;
    const portsText = rest.join('\t');
    for (const match of portsText.matchAll(/[:](\d+)->/g)) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        publishedPorts.add(parsed);
      }
    }
  }

  return Array.from(publishedPorts);
}

function resolveDockerPublishedPorts() {
  try {
    const result = spawnSync('docker', ['ps', '--format', '{{.Ports}}'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    return parseDockerPublishedPorts(result.stdout);
  } catch (_) {
    return [];
  }
}

function resolveAllocatedPorts(platform = process.platform) {
  const allocated = [];
  try {
    if (platform === 'win32') {
      const psResult = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-NetTCPConnection -State Listen,Bound -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort',
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      if (psResult.status === 0) {
        const powershellPorts = parseAllocatedPorts(psResult.stdout, platform);
        if (powershellPorts.length > 0) {
          return powershellPorts;
        }
      }
      const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result.status === 0) {
        allocated.push(...parseAllocatedPorts(result.stdout, platform));
      }
    }
  } catch (_) {
    // Docker-published ports remain a useful fallback when netstat is unavailable.
  }
  allocated.push(...resolveDockerPublishedPorts());
  return Array.from(new Set(allocated));
}

function portsConflictWithAllocatedPorts(ports, allocatedPorts) {
  const allocated = new Set(Array.isArray(allocatedPorts) ? allocatedPorts : []);
  const candidates = Object.values(ports).filter((value) => Number.isFinite(value));
  return candidates.some((port) => allocated.has(port));
}

function resolveProjectAllocatedPorts(projectId) {
  try {
    const result = spawnSync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    return parseDockerPublishedPorts(result.stdout, projectId);
  } catch (_) {
    return [];
  }
}

function allowPersistedWorkspacePorts(ports, workspaceId, options = {}) {
  const normalizedPorts = normalizeWorkspacePorts(ports);
  if (!normalizedPorts) return null;

  const allocatedPorts = Array.isArray(options.allocatedPorts)
    ? options.allocatedPorts
    : resolveAllocatedPorts(options.platform || process.platform);
  if (!portsConflictWithAllocatedPorts(normalizedPorts, allocatedPorts)) {
    return normalizedPorts;
  }

  const projectId = normalizeSupabaseProjectId(options.projectId || resolveWorkspaceProjectId(workspaceId));
  const projectAllocatedPorts = Array.isArray(options.projectAllocatedPorts)
    ? options.projectAllocatedPorts
    : resolveProjectAllocatedPorts(projectId);
  const allocated = new Set(allocatedPorts);
  const owned = new Set(projectAllocatedPorts);
  const conflictingPorts = Object.values(normalizedPorts)
    .filter((value) => Number.isFinite(value) && allocated.has(value));

  if (conflictingPorts.length > 0 && conflictingPorts.every((port) => owned.has(port))) {
    return normalizedPorts;
  }

  return null;
}

function computePorts(id, options = {}) {
  const initialOffset = Number.isInteger(options.initialOffset)
    ? Number(options.initialOffset)
    : hashToOffset(id);
  const normalizedInitialOffset = ((initialOffset % 200) + 200) % 200;
  const portBlocks = Array.isArray(options.portBlocks) && options.portBlocks.length > 0
    ? options.portBlocks
    : DEFAULT_PORT_BLOCKS;
  const initialBlockIndex = Number.isInteger(options.initialBlockIndex)
    ? Number(options.initialBlockIndex)
    : hashToBlockIndex(id, portBlocks.length);
  const excludedRanges = Array.isArray(options.excludedRanges)
    ? options.excludedRanges
    : resolveExcludedPortRanges(options.platform || process.platform);
  const allocatedPorts = Array.isArray(options.allocatedPorts)
    ? options.allocatedPorts
    : resolveAllocatedPorts(options.platform || process.platform);

  for (let blockAttempt = 0; blockAttempt < portBlocks.length; blockAttempt += 1) {
    const blockIndex = (initialBlockIndex + blockAttempt) % portBlocks.length;
    const block = portBlocks[blockIndex];
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const off = (normalizedInitialOffset + attempt) % 200;
      const ports = buildPortsFromOffset(off, block);
      if (
        !portsConflictWithRanges(ports, excludedRanges) &&
        !portsConflictWithAllocatedPorts(ports, allocatedPorts)
      ) {
        return ports;
      }
    }
  }

  return buildPortsFromOffset(
    normalizedInitialOffset,
    portBlocks[initialBlockIndex] || portBlocks[0] || DEFAULT_PORT_BLOCKS[0],
  );
}

function portSetsEqual(left, right) {
  if (!left || !right) return false;
  const keys = ['api', 'db', 'shadow', 'studio', 'inbucket', 'inbucketSmtp', 'inbucketPop3', 'analytics', 'pooler', 'inspector'];
  return keys.every((key) => Number(left[key]) === Number(right[key]));
}

function identifyPortSet(ports, portBlocks = DEFAULT_PORT_BLOCKS) {
  const shadowPort = Number(ports?.shadow);
  if (!Number.isFinite(shadowPort)) return null;
  for (let blockIndex = 0; blockIndex < portBlocks.length; blockIndex += 1) {
    const block = portBlocks[blockIndex];
    const offset = shadowPort - Number(block.shadowBase);
    if (!Number.isInteger(offset) || offset < 0 || offset >= 200) continue;
    const candidate = buildPortsFromOffset(offset, block);
    if (portSetsEqual(candidate, ports)) {
      return { blockIndex, offset };
    }
  }
  return null;
}

function computeNextPortsAfterCurrent(id, currentPorts, options = {}) {
  const portBlocks = Array.isArray(options.portBlocks) && options.portBlocks.length > 0
    ? options.portBlocks
    : DEFAULT_PORT_BLOCKS;
  const excludedRanges = Array.isArray(options.excludedRanges)
    ? options.excludedRanges
    : resolveExcludedPortRanges(options.platform || process.platform);
  const allocatedPorts = Array.isArray(options.allocatedPorts)
    ? options.allocatedPorts
    : resolveAllocatedPorts(options.platform || process.platform);
  const searchStart = identifyPortSet(currentPorts, portBlocks);
  const nextPorts = computePorts(id, {
    ...options,
    excludedRanges,
    allocatedPorts,
    initialOffset: searchStart ? searchStart.offset + 1 : options.initialOffset,
    initialBlockIndex: searchStart ? searchStart.blockIndex : options.initialBlockIndex,
    portBlocks,
  });
  if (!portSetsEqual(nextPorts, currentPorts)) return nextPorts;

  for (let blockIndex = 0; blockIndex < portBlocks.length; blockIndex += 1) {
    for (let offset = 0; offset < 200; offset += 1) {
      const candidate = buildPortsFromOffset(offset, portBlocks[blockIndex]);
      if (
        !portSetsEqual(candidate, currentPorts) &&
        !portsConflictWithRanges(candidate, excludedRanges) &&
        !portsConflictWithAllocatedPorts(candidate, allocatedPorts)
      ) {
        return candidate;
      }
    }
  }

  return nextPorts;
}

function writeJson(target, obj) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  console.log(`[workspace/local-config] Wrote ${target}`);
}

function main() {
  ensureWorkspaceEnv();

  const wk = getWorkspaceId();
  const ports = resolveWorkspacePorts(wk) || computePorts(wk);
  const projectId = resolveWorkspaceProjectId(wk);
  const out = { workspace: wk, ports, project_id: projectId };
  const outPath = path.join('supabase', '.temp', `local_config_${wk}.json`);
  writeJson(outPath, out);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildPorts,
  buildPortsFromOffset,
  computeNextPortsAfterCurrent,
  computePorts,
  DEFAULT_PORT_BLOCKS,
  getWorkspaceLocalConfigPath,
  main,
  normalizeWorkspacePorts,
  parseAllocatedPorts,
  parseDockerPublishedPorts,
  parseExcludedPortRanges,
  parseExcludedTcpRanges,
  portSetsEqual,
  portsConflictWithAllocatedPorts,
  portsConflictWithRanges,
  readSectionPort,
  readExcludedTcpRanges,
  readWorkspacePortsFromConfigToml,
  readWorkspacePortsFromJson,
  resolveWorkspaceProjectId,
  resolveAllocatedPorts,
  resolveDockerPublishedPorts,
  resolveExcludedPortRanges,
  resolveProjectAllocatedPorts,
  resolveWorkspacePorts,
  allowPersistedWorkspacePorts,
  writeWorkspaceLocalConfig,
};
