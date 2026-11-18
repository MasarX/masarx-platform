#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseFlagArgs } = require('../../utils/cli-args');
const { resolveImpactSelectionForChangedFiles, compileImpactMap } = require('./pr-change-classify');
const {
  resolveFocusedUnitSelection,
  resolveJestInvocation,
  validateCanonicalImpactSelection,
} = require('./focused-unit-selection');
const {
  addLocalGateManifestContract,
  digestManifest,
  sha256,
  resolveSafeLocalGateManifestPath,
  writeLocalGateManifestAtomic,
} = require('./local-gate-manifest');
const {
  isPackageManifest,
  isRootPackageLock,
  isLockGeneratorContractPath,
} = require('./dependency-fast-lane-integrity');

const ROOT_PACKAGE = require(path.join(__dirname, '..', '..', '..', 'package.json'));
const ROOT_NX_PROJECT = String(ROOT_PACKAGE?.name || 'masarx-delivery-platform').trim();
const NX_TASK_RUNNER_PATH = 'scripts/ops/ci/nx-task-runner.js';
const LOCAL_ENV_FILE = path.join('config', 'env', '.env.local');
const HIGH_RISK_SURFACE_IDS = new Set(['db', 'api_ingress', 'mobile_fieldops']);
const HIGH_RISK_IMPACT_IDS = new Set(['shared']);
const SCOPED_CONTROL_PLANE_IMPACT_IDS = new Set(['ci', 'docs']);
const DEFAULT_LOCAL_GATE_REMOTE_VERIFY_TIMEOUT_MINUTES = 360;
const DEFAULT_LOCAL_GATE_REMOTE_VERIFY_POLL_SECONDS = 15;
const LOCAL_GATE_LANDING_BUILD_ENV = {
  LANDING_SITE_URL: 'http://127.0.0.1:3333',
  LANDING_CONTACT_ENDPOINT: '/__landing-contact',
  LANDING_TENANT_SIGNUP_ENDPOINT: '/__tenant-signup',
};
const CONTROL_PLANE_PATTERNS = [
  /^\.github\//,
  /^config\/ci\//,
  /^scripts\/ops\/ci\//,
  /^config\/ops\//,
  /^scripts\/ops\/leader\//,
  /^scripts\/workers\//,
];
const TOOLING_ONLY_PATH_PATTERNS = [
  /^\.github\//,
  /^config\/ci\//,
  /^config\/tooling\//,
  /^docs\//,
  /^scripts\/docs\//,
  /^scripts\/ops\//,
  /^scripts\/utils\/pg-hostaddr\.js$/,
  /^scripts\/tests\//,
  /^tests\//,
  /^tests\/unit\//,
  /^tests\/ui\//,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^package(-lock)?\.json$/,
  /^nx\.json$/,
  /^project\.json$/,
  /^tooling\//,
  /^\.gitignore$/,
];
const TOOLING_UI_RELATED_PATTERNS = [
  /^packages\/ui\//,
  /^tests\/ui\//,
  /^config\/tooling\/jest\.config\.ui\.js$/,
];
const TOOLING_DOCS_RELATED_PATTERNS = [
  /^docs\//,
  /^scripts\/docs\//,
  /^scripts\/tooling\/docs-ssot-lint\.js$/,
];
const TOOLING_LANDING_RELATED_PATTERNS = [
  /^apps\/landing\//,
  /^tests\/landing-e2e\//,
  /^playwright\.landing\.config\.ts$/,
  /^scripts\/frontend\/build-landing\.js$/,
];
const TOOLING_DOCS_OPENAPI_RELATED_PATTERNS = [
  /^docs\/api\//,
  /^scripts\/docs\/generate-public-openapi\.js$/,
];

function die(message) {
  console.error(`[local-gate] ${message}`);
  process.exit(1);
}

function normalizePath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function normalizeSuiteId(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function uniq(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function parsePositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthy(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
}

function buildRemoteVerifyArgs({
  mode,
  remoteVerifyEnv,
  remoteWorkflowRef,
  verifyRef,
  env = process.env,
} = {}) {
  const timeoutMinutes = parsePositiveInt(
    env.LOCAL_GATE_REMOTE_VERIFY_TIMEOUT_MINUTES,
    DEFAULT_LOCAL_GATE_REMOTE_VERIFY_TIMEOUT_MINUTES,
  );
  const pollSeconds = parsePositiveInt(
    env.LOCAL_GATE_REMOTE_VERIFY_POLL_SECONDS,
    DEFAULT_LOCAL_GATE_REMOTE_VERIFY_POLL_SECONDS,
  );

  return [
    'run',
    'remote:verify',
    '--',
    '--env',
    remoteVerifyEnv,
    '--mode',
    String(mode || '').trim(),
    ...(remoteWorkflowRef ? ['--workflow-ref', remoteWorkflowRef] : []),
    '--ref',
    verifyRef,
    '--timeout-minutes',
    String(timeoutMinutes),
    '--poll-seconds',
    String(pollSeconds),
  ];
}

function prependRemoteVerifyRoutePreflight(commands) {
  const remoteSteps = (Array.isArray(commands) ? commands : []).filter((entry) => (
    entry?.command === npmCommand()
    && Array.isArray(entry.args)
    && entry.args[0] === 'run'
    && entry.args[1] === 'remote:verify'
  ));
  if (!remoteSteps.length) return commands;
  const representative = remoteSteps.find((entry) => /backend_remote_verify/.test(entry.command_id))
    || remoteSteps[0];
  commands.unshift({
    command_id: 'remote_verify_route_preflight',
    suite_ids: uniq(remoteSteps.flatMap((entry) => entry.suite_ids || [])),
    surface_ids: uniq(remoteSteps.flatMap((entry) => entry.surface_ids || [])),
    command: representative.command,
    args: [...representative.args, '--preflight-only'],
    env: {},
  });
  return commands;
}

function hasDbUrlInEnv(env = process.env) {
  return ['DATABASE_URL', 'DATABASE_URL_DIRECT', 'DATABASE_URL_POOLER']
    .some((key) => String(env?.[key] || '').trim().length > 0);
}

function resolveDbUrlValuesFromEnv(env = process.env) {
  return uniq(
    ['DATABASE_URL', 'DATABASE_URL_DIRECT', 'DATABASE_URL_POOLER']
      .map((key) => String(env?.[key] || '').trim())
      .filter(Boolean),
  );
}

function envFileCandidates({ cwd = process.cwd(), env = process.env } = {}) {
  const repoRoot = path.resolve(cwd);
  const explicit = String(env?.ENV_FILE || '').trim();
  const candidates = [];
  if (explicit) {
    candidates.push(path.isAbsolute(explicit) ? explicit : path.resolve(repoRoot, explicit));
  }
  candidates.push(
    path.join(repoRoot, 'config', 'env', '.env.cloud'),
    path.join(repoRoot, 'config', 'env', '.env.local'),
    path.join(repoRoot, 'config', 'env', '.env'),
    path.join(repoRoot, '.env'),
  );
  return uniq(candidates);
}

function envFileContainsDbUrl(filePath) {
  const target = String(filePath || '').trim();
  if (!target || !fs.existsSync(target)) return false;
  const body = fs.readFileSync(target, 'utf8');
  return /^\s*(DATABASE_URL|DATABASE_URL_DIRECT|DATABASE_URL_POOLER)\s*=/m.test(body);
}

function resolveDbUrlValuesFromFile(filePath) {
  const target = String(filePath || '').trim();
  if (!target || !fs.existsSync(target)) return [];
  const body = fs.readFileSync(target, 'utf8');
  const matches = body.matchAll(/^\s*(DATABASE_URL|DATABASE_URL_DIRECT|DATABASE_URL_POOLER)\s*=\s*(.+)\s*$/gm);
  const values = [];
  for (const match of matches) {
    const rawValue = String(match?.[2] || '').trim().replace(/^['"`]|['"`]$/g, '');
    if (rawValue) values.push(rawValue);
  }
  return uniq(values);
}

function parseDbEndpoint(dsn) {
  try {
    const parsed = new URL(String(dsn || '').trim());
    const host = String(parsed.hostname || '').trim().toLowerCase();
    const port = Number.parseInt(String(parsed.port || '').trim(), 10) || 5432;
    if (!host || !Number.isFinite(port) || port <= 0) return null;
    return { host, port };
  } catch {
    return null;
  }
}

function isLocalDbHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  // objectives:allow LOCALHOST Justification: local admission must recognize loopback DSNs so developer-local database checks stay fail-closed without treating hosted databases as local.
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === 'rvzwwjlztwwisjthghnipgjr.example.invalid';
}

function withLocalGateChildEnv(env = process.env) {
  return {
    ...(env && typeof env === 'object' ? env : {}),
    NX_DAEMON: 'false',
  };
}
function canReachDbEndpointSync({ host, port, timeoutMs = 750 } = {}) {
  const endpointHost = String(host || '').trim();
  const endpointPort = Number.parseInt(String(port || '').trim(), 10);
  if (!endpointHost || !Number.isFinite(endpointPort) || endpointPort <= 0) return false;
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      [
        'const net = require("net");',
        'const host = process.argv[1];',
        'const port = Number(process.argv[2]);',
        'const timeoutMs = Number(process.argv[3]) || 750;',
        'const socket = net.createConnection({ host, port });',
        'let settled = false;',
        'const finish = (ok) => {',
        '  if (settled) return;',
        '  settled = true;',
        '  try { socket.destroy(); } catch {}',
        '  process.exit(ok ? 0 : 1);',
        '};',
        'socket.setTimeout(timeoutMs, () => finish(false));',
        'socket.once("connect", () => finish(true));',
        'socket.once("error", () => finish(false));',
      ].join(' '),
      endpointHost,
      String(endpointPort),
      String(timeoutMs),
    ],
    {
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: Math.max(timeoutMs + 250, 1000),
      windowsHide: true,
    },
  );
  return !probe.error && probe.status === 0;
}

function canQueryDbSync({ dsn, timeoutMs = 1250 } = {}) {
  const resolvedDsn = String(dsn || '').trim();
  const resolvedTimeoutMs = Number.parseInt(String(timeoutMs || '').trim(), 10);
  if (!resolvedDsn) return false;
  const probeTimeoutMs = Number.isFinite(resolvedTimeoutMs) && resolvedTimeoutMs > 0
    ? resolvedTimeoutMs
    : 1250;
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      [
        'const { Client } = require("pg");',
        'const dsn = process.argv[1];',
        'const timeoutMs = Number(process.argv[2]) || 1250;',
        '(async () => {',
        '  let ok = false;',
        '  const client = new Client({',
        '    connectionString: dsn,',
        '    connectionTimeoutMillis: timeoutMs,',
        '    query_timeout: timeoutMs,',
        '    statement_timeout: timeoutMs,',
        '    keepAlive: false,',
        '  });',
        '  try {',
        '    await client.connect();',
        '    await client.query("select 1");',
        '    ok = true;',
        '  } catch {}',
        '  finally {',
        '    try { await client.end(); } catch {}',
        '  }',
        '  process.exit(ok ? 0 : 1);',
        '})().catch(() => process.exit(1));',
      ].join(' '),
      resolvedDsn,
      String(probeTimeoutMs),
    ],
    {
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: Math.max(probeTimeoutMs + 500, 1500),
      windowsHide: true,
    },
  );
  return !probe.error && probe.status === 0;
}

