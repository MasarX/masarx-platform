#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { computeWorkspaceId } = require('./id');
const { ensureWorkspaceEnv } = require('./env-bootstrap');
const {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  assertCommandDidNotTimeOut,
  parsePositiveInteger,
  runBoundedSyncCommand,
} = require('./bounded-sync-command');

const LOCAL_CONFIG_DIR = path.join('supabase', '.temp');
const LOCAL_CONFIG_PREFIX = 'local_config_';
const SUPABASE_LOCAL_PROJECT_ID_MAX_LENGTH = 40;
const RUNTIME_IDENTITY_SCHEMA = 'v1';
const RUNTIME_PROJECT_DIGEST_LENGTH = 32;

function runDiscoveryProbe(probeName, command, args, options = {}) {
  const timeoutMs = parsePositiveInteger(
    options.timeoutMs ?? options.env?.MASARX_DISCOVERY_COMMAND_TIMEOUT_MS,
    DEFAULT_DISCOVERY_TIMEOUT_MS,
  );
  const runCommand = options.runCommand || runBoundedSyncCommand;
  const result = runCommand(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    timeoutMs,
  });
  assertCommandDidNotTimeOut(result, `[workspace/local-config] ${probeName}`);
  return result || { ok: false, status: null, stdout: '', stderr: '', failure_kind: 'missing_result' };
}

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

// Backend ports are deliberately below the Windows TCP dynamic range. The
// runtime lease policy still discovers and validates both IPv4 and IPv6
// dynamic/excluded ranges before allocating; these blocks are candidates, not
// authority.
const DEFAULT_PORT_BLOCKS = Object.freeze([
  { shadowBase: 20000, inspectorBase: 20483 },
  { shadowBase: 21000, inspectorBase: 21483 },
  { shadowBase: 22000, inspectorBase: 22483 },
  { shadowBase: 23000, inspectorBase: 23483 },
]);

const SUPABASE_START_CONTAINER_PORTS = Object.freeze({
  api: 8000,
  db: 5432,
  studio: 3000,
  inbucket: 8025,
  inbucketSmtp: 1025,
  inbucketPop3: 1110,
  analytics: 4000,
});
const SUPABASE_START_PUBLISHED_PORT_NAMES = Object.freeze(Object.keys(SUPABASE_START_CONTAINER_PORTS));

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function shouldDisableAnalyticsForLocalStart(options = {}) {
  const env = options.env || process.env;
  const explicitDisable = options.disableAnalytics ?? env.WORKSPACE_LOCAL_START_DISABLE_ANALYTICS;
  if (String(explicitDisable ?? '').trim()) return isTruthy(explicitDisable);
  const explicitEnable = options.enableAnalytics ?? env.WORKSPACE_LOCAL_START_ENABLE_ANALYTICS;
  if (String(explicitEnable ?? '').trim()) return !isTruthy(explicitEnable);
  return true;
}

function resolveBackendPublishedPortNames(options = {}) {
  return SUPABASE_START_PUBLISHED_PORT_NAMES.filter((name) => (
    name !== 'analytics' || !shouldDisableAnalyticsForLocalStart(options)
  ));
}

class WorkspacePortPoolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspacePortPoolError';
    this.code = code;
    this.details = details;
  }
}

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

function resolveLegacyWorkspaceProjectId(workspaceId) {
  return normalizeSupabaseProjectId(`masarx-${String(workspaceId || '').trim()}`);
}

