#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { parseFlagArgs } = require('../../utils/cli-args');
const { readEnvFile } = require('../../utils/env-file');
const {
  parsePositiveInt,
  resolveDsnCandidates,
  runConnectivitySmoke,
  sanitizeErrorMessage,
} = require('../db-connect-smoke');
const {
  evaluateManifestRuntimeReadiness,
  printOutputs,
} = require('./shared');

function die(message) {
  console.error(`[preview-runtime-precheck] ${message}`);
  process.exit(1);
}

function resolveManifestPath(rawPath, cwd = process.cwd()) {
  const manifestPath = String(rawPath || '').trim();
  if (!manifestPath) {
    throw new Error('Missing --manifest.');
  }
  return path.isAbsolute(manifestPath) ? manifestPath : path.resolve(cwd, manifestPath);
}

function resolveBooleanOutput(value) {
  return value === false || String(value || '').trim().toLowerCase() === 'false' ? '0' : '1';
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function buildPreviewRuntimeReadinessReport({ manifest, cwd = process.cwd() }) {
  const readiness = evaluateManifestRuntimeReadiness({ manifest, cwd });
  const db = manifest?.surfaces?.db && typeof manifest.surfaces.db === 'object'
    ? manifest.surfaces.db
    : {};

  return {
    ready: readiness.ready,
    failure_class: String(readiness.failure_class || '').trim(),
    env_file: String(readiness.env_file || '').trim(),
    runtime_ready_at: String(readiness.runtime_ready_at || '').trim(),
    db_ready: resolveBooleanOutput(db.db_ready),
    jwt_ready: resolveBooleanOutput(db.jwt_ready),
    rest_ready: resolveBooleanOutput(db.rest_ready),
    db_probe_candidate: '',
    db_probe_duration_ms: 0,
    db_probe_attempts: 0,
    db_probe_error: '',
    auth_ready: '0',
    auth_probe_status: 0,
    auth_probe_error: '',
  };
}

function writeSummaryFile(summaryPath, report) {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify({
    ready: report.ready,
    failure_class: report.failure_class,
    env_file: report.env_file,
    runtime_ready_at: report.runtime_ready_at,
    db_ready: report.db_ready === '1',
    jwt_ready: report.jwt_ready === '1',
    rest_ready: report.rest_ready === '1',
    db_probe_candidate: String(report.db_probe_candidate || ''),
    db_probe_duration_ms: Number(report.db_probe_duration_ms || 0),
    db_probe_attempts: Number(report.db_probe_attempts || 0),
    db_probe_error: String(report.db_probe_error || ''),
    auth_ready: report.auth_ready === '1',
    auth_probe_status: Number(report.auth_probe_status || 0),
    auth_probe_error: String(report.auth_probe_error || ''),
  }, null, 2) + '\n', 'utf8');
}

function shouldProbeDb(args, env = process.env) {
  if (Object.prototype.hasOwnProperty.call(args || {}, 'probe-db')) {
    return isTruthy(args['probe-db']);
  }
  return isTruthy(env.PREVIEW_RUNTIME_PRECHECK_PROBE_DB);
}

function shouldProbeAuth(args, env = process.env) {
  if (Object.prototype.hasOwnProperty.call(args || {}, 'probe-auth')) {
    return isTruthy(args['probe-auth']);
  }
  return isTruthy(env.PREVIEW_RUNTIME_PRECHECK_PROBE_AUTH);
}

function buildProbeEnv({ envFile, env = process.env, readEnvFileImpl = readEnvFile }) {
  const resolvedEnvFile = String(envFile || '').trim();
  if (!resolvedEnvFile) {
    throw new Error('Preview runtime DB probe requires an env_file.');
  }
  if (!fs.existsSync(resolvedEnvFile)) {
    throw new Error(`Preview runtime DB probe env_file not found: ${resolvedEnvFile}`);
  }

  const parsed = readEnvFileImpl(resolvedEnvFile);
  return {
    ...(env || {}),
    ...(parsed || {}),
    ENV_FILE: resolvedEnvFile,
    ENV_FILE_OVERRIDE: '1',
    PREVIEW_MODE: '1',
    CI_PREVIEW: '1',
    VERIFY_PREVIEW: '1',
  };
}

async function probePreviewRuntimeDatabase({
  report,
  env = process.env,
  logger = console,
  readEnvFileImpl = readEnvFile,
  resolveDsnCandidatesImpl = resolveDsnCandidates,
  runConnectivitySmokeImpl = runConnectivitySmoke,
} = {}) {
  if (!report?.ready) {
    return { ok: false, skipped: true, reason: 'manifest_unready' };
  }

  const probeEnv = buildProbeEnv({
    envFile: report.env_file,
    env,
    readEnvFileImpl,
  });
  const candidates = await resolveDsnCandidatesImpl({ env: probeEnv });
  const connectionTimeoutMs = parsePositiveInt(
    probeEnv.PREVIEW_RUNTIME_PRECHECK_DB_TIMEOUT_MS || probeEnv.DB_SMOKE_TIMEOUT_MS,
    10000,
  );
  const maxWaitMs = parsePositiveInt(
    probeEnv.PREVIEW_RUNTIME_PRECHECK_DB_MAX_WAIT_MS
      || probeEnv.PREVIEW_RUNTIME_READY_MAX_WAIT_MS
      || probeEnv.DB_SMOKE_MAX_WAIT_MS,
    300000,
  );
  const retryDelayMs = parsePositiveInt(
    probeEnv.PREVIEW_RUNTIME_PRECHECK_DB_RETRY_DELAY_MS
      || probeEnv.PREVIEW_RUNTIME_READY_RETRY_DELAY_MS
      || probeEnv.DB_SMOKE_RETRY_DELAY_MS,
    5000,
  );

  const result = await runConnectivitySmokeImpl({
    candidates,
    env: probeEnv,
    connectionTimeoutMs,
    maxWaitMs,
    retryDelayMs,
    logger,
  });

  return {
    ok: true,
    candidate: String(result?.candidate?.name || '').trim(),
    durationMs: Number(result?.durationMs || 0),
    attempts: Number(result?.attempts || 0),
  };
}

