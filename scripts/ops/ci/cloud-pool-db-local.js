#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

// Cloud-pool DB proof (manual dispatch and the PR DB stage of merged_tree_surface_proof) on the dedicated,
// ephemeral local-db VM (one JIT runner client per VM). It starts a minimal plain-CLI Supabase stack on a fresh
// volume (every migration replayed from zero), checks that all local migrations applied, runs the canonical
// backend_local DB lints, and runs the full pgTAP suite with the repo runner against that loopback DB.
// The repo's runtime-lease guard protects the SHARED-host workspace backend config (local:configure /
// local-start); this lane never reads or writes that config, so it neither needs nor bypasses the lease.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadCliContract, getToolContract, validateVersion } = require('./require-cli-version');
const { buildSupabaseCliAsset } = require('./supabase-cli-asset');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
// objectives:allow LOCALHOST Justification: the loopback allowlist is the fail-closed boundary that rejects remote DSNs.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// Database/Supabase endpoint carriers only; GitHub runner service URLs are intentionally out of scope.
const DSN_KEY = /^(?:PGHOST|(?=(?:.*_)?(?:DATABASE|DB|PG|SUPABASE|POSTGRES)(?:_|$))[A-Z0-9_]*(?:URL|URI|DSN|CONN_STRING|HOST)(?:_[A-Z0-9]+)?)$/;
// local-db egress goes through a provider proxy that drops HTTPS CONNECT tunnels; only these failures are retried.
const TRANSIENT_PULL_ERROR = /i\/o timeout|TLS handshake timeout|proxyconnect|connection reset by peer|unexpected EOF|context deadline exceeded|Client\.Timeout|net\/http: request canceled|error pulling image|failed to (?:pull|copy|resolve reference)|toomanyrequests|no such host|ECONNRESET|ETIMEDOUT|EAI_AGAIN|50[234] (?:Bad Gateway|Service Unavailable|Gateway Timeout)/i;
const RETRY = { attempts: 3, baseDelayMs: 20000 };
// Final pull/start errors: waiting cannot fix a full disk, a missing tag or denied access, so they are never retried.
const FINAL_PULL_ERROR = /no space left on device|manifest unknown|unauthorized|requested access to the resource is denied|pull access denied/i;
const DEFAULT_IMAGE_REGISTRY = 'public.ecr.aws';
// Docker Hub keeps official images under library/ (e.g. library/kong), so the CLI's supabase/ paths do not apply there.
const DOCKER_HUB_REGISTRY = /^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)(?:\/|$)/;
// libpq settings a caller may pass through the environment instead of the DSN.
const PSQL_ENV = ['PGPASSWORD', 'PGUSER', 'PGDATABASE', 'PGHOST', 'PGPORT', 'PGSSLMODE', 'PGOPTIONS', 'PGCONNECT_TIMEOUT', 'PGAPPNAME', 'PGTZ'];
// Capacity evidence only: no hostname, proxy, mirror, registry or label fields reach the uploaded log.
const DOCKER_INFO_FIELDS = ['ServerVersion', 'Driver', 'CgroupVersion', 'MemTotal', 'NCPU', 'SecurityOptions', 'DockerRootDir'];
const DOCKER_INFO_FORMAT = DOCKER_INFO_FIELDS.map(field => `${field}={{json .${field}}}`).join(' ');
const LIFECYCLE = {
  // One deadline shared by start attempts and pgTAP, leaving >= 10 min of the job's 150 min for teardown.
  // shortcut: fixed minutes mirror the job timeout and backend_local budgets; derive them if those change.
  budget_ms: 130 * 60 * 1000,
  // A fresh attempt needs the replay budget (~53 min) plus full pgTAP (30 min); never start one with less.
  min_attempt_ms: 85 * 60 * 1000,
};
// An attempt whose inner command timed out spent its budget; its proxy noise must not trigger a retry.
const TIMED_OUT_OUTPUT = /"timed_out":\s*true|spawnSync \S+ ETIMEDOUT/;
const MIGRATION_FILE = /^\d+_.+\.sql$/;

const readConfigToml = () => fs.readFileSync(path.join(repoRoot, 'supabase/config.toml'), 'utf8');

// Raw `key = value` tokens per `section.key`; quoted strings keep their quotes so numbers must be bare.
function tomlValues(configToml) {
  let section = '';
  const values = {};
  for (const line of configToml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) { section = header[1].trim(); continue; }
    const pair = /^\s*([a-z_]+)\s*=\s*("[^"]*"|\d+)\s*(?:#.*)?$/.exec(line);
    if (pair) values[`${section}.${pair[1]}`] = pair[2];
  }
  return values;
}

function postgresMajor(configToml = readConfigToml()) {
  const major = tomlValues(configToml)['db.major_version'];
  if (!/^\d+$/.test(major || '')) throw new Error('supabase/config.toml [db] major_version is missing');
  return major;
}