function hasLocalDockerRuntimeSync({ timeoutMs = 5000 } = {}) {
  const probe = spawnSync(
    'docker',
    ['info'],
    {
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: Math.max(Number.parseInt(String(timeoutMs || '').trim(), 10) || 0, 1000),
      windowsHide: true,
    },
  );
  return !probe.error && probe.status === 0;
}

function hasDocsOpenApiDbAccess({ cwd = process.cwd(), env = process.env } = {}) {
  const candidates = resolveDocsOpenApiDbCandidates({ cwd, env });
  const allowRemoteDocsCheck = /^(1|true|yes)$/i.test(
    String(env.DOCS_OPENAPI_ALLOW_REMOTE_DB_LOCAL_CHECK || '').trim(),
  );
  if (!candidates.length) return false;
  for (const candidate of candidates) {
    const endpoint = candidate.endpoint;
    if (!isLocalDbHost(endpoint.host)) {
      if (allowRemoteDocsCheck) return true;
      continue;
    }
    if (!canReachDbEndpointSync(endpoint)) continue;
    if (canQueryDbSync({ dsn: candidate.dsn })) return true;
  }
  return false;
}

function resolveRemoteVerifyEnvironment(baseRef = '') {
  const normalized = String(baseRef || '').trim().replace(/^origin\//, '').toLowerCase();
  if (normalized === 'main') return 'stg';
  return 'dev';
}

function parseArgs(argv = process.argv.slice(2)) {
  const flags = parseFlagArgs(argv);
  const pathArgs = [];
  for (const value of String(flags.paths || '').split(',')) {
    const normalized = normalizePath(value);
    if (normalized) pathArgs.push(normalized);
  }
  for (const value of flags._ || []) {
    const normalized = normalizePath(value);
    if (normalized) pathArgs.push(normalized);
  }
  return {
    format: String(flags.format || 'json').trim().toLowerCase(),
    mode: String(flags.mode || 'auto').trim().toLowerCase(),
    baseRef: String(flags['base-ref'] || '').trim(),
    baseSha: String(flags['base-sha'] || '').trim(),
    sha: String(flags.sha || '').trim(),
    paths: uniq(pathArgs),
    manifestDir: String(flags['manifest-dir'] || '.tmp/local-gate').trim(),
  };
}

function npmCommand() {
  return 'npm';
}

function normalizeRefBranchName(value) {
  const normalized = String(value || '').trim().replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  return normalized;
}

function resolveLocalGateRemoteVerifyEnv({ env = process.env, baseRef = '' } = {}) {
  const explicit = String(env?.LOCAL_GATE_REMOTE_VERIFY_ENV || '').trim().toLowerCase();
  if (explicit) {
    if (explicit === 'dev' || explicit === 'stg') return explicit;
    die(`Unsupported LOCAL_GATE_REMOTE_VERIFY_ENV="${explicit}". Expected dev or stg.`);
  }
  const normalizedBaseRef = normalizeRefBranchName(baseRef).toLowerCase();
  if (normalizedBaseRef === 'main') return 'stg';
  return 'dev';
}

function shellRequired(command) {
  return process.platform === 'win32' && (command === 'npm' || /\.cmd$/i.test(command));
}

function runCommand(command, args, env = process.env) {
  const startedAt = Date.now();
  const res = spawnSync(command, args, {
    stdio: 'inherit',
    env: withLocalGateChildEnv(env),
    shell: shellRequired(command),
  });
  const durationMs = Date.now() - startedAt;
  if (res.error) {
    res.error.durationMs = durationMs;
    throw res.error;
  }
  if (res.status !== 0) {
    const error = new Error(`exit ${res.status}`);
    error.durationMs = durationMs;
    throw error;
  }
  return durationMs;
}

function stripLocalGateEnv(env = process.env) {
  const sanitized = { ...(env && typeof env === 'object' ? env : {}) };
  for (const key of Object.keys(sanitized)) {
    if (/^LOCAL_GATE_/i.test(String(key || '').trim())) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function sampleHostResources(previousCpu, osImpl = os) {
  const cpuSnapshot = osImpl.cpus().map((cpu) => ({ idle: Number(cpu?.times?.idle || 0),
    total: Object.values(cpu?.times || {}).reduce((sum, value) => sum + Number(value || 0), 0) }));
  let idle = 0;
  let total = 0;
  cpuSnapshot.forEach((cpu, index) => {
    idle += Math.max(0, cpu.idle - Number(previousCpu?.[index]?.idle || 0));
    total += Math.max(0, cpu.total - Number(previousCpu?.[index]?.total || 0));
  });
  return { cpu_snapshot: cpuSnapshot, available_ram_bytes: Number(osImpl.freemem()),
    cpu_percent: total > 0 ? Number((100 - ((idle / total) * 100)).toFixed(3)) : 100 };
}
function waitForBrowserAdmissionSync({
  env = process.env, validateOnly = false, testConfig,
  nowImpl = () => Number(process.hrtime.bigint() / 1000000n),
  sleepImpl = (durationMs) => Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, durationMs),
  ),
  sampleHostResourcesImpl = sampleHostResources,
} = {}) {
  const invalidConfig = (key) => {
    const error = new Error(`local_gate_browser_admission_config_invalid:${key}`);
    Object.assign(error, { code: 'browser_resource_admission_config_invalid', failureClass: 'infrastructure' });
    throw error;
  };
  const fields = [
    ['minimum_available_ram_gib', 'LOCAL_GATE_BROWSER_MIN_AVAILABLE_RAM_GIB', 10, 10, 1024],
    ['maximum_cpu_percent', 'LOCAL_GATE_BROWSER_MAX_CPU_PERCENT', 90, 1, 90],
    ['timeout_ms', 'LOCAL_GATE_BROWSER_ADMISSION_TIMEOUT_MS', 180000, 30000, 600000],
    ['stable_window_ms', 'LOCAL_GATE_BROWSER_STABLE_WINDOW_MS', 30000, 30000, 600000],
    ['sample_interval_ms', 'LOCAL_GATE_BROWSER_SAMPLE_INTERVAL_MS', 1000, 100, 5000],
  ];
  const config = Object.fromEntries(fields.map(([name, key, fallback, min, max]) => {
    const raw = String(env?.[key] ?? '').trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isFinite(value) || value < min || value > max) invalidConfig(key);
    return [name, value];
  }));
  config.minimum_available_ram_bytes = config.minimum_available_ram_gib * 1024 ** 3;
  if (config.stable_window_ms > config.timeout_ms || config.sample_interval_ms > config.stable_window_ms) {
    invalidConfig('window_order');
  }
  if (validateOnly) return config;
  Object.assign(config, testConfig || {});

  const startedAtMs = Number(nowImpl());
  const deadlineAtMs = startedAtMs + config.timeout_ms;
  let stableSinceMs = null;
  let lastSample = null;
  let previousCpu = [];
  while (true) {
    const observedAtMs = Number(nowImpl());
    let sample = {};
    try {
      sample = sampleHostResourcesImpl(previousCpu);
      previousCpu = sample.cpu_snapshot || previousCpu;
    } catch (error) {
      sample = { probe_error: String(error?.message || error) };
    }
    lastSample = { available_ram_bytes: Number(sample.available_ram_bytes || 0),
      cpu_percent: Number.isFinite(Number(sample.cpu_percent)) ? Number(sample.cpu_percent) : null,
      resource_probe_error: String(sample.probe_error || '') };
    lastSample.ready = lastSample.available_ram_bytes > config.minimum_available_ram_bytes
      && lastSample.cpu_percent < config.maximum_cpu_percent
      && !lastSample.resource_probe_error;
    if (lastSample.ready) {
      if (stableSinceMs === null) stableSinceMs = observedAtMs;
      if (observedAtMs - stableSinceMs >= config.stable_window_ms) {
        return { ...config, status: 'passed', duration_ms: observedAtMs - startedAtMs,
          nx_daemon_disabled: true, prior_phase_children_complete: true, final_sample: lastSample };
      }
    } else {
      stableSinceMs = null;
    }
    if (observedAtMs >= deadlineAtMs) {
      const error = new Error('local_gate_browser_admission_timeout');
      Object.assign(error, { code: 'browser_resource_admission_timeout', failureClass: 'infrastructure' });
      error.admission = { ...config, status: 'failed', duration_ms: observedAtMs - startedAtMs,
        nx_daemon_disabled: true, prior_phase_children_complete: true, final_sample: lastSample };
      throw error;
    }
    sleepImpl(Math.min(config.sample_interval_ms, Math.max(1, deadlineAtMs - observedAtMs)));
  }
}