function normalizeWorkspaceRuntimeRoot(cwd = process.cwd(), options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  const requestedRoot = path.resolve(cwd || process.cwd());
  const realpathSyncImpl = options.realpathSyncImpl
    || fs.realpathSync.native
    || fs.realpathSync;
  let physicalRoot;
  try {
    physicalRoot = realpathSyncImpl(requestedRoot);
  } catch (error) {
    throw new Error(
      `workspace runtime identity requires a resolvable physical worktree root: ${requestedRoot}; ` +
      `${error?.code || error?.message || error}`,
    );
  }
  let normalized = String(physicalRoot || '')
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '');
  if (!normalized) {
    throw new Error(`workspace runtime identity resolved an empty physical worktree root: ${requestedRoot}`);
  }
  if (platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

function sanitizeRuntimeProjectPrefix(workspaceId) {
  return String(workspaceId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '') || 'workspace';
}

function resolveWorkspaceRuntimeIdentity(workspaceId, options = {}) {
  const normalizedWorkspaceId = String(workspaceId || '').trim();
  if (!normalizedWorkspaceId) {
    throw new Error('workspace runtime identity requires a workspace id');
  }

  const worktreeRoot = normalizeWorkspaceRuntimeRoot(options.cwd || process.cwd(), options);
  const identityInput = [RUNTIME_IDENTITY_SCHEMA, normalizedWorkspaceId, worktreeRoot].join('\0');
  const identityDigest = crypto.createHash('sha256').update(identityInput).digest('hex');
  const projectDigest = identityDigest.slice(0, RUNTIME_PROJECT_DIGEST_LENGTH);
  const prefixBudget = SUPABASE_LOCAL_PROJECT_ID_MAX_LENGTH
    - 'masarx-'.length
    - 1
    - projectDigest.length;
  const readablePrefix = prefixBudget > 0
    ? sanitizeRuntimeProjectPrefix(normalizedWorkspaceId).slice(0, prefixBudget)
    : '';
  const projectId = readablePrefix
    ? `masarx-${readablePrefix}-${projectDigest}`
    : `masarx-${projectDigest}`;

  return Object.freeze({
    schema: RUNTIME_IDENTITY_SCHEMA,
    workspace_id: normalizedWorkspaceId,
    worktree_root: worktreeRoot,
    worktree_digest: crypto.createHash('sha256').update(worktreeRoot).digest('hex'),
    owner_id: identityDigest,
    project_id: projectId,
    legacy_project_id: resolveLegacyWorkspaceProjectId(normalizedWorkspaceId),
  });
}

function resolveWorkspaceProjectId(workspaceId, options = {}) {
  return resolveWorkspaceRuntimeIdentity(workspaceId, options).project_id;
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
      project_id: normalizeSupabaseProjectId(parsed.project_id || resolveWorkspaceProjectId(workspaceId, {
        cwd,
        platform: options.platform,
      })),
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

function serializeWorkspaceLocalConfig(workspaceId, ports, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const normalizedPorts = normalizeWorkspacePorts(ports);
  if (!normalizedPorts) {
    throw new Error(`Invalid workspace ports for ${workspaceId}`);
  }
  return `${JSON.stringify({
    workspace: workspaceId,
    ports: normalizedPorts,
    project_id: resolveWorkspaceProjectId(workspaceId, { cwd, platform: options.platform }),
    ...(Array.isArray(options.publishedPortNames)
      ? { published_port_names: options.publishedPortNames }
      : {}),
    ...(options.allocation && typeof options.allocation === 'object'
      ? { allocation: options.allocation }
      : {}),
  }, null, 2)}\n`;
}

function writeWorkspaceLocalConfig(workspaceId, ports, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const fsImpl = options.fsImpl || fs;
  const logger = options.logger === null ? null : (options.logger || console);
  const target = getWorkspaceLocalConfigPath(workspaceId, cwd);
  fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tmp, serializeWorkspaceLocalConfig(workspaceId, ports, options), 'utf8');
  fsImpl.renameSync(tmp, target);
  if (!options.silent && typeof logger?.log === 'function') {
    logger.log(`[workspace/local-config] Wrote ${target}`);
  }
  return target;
}

function parseExcludedPortRanges(output, options = {}) {
  const text = String(output || '');
  const ranges = text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)(?:\s+\*)?\s*$/))
    .filter(Boolean)
    .map((match) => ({
      start: Number.parseInt(match[1], 10),
      end: Number.parseInt(match[2], 10),
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end >= range.start);
  if (options.required && ranges.length === 0 && !/no excluded ports/i.test(text)) {
    throw new WorkspacePortPoolError(
      'workspace_port_range_discovery_malformed',
      `Unable to parse Windows ${options.family || ''} excluded TCP port ranges.`.trim(),
    );
  }
  return ranges;
}

function parseExcludedTcpRanges(output) {
  return parseExcludedPortRanges(output);
}

function parseDynamicPortRange(output, family = '') {
  const text = String(output || '');
  const startMatch = text.match(/Start Port\s*:\s*(\d+)/i);
  const countMatch = text.match(/Number of Ports\s*:\s*(\d+)/i);
  const start = Number.parseInt(startMatch?.[1] || '', 10);
  const count = Number.parseInt(countMatch?.[1] || '', 10);
  if (!Number.isInteger(start) || !Number.isInteger(count) || start <= 0 || count <= 0 || start + count - 1 > 65535) {
    throw new WorkspacePortPoolError(
      'workspace_port_range_discovery_malformed',
      `Unable to parse Windows ${family} dynamic TCP port range.`.trim(),
    );
  }
  return { start, end: start + count - 1, count, family };
}

function runNetshPortRangeQuery(args, options = {}) {
  const result = runDiscoveryProbe(
    'Windows TCP port range discovery',
    'netsh',
    args,
    options,
  );
  if (!result.ok) {
    throw new WorkspacePortPoolError(
      'workspace_port_range_discovery_failed',
      `Windows TCP port range discovery failed for ${args.join(' ')}.`,
      { status: result.status ?? null },
    );
  }
  return String(result.stdout || '');
}

function discoverWindowsTcpPortPolicy(options = {}) {
  const families = ['ipv4', 'ipv6'];
  const dynamic = [];
  const excluded = [];
  for (const family of families) {
    dynamic.push(parseDynamicPortRange(runNetshPortRangeQuery(
      ['interface', family, 'show', 'dynamicportrange', 'tcp'], options,
    ), family));
    const excludedOutput = runNetshPortRangeQuery(
      ['interface', family, 'show', 'excludedportrange', 'protocol=tcp'], options,
    );
    excluded.push(...parseExcludedPortRanges(excludedOutput, { family, required: true })
      .map((range) => ({ ...range, family })));
  }
  return { version: 1, dynamic, excluded };
}

function resolveExcludedPortRanges(platform = process.platform, options = {}) {
  if (platform !== 'win32') return [];
  return discoverWindowsTcpPortPolicy(options).excluded;
}

function readExcludedTcpRanges(platform = process.platform, options = {}) {
  return resolveExcludedPortRanges(platform, options);
}

function assertPortBlocksOutsideDynamicRanges(portBlocks, dynamicRanges) {
  const dynamicStarts = dynamicRanges.map((range) => Number(range.start));
  if (dynamicStarts.some((start) => !Number.isInteger(start) || start <= 0)) {
    throw new WorkspacePortPoolError(
      'workspace_port_range_discovery_malformed',
      'Windows dynamic TCP range evidence contains an invalid start port.',
    );
  }
  const lowestDynamicStart = Math.min(...dynamicStarts);
  for (const block of portBlocks) {
    for (let offset = 0; offset < 200; offset += 1) {
      const ports = buildPortsFromOffset(offset, block);
      if (Math.max(...Object.values(ports)) >= lowestDynamicStart) {
        throw new WorkspacePortPoolError(
          'workspace_port_pool_dynamic_overlap',
          'Governed backend port pool is not strictly below both discovered Windows dynamic TCP ranges.',
          { block, dynamic_ranges: dynamicRanges },
        );
      }
    }
  }
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

function resolveDockerPublishedPorts(options = {}) {
  try {
    const result = runDiscoveryProbe(
      'Docker published port probe',
      'docker',
      ['ps', '--format', '{{.Ports}}'],
      options,
    );
    if (!result.ok) return [];
    return parseDockerPublishedPorts(result.stdout);
  } catch (error) {
    if (error?.code === 'MASARX_DISCOVERY_TIMEOUT') throw error;
    return [];
  }
}

function resolveAllocatedPorts(platform = process.platform, options = {}) {
  const allocated = [];
  try {
    if (platform === 'win32') {
      const psResult = runDiscoveryProbe(
        'Windows allocated port probe',
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-NetTCPConnection -State Listen,Bound -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort',
        ],
        options,
      );
      if (psResult.ok) {
        const powershellPorts = parseAllocatedPorts(psResult.stdout, platform);
        if (powershellPorts.length > 0) {
          return powershellPorts;
        }
      }
      const result = runDiscoveryProbe(
        'Windows netstat allocated port probe',
        'netstat',
        ['-ano', '-p', 'tcp'],
        options,
      );
      if (result.ok) {
        allocated.push(...parseAllocatedPorts(result.stdout, platform));
      }
    }
  } catch (error) {
    if (error?.code === 'MASARX_DISCOVERY_TIMEOUT') throw error;
    // Docker-published ports remain a useful fallback when netstat is unavailable.
  }
  allocated.push(...resolveDockerPublishedPorts(options));
  return Array.from(new Set(allocated));
}

function portsConflictWithAllocatedPorts(ports, allocatedPorts) {
  const allocated = new Set(Array.isArray(allocatedPorts) ? allocatedPorts : []);
  const candidates = Object.values(ports).filter((value) => Number.isFinite(value));
  return candidates.some((port) => allocated.has(port));
}

function resolveProjectAllocatedPorts(projectId, options = {}) {
  try {
    const result = runDiscoveryProbe(
      'Docker project port ownership probe',
      'docker',
      ['ps', '--format', '{{.Names}}\t{{.Ports}}'],
      options,
    );
    if (!result.ok) return [];
    return parseDockerPublishedPorts(result.stdout, projectId);
  } catch (error) {
    if (error?.code === 'MASARX_DISCOVERY_TIMEOUT') throw error;
    return [];
  }
}

function allowPersistedWorkspacePorts(ports, workspaceId, options = {}) {
  const normalizedPorts = normalizeWorkspacePorts(ports);
  if (!normalizedPorts) return null;

  const allocatedPorts = Array.isArray(options.allocatedPorts)
    ? options.allocatedPorts
    : resolveAllocatedPorts(options.platform || process.platform, options);
  if (!portsConflictWithAllocatedPorts(normalizedPorts, allocatedPorts)) {
    return normalizedPorts;
  }

  const projectId = normalizeSupabaseProjectId(options.projectId || resolveWorkspaceProjectId(workspaceId, {
    cwd: options.cwd || process.cwd(),
    platform: options.platform,
  }));
  const projectAllocatedPorts = Array.isArray(options.projectAllocatedPorts)
    ? options.projectAllocatedPorts
    : resolveProjectAllocatedPorts(projectId, options);
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
  const platform = options.platform || process.platform;
  let discoveredPolicy = options.discoveredPolicy || null;
  if (platform === 'win32' && !discoveredPolicy && !Array.isArray(options.excludedRanges)) {
    discoveredPolicy = discoverWindowsTcpPortPolicy(options);
  }
  const excludedRanges = Array.isArray(options.excludedRanges)
    ? options.excludedRanges
    : (discoveredPolicy?.excluded || []);
  if (platform === 'win32') {
    const dynamicRanges = Array.isArray(options.dynamicRanges)
      ? options.dynamicRanges
      : (discoveredPolicy?.dynamic || []);
    if (dynamicRanges.length !== 2) {
      throw new WorkspacePortPoolError(
        'workspace_port_range_discovery_malformed',
        'Windows backend allocation requires IPv4 and IPv6 dynamic TCP range evidence.',
      );
    }
    assertPortBlocksOutsideDynamicRanges(portBlocks, dynamicRanges);
  }
  const allocatedPorts = Array.isArray(options.allocatedPorts)
    ? options.allocatedPorts
    : resolveAllocatedPorts(options.platform || process.platform, options);

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

  throw new WorkspacePortPoolError(
    'workspace_port_pool_exhausted',
    `No governed backend port set is available for ${id}.`,
    { block_count: portBlocks.length, excluded_range_count: excludedRanges.length, allocated_port_count: allocatedPorts.length },
  );
}

function resolveAllocatedPortsStrict(platform = process.platform, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const allocated = [];
  const run = (command, args, label) => {
    let result;
    try {
      result = spawnSyncImpl(command, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: options.timeoutMs || 7000,
      });
    } catch (error) {
      result = { error };
    }
    if (!result || result.error || result.status !== 0) {
      const details = {
        status: result?.status ?? null,
        error_code: result?.error?.code ? String(result.error.code).slice(0, 64) : null,
        signal: result?.signal ? String(result.signal).slice(0, 64) : null,
      };
      throw new WorkspacePortPoolError(
        'workspace_port_collision_discovery_failed',
        `${label} failed (status=${details.status ?? 'unknown'}, error=${details.error_code || 'none'}, signal=${details.signal || 'none'}).`,
        details,
      );
    }
    return String(result.stdout || '');
  };

  if (platform === 'win32') {
    allocated.push(...parseAllocatedPorts(run(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-NetTCPConnection -State Listen,Bound -ErrorAction Stop | Select-Object -ExpandProperty LocalPort',
      ],
      'Windows TCP listener/binding discovery',
    ), platform));
  } else {
    allocated.push(...parseAllocatedPorts(run(
      'sh',
      ['-c', 'if command -v ss >/dev/null 2>&1; then ss -H -ltn; elif command -v netstat >/dev/null 2>&1; then netstat -ltn; else exit 127; fi'],
      'TCP listener discovery',
    ), platform));
  }

  allocated.push(...parseDockerPublishedPorts(run(
    'docker',
    ['ps', '--format', '{{.Ports}}'],
    'Docker published-port discovery',
  )));
  return Array.from(new Set(allocated)).sort((left, right) => left - right);
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
    : resolveExcludedPortRanges(options.platform || process.platform, options);
  const allocatedPorts = Array.isArray(options.allocatedPorts)
    ? options.allocatedPorts
    : resolveAllocatedPorts(options.platform || process.platform, options);
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
  const ports = resolveWorkspacePorts(wk);
  if (!ports) {
    throw new WorkspacePortPoolError(
      'backend_allocation_receipt_required',
      'Workspace backend configuration is lease-owned. Acquire backend-supabase through runtime-leases before reading it.',
    );
  }
  console.log(JSON.stringify({
    workspace: wk,
    ports,
    project_id: resolveWorkspaceProjectId(wk),
    authority: 'runtime-lease-authoritative-allocation-v1',
    mode: 'diagnostic-read-only',
  }));
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeWorkspaceRuntimeRoot,
  buildPorts,
  buildPortsFromOffset,
  computeNextPortsAfterCurrent,
  computePorts,
  discoverWindowsTcpPortPolicy,
  DEFAULT_PORT_BLOCKS,
  getWorkspaceLocalConfigPath,
  main,
  normalizeWorkspacePorts,
  parseAllocatedPorts,
  parseDockerPublishedPorts,
  parseExcludedPortRanges,
  parseExcludedTcpRanges,
  parseDynamicPortRange,
  portSetsEqual,
  portsConflictWithAllocatedPorts,
  portsConflictWithRanges,
  readSectionPort,
  readExcludedTcpRanges,
  readWorkspacePortsFromConfigToml,
  readWorkspacePortsFromJson,
  resolveLegacyWorkspaceProjectId,
  resolveWorkspaceRuntimeIdentity,
  resolveWorkspaceProjectId,
  resolveAllocatedPorts,
  resolveAllocatedPortsStrict,
  resolveDockerPublishedPorts,
  resolveExcludedPortRanges,
  resolveProjectAllocatedPorts,
  resolveWorkspacePorts,
  resolveBackendPublishedPortNames,
  serializeWorkspaceLocalConfig,
  SUPABASE_START_CONTAINER_PORTS,
  shouldDisableAnalyticsForLocalStart,
  WorkspacePortPoolError,
  allowPersistedWorkspacePorts,
  writeWorkspaceLocalConfig,
};