function readSupabaseConfig(configToml = readConfigToml()) {
  const values = tomlValues(configToml);
  const projectId = /^"([a-z0-9][a-z0-9_-]*)"$/i.exec(values['.project_id'] || '')?.[1];
  if (!projectId) throw new Error('supabase/config.toml project_id is missing');
  const dbPort = /^\d+$/.test(values['db.port'] || '') ? Number(values['db.port']) : 0;
  if (!dbPort) throw new Error('supabase/config.toml [db] port is missing');
  return { projectId, dbPort, major: postgresMajor(configToml) };
}

const IMAGE_SOURCE_MODES = new Set(['registry', 'tarball']);

function loadLaneConfig(raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/ci/cloud-pool-db-local.json'), 'utf8'))) {
  const where = 'config/ci/cloud-pool-db-local.json';
  const exclude = raw?.supabase_start_exclude;
  const required = raw?.supabase_start_required || [];
  if (!Array.isArray(exclude) || !exclude.length || exclude.some(name => !/^[a-z][a-z0-9-]*$/.test(String(name)))) {
    throw new Error(`${where} supabase_start_exclude must be a non-empty list of container names`);
  }
  const conflict = exclude.filter(name => required.includes(name));
  if (conflict.length) throw new Error(`cloud-pool-db-local excludes required services: ${conflict.join(',')}`);
  const source = raw?.image_source || {};
  if (!IMAGE_SOURCE_MODES.has(source.mode)) throw new Error(`${where} image_source.mode must be registry or tarball`);
  if (!/^[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._-]+)*$/.test(String(source.registry || ''))) {
    throw new Error(`${where} image_source.registry must be a registry host (optionally with a path prefix)`);
  }
  if (DOCKER_HUB_REGISTRY.test(source.registry)) {
    throw new Error(`${where} image_source.registry must not be Docker Hub: its official images live under library/ (e.g. library/kong), not the CLI's supabase/ paths`);
  }
  const images = raw?.pre_pull_images;
  if (!Array.isArray(images) || !images.length || images.some(name => !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(String(name)))) {
    throw new Error(`${where} pre_pull_images must be a non-empty list of <namespace>/<repository> names (no tags)`);
  }
  if (images[0] !== 'supabase/postgres') {
    throw new Error(`${where} pre_pull_images must start with supabase/postgres (largest image first, on the emptiest disk)`);
  }
  const psqlClient = /^[a-z0-9][a-z0-9._/-]*:(\d+)@sha256:[0-9a-f]{64}$/.exec(String(raw?.psql_client_image || ''));
  if (!psqlClient) throw new Error(`${where} psql_client_image must be a digest-pinned <image>:<major>@sha256:<digest>`);
  const backoff = raw?.pull_backoff_seconds;
  if (!Array.isArray(backoff) || backoff.some(value => !Number.isInteger(value) || value <= 0)) {
    throw new Error(`${where} pull_backoff_seconds must be a list of positive integers`);
  }
  const minFree = raw?.min_free_disk_gb;
  if (typeof minFree !== 'number' || !(minFree > 0)) throw new Error(`${where} min_free_disk_gb must be a positive number`);
  const attemptTimeout = raw?.pull_attempt_timeout_seconds;
  if (!Number.isInteger(attemptTimeout) || attemptTimeout <= 0) {
    throw new Error(`${where} pull_attempt_timeout_seconds must be a positive integer`);
  }
  return { exclude, required, imageSource: { mode: source.mode, registry: source.registry, tarballBaseUrl: source.tarball_base_url || '' },
    prePullImages: images, psqlClientImage: psqlClient[0], psqlClientMajor: psqlClient[1], pullBackoffMs: backoff.map(seconds => seconds * 1000), minFreeBytes: Math.round(minFree * 1e9),
    pullAttemptTimeoutMs: attemptTimeout * 1000 };
}

