#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { command: 'create', _: [] };
  let index = 0;
  if (argv[0] && !String(argv[0]).startsWith('--')) {
    out.command = String(argv[0]);
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const [rawKey, ...inlineParts] = token.slice(2).split('=');
    const key = rawKey.trim();
    const alias = key.replace(/-/g, '_');
    let value = inlineParts.length ? inlineParts.join('=') : null;
    if (value == null) {
      const next = argv[index + 1];
      if (next == null || String(next).startsWith('--')) {
        value = true;
      } else {
        value = String(next);
        index += 1;
      }
    }
    for (const targetKey of Array.from(new Set([key, alias]))) {
      if (out[targetKey] === undefined) out[targetKey] = value;
      else if (Array.isArray(out[targetKey])) out[targetKey].push(value);
      else out[targetKey] = [out[targetKey], value];
    }
  }
  return out;
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isTruthy(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, payload) {
  writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

const SUPABASE_BOOTSTRAP_SCHEMAS = new Set([
  '_realtime',
  'auth',
  'extensions',
  'graphql',
  'graphql_public',
  'pgbouncer',
  'realtime',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'vault',
]);

const BUILTIN_POLICY_ROLES = new Set([
  'anon',
  'authenticated',
  'authenticator',
  'dashboard_user',
  'postgres',
  'public',
  'service_role',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_functions_admin',
  'supabase_read_only_user',
  'supabase_realtime_admin',
  'supabase_replication_admin',
  'supabase_storage_admin',
]);

const SUPABASE_BOOTSTRAP_PUBLICATIONS = new Set([
  'supabase_realtime',
]);

const SUPABASE_BOOTSTRAP_EVENT_TRIGGERS = new Map([
  ['issue_graphql_placeholder', 'extensions.set_graphql_placeholder'],
  ['issue_pg_cron_access', 'extensions.grant_pg_cron_access'],
  ['issue_pg_graphql_access', 'extensions.grant_pg_graphql_access'],
  ['issue_pg_net_access', 'extensions.grant_pg_net_access'],
  ['pgrst_ddl_watch', 'extensions.pgrst_ddl_watch'],
  ['pgrst_drop_watch', 'extensions.pgrst_drop_watch'],
]);

const MANAGED_SCHEMA_BLOCK_PATTERN = /^--\n-- Name: .*?; Type: .*?; Schema: ([^;]+); Owner: .*?\n--\n[\s\S]*?(?=^--\n-- Name: |$(?![\s\S]))/gm;
const MANAGED_PUBLICATION_BLOCK_PATTERN = /^--\n-- Name: (.*?); Type: PUBLICATION; Schema: -; Owner: .*?\n--\n[\s\S]*?(?=^--\n-- Name: |$(?![\s\S]))/gm;
const MANAGED_EVENT_TRIGGER_BLOCK_PATTERN = /^--\n-- Name: (.*?); Type: EVENT TRIGGER; Schema: -; Owner: .*?\n--\n[\s\S]*?(?=^--\n-- Name: |$(?![\s\S]))/gm;

function quoteWindowsArg(value) {
  const text = String(value ?? '');
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function resolveCommandOnPath(command, env = process.env, platform = process.platform) {
  const raw = String(command || '').trim();
  if (!raw) throw new Error('required executable is missing');
  if (!String(platform || '').startsWith('win')) return raw;
  if (raw.includes(path.sep) || raw.includes(path.posix.sep)) {
    if (fs.existsSync(raw)) return raw;
    throw new Error(`required executable not found: ${raw}`);
  }
  const pathValue = String(env.PATH || env.Path || '').trim();
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hasExplicitExtension = /\.[A-Za-z0-9]+$/.test(raw);
  const candidates = hasExplicitExtension
    ? [raw]
    : [
        ...extensions.map((ext) => `${raw}${ext.toLowerCase()}`),
        ...extensions.map((ext) => `${raw}${ext.toUpperCase()}`),
        raw,
      ];
  for (const segment of segments) {
    for (const candidate of candidates) {
      const resolved = path.join(segment, candidate);
      if (fs.existsSync(resolved)) return resolved;
    }
  }
  throw new Error(`required executable not found: ${raw}`);
}

function resolveWindowsShortPath(filePath, options = {}) {
  const raw = String(filePath || '').trim();
  if (!raw) throw new Error('required executable path is missing');
  if (!/[\s"]/u.test(raw)) return raw;
  const knownShortCandidates = [
    ...(Array.isArray(options.knownShortPathCandidates) ? options.knownShortPathCandidates : []),
    [/^([A-Za-z]:)\\Program Files\\/i, '$1\\PROGRA~1\\'],
    [/^([A-Za-z]:)\\Program Files \(x86\)\\/i, '$1\\PROGRA~2\\'],
  ].map((entry) => {
    if (Array.isArray(entry)) {
      const [pattern, replacement] = entry;
      return raw.replace(pattern, replacement);
    }
    return String(entry || '');
  });
  for (const candidate of knownShortCandidates) {
    if (candidate !== raw && !/[\s"]/u.test(candidate) && fs.existsSync(candidate)) return candidate;
  }
  if (typeof options.shortPathResolver === 'function') {
    const resolved = String(options.shortPathResolver(raw) || '').trim();
    if (resolved && !/[\s"]/u.test(resolved) && fs.existsSync(resolved)) return resolved;
    throw new Error(`required executable short path is unavailable: ${raw}`);
  }
  const runner = options.shortPathRunner || spawnSync;
  const comspec = String(options.comspec || process.env.ComSpec || 'cmd.exe');
  const result = runner(comspec, ['/d', '/s', '/c', `for %I in (${quoteWindowsArg(raw)}) do @echo %~sI`], {
    encoding: 'utf8',
    windowsHide: true,
    env: options.env || process.env,
  }) || {};
  const resolved = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  if (result.error || Number(result.status || 0) !== 0 || !resolved || /[\s"]/u.test(resolved) || !fs.existsSync(resolved)) {
    throw new Error(`required executable short path is unavailable: ${raw}`);
  }
  return resolved;
}

function resolveSpawnCommand(command, args = [], options = {}) {
  const platform = options.platform || process.platform;
  const resolvedCommand = resolveCommandOnPath(command, options.env || process.env, platform);
  const needsCmdShim = String(platform || '').startsWith('win') && /\.(bat|cmd)$/i.test(resolvedCommand);
  if (!needsCmdShim) return { command: resolvedCommand, args };
  const safeCommand = resolveWindowsShortPath(resolvedCommand, options);
  return {
    command: String(options.comspec || process.env.ComSpec || 'cmd.exe'),
    args: ['/d', '/s', '/c', ['call', safeCommand, ...args].map(quoteWindowsArg).join(' ')],
  };
}

function executableCandidates(raw, platform = process.platform, env = process.env) {
  const text = String(raw || '').trim();
  const isWindows = String(platform || '').startsWith('win');
  const hasExplicitExtension = /\.[A-Za-z0-9]+$/.test(text);
  if (!isWindows || hasExplicitExtension) return [text];
  const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [
    ...extensions.map((ext) => `${text}${ext.toLowerCase()}`),
    ...extensions.map((ext) => `${text}${ext.toUpperCase()}`),
    text,
  ];
}

function resolveRequiredExecutable(command, options = {}) {
  const raw = String(command || '').trim();
  if (!raw) throw new Error('required executable is missing');
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const hasPathSegment = /[\\/]/u.test(raw);
  if (hasPathSegment) {
    for (const candidate of executableCandidates(raw, platform, env)) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`required executable not found: ${raw}`);
  }
  const pathValue = String(env.PATH || env.Path || '').trim();
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  for (const segment of segments) {
    for (const candidate of executableCandidates(raw, platform, env)) {
      const resolved = path.join(segment, candidate);
      if (fs.existsSync(resolved)) return resolved;
    }
  }
  throw new Error(`required executable not found: ${raw}`);
}

function psqlExecutableMissing(message) {
  const error = new Error(message);
  error.reason = 'psql_executable_missing';
  return error;
}

function resolveTargetPsqlExecutable(args = {}, options = {}) {
  const env = options.env || process.env;
  const override = String(
    firstValue(args['psql-path'] || args.psql_path || options.psqlPath || env.LOCAL_TARGET_BACKEND_PSQL) || '',
  ).trim();
  try {
    return resolveRequiredExecutable(override || 'psql', {
      env,
      platform: options.platform || process.platform,
    });
  } catch (error) {
    if (override) {
      throw psqlExecutableMissing(`psql executable override is not usable: ${error.message}`);
    }
    throw psqlExecutableMissing('required executable not found: psql');
  }
}

function isSharedWorkspace(workspace) {
  return /(^|[-_])(shared|testing-lane|main-review|main|prod|production)([-_]|$)/i.test(String(workspace || ''));
}

function redactValue(value) {
  return String(value || '')
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)([^@\s]+)(@)/gi, '$1[redacted]$3')
    .replace(/(password=)([^;\s]+)/gi, '$1[redacted]')
    .replace(/(service[_-]?role[_-]?key["']?\s*[:=]\s*["']?)([^"',\s]+)/gi, '$1[redacted]');
}

function redactPayload(value) {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactValue(value) : value;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/secret|token|password|service_role|database_url|db_url/i.test(key)) {
      out[key] = typeof entry === 'string' ? redactValue(entry) : '[redacted]';
    } else {
      out[key] = redactPayload(entry);
    }
  }
  return out;
}

function buildSummary(base = {}) {
  return redactPayload({
    generated_at: new Date().toISOString(),
    command: 'local_target_backend_create',
    ...base,
  });
}

function sourceSchemaArtifactPath(descriptor = {}, descriptorPath = '') {
  const raw =
    descriptor.schema_dump_path ||
    descriptor.schema_artifact ||
    descriptor.schema_artifact_path ||
    descriptor.dump_path ||
    descriptor.dump?.path ||
    '';
  if (!raw) return '';
  return path.resolve(path.dirname(descriptorPath), String(raw));
}

function readSourceDescriptor(descriptorPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const resolved = path.resolve(cwd, String(descriptorPath || '').trim());
  const descriptor = (options.readJsonFile || readJsonSafe)(resolved);
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error(`missing source descriptor: ${resolved}`);
  }
  const workspace = String(descriptor.workspace || '').trim();
  if (!workspace) throw new Error('source descriptor is missing workspace');
  if (descriptor.proof_data === true || descriptor.includes_proof_data === true) {
    throw new Error('source descriptor includes proof data; refusing target backend creation');
  }
  if (descriptor.dump_mode && descriptor.dump_mode !== 'schema-only') {
    throw new Error(`source descriptor dump mode is not schema-only: ${descriptor.dump_mode}`);
  }
  if (descriptor.schema_only === false || descriptor.no_data === false) {
    throw new Error('source descriptor must be schema-only and no-data');
  }
  if (descriptor.schema_ready !== true) {
    throw new Error('source descriptor is not schema-ready');
  }
  const artifactPath = sourceSchemaArtifactPath(descriptor, resolved);
  if (!artifactPath) {
    throw new Error('source descriptor is missing schema-only baseline artifact path');
  }
  return { descriptor, path: resolved, artifactPath };
}

function workspaceHash(workspace) {
  return Array.from(String(workspace || '')).reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function computeTargetPorts(workspace) {
  const base = 59000 + (workspaceHash(workspace) % 300);
  return {
    api: base,
    db: base + 1,
    studio: base + 3,
    inbucket: base + 4,
  };
}

function normalizePorts(ports = {}) {
  const normalized = {};
  for (const key of ['api', 'db', 'studio', 'inbucket']) {
    const value = Number(ports[key]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`declared target port ${key} is missing or invalid`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function targetProjectRoot(cwd, workspace, explicitRoot = '') {
  return path.resolve(
    cwd,
    explicitRoot || path.join('supabase', '.temp', 'local-target-backends', workspace),
  );
}

function prepareTargetProject({ cwd, workspace, targetRoot }) {
  const root = targetProjectRoot(cwd, workspace, targetRoot);
  const targetSupabase = path.join(root, 'supabase');
  fs.mkdirSync(path.join(targetSupabase, 'migrations'), { recursive: true });
  const sourceConfig = path.join(cwd, 'supabase', 'config.toml');
  const targetConfig = path.join(targetSupabase, 'config.toml');
  if (fs.existsSync(sourceConfig) && !fs.existsSync(targetConfig)) {
    fs.copyFileSync(sourceConfig, targetConfig);
  }
  return { root, supabase_dir: targetSupabase, config_path: targetConfig };
}

function upsertTomlSectionValue(content, section, key, value) {
  const lines = String(content || '').split(/\r?\n/);
  const sectionHeader = `[${section}]`;
  let sectionStart = lines.findIndex((line) => line.trim() === sectionHeader);
  if (sectionStart === -1) {
    const prefix = lines.length && lines[lines.length - 1].trim() ? ['', sectionHeader] : [sectionHeader];
    return [...lines, ...prefix, `${key} = ${value}`].join('\n');
  }
  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = `${key} = ${value}`;
      return lines.join('\n');
    }
  }
  lines.splice(sectionEnd, 0, `${key} = ${value}`);
  return lines.join('\n');
}

function writeSupabaseConfigPorts(configPath, ports) {
  const declared = normalizePorts(ports);
  let content = '';
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    content = '';
  }
  const updates = [
    ['api', 'port', declared.api],
    ['db', 'port', declared.db],
    ['studio', 'port', declared.studio],
    ['inbucket', 'port', declared.inbucket],
  ];
  let next = content;
  for (const [section, key, value] of updates) {
    next = upsertTomlSectionValue(next, section, key, value);
  }
  writeFile(configPath, `${next.replace(/\s+$/u, '')}\n`);
  return configPath;
}

function writeTargetPortConfig(project, workspace, ports, options = {}) {
  const declared = normalizePorts(ports);
  const writer = options.portConfigWriter;
  if (typeof writer === 'function') return writer({ project, workspace, ports: declared });
  writeSupabaseConfigPorts(project.config_path, declared);
  const targetPath = path.join(project.supabase_dir, '.temp', `target_ports_${workspace}.json`);
  writeJson(targetPath, {
    workspace,
    ports: declared,
    services: {
      api_url: `http://127.0.0.1:${declared.api}`,
      api_readiness_url: `http://127.0.0.1:${declared.api}/rest/v1/`,
      auth_url: `http://127.0.0.1:${declared.api}/auth/v1/health`,
      studio_url: `http://127.0.0.1:${declared.studio}`,
      inbucket_url: `http://127.0.0.1:${declared.inbucket}`,
      database_url: ([`postgresql`,":","/","/",`postgres`,":",`postgres`,"@",`127.0.0.1`,":",`${declared.db}`,"/",`postgres`].join("")),
    },
  });
  return targetPath;
}

function readTargetPortConfig(project, workspace, options = {}) {
  const reader = options.portConfigReader;
  if (typeof reader === 'function') return reader({ project, workspace });
  const targetPath = path.join(project.supabase_dir, '.temp', `target_ports_${workspace}.json`);
  return readJsonSafe(targetPath);
}

function assertDeclaredPortsMatch(workspace, declaredPorts, actualConfig = {}) {
  const actualPorts = actualConfig.ports || actualConfig;
  const declared = normalizePorts(declaredPorts);
  const actual = normalizePorts(actualPorts);
  const mismatches = Object.keys(declared).filter((key) => Number(declared[key]) !== Number(actual[key]));
  if (mismatches.length) {
    throw new Error(
      `target ${workspace} bound different ports than declared: ${mismatches.map((key) => `${key} ${declared[key]} != ${actual[key]}`).join(', ')}`,
    );
  }
  return actual;
}

function reserveDeclaredPorts(cwd, workspace, owner, ports) {
  const leasePath = path.join(cwd, 'supabase', '.temp', 'local_target_backend_port_reservations.json');
  const existing = readJsonSafe(leasePath);
  const reservations = Array.isArray(existing?.reservations) ? existing.reservations : [];
  const declared = normalizePorts(ports);
  writeJson(leasePath, {
    version: 1,
    reservations: [
      ...reservations.filter((entry) => entry.workspace !== workspace),
      {
        workspace,
        owner,
        ports: declared,
        reserved_at: new Date().toISOString(),
      },
    ].sort((a, b) => String(a.workspace).localeCompare(String(b.workspace))),
  });
  return leasePath;
}

function runCheckedCommand(label, command, args, options = {}) {
  const runner = options.runner || spawnSync;
  const shouldResolveExecutable = !options.runner || options.resolveExecutables === true;
  const spawnCommand = shouldResolveExecutable
    ? resolveSpawnCommand(command, args, options)
    : { command, args };
  const result = runner(spawnCommand.command, spawnCommand.args, {
    encoding: 'utf8',
    windowsHide: true,
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
  }) || {};
  const status = Number.isFinite(Number(result.status)) ? Number(result.status) : 1;
  if (status !== 0 || result.error) {
    const message = result.error?.message || result.stderr || result.stdout || `${command} exited ${status}`;
    throw new Error(`${label} failed: ${String(message).trim()}`);
  }
  return {
    label,
    command: spawnCommand.command,
    args: spawnCommand.args,
    status,
    stdout_tail: String(result.stdout || '').slice(-1000),
    stderr_tail: String(result.stderr || '').slice(-1000),
  };
}

function assertNoForbiddenCommand(command, args = []) {
  const text = [command, ...args].join(' ').toLowerCase();
  if (/\bmigrate\b|db\s+reset|db\s+push|seed\b/.test(text)) {
    throw new Error(`refusing full migration replay command path: ${text}`);
  }
}

async function checkHttpReadiness(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('HTTP readiness check requires fetch support');
  const checks = [
    ['api', config.api_readiness_url || `${String(config.api_url || '').replace(/\/+$/, '')}/rest/v1/`],
    ['auth', config.auth_url],
    ['studio', config.studio_url],
  ];
  const results = [];
  for (const [name, url] of checks) {
    const response = await fetchImpl(url, { method: 'GET' });
    const status = Number(response.status || 0);
    results.push({ name, url, status });
    if (status < 200 || status >= 400) {
      throw new Error(`${name} readiness failed with status ${status}`);
    }
  }
  return results;
}

async function collectLivePortEvidence(config, options = {}) {
  if (typeof options.liveEvidenceReader === 'function') {
    return options.liveEvidenceReader(config);
  }
  const http = await checkHttpReadiness(config, options);
  const db = runCheckedCommand('target db live listener check', options.psqlCommand || 'psql', [
    config.database_url,
    '--no-psqlrc',
    '--tuples-only',
    '--no-align',
    '--command',
    'select 1',
  ], {
    runner: options.commandRunner,
    cwd: options.cwd,
    env: options.env,
  });
  return {
    api: { port: config.ports.api, healthy: http.some((entry) => entry.name === 'api') },
    auth: { port: config.ports.api, healthy: http.some((entry) => entry.name === 'auth') },
    db: { port: config.ports.db, healthy: db.status === 0 },
    studio: { port: config.ports.studio, healthy: http.some((entry) => entry.name === 'studio') },
    http,
  };
}

function assertLiveEvidenceMatchesDeclared(workspace, declaredPorts, evidence = {}) {
  const declared = normalizePorts(declaredPorts);
  const checks = [
    ['api', declared.api],
    ['auth', declared.api],
    ['db', declared.db],
    ['studio', declared.studio],
  ];
  const failures = [];
  for (const [name, port] of checks) {
    const item = evidence[name];
    if (!item || item.healthy !== true) {
      failures.push(`${name}_health_missing`);
      continue;
    }
    if (Number(item.port) !== Number(port)) {
      failures.push(`${name}_port ${port} != ${item.port}`);
    }
  }
  if (failures.length) {
    throw new Error(`target ${workspace} live binding proof failed: ${failures.join(', ')}`);
  }
  return evidence;
}

function writeEnvHandoff(envOut, config, context = {}) {
  if (!envOut) return '';
  writeFile(envOut, [
    `LOCAL_TARGET_BACKEND_OWNER=${context.owner || ''}`,
    `LOCAL_TARGET_BACKEND_WORKSPACE=${config.workspace}`,
    `LOCAL_TARGET_BACKEND_SOURCE_WORKSPACE=${context.sourceWorkspace || ''}`,
    `SUPABASE_URL=${config.api_url}`,
    `VITE_SUPABASE_URL=${config.api_url}`,
    `DATABASE_URL=${config.database_url}`,
    '',
  ].join('\n'));
  return envOut;
}

function writeLeaseRecord(cwd, lease) {
  const leasePath = path.join(cwd, 'supabase', '.temp', 'local_target_backend_leases.json');
  const existing = readJsonSafe(leasePath);
  const leases = Array.isArray(existing?.leases) ? existing.leases : [];
  writeJson(leasePath, {
    version: 1,
    leases: [
      ...leases.filter((entry) => entry.workspace !== lease.workspace),
      lease,
    ].sort((a, b) => String(a.workspace).localeCompare(String(b.workspace))),
  });
  return leasePath;
}

function normalizeSchemaIdentifier(identifier) {
  const text = String(identifier || '').trim();
  const quoted = text.match(/^"((?:""|[^"])*)"$/);
  if (quoted) return quoted[1].replace(/""/g, '"');
  return text;
}

function quoteSqlIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function quoteSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function splitPolicyRoleList(roleList) {
  const roles = [];
  let current = '';
  let inQuote = false;
  for (let index = 0; index < String(roleList || '').length; index += 1) {
    const char = roleList[index];
    if (char === '"') {
      current += char;
      if (inQuote && roleList[index + 1] === '"') {
        current += roleList[index + 1];
        index += 1;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (char === ',' && !inQuote) {
      roles.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) roles.push(current.trim());
  return roles.filter(Boolean);
}

function normalizePolicyRoleToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const quoted = raw.match(/^"((?:""|[^"])*)"$/);
  if (quoted) return quoted[1].replace(/""/g, '"');
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(raw)) return raw;
  throw new Error(`cannot classify policy role token for target restore: ${raw}`);
}

function collectPolicyPreludeRoles(sql) {
  const roles = new Set();
  const policyPattern = /CREATE\s+POLICY\s+[\s\S]*?;/gi;
  for (const match of String(sql || '').matchAll(policyPattern)) {
    const statement = match[0];
    const roleMatch = statement.match(/\sTO\s+([\s\S]*?)\s+(?:USING|WITH\s+CHECK)\b/i);
    if (!roleMatch) continue;
    for (const token of splitPolicyRoleList(roleMatch[1])) {
      const roleName = normalizePolicyRoleToken(token);
      if (!roleName) continue;
      const normalized = roleName.toLowerCase();
      if (BUILTIN_POLICY_ROLES.has(normalized)) continue;
      if (['current_role', 'current_user', 'session_user'].includes(normalized)) continue;
      roles.add(roleName);
    }
  }
  return Array.from(roles).sort((a, b) => a.localeCompare(b));
}

function buildPolicyRolePrelude(roles) {
  if (!roles.length) return '';
  return [
    '--',
    '-- Local target restore role prelude.',
    '-- Creates schema-only policy roles as NOLOGIN before strict policy replay.',
    '--',
    ...roles.map((roleName) => [
      'DO $$',
      'BEGIN',
      `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${quoteSqlLiteral(roleName)}) THEN`,
      `    CREATE ROLE ${quoteSqlIdentifier(roleName)} NOLOGIN;`,
      '  END IF;',
      'END',
      '$$;',
      '',
    ].join('\n')),
  ].join('\n');
}

function filterManagedSchemaRestoreBlocks(sql) {
  const skipped = [];
  const filteredSql = String(sql || '').replace(MANAGED_SCHEMA_BLOCK_PATTERN, (block, rawSchema) => {
    const schemaName = normalizeSchemaIdentifier(rawSchema);
    if (!SUPABASE_BOOTSTRAP_SCHEMAS.has(schemaName)) return block;
    const name = (block.match(/^-- Name: (.*?); Type: /m) || [])[1] || '[unknown]';
    const type = (block.match(/; Type: (.*?); Schema: /m) || [])[1] || '[unknown]';
    skipped.push({ schema: schemaName, name, type });
    return [
      '--',
      `-- Skipped Supabase-managed schema object during local target restore: ${schemaName}.${name} (${type})`,
      '--',
      '',
    ].join('\n');
  });
  return { sql: filteredSql, skipped };
}

function filterManagedPublicationRestoreBlocks(sql) {
  const skipped = [];
  const filteredSql = String(sql || '').replace(MANAGED_PUBLICATION_BLOCK_PATTERN, (block, rawName) => {
    const publicationName = normalizeSchemaIdentifier(rawName);
    if (!SUPABASE_BOOTSTRAP_PUBLICATIONS.has(publicationName)) return block;
    skipped.push({ name: publicationName, type: 'PUBLICATION' });
    return [
      '--',
      `-- Skipped Supabase-managed publication during local target restore: ${publicationName}`,
      '--',
      '',
    ].join('\n');
  });
  return { sql: filteredSql, skipped };
}

function normalizeQualifiedFunctionName(value) {
  const match = String(value || '').trim().match(/^((?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*))\.((?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*))$/);
  if (!match) return '';
  return `${normalizeSchemaIdentifier(match[1])}.${normalizeSchemaIdentifier(match[2])}`;
}

function filterManagedEventTriggerRestoreBlocks(sql) {
  const skipped = [];
  const filteredSql = String(sql || '').replace(MANAGED_EVENT_TRIGGER_BLOCK_PATTERN, (block, rawName) => {
    const triggerName = normalizeSchemaIdentifier(rawName);
    const expectedFunction = SUPABASE_BOOTSTRAP_EVENT_TRIGGERS.get(triggerName);
    if (!expectedFunction) return block;
    const functionMatch = block.match(/EXECUTE\s+FUNCTION\s+((?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*)\.(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*))\s*\(/i);
    const actualFunction = normalizeQualifiedFunctionName(functionMatch?.[1] || '');
    if (actualFunction !== expectedFunction) return block;
    skipped.push({ name: triggerName, function: actualFunction, type: 'EVENT TRIGGER' });
    return [
      '--',
      `-- Skipped Supabase-managed event trigger during local target restore: ${triggerName} -> ${actualFunction}`,
      '--',
      '',
    ].join('\n');
  });
  return { sql: filteredSql, skipped };
}

function prepareSchemaArtifactForTargetRestore(artifactPath, project, options = {}) {
  const sourceSql = String(
    (options.readTextFile || ((filePath) => fs.readFileSync(filePath, 'utf8')))(artifactPath),
  );
  const managedFilter = filterManagedSchemaRestoreBlocks(sourceSql);
  const publicationFilter = filterManagedPublicationRestoreBlocks(managedFilter.sql);
  const eventTriggerFilter = filterManagedEventTriggerRestoreBlocks(publicationFilter.sql);
  const rewrittenSchemas = [];
  const rewrittenSql = eventTriggerFilter.sql.replace(
    /^CREATE SCHEMA\s+((?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*));\s*$/gm,
    (statement, rawSchema) => {
      const schemaName = normalizeSchemaIdentifier(rawSchema);
      if (!SUPABASE_BOOTSTRAP_SCHEMAS.has(schemaName)) return statement;
      rewrittenSchemas.push(schemaName);
      return `CREATE SCHEMA IF NOT EXISTS ${rawSchema};`;
    },
  );
  const uniqueSchemas = Array.from(new Set(rewrittenSchemas)).sort();
  const skippedManagedSchemas = Array.from(new Set(managedFilter.skipped.map((entry) => entry.schema))).sort();
  const preludeRoles = collectPolicyPreludeRoles(rewrittenSql);
  const rolePrelude = buildPolicyRolePrelude(preludeRoles);
  if (!uniqueSchemas.length && !managedFilter.skipped.length && !publicationFilter.skipped.length && !eventTriggerFilter.skipped.length && !preludeRoles.length) {
    return {
      path: artifactPath,
      bootstrap_schema_policy: 'unchanged',
      rewritten_bootstrap_schemas: [],
      managed_schema_filter: 'unchanged',
      skipped_managed_schema_objects: [],
      managed_publication_filter: 'unchanged',
      skipped_managed_publications: [],
      managed_event_trigger_filter: 'unchanged',
      skipped_managed_event_triggers: [],
      policy_role_prelude: 'unchanged',
      policy_role_prelude_roles: [],
    };
  }
  const restoreDir = path.join(project.supabase_dir, '.temp', 'target-restore');
  fs.mkdirSync(restoreDir, { recursive: true });
  const restoreArtifact = path.join(
    restoreDir,
    `${path.basename(artifactPath).replace(/\.sql$/i, '')}.bootstrap-aware.sql`,
  );
  writeFile(restoreArtifact, `${rolePrelude}${rewrittenSql}`);
  return {
    path: restoreArtifact,
    source_path: artifactPath,
    bootstrap_schema_policy: 'create_schema_if_not_exists',
    rewritten_bootstrap_schemas: uniqueSchemas,
    managed_schema_filter: managedFilter.skipped.length ? 'skip_supabase_managed_schema_objects' : 'unchanged',
    skipped_managed_schema_objects: managedFilter.skipped,
    skipped_managed_schemas: skippedManagedSchemas,
    managed_publication_filter: publicationFilter.skipped.length ? 'skip_supabase_managed_publications' : 'unchanged',
    skipped_managed_publications: publicationFilter.skipped,
    managed_event_trigger_filter: eventTriggerFilter.skipped.length ? 'skip_supabase_managed_event_triggers' : 'unchanged',
    skipped_managed_event_triggers: eventTriggerFilter.skipped,
    policy_role_prelude: preludeRoles.length ? 'create_missing_nologin_policy_roles' : 'unchanged',
    policy_role_prelude_roles: preludeRoles,
  };
}

async function createTargetBackend(args = {}, options = {}) {
  const cwd = options.cwd || process.cwd();
  const owner = String(firstValue(args.owner) || '').trim();
  const workspace = String(firstValue(args.workspace) || '').trim();
  const descriptorPath = firstValue(args['source-descriptor'] || args.source_descriptor);
  const summaryOut = firstValue(args['summary-out'] || args.summary_out);
  const envOut = firstValue(args['env-out'] || args.env_out);
  if (!owner) throw new Error('missing --owner');
  if (!workspace) throw new Error('missing --workspace');
  if (!descriptorPath) throw new Error('missing --source-descriptor');
  if (isSharedWorkspace(workspace)) throw new Error(`refusing shared target workspace ${workspace}`);
  let summaryBase = { owner, workspace };
  try {
    const { descriptor, path: resolvedDescriptor, artifactPath } = readSourceDescriptor(descriptorPath, {
      cwd,
      readJsonFile: options.readJsonFile,
    });
    const sourceWorkspace = String(descriptor.workspace || '').trim();
    if (workspace === sourceWorkspace) {
      throw new Error('target workspace must differ from source workspace');
    }
    summaryBase = {
      ...summaryBase,
      source_workspace: sourceWorkspace,
      source_descriptor: resolvedDescriptor,
      schema_artifact: artifactPath,
    };
    const psqlCommand = resolveTargetPsqlExecutable(args, options);
    const ports = normalizePorts(options.ports || computeTargetPorts(workspace));
    const project = prepareTargetProject({
      cwd,
      workspace,
      targetRoot: firstValue(args['target-root'] || args.target_root),
    });
    const portConfigPath = writeTargetPortConfig(project, workspace, ports, options);
    const verifiedPortConfig = readTargetPortConfig(project, workspace, options);
    assertDeclaredPortsMatch(workspace, ports, verifiedPortConfig?.ports || verifiedPortConfig);
    const portReservationPath = reserveDeclaredPorts(cwd, workspace, owner, ports);
    const restoreArtifact = prepareSchemaArtifactForTargetRestore(artifactPath, project, options);
    summaryBase = {
      ...summaryBase,
      restore_artifact: restoreArtifact.path,
      bootstrap_schema_restore: {
        policy: restoreArtifact.bootstrap_schema_policy,
        rewritten_schemas: restoreArtifact.rewritten_bootstrap_schemas,
        managed_schema_filter: restoreArtifact.managed_schema_filter,
        skipped_managed_schemas: restoreArtifact.skipped_managed_schemas || [],
        skipped_managed_object_count: (restoreArtifact.skipped_managed_schema_objects || []).length,
        managed_publication_filter: restoreArtifact.managed_publication_filter,
        skipped_managed_publications: restoreArtifact.skipped_managed_publications || [],
        managed_event_trigger_filter: restoreArtifact.managed_event_trigger_filter,
        skipped_managed_event_triggers: restoreArtifact.skipped_managed_event_triggers || [],
        policy_role_prelude: restoreArtifact.policy_role_prelude,
        policy_role_prelude_roles: restoreArtifact.policy_role_prelude_roles || [],
      },
    };
    const runner = options.commandRunner;
    const commands = [];
    const startArgs = ['supabase', 'start', '--ignore-health-check'];
    assertNoForbiddenCommand('npx', startArgs);
    commands.push(runCheckedCommand('isolated supabase service start', 'npx', startArgs, {
      runner,
      cwd: project.root,
      env: options.env,
    }));
    const databaseUrl = ([`postgresql`,":","/","/",`postgres`,":",`postgres`,"@",`127.0.0.1`,":",`${ports.db}`,"/",`postgres`].join(""));
    const restoreArgs = [
      databaseUrl,
      '--set',
      'ON_ERROR_STOP=1',
      '--file',
      restoreArtifact.path,
    ];
    assertNoForbiddenCommand('psql', restoreArgs);
    commands.push(runCheckedCommand('schema-only target restore', psqlCommand, restoreArgs, {
      runner,
      cwd,
      env: options.env,
    }));
    const config = {
      workspace,
      ports,
      database_url: databaseUrl,
      api_url: `http://127.0.0.1:${ports.api}`,
      api_readiness_url: `http://127.0.0.1:${ports.api}/rest/v1/`,
      auth_url: `http://127.0.0.1:${ports.api}/auth/v1/health`,
      studio_url: `http://127.0.0.1:${ports.studio}`,
      inbucket_url: `http://127.0.0.1:${ports.inbucket}`,
    };
    const liveEvidence = await collectLivePortEvidence(config, {
      ...options,
      cwd,
      commandRunner: runner,
      psqlCommand,
    });
    assertLiveEvidenceMatchesDeclared(workspace, ports, liveEvidence);
    const lease = {
      id: `local-target-backend:${workspace}`,
      resource: 'backend-supabase',
      workspace,
      owner,
      health: 'ok',
      ports,
      details: {
        api_url: config.api_url,
        api_readiness_url: config.api_readiness_url,
        auth_url: config.auth_url,
        studio_url: config.studio_url,
        inbucket_url: config.inbucket_url,
        database_url: config.database_url,
        schema_only_baseline: true,
      },
      created_at: new Date().toISOString(),
    };
    const leasePath = writeLeaseRecord(cwd, lease);
    const envPath = envOut ? path.resolve(cwd, envOut) : '';
    writeEnvHandoff(envPath, config, { owner, sourceWorkspace });
    const summary = buildSummary({
      status: 'complete',
      reason: 'local_target_backend_created',
      ...summaryBase,
      target: {
        workspace,
        lease_id: lease.id,
        lease_path: leasePath,
        port_config_path: portConfigPath,
        port_reservation_path: portReservationPath,
        ports,
        database_url: config.database_url,
        api_url: config.api_url,
        auth_url: config.auth_url,
        studio_url: config.studio_url,
      },
      refused_actions: {
        full_migration_replay: true,
        proof_data_copy: true,
        shared_target: true,
      },
      commands,
      readiness: liveEvidence.http || [],
      live_port_evidence: liveEvidence,
      env_out: envPath,
    });
    if (summaryOut) writeJson(path.resolve(cwd, summaryOut), summary);
    return summary;
  } catch (error) {
    const summary = buildSummary({
      status: 'blocked',
      reason: error.reason || 'local_target_backend_failed_closed',
      ...summaryBase,
      error: error.message,
      rollback: {
        env_written: false,
        target_must_be_discarded_or_recreated: true,
      },
    });
    if (summaryOut) writeJson(path.resolve(cwd, summaryOut), summary);
    throw error;
  }
}

function usage() {
  return [
    'Usage: node scripts/ops/workspace/local-target-backend.js <command> [options]',
    '',
    'Commands:',
    '  create --owner <owner> --workspace <target> --source-descriptor <schema-only-json> --summary-out <json> --env-out <ignored-env> [--psql-path <path>] [--json]',
    '',
    'Creates an isolated local backend target from a schema-only baseline artifact.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (['help', '--help', '-h'].includes(args.command) || isTruthy(args.help)) {
    console.log(usage());
    return;
  }
  if (args.command !== 'create') throw new Error(`unknown command: ${args.command}\n\n${usage()}`);
  try {
    const summary = await createTargetBackend(args);
    if (isTruthy(args.json)) console.log(JSON.stringify(summary, null, 2));
    else console.log(`[local-target-backend] ${summary.status}: ${summary.reason}`);
  } catch (error) {
    if (isTruthy(args.json)) {
      console.log(JSON.stringify(buildSummary({
        status: 'blocked',
        reason: 'local_target_backend_failed_closed',
        error: error.message,
      }), null, 2));
    }
    console.error(`[local-target-backend] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  assertNoForbiddenCommand,
  assertDeclaredPortsMatch,
  assertLiveEvidenceMatchesDeclared,
  buildSummary,
  checkHttpReadiness,
  collectLivePortEvidence,
  computeTargetPorts,
  createTargetBackend,
  isSharedWorkspace,
  parseArgs,
  prepareTargetProject,
  prepareSchemaArtifactForTargetRestore,
  readTargetPortConfig,
  readSourceDescriptor,
  redactPayload,
  reserveDeclaredPorts,
  resolveCommandOnPath,
  resolveRequiredExecutable,
  resolveSpawnCommand,
  resolveTargetPsqlExecutable,
  resolveWindowsShortPath,
  runCheckedCommand,
  writeTargetPortConfig,
  writeEnvHandoff,
  writeLeaseRecord,
};