function isSupabaseHttpPlaneUnavailableSync(env = process.env, options = {}) {
  const supabaseUrl = String(env?.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (!supabaseUrl) return false;
  const timeoutMs = Number.parseInt(String(options.timeoutMs || '').trim(), 10) || 3000;
  const authUrl = `${supabaseUrl}/auth/v1/settings`;
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      [
        'const url = process.argv[1];',
        'const timeoutMs = Number(process.argv[2]) || 3000;',
        'const controller = new AbortController();',
        'const timer = setTimeout(() => controller.abort(), timeoutMs);',
        '(async () => {',
        '  try {',
        '    const res = await fetch(url, { method: "GET", signal: controller.signal, headers: { accept: "application/json" } });',
        '    clearTimeout(timer);',
        '    process.exit(res ? 0 : 1);',
        '  } catch (_err) {',
        '    clearTimeout(timer);',
        '    process.exit(1);',
        '  }',
        '})();',
      ].join(' '),
      authUrl,
      String(timeoutMs),
    ],
    {
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: Math.max(timeoutMs + 500, 1500),
      windowsHide: true,
    },
  );
  return Boolean(probe.error) || probe.status !== 0;
}

function buildZeroUuid() {
  return [8, 4, 4, 4, 12].map((length) => '0'.repeat(length)).join('-');
}

function isSupabaseFunctionsRuntimeUnavailableSync(env = process.env, options = {}) {
  const supabaseUrl = String(env?.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(env?.SUPABASE_ANON_KEY || '').trim();
  const labelRendererJwt = String(
    env?.LABEL_RENDERER_DB_JWT ||
      env?.SUPABASE_SERVICE_ROLE_KEY ||
      env?.SERVICE_ROLE_KEY ||
      '',
  ).trim();
  if (!supabaseUrl || !anonKey || !labelRendererJwt) return false;

  const timeoutMs = Number.parseInt(String(options.timeoutMs || '').trim(), 10) || 5000;
  const probeOrganizationId = buildZeroUuid();
  const url = `${supabaseUrl}/functions/v1/label-renderer`;
  const body = JSON.stringify({
    mode: 'bundle',
    organization_id: probeOrganizationId,
    bundle: {
      organization_id: probeOrganizationId,
      file_urls: [],
    },
  });
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      [
        'const url = process.argv[1];',
        'const anonKey = process.argv[2];',
        'const bearer = process.argv[3];',
        'const body = process.argv[4];',
        'const timeoutMs = Number(process.argv[5]) || 5000;',
        'const controller = new AbortController();',
        'const timer = setTimeout(() => controller.abort(), timeoutMs);',
        '(async () => {',
        '  try {',
        '    const res = await fetch(url, {',
        '      method: "POST",',
        '      signal: controller.signal,',
        '      headers: {',
        '        "content-type": "application/json",',
        '        authorization: `Bearer ${bearer}`,',
        '        apikey: anonKey,',
        '      },',
        '      body,',
        '    });',
        '    clearTimeout(timer);',
        '    process.exit(res && res.status === 200 ? 0 : 1);',
        '  } catch (_err) {',
        '    clearTimeout(timer);',
        '    process.exit(1);',
        '  }',
        '})();',
      ].join(' '),
      url,
      anonKey,
      labelRendererJwt,
      body,
      String(timeoutMs),
    ],
    {
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: Math.max(timeoutMs + 500, 1500),
      windowsHide: true,
    },
  );
  return Boolean(probe.error) || probe.status !== 0;
}

function gitStdout(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(String(res.stderr || '').trim() || `git ${args.join(' ')} failed (${res.status})`);
  }
  return String(res.stdout || '').trim();
}

function gitStatusPorcelain() {
  return gitStdout(['status', '--porcelain', '--untracked-files=all']);
}

function assertCleanLocalGateRepository({ status = gitStatusPorcelain(), phase = 'before' } = {}) {
  if (String(status || '').trim()) {
    throw new Error(`Local gate requires a clean repository ${phase} validation.`);
  }
}

function assertLocalGateHeadMatches({ expectedHeadSha, actualHeadSha, phase = 'before' } = {}) {
  const expected = String(expectedHeadSha || '').trim().toLowerCase();
  const actual = String(actualHeadSha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected) || !/^[0-9a-f]{40}$/.test(actual) || actual !== expected) {
    throw new Error(
      `Local gate checked-out HEAD mismatch ${phase} validation: expected=${expected || '<missing>'} actual=${actual || '<missing>'}.`,
    );
  }
}

function diffNameOnly(range, gitStdoutImpl = gitStdout) {
  return uniq(
    String(gitStdoutImpl(['diff', '--no-renames', '--name-only', range]) || '')
      .split(/\r?\n/)
      .map((value) => normalizePath(value)),
  );
}

function resolveHeadSha(explicitSha = '') {
  return String(explicitSha || '').trim() || gitStdout(['rev-parse', 'HEAD']);
}