async function probePreviewRuntimeAuth({
  report,
  env = process.env,
  readEnvFileImpl = readEnvFile,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!report?.ready) {
    return { ok: false, skipped: true, reason: 'manifest_unready' };
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Preview runtime auth probe requires fetch support.');
  }

  const probeEnv = buildProbeEnv({
    envFile: report.env_file,
    env,
    readEnvFileImpl,
  });
  const supabaseUrl = String(
    probeEnv.SUPABASE_URL
      || probeEnv.NEXT_PUBLIC_SUPABASE_URL
      || probeEnv.PREVIEW_SUPABASE_URL
      || '',
  ).trim().replace(/\/+$/, '');
  const anonKey = String(
    probeEnv.SUPABASE_ANON_KEY
      || probeEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || probeEnv.PREVIEW_SUPABASE_ANON_KEY
      || '',
  ).trim();
  if (!supabaseUrl) throw new Error('Preview runtime auth probe requires SUPABASE_URL.');
  if (!anonKey) throw new Error('Preview runtime auth probe requires SUPABASE_ANON_KEY.');

  const response = await fetchImpl(`${supabaseUrl}/auth/v1/settings`, {
    method: 'GET',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
    },
  });
  const status = Number(response?.status || 0);
  if (response?.ok) {
    return { ok: true, status };
  }
  let body = '';
  try {
    body = typeof response?.text === 'function' ? await response.text() : '';
  } catch {
    body = '';
  }
  const details = body ? sanitizeErrorMessage(body) : `status ${status || 'unknown'}`;
  const error = new Error(`Preview auth API key probe failed (${details}).`);
  error.status = status;
  throw error;
}

async function finalizePreviewRuntimeReadinessReport({
  report,
  probeDb = false,
  probeAuth = false,
  options = {},
} = {}) {
  const next = { ...(report || {}) };
  if (!next.ready) return next;

  if (probeDb) {
    try {
      const probe = await probePreviewRuntimeDatabase({ report: next, ...options });
      next.db_probe_candidate = probe.candidate || '';
      next.db_probe_duration_ms = probe.durationMs || 0;
      next.db_probe_attempts = probe.attempts || 0;
      next.db_probe_error = '';
      next.db_ready = '1';
    } catch (error) {
      next.ready = false;
      next.failure_class = 'preview-db-unready';
      next.db_ready = '0';
      next.db_probe_error = sanitizeErrorMessage(error);
      return next;
    }
  }

  if (probeAuth) {
    try {
      const probe = await probePreviewRuntimeAuth({ report: next, ...options });
      next.auth_ready = '1';
      next.auth_probe_status = Number(probe?.status || 0);
      next.auth_probe_error = '';
    } catch (error) {
      next.ready = false;
      next.failure_class = 'preview-auth-unready';
      next.auth_ready = '0';
      next.auth_probe_status = Number(error?.status || 0);
      next.rest_ready = '0';
      next.auth_probe_error = sanitizeErrorMessage(error);
    }
  }

  return next;
}

async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseFlagArgs(argv);
  const manifestPath = resolveManifestPath(args.manifest);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const report = await finalizePreviewRuntimeReadinessReport({
    report: buildPreviewRuntimeReadinessReport({ manifest, cwd: process.cwd() }),
    probeDb: shouldProbeDb(args, options.env || process.env),
    probeAuth: shouldProbeAuth(args, options.env || process.env),
    options,
  });
  const summaryPath = path.resolve(
    process.cwd(),
    String(args.report || '.tmp/preview-runtime-ready.json').trim(),
  );

  writeSummaryFile(summaryPath, report);
  printOutputs({
    ready: report.ready ? '1' : '0',
    failure_class: report.failure_class,
    env_file: report.env_file,
    runtime_ready_at: report.runtime_ready_at,
    db_ready: report.db_ready,
    jwt_ready: report.jwt_ready,
    rest_ready: report.rest_ready,
    db_probe_candidate: report.db_probe_candidate,
    db_probe_duration_ms: report.db_probe_duration_ms,
    db_probe_attempts: report.db_probe_attempts,
    auth_ready: report.auth_ready,
    auth_probe_status: report.auth_probe_status,
    summary_path: summaryPath,
  }, String(args.format || '').trim());

  if (!report.ready) {
    throw new Error(`Preview runtime readiness failed (${report.failure_class || 'preview-runtime-unready'}).`);
  }

  return {
    ...report,
    summary_path: summaryPath,
  };
}

if (require.main === module) {
  main().catch((error) => {
    die(error && error.message ? error.message : String(error));
  });
}

module.exports = {
  buildPreviewRuntimeReadinessReport,
  buildProbeEnv,
  finalizePreviewRuntimeReadinessReport,
  main,
  probePreviewRuntimeAuth,
  probePreviewRuntimeDatabase,
  resolveBooleanOutput,
  resolveManifestPath,
  shouldProbeAuth,
  shouldProbeDb,
  writeSummaryFile,
};