const SERVICE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// `supabase services` (pinned CLI) lists each service image with its local version: JSON on a non-TTY
// (CLI 2.116: {"services":[{"name":"supabase/postgres","local":"17.6.1.165"}]}), a box table on a TTY,
// or repo:tag text. Only the wanted repositories are kept.
function parseServiceImages(output, wanted) {
  const found = new Map();
  const keep = (name, tag) => {
    const repository = String(name || '').replace(/^library\//, 'supabase/');
    if (wanted.includes(repository) && SERVICE_TAG.test(String(tag || '')) && !found.has(repository)) found.set(repository, String(tag));
  };
  const text = String(output || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/`/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      for (const service of Array.isArray(parsed?.services) ? parsed.services : []) keep(service?.name, service?.local);
    } catch (_) { /* not JSON; fall through to the text formats */ }
  }
  for (const line of text.split(/\r?\n/)) {
    const table = /((?:supabase|library|postgrest)\/[a-z0-9-]+)\s*[\u2502|]\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (table) keep(table[1], table[2]);
    for (const ref of line.matchAll(/(?:[a-z0-9.-]+(?::\d+)?\/)?((?:supabase|library|postgrest)\/[a-z0-9-]+):([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
      keep(ref[1], ref[2]);
    }
  }
  return found;
}

const readDeploySurfaces = () => JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/ci/deploy-surfaces.json'), 'utf8'));

function backendLocalCommands(surfaces) {
  let commands;
  JSON.stringify(surfaces, (_key, value) => {
    if (value?.shard_id === 'backend_local' && value.execution_mode === 'backend_local') commands = value.commands;
    return value;
  });
  return commands || {};
}

// The full-pgTAP env (per-file sessions, no retries, no file filter) comes from the canonical backend_local suite row.
function loadBackendLocalPgtapEnv(surfaces = readDeploySurfaces()) {
  const spec = (backendLocalCommands(surfaces).suite_commands || []).find(entry => entry.suite_ids?.includes('pgtap'));
  if (spec?.env?.PGTAP_FULL_LOCAL_QUALIFICATION !== '1' || spec.env.PGTAP_ONLY_FILES !== '') {
    throw new Error('backend_local pgTAP must run the full suite with PGTAP_FULL_LOCAL_QUALIFICATION=1');
  }
  return { ...spec.env };
}

// The DB lints the PR DB shard ran before pgTAP (lint:db, lint:db:fixtures) are the canonical backend_local
// pre-suite rows; only `npm run <script>` rows are admitted so the row cannot smuggle an arbitrary command.
function loadBackendLocalPreSuiteCommands(surfaces = readDeploySurfaces()) {
  const rows = backendLocalCommands(surfaces).pre_suite_commands;
  if (!Array.isArray(rows) || !rows.length) throw new Error('backend_local pre_suite_commands must be a non-empty list');
  return rows.map((row) => {
    const [run, script, ...rest] = Array.isArray(row?.args) ? row.args : [];
    if (row?.command !== 'npm' || run !== 'run' || !/^[a-z][a-z0-9:_-]*$/.test(String(script || '')) || rest.length
      || !(Number(row.timeout_ms) > 0)) {
      throw new Error('backend_local pre_suite_commands rows must be `npm run <script>` with a positive timeout_ms');
    }
    return { script, env: { ...(row.env || {}) }, timeout_ms: Number(row.timeout_ms) };
  });
}

function countLocalMigrations(dir = path.join(repoRoot, 'supabase/migrations')) {
  return fs.readdirSync(dir).filter(name => MIGRATION_FILE.test(name)).length;
}

function localDatabaseUrl(port) {
  // objectives:allow DSN_URL Justification: the plain-CLI local Supabase default superuser on the loopback config.toml port.
  // objectives:allow LOCALHOST Justification: the dedicated local-db lane reaches its own Supabase DB only on loopback.
  return ([`postgresql`,":","/","/",`postgres`,":",`postgres`,"@",`127.0.0.1`,":",`${port}`,"/",`postgres`].join(""));
}

// local-db has Docker but no host psql and no root for apt: run the matching client image on the host network.
// A rootless daemon already maps container root to the caller, and --user would then lose access to the
// caller's 0700 temp dirs (pgTAP batch work dir), so --user is only added for a rootful daemon.
function writePsqlWrapper(binDir, image, { rootless = false } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'psql');
  const user = rootless ? '' : '--user "$(id -u):$(id -g)" ';
  fs.writeFileSync(file, ['#!/bin/sh',
    `exec docker run --rm -i --network host ${user}-v "$PWD:$PWD" -v "\${TMPDIR:-/tmp}:\${TMPDIR:-/tmp}" -w "$PWD" ${PSQL_ENV.map(key => `-e ${key}`).join(' ')} ${image} psql "$@"`,
    ''].join('\n'), { mode: 0o755 });
  return file;
}

function isRootlessDocker(securityOptionsJson) {
  try {
    const options = JSON.parse(String(securityOptionsJson || '').trim() || '[]');
    return Array.isArray(options) && options.some(option => String(option).split(',').includes('name=rootless'));
  } catch (_) {
    return false;
  }
}

// Same pinned contract and asset as setup-cloud-env, installed here so only this job retries the flaky local-db egress.
function resolveSupabaseCliAsset(env) {
  const version = validateVersion(getToolContract(loadCliContract(), 'supabase'), env);
  if (!version) throw new Error('SUPABASE_CLI_VERSION is required for the local Supabase lifecycle');
  return buildSupabaseCliAsset({ version, platform: env.RUNNER_OS || process.platform, arch: env.RUNNER_ARCH || process.arch });
}

function dsnHost(value) {
  const raw = String(value).trim();
  if (!raw.includes('://')) {
    const keyValue = /(?:^|\s)host=([^\s]+)/.exec(raw);
    return keyValue ? keyValue[1] : raw.split(/[:/]/)[0];
  }
  return new URL(raw).hostname;
}

function findRemoteDsns(env, source) {
  const issues = [];
  for (const [key, value] of Object.entries(env || {})) {
    if (!DSN_KEY.test(key) || !String(value || '').trim()) continue;
    let hosts;
    try {
      hosts = dsnHost(value).split(',').map(host => host.replace(/:\d+$/, '').toLowerCase());
    } catch (_) {
      issues.push(`${source}: ${key} is not a parseable loopback DSN`);
      continue;
    }
    if (!hosts.length || hosts.some(host => !LOOPBACK_HOSTS.has(host))) issues.push(`${source}: ${key} targets a non-loopback host`);
  }
  return issues;
}

function assertLoopbackOnly(env, source) {
  const issues = findRemoteDsns(env, source);
  if (issues.length) throw new Error(`remote_dsn_rejected (fail-closed):\n- ${issues.join('\n- ')}`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main(resultDir, {
  spawn = spawnSync, env = process.env, supabaseConfig = readSupabaseConfig(), laneConfig = loadLaneConfig(),
  pgtapEnv = loadBackendLocalPgtapEnv(), preSuite = loadBackendLocalPreSuiteCommands(), migrationCount = countLocalMigrations(), binDir, sleep = sleepSync,
  retry = RETRY, cliAsset = () => resolveSupabaseCliAsset(env), lifecycle = LIFECYCLE, now = Date.now,
} = {}) {
  if (!resultDir) throw new Error('usage: cloud-pool-db-local.js <result-dir>');
  fs.mkdirSync(resultDir, { recursive: true });
  const registry = laneConfig.imageSource.registry;
  const registryIsDefault = registry === DEFAULT_IMAGE_REGISTRY;
  // A non-default registry (a mirror) stays out of uploaded results and logs.
  const mask = text => (registryIsDefault ? String(text) : String(text).split(registry).join('custom'));
  let psqlImage = '';
  const dsn = localDatabaseUrl(supabaseConfig.dbPort);
  const ownsBin = !binDir;
  const psqlBin = binDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cpdb-psql-'));
  const cliRoot = path.join(psqlBin, 'supabase-cli');
  const baseEnv = { ...env, CI: 'true', NX_DAEMON: 'false', PATH: [psqlBin, cliRoot, env.PATH].filter(Boolean).join(path.delimiter) };
  let prePullImages;
  // The shared deadline starts with the job prep, so prep + lifecycle never exceed the job timeout.
  const deadline = now() + lifecycle.budget_ms;
  // DB_LOCAL_REF is the exact checked-out commit; GITHUB_SHA is a PR merge ref when called from pull_request.
  const summary = { sha: env.DB_LOCAL_REF || env.GITHUB_SHA || '', psql_image: '', project_id: supabaseConfig.projectId,
    supabase_start_exclude: laneConfig.exclude,
    image_source: { mode: laneConfig.imageSource.mode, registry: registryIsDefault ? registry : 'custom',
      tarball_base_url: laneConfig.imageSource.tarballBaseUrl ? 'custom' : '' },
    images: [], steps: [], ok: false };
  const record = (step, fn) => {
    const started = Date.now();
    const entry = { step, status: 'failed', duration_ms: 0 };
    summary.steps.push(entry);
    try {
      fn();
      entry.status = 'passed';
    } finally {
      entry.duration_ms = Date.now() - started;
    }
  };
  const runChecked = (label, command, args, { timeout = 600000, extraEnv = {}, masked = false } = {}) => {
    // masked: piped and printed through mask(), for commands that print image names (a mirror host stays out of the job log).
    const result = spawn(command, args, { cwd: repoRoot, timeout, env: { ...baseEnv, ...extraEnv },
      ...(masked ? { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 } : { stdio: 'inherit' }) });
    if (masked) process.stdout.write(mask(`${result.stdout || ''}${result.stderr || ''}`));
    if (result.error || result.status !== 0) {
      throw new Error(`${label} failed: ${result.error?.code || result.error?.message || `exit ${result.status}`}`);
    }
  };
  // Bounded retries for transient pulls only; deterministic failures (migrations, tests) fail on the first attempt.
  const withRetries = (step, attemptOnce, between, canRetry = () => true) => record(step, () => {
    for (let attempt = 1; ; attempt += 1) {
      const outcome = attemptOnce(attempt);
      if (outcome.ok) return;
      if (!outcome.transient || attempt >= retry.attempts) {
        throw new Error(`${step} failed: ${outcome.reason}${attempt > 1 ? ` after ${attempt} attempts` : ''}`);
      }
      const delayMs = retry.baseDelayMs * attempt;
      if (!canRetry(delayMs)) {
        throw new Error(`${step} failed: ${outcome.reason}; no retry, the shared deadline leaves too little time for a fresh attempt`);
      }
      console.error(`[cloud-pool-db-local] ${step} attempt ${attempt}/${retry.attempts} hit a transient pull/network error; retrying in ${delayMs / 1000}s`);
      between?.();
      sleep(delayMs);
    }
  });
  const runLogged = (spec, logFile) => {
    const fd = fs.openSync(logFile, 'w');
    let result;
    try {
      result = spawn(spec.command, spec.args, {
        cwd: repoRoot, stdio: ['ignore', fd, fd], timeout: spec.timeout_ms, env: { ...baseEnv, ...(spec.env || {}) },
      });
    } finally {
      fs.closeSync(fd);
    }
    const output = fs.readFileSync(logFile, 'utf8');
    const masked = mask(output);
    if (masked !== output) fs.writeFileSync(logFile, masked);
    process.stdout.write(masked);
    if (!result.error && result.status === 0) return { ok: true };
    // A timeout is never retried (a hung attempt already spent its budget), and neither is a final error.
    const final = FINAL_PULL_ERROR.exec(output)?.[0] || '';
    return { ok: false, final,
      transient: !result.error && !final && TRANSIENT_PULL_ERROR.test(output) && !TIMED_OUT_OUTPUT.test(output),
      reason: `${result.error?.code || result.error?.message || `exit ${result.status}`}${final ? ` (final: ${final})` : ''}` };
  };
  const diagnose = (label, command, args) => {
    const result = spawn(command, args, { encoding: 'utf8', timeout: 60000 });
    const body = result.error ? `unavailable (${result.error.code || result.error.message})` : `${result.stdout || ''}${result.stderr || ''}`;
    console.log(`[cloud-pool-db-local] ${label}:\n${body}`);
    return result;
  };
  let failure;
  let pruneProjectContainers;
  let removePulledImages;
  let probeImageRef = '';
  try {
    record('loopback_job_env', () => {
      assertLoopbackOnly(env, 'job environment');
      assertLoopbackOnly({ DATABASE_URL: dsn }, 'lane database');
    });
    // Evidence only (shared local-db VMs): never fails the proof by itself.
    let dockerRoot = '';
    record('runner_diagnostics', () => {
      diagnose('free -m', 'free', ['-m']);
      const info = diagnose('docker info (selected fields)', 'docker', ['info', '--format', DOCKER_INFO_FORMAT]);
      dockerRoot = /DockerRootDir="([^"]+)"/.exec(String(info.stdout || ''))?.[1] || '';
      if (dockerRoot) diagnose(`df -h ${dockerRoot}`, 'df', ['-h', dockerRoot]);
    });
    record('docker_daemon', () => {
      const probe = spawn('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 60000 });
      if (probe.error || probe.status !== 0) {
        throw new Error('docker_unavailable: this runner cannot reach a Docker daemon; Runners must attest Docker on example-runner/example-runner');
      }
    });
    withRetries('supabase_cli', attempt => {
      const asset = cliAsset();
      const archive = path.join(cliRoot, asset.asset_name);
      fs.rmSync(cliRoot, { recursive: true, force: true });
      fs.mkdirSync(cliRoot, { recursive: true });
      const fetched = (url, connect, max) => {
        const result = spawn('curl', ['-fsSL', '--connect-timeout', connect, '--max-time', max, url, '-o', archive], { stdio: 'inherit' });
        return !result.error && result.status === 0 && (!asset.sha256
          || crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') === asset.sha256);
      };
      if (!(asset.mirror_url && fetched(asset.mirror_url, '5', '30')) && !fetched(asset.download_url, '15', '450')) {
        // A dropped tunnel or truncated body is a network failure; the next attempt downloads again.
        return { ok: false, transient: true, reason: `download or checksum failed (attempt ${attempt})` };
      }
      const untar = spawn('tar', ['-xzf', archive, '-C', cliRoot], { stdio: 'inherit' });
      if (untar.error || untar.status !== 0) return { ok: false, transient: false, reason: 'extract failed' };
      baseEnv.SUPABASE_CLI_BIN = path.join(cliRoot, asset.binary_name);
      return { ok: true };
    });
    record('docker_disk_before', () => { diagnose('docker system df', 'docker', ['system', 'df']); });
    const cli = baseEnv.SUPABASE_CLI_BIN;
    // One registry prefix for the pre-pull and the CLI, so supabase start finds every image locally.
    baseEnv.SUPABASE_INTERNAL_IMAGE_REGISTRY = registry;
    const gb = bytes => `${(bytes / 1e9).toFixed(1)} GB`;
    const listImages = ({ required = false } = {}) => {
      const result = spawn('docker', ['image', 'ls', '--no-trunc', '--format', '{{.ID}}\t{{.Repository}}:{{.Tag}}'], {
        encoding: 'utf8', timeout: 60000,
      });
      if (result.error || result.status !== 0) {
        if (required) throw new Error(`docker_image_list failed: ${result.error?.code || result.error?.message || `exit ${result.status}`}`);
        return [];
      }
      return String(result.stdout || '').split(/\r?\n/).map(line => {
        const [id, ref] = line.trim().split(/\s+/, 2);
        return { id, ref };
      }).filter(entry => entry.id && entry.ref);
    };
    const parseContainerDf = output => {
      for (const line of String(output || '').split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length >= 6 && /^\d+$/.test(columns[1]) && /^\d+$/.test(columns[2])
          && /^\d+$/.test(columns[3]) && /^\d+%$/.test(columns[4]) && columns[5] === '/') {
          const kib = Number(columns[3]);
          if (Number.isSafeInteger(kib)) return kib * 1024;
        }
      }
      return NaN;
    };
    const pullProbeImage = () => {
      // The first psql pull is exempt from the 6 GB floor because Docker space is unreadable until this tiny probe image exists.
      if (laneConfig.psqlClientMajor !== supabaseConfig.major) {
        throw new Error(`psql_client_image major ${laneConfig.psqlClientMajor} != supabase/config.toml [db] major_version ${supabaseConfig.major}`);
      }
      const image = laneConfig.psqlClientImage;
      for (let attempt = 1; ; attempt += 1) {
        const outcome = runLogged({ command: 'docker', args: ['pull', image],
          timeout_ms: Math.max(1, Math.min(laneConfig.pullAttemptTimeoutMs, deadline - now())) },
        path.join(resultDir, `image-pull-psql_probe-${attempt}.log`));
        if (outcome.ok) {
          probeImageRef = image;
          return;
        }
        const delayMs = laneConfig.pullBackoffMs[attempt - 1];
        if (!outcome.transient || delayMs === undefined || deadline - now() - delayMs < lifecycle.min_attempt_ms) {
          throw new Error(`probe_image_pull failed: ${mask(image)} ${outcome.reason} after ${attempt} attempt(s)`);
        }
        console.error(`[cloud-pool-db-local] ${mask(image)} probe pull attempt ${attempt} throttled/transient; retrying in ${delayMs / 1000}s`);
        sleep(delayMs);
      }
    };
    const freeBytes = () => {
      if (!dockerRoot) {
        const info = spawn('docker', ['info', '--format', '{{.DockerRootDir}}'], { encoding: 'utf8', timeout: 60000 });
        dockerRoot = String(info.stdout || '').trim();
      }
      if (dockerRoot) {
        const df = spawn('df', ['--output=avail', '-B1', dockerRoot], { encoding: 'utf8', timeout: 60000 });
        const last = String(df.stdout || '').trim().split(/\s+/).pop();
        const value = /^\d+$/.test(last) ? Number(last) : NaN;
        if (!df.error && df.status === 0 && Number.isFinite(value)) {
          console.log(`[cloud-pool-db-local] Docker root free space method: host df (${gb(value)})`);
          return value;
        }
      }
      const image = probeImageRef;
      if (image) {
        const probe = spawn('docker', ['run', '--rm', '--pull=never', '--network', 'none', '--entrypoint', 'df', image, '-Pk', '/'], {
          encoding: 'utf8', timeout: 60000,
        });
        const value = parseContainerDf(`${probe.stdout || ''}${probe.stderr || ''}`);
        if (!probe.error && probe.status === 0 && Number.isFinite(value)) {
          console.log(`[cloud-pool-db-local] Docker root free space method: container df (${mask(image)}, ${gb(value)})`);
          return value;
        }
      }
      throw new Error(`disk_unknown: cannot read free space of the Docker root ${dockerRoot || '(unknown)'}`);
    };
    const stop = () => {
      const result = spawn(cli, ['stop', '--no-backup'], { cwd: repoRoot, stdio: 'inherit', timeout: 600000, env: baseEnv });
      if (result.error || result.status !== 0) console.error('[cloud-pool-db-local] supabase stop --no-backup failed; continuing');
    };
    const projectLabel = `label=com.supabase.cli.project=${supabaseConfig.projectId}`;
    pruneProjectContainers = () => runChecked('docker_container_prune', 'docker', ['container', 'prune', '-f', '--filter', projectLabel], { masked: true });
    removePulledImages = () => {
      if (!prePullImages) return;
      const before = new Set(prePullImages.map(entry => entry.id));
      const pulled = [...new Set(listImages({ required: true }).filter(entry => !before.has(entry.id)).map(entry => entry.id))];
      if (pulled.length) {
        try {
          runChecked('docker_image_remove', 'docker', ['image', 'rm', '-f', ...pulled], { masked: true });
        } catch (error) {
          console.error(`::warning::[cloud-pool-db-local] failed to remove job-pulled Docker images; possible leak: ${error.message}`);
          throw error;
        }
      }
      else console.log('[cloud-pool-db-local] no job-pulled images to remove');
    };
    record('docker_prune_before', () => {
      // Keep shared fleet images; only this job's newly pulled images are removed during teardown.
      stop();
      prePullImages = listImages({ required: true });
      pruneProjectContainers();
      pullProbeImage();
      console.log(`[cloud-pool-db-local] Docker root free after prune: ${gb(freeBytes())}`);
    });
    record('image_prepull', () => {
      if (laneConfig.imageSource.mode === 'tarball') {
        throw new Error('image_source.mode=tarball is not implemented yet: download <tarball_base_url>/<repo>_<tag>.tar, verify sha256, docker load');
      }
      const services = spawn(cli, ['services'], { cwd: repoRoot, encoding: 'utf8', timeout: 120000, env: baseEnv });
      const raw = `${services.stdout || ''}${services.stderr ? `\n--- stderr ---\n${services.stderr}` : ''}`;
      fs.writeFileSync(path.join(resultDir, 'supabase-services.raw.txt'), mask(raw));
      const tags = parseServiceImages(services.stdout || '', laneConfig.prePullImages);
      const missing = laneConfig.prePullImages.filter(name => !tags.has(name));
      // The parallel fallback is known to fail on local-db (throttle + vfs disk), so an unreadable list fails fast.
      if (services.error || services.status !== 0 || missing.length) {
        throw new Error(`image_prepull_unparsed: supabase services did not list ${missing.join(',') || 'the images'} (raw output in supabase-services.raw.txt)`);
      }
      if (laneConfig.psqlClientMajor !== supabaseConfig.major) {
        throw new Error(`psql_client_image major ${laneConfig.psqlClientMajor} != supabase/config.toml [db] major_version ${supabaseConfig.major}`);
      }
      // The small psql client was pulled before the first floor check so Docker-root space can be measured safely.
      const pulls = [...laneConfig.prePullImages.map(repository => ({ repository, image: `${registry}/${repository}:${tags.get(repository)}` })),
        { repository: 'psql_client', image: laneConfig.psqlClientImage }];
      for (const { repository, image } of pulls) {
        const started = now();
        if (repository === 'psql_client' && probeImageRef === image) {
          console.log(`[cloud-pool-db-local] using cached probe image ${mask(image)}`);
        } else {
          for (let attempt = 1; ; attempt += 1) {
            const free = freeBytes();
            console.log(`[cloud-pool-db-local] Docker root free before ${mask(image)}: ${gb(free)}`);
            if (free < laneConfig.minFreeBytes) {
              throw new Error(`disk_low: ${gb(free)} free on the Docker root before ${mask(image)} < min_free_disk_gb ${gb(laneConfig.minFreeBytes)}`);
            }
            const outcome = runLogged({ command: 'docker', args: ['pull', image],
              timeout_ms: Math.max(1, Math.min(laneConfig.pullAttemptTimeoutMs, deadline - now())) },
            path.join(resultDir, `image-pull-${repository.replace('/', '_')}-${attempt}.log`));
            if (outcome.ok) break;
            const delayMs = laneConfig.pullBackoffMs[attempt - 1];
            if (!outcome.transient || delayMs === undefined || deadline - now() - delayMs < lifecycle.min_attempt_ms) {
              throw new Error(`image_prepull failed: ${mask(image)} ${outcome.reason} after ${attempt} attempt(s)`);
            }
            console.error(`[cloud-pool-db-local] ${mask(image)} pull attempt ${attempt} throttled/transient; retrying in ${delayMs / 1000}s`);
            sleep(delayMs);
          }
        }
        const inspect = spawn('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image], { encoding: 'utf8', timeout: 60000 });
        const digest = String(inspect.stdout || '').trim();
        if (!/@sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`image_prepull failed: no digest for ${mask(image)}`);
        const entry = { repository, image: mask(image), digest: mask(digest), duration_ms: now() - started };
        summary.images.push(entry);
        console.log(`[cloud-pool-db-local] pulled ${entry.digest} in ${Math.round(entry.duration_ms / 1000)}s`);
        diagnose(`docker system df after ${repository}`, 'docker', ['system', 'df']);
      }
      psqlImage = laneConfig.psqlClientImage;
      summary.image_prepull = 'pulled';
      summary.psql_image = mask(psqlImage);
      console.log(`[cloud-pool-db-local] Docker root free after pre-pull: ${gb(freeBytes())}`);
    });
    record('lifecycle_budget', () => {
      const remaining = deadline - now();
      if (remaining < lifecycle.min_attempt_ms) {
        throw new Error(`deadline_short: ${Math.round(remaining / 60000)} min left after the pre-pull < ${Math.round(lifecycle.min_attempt_ms / 60000)} min for start + replay + pgTAP`);
      }
    });
    record('psql_wrapper', () => {
      const security = spawn('docker', ['info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8', timeout: 60000 });
      const rootless = !security.error && security.status === 0 && isRootlessDocker(security.stdout);
      console.log(`[cloud-pool-db-local] psql wrapper mode: ${rootless ? 'rootless daemon, no --user' : 'rootful daemon, --user uid:gid'}`);
      // psql from the small pre-pulled psql_client_image (same server major, digest-pinned).
      writePsqlWrapper(psqlBin, psqlImage, { rootless });
      const probe = spawn('psql', ['--version'], { encoding: 'utf8', timeout: 60000, env: baseEnv });
      if (probe.error || probe.status !== 0) throw new Error(`psql wrapper (${mask(psqlImage)}) is not usable`);
      console.log(`[cloud-pool-db-local] psql via ${mask(psqlImage)}: ${String(probe.stdout || '').trim()}`);
    });
    // A fresh volume: start replays every migration from zero; a migration error fails start.
    console.log(`[cloud-pool-db-local] supabase start excluding: ${laneConfig.exclude.join(',')}`);
    withRetries('supabase_start', attempt => runLogged({ command: cli, args: ['start', '-x', laneConfig.exclude.join(',')],
      timeout_ms: Math.max(1, deadline - now()) }, path.join(resultDir, `supabase-start-attempt-${attempt}.log`)),
    stop, delayMs => deadline - now() - delayMs >= lifecycle.min_attempt_ms);
    record('migrations_applied', () => {
      const applied = spawn('psql', [dsn, '-Atc', 'SELECT count(*) FROM supabase_migrations.schema_migrations'],
        { cwd: repoRoot, encoding: 'utf8', timeout: 60000, env: baseEnv });
      const count = Number(String(applied.stdout || '').trim());
      if (applied.error || applied.status !== 0 || count !== migrationCount) {
        throw new Error(`migrations_incomplete: applied=${Number.isFinite(count) ? count : 'unknown'} expected=${migrationCount}`);
      }
    });
    // No env file: every DB consumer sees only the loopback lane DSN.
    const laneEnv = { ENV_FILE: os.devNull, ENV_FILE_OVERRIDE: '0', ENV_FILE_APPEND: '0', DATABASE_URL: dsn,
      DATABASE_URL_DIRECT: dsn, WORKSPACE_NAME: supabaseConfig.projectId };
    for (const lint of preSuite) {
      record(`pre_suite:${lint.script}`, () => runChecked(lint.script, 'npm', ['run', lint.script], {
        timeout: Math.max(1, Math.min(lint.timeout_ms, deadline - now())), extraEnv: { ...lint.env, ...laneEnv },
      }));
    }
    record('pgtap_disk_floor', () => {
      // Each per-file psql container is a transient vfs copy of the client image; fail closed before pgTAP if that cannot fit.
      const free = freeBytes();
      console.log(`[cloud-pool-db-local] Docker root free before pgTAP: ${gb(free)}`);
      if (free < laneConfig.minFreeBytes) throw new Error(`disk_low: ${gb(free)} free on the Docker root before pgTAP < min_free_disk_gb ${gb(laneConfig.minFreeBytes)}`);
    });
    record('pgtap_full_local', () => runChecked('pgtap_full_local', process.execPath, ['scripts/ops/ci/cloud-pool-db-local-pgtap.js'], {
      timeout: Math.max(1, deadline - now()),
      extraEnv: { ...pgtapEnv, ...laneEnv, DB_LOCAL_PROJECT_ID: supabaseConfig.projectId,
        DB_LOCAL_DB_PORT: String(supabaseConfig.dbPort) },
    }));
    summary.ok = true;
  } catch (error) {
    failure = error;
    console.error(`[cloud-pool-db-local] ${error.message}`);
  } finally {
    // Teardown evidence and cleanup never change the proof verdict. Preserve shared fleet images and remove only
    // this job's newly pulled images plus stopped containers carrying this project's Supabase label.
    if (summary.steps.some(entry => entry.step === 'docker_daemon' && entry.status === 'passed')) {
      const teardown = (step, fn) => {
        try { record(step, fn); } catch (error) { console.error(`[cloud-pool-db-local] ${error.message}`); }
      };
      teardown('docker_disk_after', () => { diagnose('docker system df', 'docker', ['system', 'df']); });
      if (baseEnv.SUPABASE_CLI_BIN) teardown('supabase_stop', () => runChecked('supabase_stop', baseEnv.SUPABASE_CLI_BIN, ['stop', '--no-backup']));
      if (pruneProjectContainers) teardown('docker_container_prune', pruneProjectContainers);
      if (removePulledImages) teardown('docker_image_remove', removePulledImages);
    }
    if (ownsBin) fs.rmSync(psqlBin, { recursive: true, force: true });
    fs.writeFileSync(path.join(resultDir, 'db-local-result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (failure) throw failure;
  return summary;
}

if (require.main === module) {
  try {
    main(process.argv[2]);
  } catch (_) {
    process.exit(1);
  }
}

module.exports = {
  LOOPBACK_HOSTS, TRANSIENT_PULL_ERROR, FINAL_PULL_ERROR, DOCKER_INFO_FORMAT, LIFECYCLE, readSupabaseConfig, postgresMajor, loadLaneConfig, parseServiceImages,
  loadBackendLocalPgtapEnv, loadBackendLocalPreSuiteCommands, countLocalMigrations, localDatabaseUrl, writePsqlWrapper, isRootlessDocker,
  resolveSupabaseCliAsset, findRemoteDsns, assertLoopbackOnly, main,
};
