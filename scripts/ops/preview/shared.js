#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseFlagArgs } = require('../../utils/cli-args');
const { loadDeploySurfaceRegistry, compileRegistry } = require('../ci/deploy-surface-registry');

function die(prefix, msg) {
  console.error(`[${prefix}] ${msg}`);
  process.exit(1);
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function normalizeTopology(value) {
  const topology = String(value || '').trim().toLowerCase();
  if (topology !== 'pr' && topology !== 'worktree') {
    throw new Error(`Invalid topology "${topology || '<missing>'}" (expected pr|worktree).`);
  }
  return topology;
}

function normalizeSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{7,64}$/.test(sha) ? sha : '';
}

function resolveTopologyIdentity({ args, env = process.env, cwd = process.cwd() }) {
  const topology = normalizeTopology(args.topology || env.PREVIEW_TOPOLOGY || 'pr');
  const sha = normalizeSha(args.sha || env.GITHUB_SHA || '');
  if (!sha) throw new Error('Missing --sha (or GITHUB_SHA).');

  let id = String(args.id || '').trim();
  if (!id) {
    id = topology === 'pr'
      ? String(args.pr || env.PR_NUMBER || '').trim()
      : String(env.WORKTREE_ID || '').trim();
  }
  if (!id) {
    throw new Error(`Missing --id for topology "${topology}".`);
  }

  const workerId = String(args['worker-id'] || env.WORKER_ID || id).trim();
  const worktreeSlug = String(args['worktree-slug'] || env.WORKTREE_SLUG || path.basename(cwd)).trim();
  if (!workerId) throw new Error('Missing worker id for worktree topology.');
  if (!worktreeSlug) throw new Error('Missing worktree slug for worktree topology.');

  const topologyKey = topology === 'pr'
    ? `pr:${id}:${sha}`
    : `worktree:${workerId}:${worktreeSlug}:${sha}`;
  const topologyHash = crypto.createHash('sha1').update(topologyKey).digest('hex').slice(0, 12);

  return {
    topology,
    id,
    sha,
    workerId,
    worktreeSlug,
    topologyKey,
    topologyHash,
  };
}

function resolveManifestPath({ args, identity, cwd = process.cwd() }) {
  const explicit = String(args.manifest || '').trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit);
  }
  const fileName = `${identity.topology}-${identity.id}-${identity.sha}.json`;
  return path.resolve(cwd, '.tmp', 'preview-manifests', fileName);
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function normalizeSurfaceUrlValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) return `https://${raw}`;
  return '';
}

function resolveSurfaceUrl({
  manifest,
  surfaceId,
  envKey = '',
  env = process.env,
  includeEnvFallback = true,
}) {
  const surfaces = manifest?.surfaces && typeof manifest.surfaces === 'object'
    ? manifest.surfaces
    : {};
  const readSurface = (surface) => {
    if (!surface || typeof surface !== 'object') return '';
    for (const candidate of [
      surface.deployment_url,
      surface.url,
      surface.preview_url,
      surface.base_url,
      surface.host,
    ]) {
      const normalized = normalizeSurfaceUrlValue(candidate);
      if (normalized) return normalized;
    }
    return '';
  };

  const direct = readSurface(surfaces[surfaceId]);
  if (direct) return direct;

  const keyMatcher = new RegExp(`(^|[_-])${String(surfaceId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([_-]|$)`, 'i');
  for (const [key, value] of Object.entries(surfaces)) {
    if (!keyMatcher.test(String(key || ''))) continue;
    const normalized = readSurface(value);
    if (normalized) return normalized;
  }

  const rootAliases = surfaceId === 'console'
    ? ['console_url', 'consoleUrl', 'console_base_url', 'consoleBaseUrl']
    : surfaceId === 'portal'
      ? ['portal_url', 'portalUrl', 'portal_base_url', 'portalBaseUrl']
      : surfaceId === 'landing'
        ? ['landing_url', 'landingUrl', 'landing_base_url', 'landingBaseUrl']
        : ['docs_url', 'docsUrl', 'docs_base_url', 'docsBaseUrl'];
  for (const alias of rootAliases) {
    const normalized = normalizeSurfaceUrlValue(manifest?.[alias]);
    if (normalized) return normalized;
  }

  if (!includeEnvFallback || !envKey) return '';
  return normalizeSurfaceUrlValue(env?.[envKey]);
}