function resolveRemoteWorkflowRef({ explicitWorkflowRef = '', baseRef = '' } = {}) {
  const explicit = String(explicitWorkflowRef || '').trim();
  if (explicit) return explicit;
  return String(baseRef || '').trim().replace(/^origin\//, '');
}

function resolveBaseSha({ baseRef = '', explicitBaseSha = '' }) {
  const ref = String(baseRef || '').trim();
  if (String(explicitBaseSha || '').trim()) return String(explicitBaseSha).trim();
  if (!ref) return '';
  return gitStdout(['rev-parse', ref]);
}

function resolveChangedFiles({ baseRef = '', baseSha = '', headSha = '', paths = [] }) {
  const explicitPaths = uniq(paths.map((value) => normalizePath(value)).filter(Boolean));
  if (explicitPaths.length) return explicitPaths;
  const resolvedHeadSha = String(headSha || '').trim();
  const resolvedBaseSha = String(baseSha || '').trim() || resolveBaseSha({ baseRef });
  if (!resolvedBaseSha || !resolvedHeadSha) {
    throw new Error('Missing base/head SHAs for local gate diff resolution.');
  }
  const mergeBase = gitStdout(['merge-base', resolvedBaseSha, resolvedHeadSha]) || resolvedBaseSha;
  return diffNameOnly(`${mergeBase}..${resolvedHeadSha}`);
}

function backendSuitesSelected(selection) {
  const selected = new Set((Array.isArray(selection?.selectedSuites) ? selection.selectedSuites : []).map(normalizeSuiteId));
  return ['verify_cloud_core', 'pgtap', 'integration', 'edge_deploy'].filter((suiteId) => selected.has(suiteId));
}

function isControlPlanePath(filePath) {
  const normalized = normalizePath(filePath);
  return CONTROL_PLANE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function matchesAnyPattern(filePath, patterns) {
  const normalized = normalizePath(filePath);
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => pattern.test(normalized));
}

function isToolingOnlyPath(filePath) {
  return matchesAnyPattern(filePath, TOOLING_ONLY_PATH_PATTERNS);
}

function resolveToolingOnlySuites(changedFiles) {
  const normalizedFiles = uniq((Array.isArray(changedFiles) ? changedFiles : []).map(normalizePath));
  const suiteIds = new Set(['lint_structure', 'test_unit']);

  if (normalizedFiles.some((filePath) => matchesAnyPattern(filePath, TOOLING_UI_RELATED_PATTERNS))) {
    suiteIds.add('test_ui');
    suiteIds.add('lint_frontend');
  }
  if (normalizedFiles.some((filePath) => matchesAnyPattern(filePath, TOOLING_DOCS_RELATED_PATTERNS))) {
    suiteIds.add('docs_lane');
  }
  if (normalizedFiles.some((filePath) => matchesAnyPattern(filePath, TOOLING_LANDING_RELATED_PATTERNS))) {
    suiteIds.add('landing_build');
    suiteIds.add('landing_e2e');
  }

  return uniq(Array.from(suiteIds)).sort();
}

function isExplicitScopedControlPlaneSelection(selection, changedFiles = []) {
  const canonical = validateCanonicalImpactSelection(selection, changedFiles);
  if (!canonical.ok) return false;
  const impactSurfaces = canonical.arrays.impactSurfaces
    .map((value) => String(value || '').trim().toLowerCase());

  return canonical.arrays.unmatchedFiles.length === 0
    && canonical.arrays.impactedSurfaceIds.length === 0
    && canonical.arrays.directSurfaceIds.length === 0
    && canonical.arrays.surfaceIds.length === 0
    && canonical.arrays.requiredPreviewSurfaceIds.length === 0
    && impactSurfaces.length > 0
    && impactSurfaces.every((impactId) => SCOPED_CONTROL_PLANE_IMPACT_IDS.has(impactId));
}

function shouldRunDocsOpenApiCheck({ changedFiles = [], toolingOnly = false } = {}) {
  const normalizedFiles = uniq((Array.isArray(changedFiles) ? changedFiles : []).map(normalizePath));
  if (!toolingOnly) return true;
  return normalizedFiles.some((filePath) => matchesAnyPattern(filePath, TOOLING_DOCS_OPENAPI_RELATED_PATTERNS));
}

function resolveLocalGateBackendVerifyMode(env = process.env) {
  const explicitMode = String(env?.LOCAL_GATE_BACKEND_VERIFY_MODE || '').trim().toLowerCase();
  if (!explicitMode) return 'local';
  if (explicitMode === 'local' || explicitMode === 'remote-full') return explicitMode;
  throw new Error(`Unsupported LOCAL_GATE_BACKEND_VERIFY_MODE "${explicitMode}"`);
}

function resolveLocalGateRemoteVerifyEnvironment({ env = process.env, baseRef = '' } = {}) {
  const explicitEnv = String(env?.LOCAL_GATE_REMOTE_VERIFY_ENV || '').trim().toLowerCase();
  if (explicitEnv) {
    if (explicitEnv === 'dev' || explicitEnv === 'stg') return explicitEnv;
    throw new Error(`Unsupported LOCAL_GATE_REMOTE_VERIFY_ENV "${explicitEnv}"`);
  }

  const normalizedBaseRef = String(baseRef || '')
    .trim()
    .replace(/^refs\/heads\//i, '')
    .replace(/^origin\//i, '')
    .toLowerCase();
  return normalizedBaseRef === 'main' ? 'stg' : 'dev';
}

function resolveLocalGatePolicy({ selection, changedFiles, mode = 'auto' }) {
  const requestedMode = String(mode || 'auto').trim().toLowerCase();
  const impactedSurfaceIds = new Set(uniq(selection?.impactedSurfaceIds || []));
  const directSurfaceIds = new Set(uniq(selection?.directSurfaceIds || []));
  const impactSurfaces = new Set(uniq(selection?.impactSurfaces || []));
  const normalizedFiles = uniq((Array.isArray(changedFiles) ? changedFiles : []).map(normalizePath));
  const riskReasons = [];

  for (const surfaceId of impactedSurfaceIds) {
    if (HIGH_RISK_SURFACE_IDS.has(surfaceId)) riskReasons.push(`surface:${surfaceId}`);
  }
  for (const impactId of impactSurfaces) {
    if (HIGH_RISK_IMPACT_IDS.has(impactId)) riskReasons.push(`impact:${impactId}`);
  }
  if (normalizedFiles.some(isControlPlanePath)) riskReasons.push('control_plane');

  const strictRequested = requestedMode === 'strict'
    || (requestedMode === 'auto' && riskReasons.length > 0);
  const lockfileFullFallback = String(selection?.lockfileSelectionMode || '') === 'full_fallback'
    || String(selection?.fallbackReason || '').startsWith('lockfile_');
  const toolingOnly = !lockfileFullFallback && normalizedFiles.length > 0 && normalizedFiles.every(isToolingOnlyPath);
  const scopedControlPlaneOnly = toolingOnly && isExplicitScopedControlPlaneSelection(selection, normalizedFiles);
  const nextSuites = new Set(
    (Array.isArray(selection?.selectedSuites) ? selection.selectedSuites : [])
      .map(normalizeSuiteId),
  );
  const hasDirectMobileImpact = directSurfaceIds.has('mobile_fieldops');

  if (hasDirectMobileImpact) {
    nextSuites.add('mobile_fieldops');
  }

  if (strictRequested) {
    if (toolingOnly) {
      for (const suiteId of resolveToolingOnlySuites(normalizedFiles)) {
        nextSuites.add(suiteId);
      }
    } else {
      nextSuites.add('lint_structure');
      nextSuites.add('test_unit');
      if (
        impactedSurfaceIds.has('console')
        || impactedSurfaceIds.has('portal')
        || impactSurfaces.has('shared')
        || riskReasons.includes('control_plane')
      ) {
        nextSuites.add('test_ui');
        nextSuites.add('lint_frontend');
      }
      if (impactedSurfaceIds.has('landing')) {
        nextSuites.add('landing_build');
      }
      if (impactedSurfaceIds.has('docs') || riskReasons.includes('control_plane')) {
        nextSuites.add('docs_lane');
      }
      if (
        impactedSurfaceIds.has('db')
        || impactedSurfaceIds.has('api_ingress')
        || impactSurfaces.has('shared')
        || riskReasons.includes('control_plane')
      ) {
        ['verify_cloud_core', 'pgtap', 'integration', 'edge_deploy'].forEach((suiteId) => nextSuites.add(suiteId));
      }
    }
  }

  return {
    requestedMode,
    mode: strictRequested ? 'strict' : 'impact',
    strictMode: strictRequested,
    toolingOnly,
    scopedControlPlaneOnly,
    riskReasons: uniq(riskReasons),
    selection: {
      ...selection,
      selectedSuites: uniq(Array.from(nextSuites)),
    },
  };
}

function resolveDocsOpenApiDbCandidates({ cwd = process.cwd(), env = process.env } = {}) {
  return uniq([
    ...resolveDbUrlValuesFromEnv(env),
    ...envFileCandidates({ cwd, env }).flatMap((filePath) => resolveDbUrlValuesFromFile(filePath)),
  ])
    .map((dsn) => ({ dsn, endpoint: parseDbEndpoint(dsn) }))
    .filter((candidate) => Boolean(candidate.endpoint));
}

function hasDocsOpenApiLocalDbCandidate({ cwd = process.cwd(), env = process.env } = {}) {
  return resolveDocsOpenApiDbCandidates({ cwd, env }).some((candidate) =>
    isLocalDbHost(candidate.endpoint.host),
  );
}

function hasReusableSharedLaneDbPreflight({ env = process.env } = {}) {
  const selectedCandidateName = String(
    env?.SHARED_LANE_DB_PROBE_SELECTED_DSN_NAME
      || env?.DB_SMOKE_SELECTED_DSN_NAME
      || '',
  ).trim();
  return isTruthy(env?.SHARED_LANE_PREFLIGHT_OK)
    && isTruthy(env?.SHARED_LANE_DB_PROBE_OK)
    && selectedCandidateName.length > 0;
}

function buildLocalMobileFieldopsEnv() {
  return {
    FIELDOPS_VERIFY_SKIP_STORE_PREFLIGHT: '1',
    ENV_FILE: LOCAL_ENV_FILE,
    ENV_FILE_OVERRIDE: '1',
    ENV_FILE_APPEND: '0',
    CLOUD_DB_BOOTSTRAP_MODE: 'ephemeral',
    // Clear higher-priority cloud/pinned selectors so db-connect-smoke resolves
    // against the local env file that local:start generated.
    TARGET_DEPLOY_ENV: '',
    DEPLOY_ENV: '',
    DEPLOY_ENVIRONMENT: '',
    PG_CONN_STRING: '',
    SYNCED_DB_URL_POOLER: '',
    DATABASE_URL_POOLER: '',
    SYNCED_DB_URL: '',
    SYNCED_DB_URL_DIRECT: '',
    DATABASE_URL_DIRECT: '',
    DB_SMOKE_SELECTED_DSN_NAME: '',
    DATABASE_URL_SELECTED_DSN_NAME: '',
    SHARED_LANE_DB_PROBE_SELECTED_DSN_NAME: '',
    SHARED_LANE_PREFLIGHT_OK: '',
    SHARED_LANE_DB_PROBE_OK: '',
  };
}

function buildNxRunnerArgs({ mode = 'run-many', targets = [], projects = [], fallbackArgs = [] }) {
  const args = [
    NX_TASK_RUNNER_PATH,
    '--mode',
    mode,
    '--targets',
    uniq(targets).join(','),
    '--fallback-command',
    npmCommand(),
    '--fallback-args-json',
    JSON.stringify(Array.isArray(fallbackArgs) ? fallbackArgs : []),
  ];
  const resolvedProjects = uniq(projects);
  if (resolvedProjects.length) {
    args.push('--projects', resolvedProjects.join(','));
  }
  return args;
}

function buildExecutionPlan(selection, options = {}) {
  const selectedSuites = new Set((Array.isArray(selection?.selectedSuites) ? selection.selectedSuites : []).map(normalizeSuiteId));
  const impactedSurfaceIds = uniq(selection?.impactedSurfaceIds || []);
  const runtimeEnv = options.env || process.env;
  const normalizedChangedFiles = uniq((Array.isArray(options.changedFiles) ? options.changedFiles : []).map(normalizePath));
  const toolingOnly = Boolean(options.toolingOnly);
  const lockfileVerifyRequired = normalizedChangedFiles.some((filePath) => (
    isPackageManifest(filePath) || isRootPackageLock(filePath) || isLockGeneratorContractPath(filePath)
  ));
  const docsLaneSelected = selectedSuites.has('docs_lane');
  const backendVerifyMode = resolveLocalGateBackendVerifyMode(runtimeEnv);
  const hasDocsOpenApiDbAccessImpl = typeof options.hasDocsOpenApiDbAccessImpl === 'function'
    ? options.hasDocsOpenApiDbAccessImpl
    : hasDocsOpenApiDbAccess;
  const hasDocsOpenApiLocalDbCandidateImpl = typeof options.hasDocsOpenApiLocalDbCandidateImpl === 'function'
    ? options.hasDocsOpenApiLocalDbCandidateImpl
    : hasDocsOpenApiLocalDbCandidate;
  const hasLocalBackendRuntimeImpl = typeof options.hasLocalBackendRuntimeImpl === 'function'
    ? options.hasLocalBackendRuntimeImpl
    : hasLocalDockerRuntimeSync;
  const docsOpenApiDbAccessAvailable = hasDocsOpenApiDbAccessImpl({
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
  });
  const backendSuites = backendSuitesSelected(selection);
  const docsOpenApiForceLocal = isTruthy(runtimeEnv.LOCAL_GATE_DOCS_OPENAPI_LOCAL || '');
  const docsOpenApiShouldRun = docsLaneSelected
    && shouldRunDocsOpenApiCheck({ changedFiles: normalizedChangedFiles, toolingOnly });
  const docsOpenApiCanRunLocallyNow = docsOpenApiShouldRun && docsOpenApiDbAccessAvailable;
  const docsOpenApiLocalStackAllowed = docsOpenApiShouldRun
    && (!toolingOnly || docsOpenApiForceLocal);
  const docsOpenApiHasLocalDbCandidate = docsOpenApiLocalStackAllowed
    && hasDocsOpenApiLocalDbCandidateImpl({
      cwd: options.cwd || process.cwd(),
      env: runtimeEnv,
    });
  const localBackendRuntimeAvailable = hasLocalBackendRuntimeImpl({
    cwd: options.cwd || process.cwd(),
    env: runtimeEnv,
  });
  const docsOpenApiNeedsLocalStack = docsLaneSelected
    && localBackendRuntimeAvailable
    && (docsOpenApiHasLocalDbCandidate || (backendVerifyMode === 'local' && backendSuites.length > 0));
  const docsOpenApiCanRunLocally = docsOpenApiCanRunLocallyNow || docsOpenApiNeedsLocalStack || (
    docsOpenApiForceLocal && docsOpenApiShouldRun && localBackendRuntimeAvailable
  );
  const mobileFieldopsSelected = selectedSuites.has('mobile_fieldops');
  const reusableSharedLaneDbPreflight = hasReusableSharedLaneDbPreflight({
    env: runtimeEnv,
  });
  const mobileFieldopsNeedsLocalStack = mobileFieldopsSelected
    && !reusableSharedLaneDbPreflight
    && hasDocsOpenApiLocalDbCandidateImpl({
      cwd: options.cwd || process.cwd(),
      env: runtimeEnv,
    });
  const remoteVerifyEnv = resolveLocalGateRemoteVerifyEnvironment({
    env: runtimeEnv,
    baseRef: options.baseRef,
  });
  const backendRemoteVerify = backendSuites.length > 0
    && (backendVerifyMode === 'remote-full' || !localBackendRuntimeAvailable);
  const docsOpenApiCoveredByBackendRemoteVerify = docsLaneSelected
    && backendRemoteVerify
    && !docsOpenApiCanRunLocally;
  const verifyRef = String(options.headSha || '').trim() || 'HEAD';
  const remoteWorkflowRef = String(options.remoteWorkflowRef || '').trim();
  const commands = [];

  function addCommand({ commandId, suiteIds = [], surfaceIds = [], command, args, env: stepEnv = {} }) {
    commands.push({
      command_id: String(commandId || '').trim(),
      suite_ids: uniq(suiteIds.map(normalizeSuiteId)),
      surface_ids: uniq(surfaceIds),
      command,
      args: Array.isArray(args) ? args.slice() : [],
      env: stepEnv && typeof stepEnv === 'object' ? { ...stepEnv } : {},
    });
  }

  function ensureLocalStart({ suiteIds = [], surfaceIds = [] }) {
    const normalizedSuiteIds = uniq(suiteIds.map(normalizeSuiteId));
    const normalizedSurfaceIds = uniq(surfaceIds);
    const edgeSmokeSelected = normalizedSuiteIds.includes('edge_deploy');
    const existing = commands.find((entry) => entry.command_id === 'local_start');
    if (existing) {
      existing.suite_ids = uniq([...existing.suite_ids, ...normalizedSuiteIds]);
      existing.surface_ids = uniq([...existing.surface_ids, ...normalizedSurfaceIds]);
      if (edgeSmokeSelected) existing.env.RUN_LOCAL_EDGE_TESTS = 'true';
      return;
    }
    addCommand({
      commandId: 'local_start',
      suiteIds: normalizedSuiteIds,
      surfaceIds: normalizedSurfaceIds,
      command: npmCommand(),
      args: ['run', 'local:start'],
      env: {
        WORKSPACE_LOCAL_START_FRESH: '1',
        WORKSPACE_LOCAL_START_RUN_MIGRATE_LOCAL: '1',
        ...(edgeSmokeSelected ? { RUN_LOCAL_EDGE_TESTS: 'true' } : {}),
      },
    });
  }

  function ensureLocalVerify({ suiteIds = [], surfaceIds = [] }) {
    const normalizedSuiteIds = uniq(suiteIds.map(normalizeSuiteId));
    const normalizedSurfaceIds = uniq(surfaceIds);
    const edgeSmokeSelected = normalizedSuiteIds.includes('edge_deploy');
    const existing = commands.find((entry) => entry.command_id === 'local_verify');
    if (existing) {
      existing.suite_ids = uniq([...existing.suite_ids, ...normalizedSuiteIds]);
      existing.surface_ids = uniq([...existing.surface_ids, ...normalizedSurfaceIds]);
      if (edgeSmokeSelected) {
        existing.env.RUN_LOCAL_EDGE_TESTS = 'true';
        existing.env.EDGE_SMOKE_REQUIRED = '1';
      }
      return;
    }
    addCommand({
      commandId: 'local_verify',
      suiteIds: normalizedSuiteIds,
      surfaceIds: normalizedSurfaceIds,
      command: npmCommand(),
      args: ['run', 'local:verify'],
      env: {
        LOCAL_VERIFY_SKIP_DB_RESET: '1',
        ...(edgeSmokeSelected
          ? {
              RUN_LOCAL_EDGE_TESTS: 'true',
              EDGE_SMOKE_REQUIRED: '1',
            }
          : {}),
      },
    });
  }

  const focusedUnitSelection = resolveFocusedUnitSelection({
    changedFiles: normalizedChangedFiles,
    impactSelection: selection,
    repoRoot: options.cwd || process.cwd(),
    validateCohortTestFiles: true,
  });
  const targetedUnitTests = focusedUnitSelection.mode === 'focused'
    ? focusedUnitSelection.testPaths
    : [];
  const targetedUiTests = toolingOnly
    ? normalizedChangedFiles.filter((filePath) => /^tests\/ui\/.+\.test\.(js|ts|tsx)$/i.test(filePath))
    : [];
  const targetedLandingSpecs = toolingOnly
    ? normalizedChangedFiles.filter((filePath) => /^tests\/landing-e2e\/.+\.spec\.(js|ts)$/i.test(filePath)
      && (options.fsImpl || fs).existsSync(path.resolve(options.cwd || process.cwd(), filePath)))
    : [];

  if (lockfileVerifyRequired) {
    addCommand({
      commandId: 'lockfile_verify',
      suiteIds: Array.from(selectedSuites),
      surfaceIds: impactedSurfaceIds,
      command: npmCommand(),
      args: ['run', 'lockfile:verify'],
    });
  }

  if (selectedSuites.has('lint_structure')) {
    addCommand({
      commandId: 'lint_structure',
      suiteIds: ['lint_structure'],
      command: 'node',
      args: buildNxRunnerArgs({
        mode: 'run-many',
        targets: ['lint:structure'],
        projects: [ROOT_NX_PROJECT],
        fallbackArgs: ['run', 'lint:structure'],
      }),
    });
  }
  if (selectedSuites.has('test_unit')) {
    const focusedUnit = focusedUnitSelection.mode === 'focused';
    addCommand({
      commandId: 'test_unit',
      suiteIds: ['test_unit'],
      command: 'node',
      args: focusedUnit
        ? ['scripts/ops/ci/focused-unit-selection.js', '--execute']
        : buildNxRunnerArgs({
            mode: 'run-many',
            targets: ['test:unit'],
            projects: [ROOT_NX_PROJECT],
            fallbackArgs: ['run', 'test:unit'],
          }),
      env: focusedUnit
        ? {
            FOCUSED_UNIT_MODE: 'focused',
            FOCUSED_UNIT_TESTS_JSON: JSON.stringify(targetedUnitTests),
          }
        : {},
    });
  }
  if (selectedSuites.has('test_ui')) {
    const targetedUiJest = targetedUiTests.length
      ? resolveJestInvocation({
          configPath: 'config/tooling/jest.config.ui.js',
          targetedTests: targetedUiTests,
          localJestBinPath: options.localJestBinPath,
          repoRoot: options.cwd || process.cwd(),
          fsImpl: options.fsImpl || fs,
        })
      : null;
    addCommand({
      commandId: 'test_ui',
      suiteIds: ['test_ui'],
      command: targetedUiJest ? targetedUiJest.command : 'node',
      args: targetedUiJest
        ? targetedUiJest.args
        : buildNxRunnerArgs({
            mode: 'run-many',
            targets: ['test:ui'],
            projects: [ROOT_NX_PROJECT],
            fallbackArgs: ['run', 'test:ui'],
          }),
    });
  }
  if (selectedSuites.has('lint_frontend')) {
    addCommand({
      commandId: 'lint_frontend',
      suiteIds: ['lint_frontend'],
      command: 'node',
      args: buildNxRunnerArgs({
        mode: 'affected',
        targets: ['lint', 'typecheck'],
        projects: ['@masarx/console', '@masarx/portal'],
        fallbackArgs: ['run', 'lint:frontend'],
      }),
    });
  }
  if (selectedSuites.has('landing_build')) {
    addCommand({
      commandId: 'landing_build',
      suiteIds: ['landing_build'],
      surfaceIds: ['landing'],
      command: 'node',
      args: buildNxRunnerArgs({
        mode: 'run-many',
        targets: ['build:landing'],
        projects: [ROOT_NX_PROJECT],
        fallbackArgs: ['run', 'build:landing'],
      }),
      env: LOCAL_GATE_LANDING_BUILD_ENV,
    });
  }
  if (selectedSuites.has('landing_e2e')) {
    const browserAdmission = waitForBrowserAdmissionSync({
      env: options.env || process.env,
      validateOnly: true,
    });
    addCommand({
      commandId: 'landing_e2e_admission', suiteIds: ['landing_e2e'], surfaceIds: ['landing'],
      command: 'internal', args: ['browser-resource-quiescence'],
      env: {
        LOCAL_GATE_BROWSER_MIN_AVAILABLE_RAM_GIB: String(browserAdmission.minimum_available_ram_gib),
        LOCAL_GATE_BROWSER_MAX_CPU_PERCENT: String(browserAdmission.maximum_cpu_percent),
        LOCAL_GATE_BROWSER_ADMISSION_TIMEOUT_MS: String(browserAdmission.timeout_ms),
        LOCAL_GATE_BROWSER_STABLE_WINDOW_MS: String(browserAdmission.stable_window_ms),
        LOCAL_GATE_BROWSER_SAMPLE_INTERVAL_MS: String(browserAdmission.sample_interval_ms),
      },
    });
    addCommand({
      commandId: 'landing_e2e',
      suiteIds: ['landing_e2e'],
      surfaceIds: ['landing'],
      command: npmCommand(),
      args: targetedLandingSpecs.length
        ? ['exec', '--', 'playwright', 'test', '-c', 'playwright.landing.config.ts', ...targetedLandingSpecs]
        : ['run', 'test:e2e:landing'],
    });
  }
  if (docsOpenApiNeedsLocalStack) {
    ensureLocalStart({
      suiteIds: uniq(['docs_lane', ...(backendVerifyMode === 'local' ? backendSuites : [])]),
      surfaceIds: uniq([
        'docs',
        ...(backendVerifyMode === 'local'
          ? impactedSurfaceIds.filter((surfaceId) => ['db', 'api_ingress'].includes(surfaceId))
          : []),
      ]),
    });
  }
  if (docsLaneSelected) {
    if (docsOpenApiShouldRun && !docsOpenApiCoveredByBackendRemoteVerify) {
      addCommand({
        commandId: 'docs_openapi_check',
        suiteIds: ['docs_lane'],
        surfaceIds: ['docs'],
        command: docsOpenApiCanRunLocally ? 'node' : npmCommand(),
        args: docsOpenApiCanRunLocally
          ? buildNxRunnerArgs({
              mode: 'run-many',
              targets: ['docs:openapi:check'],
              projects: [ROOT_NX_PROJECT],
              fallbackArgs: ['run', 'docs:openapi:check'],
            })
          : buildRemoteVerifyArgs({
              mode: 'docs-openapi',
              remoteVerifyEnv,
              remoteWorkflowRef,
              verifyRef,
              env: options.env || process.env,
            }),
      });
    }
    addCommand({
      commandId: 'docs_ssot_lint',
      suiteIds: ['docs_lane'],
      surfaceIds: ['docs'],
      command: 'node',
      args: buildNxRunnerArgs({
        mode: 'run-many',
        targets: ['lint:docs:ssot'],
        projects: [ROOT_NX_PROJECT],
        fallbackArgs: ['run', 'lint:docs:ssot'],
        }),
    });
  }

  if (backendSuites.length) {
    if (backendRemoteVerify) {
      addCommand({
        commandId: backendVerifyMode === 'remote-full' ? 'backend_remote_verify' : 'remote_backend_verify',
        suiteIds: backendSuites,
        surfaceIds: impactedSurfaceIds.filter((surfaceId) => ['db', 'api_ingress'].includes(surfaceId)),
        command: npmCommand(),
        args: buildRemoteVerifyArgs({
          mode: 'full',
          remoteVerifyEnv,
          remoteWorkflowRef,
          verifyRef,
          env: options.env || process.env,
        }),
      });
    } else {
      if (!docsOpenApiNeedsLocalStack) {
        ensureLocalStart({
          suiteIds: backendSuites,
          surfaceIds: impactedSurfaceIds.filter((surfaceId) => ['db', 'api_ingress'].includes(surfaceId)),
        });
      }
      ensureLocalVerify({
        suiteIds: backendSuites,
        surfaceIds: impactedSurfaceIds.filter((surfaceId) => ['db', 'api_ingress'].includes(surfaceId)),
      });
    }
  }

  if (mobileFieldopsSelected) {
    if (mobileFieldopsNeedsLocalStack) {
      ensureLocalStart({
        suiteIds: ['mobile_fieldops'],
        surfaceIds: ['mobile_fieldops'],
      });
      ensureLocalVerify({
        suiteIds: ['mobile_fieldops'],
        surfaceIds: ['mobile_fieldops'],
      });
    }
    const mobileFieldopsEnv = mobileFieldopsNeedsLocalStack
      ? buildLocalMobileFieldopsEnv()
      : {
          FIELDOPS_VERIFY_SKIP_STORE_PREFLIGHT: '1',
        };
    addCommand({
      commandId: 'verify_mobile_fieldops',
      suiteIds: ['mobile_fieldops'],
      surfaceIds: ['mobile_fieldops'],
      command: npmCommand(),
      args: ['run', 'verify:mobile:fieldops'],
      env: mobileFieldopsEnv,
    });
  }

  const localStartStep = commands.find((entry) => entry.command_id === 'local_start');
  if (localStartStep) {
    addCommand({
      commandId: 'local_stop',
      suiteIds: localStartStep.suite_ids,
      surfaceIds: localStartStep.surface_ids,
      command: npmCommand(),
      args: ['run', 'local:stop'],
    });
  }

  return prependRemoteVerifyRoutePreflight(commands);
}

function attachExecutionFailure(error, results, failedPhase) {
  const target = error instanceof Error ? error : new Error(String(error));
  target.localGateCommandResults = results.map((entry) => ({ ...entry }));
  target.localGateFailedPhase = String(failedPhase || 'execution');
  const exitCode = Number.isInteger(target.exitCode) ? target.exitCode
    : Number(target.message.match(/^exit\s+(-?\d+)$/i)?.[1]) || null;
  target.localGateFailure = {
    failed_phase: target.localGateFailedPhase,
    failure_class: String(target.failureClass || (exitCode === null ? 'infrastructure' : 'command')),
    error_code: String(target.code || 'command_failed'), exit_code: exitCode,
    error_message: String(target.message || target),
    duration_ms: Number(target.durationMs || target.admission?.duration_ms || 0),
    ...(target.admission ? { admission: target.admission } : {}),
  };
  return target;
}

function runExecutionPlan(commands, env = process.env, options = {}) {
  const runCommandImpl = options.runCommandImpl || runCommand;
  const waitForBrowserAdmissionSyncImpl =
    options.waitForBrowserAdmissionSyncImpl || waitForBrowserAdmissionSync;
  const isSupabaseHttpPlaneUnavailableSyncImpl =
    options.isSupabaseHttpPlaneUnavailableSyncImpl || isSupabaseHttpPlaneUnavailableSync;
  const isSupabaseFunctionsRuntimeUnavailableSyncImpl =
    options.isSupabaseFunctionsRuntimeUnavailableSyncImpl || isSupabaseFunctionsRuntimeUnavailableSync;
  const results = [];
  let backendRecoveryAttempted = false;
  let localStartAttempted = false;
  let localStopAttempted = false;
  let activePhase = 'execution';
  const terminalLocalStopStep = (Array.isArray(commands) ? commands : [])
    .find((entry) => entry.command_id === 'local_stop');
  try {
    for (const step of Array.isArray(commands) ? commands : []) {
      activePhase = step.command_id;
    const stepEnv = {
      ...stripLocalGateEnv(env),
      ...(step.env && typeof step.env === 'object' ? step.env : {}),
    };
    if (step.command_id === 'landing_e2e_admission') {
      console.log('[local-gate] internal browser-resource-quiescence');
      const admission = waitForBrowserAdmissionSyncImpl({
        env: withLocalGateChildEnv(stepEnv),
      });
      results.push({
        ...step,
        duration_ms: Number(admission?.duration_ms || 0),
        status: 'passed',
        admission,
      });
      continue;
    }

    console.log(`[local-gate] ${step.command} ${step.args.join(' ')}`);
    if (step.command_id === 'local_start') localStartAttempted = true;
    if (step.command_id === 'local_stop') localStopAttempted = true;
    let durationMs;
    try {
      durationMs = runCommandImpl(step.command, step.args, stepEnv);
    } catch (error) {
      const shouldAttemptRecovery =
        step.command_id === 'local_verify'
        && !backendRecoveryAttempted
        && (
          isSupabaseHttpPlaneUnavailableSyncImpl(stepEnv)
          || isSupabaseFunctionsRuntimeUnavailableSyncImpl(stepEnv)
        );

      if (!shouldAttemptRecovery) {
        throw error;
      }

      backendRecoveryAttempted = true;
      console.warn(
        '[local-gate] Local backend runtime became unavailable during local_verify; retrying local:stop + local:start + local:verify once.',
      );

      activePhase = 'local_stop_recovery';
      const recoveryStopDuration = runCommandImpl(npmCommand(), ['run', 'local:stop'], stepEnv);
      results.push({
        command_id: 'local_stop_recovery',
        suite_ids: uniq(step.suite_ids || []),
        surface_ids: uniq(step.surface_ids || []),
        command: npmCommand(),
        args: ['run', 'local:stop'],
        env: {},
        duration_ms: recoveryStopDuration,
        status: 'passed',
      });

      const localStartStep = commands.find((entry) => entry.command_id === 'local_start');
      const localStartRecoveryStepEnv = {
        ...(localStartStep?.env && typeof localStartStep.env === 'object' ? localStartStep.env : {}),
        WORKSPACE_LOCAL_START_FRESH: '1',
        WORKSPACE_LOCAL_START_RUN_MIGRATE_LOCAL: '1',
      };
      activePhase = 'local_start_recovery';
      const recoveryStartDuration = runCommandImpl(npmCommand(), ['run', 'local:start'], {
        ...stepEnv,
        ...localStartRecoveryStepEnv,
      });
      results.push({
        command_id: 'local_start_recovery',
        suite_ids: uniq(step.suite_ids || []),
        surface_ids: uniq(step.surface_ids || []),
        command: npmCommand(),
        args: ['run', 'local:start'],
        env: localStartRecoveryStepEnv,
        duration_ms: recoveryStartDuration,
        status: 'passed',
      });

      activePhase = step.command_id;
      console.log(`[local-gate] ${step.command} ${step.args.join(' ')} (recovery retry)`);
      durationMs = runCommandImpl(step.command, step.args, stepEnv);
    }
      results.push({
        command_id: step.command_id,
        suite_ids: uniq(step.suite_ids || []),
        surface_ids: uniq(step.surface_ids || []),
        command: step.command,
        args: Array.isArray(step.args) ? step.args.slice() : [],
        env: step.env && typeof step.env === 'object' ? { ...step.env } : {},
        duration_ms: durationMs,
        status: 'passed',
      });
    }
    return results;
  } catch (error) {
    const failedPhase = activePhase;
    if (localStartAttempted && !localStopAttempted && terminalLocalStopStep) {
      localStopAttempted = true;
      const cleanupEnv = {
        ...stripLocalGateEnv(env),
        ...(terminalLocalStopStep.env && typeof terminalLocalStopStep.env === 'object'
          ? terminalLocalStopStep.env
          : {}),
      };
      try {
        console.warn(
          `[local-gate] ${failedPhase} failed after local runtime startup; running terminal local:stop before reporting the primary failure.`,
        );
        const cleanupDurationMs = runCommandImpl(
          terminalLocalStopStep.command,
          terminalLocalStopStep.args,
          cleanupEnv,
        );
        results.push({
          command_id: terminalLocalStopStep.command_id,
          suite_ids: uniq(terminalLocalStopStep.suite_ids || []),
          surface_ids: uniq(terminalLocalStopStep.surface_ids || []),
          command: terminalLocalStopStep.command,
          args: Array.isArray(terminalLocalStopStep.args)
            ? terminalLocalStopStep.args.slice()
            : [],
          env: terminalLocalStopStep.env && typeof terminalLocalStopStep.env === 'object'
            ? { ...terminalLocalStopStep.env }
            : {},
          duration_ms: cleanupDurationMs,
          status: 'passed',
        });
      } catch (cleanupError) {
        const attached = attachExecutionFailure(error, results, failedPhase);
        attached.localGateFailure = {
          ...attached.localGateFailure,
          cleanup_error_message: String(cleanupError?.message || cleanupError),
        };
        attached.localGateCleanupError = cleanupError;
        throw attached;
      }
    }
    throw attachExecutionFailure(error, results, failedPhase);
  }
}

function createManifest({
  headSha,
  baseSha,
  changedFiles,
  classificationFiles,
  selection,
  commandResults,
  plannedCommands,
  manifestPath,
  mode,
  strictMode,
  riskReasons,
  status = 'passed', failure = {}, terminalRepository,
  startedAt = '', finishedAt = '', terminalProbeErrors = [],
}) {
  const durationMs = (Array.isArray(commandResults) ? commandResults : []).reduce(
    (sum, entry) => sum + Number(entry?.duration_ms || 0),
    0,
  );
  const manifest = addLocalGateManifestContract({
    sha: headSha,
    head_sha: headSha,
    base_sha: baseSha,
    generated_at: new Date().toISOString(),
    manifest_path: manifestPath,
    changed_files: uniq(changedFiles),
    classification_files: uniq(classificationFiles || selection?.classificationFiles || changedFiles),
    impact_surfaces: uniq(selection?.impactSurfaces || []),
    surface_ids: uniq(selection?.impactedSurfaceIds || []),
    suite_ids: uniq(selection?.selectedSuites || []),
    commands: Array.isArray(commandResults) ? commandResults : [],
    planned_commands: Array.isArray(plannedCommands) ? plannedCommands : commandResults,
    selection_confidence: String(selection?.selectionConfidence || 'unknown'),
    fallback_to_full: Boolean(selection?.fallbackToFull),
    fallback_reason: String(selection?.fallbackReason || ''),
    skip_reasons: uniq(selection?.skipReasons || []),
    lockfile_selection_mode: String(selection?.lockfileSelectionMode || 'not_applicable'),
    lockfile_selection_reason: String(selection?.lockfileSelectionReason || ''),
    lockfile_owner_workspaces: uniq(selection?.lockfileOwnerWorkspaces || []),
    lockfile_changed_package_keys: uniq(selection?.lockfileChangedPackageKeys || []),
    lockfile_native_package_keys: uniq(selection?.lockfileNativePackageKeys || []),
    local_mode: String(mode || 'impact'),
    strict_mode: Boolean(strictMode),
    risk_reasons: uniq(riskReasons),
    status,
    duration_ms: durationMs,
  });
  if (status === 'passed') return manifest;
  return {
    ...manifest,
    status,
    started_at: String(startedAt || ''),
    finished_at: String(finishedAt || ''),
    generated_at: String(finishedAt || new Date().toISOString()),
    completed_phases: (Array.isArray(commandResults) ? commandResults : [])
      .filter((entry) => entry?.status === 'passed').map((entry) => String(entry?.command_id || '')).filter(Boolean),
    failed_phase: String(failure.failed_phase || 'execution'),
    failure_class: String(failure.failure_class || 'infrastructure'),
    error_code: String(failure.error_code || 'local_gate_failed'),
    exit_code: Number.isInteger(failure.exit_code) ? failure.exit_code : null,
    error_message: String(failure.error_message || ''),
    failure_details: failure,
    repository_clean: terminalRepository?.clean ?? null,
    repository_status_sha256: String(terminalRepository?.status_sha256 || ''),
    terminal_probe_errors: Array.isArray(terminalProbeErrors) ? terminalProbeErrors : [],
    terminal_repository: terminalRepository || {},
  };
}

function writeManifest(manifest, manifestDir, headSha, { cwd = process.cwd() } = {}) {
  const resolved = resolveSafeLocalGateManifestPath({
    cwd,
    manifestDir: String(manifestDir || '.tmp/local-gate').trim() || '.tmp/local-gate',
    headSha,
    createDirectory: true,
  });
  const manifestPath = resolved.manifestPath;
  const nextManifest = {
    ...manifest,
    manifest_path: normalizePath(path.relative(cwd, manifestPath)) || normalizePath(manifestPath),
  };
  nextManifest.manifest_sha256 = digestManifest(nextManifest);
  writeLocalGateManifestAtomic(manifestPath, nextManifest);
  return {
    manifestPath,
    manifest: nextManifest,
  };
}

function resolveLocalGateOutputFormat(format, env = process.env) {
  const normalizedFormat = String(format || 'json').trim().toLowerCase();
  if (!['json', 'github-output'].includes(normalizedFormat)) {
    throw new Error(`Unsupported format "${format}"`);
  }
  if (normalizedFormat === 'github-output' && !String(env.GITHUB_OUTPUT || '').trim()) {
    throw new Error('GITHUB_OUTPUT not set; use --format json locally.');
  }
  return normalizedFormat;
}

function printResult(result, format) {
  const normalizedFormat = resolveLocalGateOutputFormat(format, process.env);
  const payload = {
    head_sha: result.manifest.head_sha,
    base_sha: result.manifest.base_sha,
    manifest_path: result.manifest.manifest_path,
    surface_ids: result.manifest.surface_ids,
    suite_ids: result.manifest.suite_ids,
    local_mode: result.manifest.local_mode,
    strict_mode: result.manifest.strict_mode,
    duration_ms: result.manifest.duration_ms,
    status: result.manifest.status,
  };
  if (normalizedFormat === 'json') {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  if (normalizedFormat === 'github-output') {
    const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
    const lines = [
      `head_sha=${payload.head_sha}`,
      `base_sha=${payload.base_sha}`,
      `manifest_path=${payload.manifest_path}`,
      `surface_ids=${payload.surface_ids.join(',')}`,
      `suite_ids=${payload.suite_ids.join(',')}`,
      `local_mode=${payload.local_mode}`,
      `strict_mode=${payload.strict_mode ? '1' : '0'}`,
      `duration_ms=${String(payload.duration_ms)}`,
      `status=${payload.status}`,
    ];
    fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
    return;
  }
}

function runLocalGate({
  args = parseArgs(),
  env = process.env,
  impactMap = compileImpactMap(),
  resolveChangedFilesImpl = resolveChangedFiles,
  buildExecutionPlanImpl = buildExecutionPlan,
  runExecutionPlanImpl = runExecutionPlan,
  writeManifestImpl = writeManifest,
  gitStatusImpl = gitStatusPorcelain,
  resolveCurrentHeadShaImpl = () => gitStdout(['rev-parse', 'HEAD']),
  resolveCurrentTreeShaImpl = () => gitStdout(['write-tree']),
  nowImpl = () => new Date(),
} = {}) {
  const gateStartedAt = nowImpl().toISOString();
  assertCleanLocalGateRepository({ status: gitStatusImpl(), phase: 'before' });
  const headSha = resolveHeadSha(args.sha);
  assertLocalGateHeadMatches({
    expectedHeadSha: headSha,
    actualHeadSha: resolveCurrentHeadShaImpl(),
    phase: 'before',
  });
  resolveLocalGateOutputFormat(args.format, env);
  resolveSafeLocalGateManifestPath({
    cwd: process.cwd(),
    manifestDir: String(args.manifestDir || '.tmp/local-gate').trim() || '.tmp/local-gate',
    headSha,
    createDirectory: true,
  });
  const baseSha = resolveBaseSha({ baseRef: args.baseRef, explicitBaseSha: args.baseSha });
  const changedFiles = resolveChangedFilesImpl({
    baseRef: args.baseRef,
    baseSha,
    headSha,
    paths: args.paths,
  });
  const selectionResult = resolveImpactSelectionForChangedFiles({
    changedFiles,
    impactMap,
    unknown: false,
    forceFull: false,
    forceReason: '',
    baseRef: baseSha,
    headRef: headSha,
  });
  const selection = selectionResult.impactSelection;
  const classificationFiles = selection.classificationFiles || changedFiles;
  const policy = resolveLocalGatePolicy({
    selection,
    changedFiles: classificationFiles,
    mode: args.mode,
  });
  const effectiveSelection = policy.selection;
  const executionPlan = buildExecutionPlanImpl(effectiveSelection, {
    cwd: process.cwd(),
    env,
    baseRef: args.baseRef,
    headSha,
    baseRef: args.baseRef,
    changedFiles: classificationFiles,
    toolingOnly: policy.toolingOnly,
    baseRef: args.baseRef,
    remoteWorkflowRef: resolveRemoteWorkflowRef({
      explicitWorkflowRef: env.LOCAL_GATE_REMOTE_WORKFLOW_REF,
      baseRef: args.baseRef,
    }),
  });
  const executionEnv = {
    ...env,
    LOCAL_GATE_BASE_SHA: baseSha,
    LOCAL_GATE_HEAD_SHA: headSha,
    LOCAL_GATE_CHANGED_FILES: changedFiles.join(','),
    LOCAL_GATE_CHANGED_FILES_JSON: JSON.stringify(changedFiles),
    LOCAL_GATE_CLASSIFICATION_FILES_JSON: JSON.stringify(classificationFiles),
    NX_TASK_FILES_JSON: JSON.stringify(changedFiles),
  };
  const manifestInput = {
    headSha, baseSha, changedFiles, classificationFiles, selection: effectiveSelection, plannedCommands: executionPlan,
    manifestPath: '', mode: policy.mode, strictMode: policy.strictMode, riskReasons: policy.riskReasons,
  };
  let commandResults = [];
  let lifecyclePhase = 'execution';
  try {
    commandResults = runExecutionPlanImpl(executionPlan, executionEnv, {
      cwd: process.cwd(),
    });
    lifecyclePhase = 'post_execution_head';
    assertLocalGateHeadMatches({
      expectedHeadSha: headSha,
      actualHeadSha: resolveCurrentHeadShaImpl(),
      phase: 'after',
    });
    lifecyclePhase = 'post_execution_repository_clean';
    assertCleanLocalGateRepository({ status: gitStatusImpl(), phase: 'after' });
    const initialManifest = createManifest({ ...manifestInput, commandResults });
    const persisted = writeManifestImpl(initialManifest, args.manifestDir, headSha);
    return {
      changedFiles,
      selection: effectiveSelection,
      classificationFiles,
      commands: executionPlan,
      manifest: persisted.manifest,
      manifestPath: persisted.manifestPath,
    };
  } catch (error) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    if (Array.isArray(primaryError.localGateCommandResults)) {
      commandResults = primaryError.localGateCommandResults;
    }
    const terminalProbeErrors = [];
    const probe = (name, fn, fallback) => {
      try {
        return fn();
      } catch (probeError) {
        terminalProbeErrors.push({ probe: name, error_message: String(probeError?.message || probeError) });
        return fallback;
      }
    };
    const terminalStatus = probe('repository_status', gitStatusImpl, null);
    const failure = primaryError.localGateFailure || {
      failed_phase: primaryError.localGateFailedPhase || lifecyclePhase,
      failure_class: String(primaryError.failureClass || 'infrastructure'),
      error_code: String(primaryError.code || 'local_gate_failed'),
      exit_code: Number.isInteger(primaryError.exitCode) ? primaryError.exitCode : null,
      error_message: String(primaryError.message || primaryError),
    };
    const failureManifest = createManifest({
      ...manifestInput, commandResults, status: 'failed', failure, startedAt: gateStartedAt,
      finishedAt: probe('finished_at', () => nowImpl().toISOString(), new Date().toISOString()),
      terminalProbeErrors,
      terminalRepository: {
        head_sha: probe('head_sha', resolveCurrentHeadShaImpl, ''),
        tree_sha: probe('tree_sha', resolveCurrentTreeShaImpl, ''),
        clean: terminalStatus === null ? null : !String(terminalStatus).trim(),
        status_porcelain: terminalStatus || '',
        status_sha256: terminalStatus === null ? '' : sha256(String(terminalStatus || '')),
      },
    });
    try {
      primaryError.localGateFailureManifest = writeManifestImpl(failureManifest, args.manifestDir, headSha);
    } catch (writeError) {
      primaryError.localGateFailureManifestWriteError = String(writeError?.message || writeError);
    }
    throw primaryError;
  }
}

function main() {
  const args = parseArgs();
  const result = runLocalGate({ args });
  printResult(result, args.format);
  console.log(
    `[local-gate] passed head=${result.manifest.head_sha} base=${result.manifest.base_sha} suites=${result.manifest.suite_ids.join(',') || '<none>'}`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  }
}

module.exports = {
  parseArgs,
  normalizePath,
  resolveChangedFiles,
  resolveLocalGateBackendVerifyMode,
  resolveLocalGateRemoteVerifyEnv,
  buildExecutionPlan,
  buildLocalMobileFieldopsEnv,
  hasDocsOpenApiDbAccess,
  hasDocsOpenApiLocalDbCandidate,
  hasReusableSharedLaneDbPreflight,
  resolveDocsOpenApiDbCandidates,
  createManifest,
  isSupabaseHttpPlaneUnavailableSync,
  isSupabaseFunctionsRuntimeUnavailableSync,
  hasLocalDockerRuntimeSync,
  resolveRemoteVerifyEnvironment,
  resolveLocalGateBackendVerifyMode,
  resolveRemoteWorkflowRef,
  resolveLocalGatePolicy,
  isExplicitScopedControlPlaneSelection,
  withLocalGateChildEnv, sampleHostResources, waitForBrowserAdmissionSync,
  runExecutionPlan,
  gitStatusPorcelain,
  assertCleanLocalGateRepository,
  assertLocalGateHeadMatches,
  diffNameOnly,
  resolveLocalGateRemoteVerifyEnvironment,
  writeManifest,
  resolveLocalGateOutputFormat,
  runLocalGate,
};