function loadSurfaceRegistry() {
  const { registry } = loadDeploySurfaceRegistry();
  return compileRegistry(registry);
}

function parseRequiredSurfaceIds({ raw, compiledRegistry }) {
  const requested = String(raw || '').trim();
  if (!requested) return null;

  const values = requested
    .split(',')
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) return null;
  if (values.includes('*') || values.includes('all')) return null;

  const knownSurfaceIds = new Set(
    (compiledRegistry?.surfaces || [])
      .map((surface) => String(surface?.surface_id || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const out = new Set();
  for (const value of values) {
    if (!knownSurfaceIds.has(value)) {
      throw new Error(`Unknown required preview surface "${value}".`);
    }
    out.add(value);
  }
  return out;
}

function collectSurfacePreviewContext({ compiledRegistry, env = process.env }) {
  const envEntries = Object.entries(env || {});
  function resolveEnvValue(key) {
    const raw = String(key || '').trim();
    if (!raw) return '';
    if (raw.startsWith('re:')) {
      const pattern = raw.slice(3);
      let re = null;
      try {
        re = new RegExp(pattern);
      } catch {
        return '';
      }
      const match = envEntries.find(([name, value]) => re.test(String(name || '')) && String(value || '').trim());
      return match ? String(match[1] || '').trim() : '';
    }

    const exact = String(env[raw] || '').trim();
    if (exact) return exact;

    // Preview environments frequently namespace shared keys under PREVIEW_*.
    const previewAlias = String(env[`PREVIEW_${raw}`] || '').trim();
    if (previewAlias) return previewAlias;

    return '';
  }

  const surfaces = Array.isArray(compiledRegistry?.surfaces) ? compiledRegistry.surfaces : [];
  return surfaces.map((surface) => {
    const preview = surface.preview || {};
    const requiredSecrets = Array.isArray(preview.required_preview_secret_keys)
      ? preview.required_preview_secret_keys
      : [];
    const requiredVars = Array.isArray(preview.required_preview_var_keys)
      ? preview.required_preview_var_keys
      : [];
    const missingSecrets = requiredSecrets.filter((k) => !resolveEnvValue(k));
    const missingVars = requiredVars.filter((k) => !resolveEnvValue(k));
    return {
      surface_id: surface.surface_id,
      provider: preview.provider || '',
      preview,
      missing_required_preview_secret_keys: missingSecrets,
      missing_required_preview_var_keys: missingVars,
      ready: missingSecrets.length === 0 && missingVars.length === 0,
    };
  });
}

function parseLastJsonFromText(text) {
  const raw = String(text || '');
  const start = raw.lastIndexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

async function runNodeScript({
  scriptPath,
  scriptArgs = [],
  env = process.env,
  cwd = process.cwd(),
  label,
  timeoutMs = 0,
  heartbeatIntervalMs,
}) {
  const resolvedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : 0;
  const rawHeartbeatIntervalMs = Number.isFinite(Number(heartbeatIntervalMs))
    ? Number(heartbeatIntervalMs)
    : Number(process.env.PREVIEW_CHILD_HEARTBEAT_MS || 30_000);
  const resolvedHeartbeatIntervalMs = rawHeartbeatIntervalMs > 0
    ? Math.floor(rawHeartbeatIntervalMs)
    : 0;
  const resolvedLabel = String(label || path.basename(scriptPath)).trim() || path.basename(scriptPath);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let lastOutputAt = Date.now();
    let timeoutHandle = null;
    let heartbeatHandle = null;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (heartbeatHandle) clearInterval(heartbeatHandle);
      timeoutHandle = null;
      heartbeatHandle = null;
    };

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const writeChunk = (target, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (!text) return '';
      target.write(text);
      lastOutputAt = Date.now();
      return text;
    };

    child.stdout.on('data', (chunk) => {
      stdout += writeChunk(process.stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += writeChunk(process.stderr, chunk);
    });
    child.on('error', (error) => {
      finish(() => {
        const err = new Error(`${resolvedLabel} failed: ${error.message}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.output = [stdout, stderr].filter(Boolean).join('\n');
        reject(err);
      });
    });

    if (resolvedTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Best-effort kill only.
        }
      }, resolvedTimeoutMs);
    }

    if (resolvedHeartbeatIntervalMs > 0) {
      heartbeatHandle = setInterval(() => {
        const idleSeconds = Math.max(1, Math.floor((Date.now() - lastOutputAt) / 1000));
        process.stdout.write(
          `[preview-child] ${resolvedLabel} still running (${idleSeconds}s since last child output)\n`,
        );
      }, resolvedHeartbeatIntervalMs);
    }

    child.on('close', (code, signal) => {
      finish(() => {
        if (timedOut) {
          const err = new Error(`${resolvedLabel} timed out after ${resolvedTimeoutMs}ms`);
          err.stdout = stdout;
          err.stderr = stderr;
          err.output = [stdout, stderr].filter(Boolean).join('\n');
          reject(err);
          return;
        }
        if (signal) {
          const err = new Error(`${resolvedLabel} terminated by signal ${signal}`);
          err.stdout = stdout;
          err.stderr = stderr;
          err.output = [stdout, stderr].filter(Boolean).join('\n');
          err.signal = signal;
          reject(err);
          return;
        }
        if (code !== 0) {
          const err = new Error(`${resolvedLabel} failed with exit code ${code}`);
          err.stdout = stdout;
          err.stderr = stderr;
          err.output = [stdout, stderr].filter(Boolean).join('\n');
          err.status = code;
          reject(err);
          return;
        }
        resolve({
          status: Number.isFinite(Number(code)) ? Number(code) : 0,
          stdout,
          stderr,
        });
      });
    });
  });
}

function evaluateManifestFreshness({ manifest, identity, ttlHours = 6 }) {
  if (!manifest || typeof manifest !== 'object') {
    return { reusable: false, reason: 'missing_manifest' };
  }
  const manifestShas = new Set(
    [
      manifest.source_sha,
      manifest.head_sha,
      manifest.sha,
      manifest.merge_sha,
    ]
      .map((value) => normalizeSha(value))
      .filter(Boolean),
  );
  if (!manifestShas.size || !manifestShas.has(identity.sha)) {
    return { reusable: false, reason: 'sha_mismatch' };
  }
  const manifestTopology = String(manifest.topology || '').trim().toLowerCase();
  if (manifestTopology !== identity.topology) {
    return { reusable: false, reason: 'topology_mismatch' };
  }
  const manifestId = String(manifest.id || '').trim();
  if (manifestId !== identity.id) {
    return { reusable: false, reason: 'id_mismatch' };
  }
  const generatedAt = new Date(manifest.generated_at || '').getTime();
  if (!Number.isFinite(generatedAt)) {
    return { reusable: false, reason: 'missing_generated_at' };
  }
  const ageMs = Date.now() - generatedAt;
  const ttlMs = Math.max(1, Number(ttlHours || 6)) * 60 * 60 * 1000;
  if (ageMs > ttlMs) {
    return { reusable: false, reason: 'manifest_stale' };
  }
  return { reusable: true, reason: 'ok', age_ms: ageMs, ttl_ms: ttlMs };
}

function evaluateManifestRequiredSurfaceCoverage({ manifest, requiredSurfaceIds }) {
  if (!requiredSurfaceIds || requiredSurfaceIds.size === 0) {
    return { reusable: true, reason: 'ok' };
  }
  if (!manifest || typeof manifest !== 'object') {
    return { reusable: false, reason: 'missing_manifest' };
  }

  const surfaces = manifest?.surfaces && typeof manifest.surfaces === 'object'
    ? manifest.surfaces
    : {};
  for (const requiredSurfaceId of requiredSurfaceIds) {
    const surfaceId = String(requiredSurfaceId || '').trim().toLowerCase();
    if (!surfaceId || surfaceId === 'db') continue;

    const surface = surfaces[surfaceId];
    if (!surface || typeof surface !== 'object') {
      return { reusable: false, reason: `required_surface_missing:${surfaceId}` };
    }

    const status = String(surface.status || '').trim().toLowerCase();
    if (status !== 'deployed') {
      return { reusable: false, reason: `required_surface_not_ready:${surfaceId}` };
    }
  }

  return { reusable: true, reason: 'ok' };
}

function evaluateManifestReuseHealth({ manifest, cwd = process.cwd(), requiredSurfaceIds = null }) {
  if (!manifest || typeof manifest !== 'object') {
    return { reusable: false, reason: 'missing_manifest' };
  }

  const db = manifest?.surfaces?.db && typeof manifest.surfaces.db === 'object'
    ? manifest.surfaces.db
    : null;
  if (!db) {
    return { reusable: false, reason: 'missing_db_surface' };
  }

  const dbStatus = String(db.status || '').trim().toLowerCase();
  if (!['prewarmed', 'deployed'].includes(dbStatus)) {
    return { reusable: false, reason: 'db_not_ready' };
  }
  if (String(db.db_push || '').trim().toLowerCase() === 'failed') {
    return { reusable: false, reason: 'db_push_failed' };
  }

  const envFile = String(db.env_file || '').trim();
  if (!envFile) {
    return { reusable: false, reason: 'missing_env_file' };
  }

  const envPath = path.isAbsolute(envFile) ? envFile : path.resolve(cwd, envFile);
  if (!fs.existsSync(envPath)) {
    return { reusable: false, reason: 'env_file_missing_on_disk' };
  }

  const runtime = evaluateManifestRuntimeReadiness({ manifest, cwd });
  if (!runtime.ready) {
    return { reusable: false, reason: runtime.failure_class || 'preview_runtime_not_ready' };
  }

  const coverage = evaluateManifestRequiredSurfaceCoverage({ manifest, requiredSurfaceIds });
  if (!coverage.reusable) {
    return coverage;
  }

  return { reusable: true, reason: 'ok', env_file: envPath };
}

function evaluateManifestRuntimeReadiness({ manifest, cwd = process.cwd() }) {
  if (!manifest || typeof manifest !== 'object') {
    return { ready: false, failure_class: 'preview-manifest-invalid', reason: 'missing_manifest' };
  }

  const db = manifest?.surfaces?.db && typeof manifest.surfaces.db === 'object'
    ? manifest.surfaces.db
    : null;
  if (!db) {
    return { ready: false, failure_class: 'preview-manifest-invalid', reason: 'missing_db_surface' };
  }

  const dbStatus = String(db.status || '').trim().toLowerCase();
  if (!['prewarmed', 'deployed'].includes(dbStatus)) {
    return { ready: false, failure_class: 'preview-db-unready', reason: 'db_not_ready' };
  }
  if (String(db.db_push || '').trim().toLowerCase() === 'failed') {
    return {
      ready: false,
      failure_class: String(db.db_push_failure_class || '').trim() || 'preview-db-drift',
      reason: 'db_push_failed',
    };
  }

  const envFile = String(db.env_file || '').trim();
  if (!envFile) {
    return { ready: false, failure_class: 'preview-manifest-invalid', reason: 'missing_env_file' };
  }
  const envPath = path.isAbsolute(envFile) ? envFile : path.resolve(cwd, envFile);
  if (!fs.existsSync(envPath)) {
    return { ready: false, failure_class: 'preview-manifest-invalid', reason: 'env_file_missing_on_disk' };
  }

  if (db.db_ready === false || String(db.db_ready || '').trim().toLowerCase() === 'false') {
    return { ready: false, failure_class: 'preview-db-unready', reason: 'db_probe_failed', env_file: envPath };
  }
  if (db.jwt_ready === false || String(db.jwt_ready || '').trim().toLowerCase() === 'false') {
    return { ready: false, failure_class: 'preview-jwt-unready', reason: 'jwt_not_ready', env_file: envPath };
  }
  if (db.rest_ready === false || String(db.rest_ready || '').trim().toLowerCase() === 'false') {
    return {
      ready: false,
      failure_class: String(db.readiness_failure_class || '').trim() || 'preview-runtime-unready',
      reason: 'rest_auth_not_ready',
      env_file: envPath,
    };
  }

  if (db.runtime_ready === false || String(db.runtime_ready || '').trim().toLowerCase() === 'false') {
    return {
      ready: false,
      failure_class: String(db.readiness_failure_class || '').trim() || 'preview-runtime-unready',
      reason: 'runtime_not_ready',
      env_file: envPath,
    };
  }

  return {
    ready: true,
    failure_class: '',
    reason: 'ok',
    env_file: envPath,
    runtime_ready_at: String(db.runtime_ready_at || '').trim(),
  };
}

function createBaseManifest({ identity, mode }) {
  return {
    version: 3,
    topology: identity.topology,
    id: identity.id,
    sha: identity.sha,
    source_sha: identity.sha,
    head_sha: identity.sha,
    merge_sha: '',
    validated_at: '',
    topology_key: identity.topologyKey,
    topology_hash: identity.topologyHash,
    worker_id: identity.workerId,
    worktree_slug: identity.worktreeSlug,
    active_family_generation: 1,
    recovery_reason: '',
    mode: String(mode || '').trim() || 'deploy',
    generated_at: new Date().toISOString(),
    prewarm: {
      reused: false,
      reusable: false,
      reuse_reason: '',
      reuse_health_reason: '',
      reused_from_artifact: '',
      reused_from_run_id: '',
      reused_from_source_sha: '',
      prior_validation: '',
      env_rehydrated: false,
    },
    surfaces: {},
    checks: {},
    warnings: [],
    teardown: {},
  };
}

function ensureManifestShape({ manifest, identity, mode }) {
  const base = manifest && typeof manifest === 'object'
    ? manifest
    : createBaseManifest({ identity, mode });

  // Always realign the top-level manifest identity to the current run. Reused
  // artifacts can carry stale preview-evidence reports or prior-SHA manifests,
  // and the manifest contract must stay anchored to the current topology/id/SHA.
  base.version = Number(base.version || 0) >= 3 ? Number(base.version) : 3;
  base.topology = identity.topology;
  base.id = identity.id;
  base.sha = identity.sha;
  base.source_sha = identity.sha;
  base.head_sha = identity.sha;
  base.worker_id = identity.workerId;
  base.worktree_slug = identity.worktreeSlug;
  base.topology_key = identity.topologyKey;
  base.topology_hash = identity.topologyHash;
  base.mode = String(mode || base.mode || '').trim() || 'deploy';
  if (typeof base.merge_sha !== 'string') {
    base.merge_sha = String(base.merge_sha || '').trim();
  }

  base.prewarm = base.prewarm && typeof base.prewarm === 'object'
    ? base.prewarm
    : {};
  base.surfaces = base.surfaces && typeof base.surfaces === 'object'
    ? base.surfaces
    : {};
  base.checks = base.checks && typeof base.checks === 'object'
    ? base.checks
    : {};
  base.warnings = Array.isArray(base.warnings)
    ? base.warnings
    : [];
  base.teardown = base.teardown && typeof base.teardown === 'object'
    ? base.teardown
    : {};

  return base;
}

function printOutputs(payload, format = '') {
  const fmt = String(format || '').trim().toLowerCase();
  if (fmt === 'github-output') {
    const outPath = process.env.GITHUB_OUTPUT;
    if (!outPath) throw new Error('GITHUB_OUTPUT not set for github-output format.');
    const lines = [];
    for (const [k, v] of Object.entries(payload || {})) {
      lines.push(`${k}=${String(v == null ? '' : v)}`);
    }
    fs.appendFileSync(outPath, lines.join('\n') + '\n', 'utf8');
    return;
  }
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function parseCommonCli(argv = process.argv.slice(2)) {
  const args = parseFlagArgs(argv);
  return {
    args,
    format: String(args.format || '').trim(),
    dryRun: isTruthy(args['dry-run']),
    strict: isTruthy(args.strict || process.env.PREVIEW_FULL_STACK_STRICT || '0'),
    reusePrewarm: isTruthy(args['reuse-prewarm']),
    ttlHours: Number.parseInt(String(args['prewarm-ttl-hours'] || process.env.PREVIEW_PREWARM_TTL_HOURS || '6'), 10) || 6,
  };
}

module.exports = {
  die,
  isTruthy,
  normalizeTopology,
  normalizeSha,
  resolveTopologyIdentity,
  resolveManifestPath,
  ensureParentDir,
  readJsonFile,
  writeJsonFile,
  normalizeSurfaceUrlValue,
  resolveSurfaceUrl,
  loadSurfaceRegistry,
  parseRequiredSurfaceIds,
  collectSurfacePreviewContext,
  parseLastJsonFromText,
  runNodeScript,
  evaluateManifestFreshness,
  evaluateManifestRequiredSurfaceCoverage,
  evaluateManifestReuseHealth,
  evaluateManifestRuntimeReadiness,
  createBaseManifest,
  ensureManifestShape,
  printOutputs,
  parseCommonCli,
};
