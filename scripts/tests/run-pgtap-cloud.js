#!/usr/bin/env node

/**
 * Cloud pgTAP runner
 *
 * Loads DATABASE_URL from .env.cloud and executes the pgTAP suite against the
 * shared Supabase database. Mirrors the behaviour of `supabase test db`, but
 * without spinning up local containers.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { createQaLogger } = require('../qa/qa-log');
const { buildDbConnectionCandidates } = require('../utils/pg-candidates');

function normalizeDatabaseUrlForLibpq(dsn) {
  // libpq/psql rejects non-standard sslmode values (e.g. sslmode=no-verify).
  // Keep DATABASE_URL as-is for Node pg clients, but translate for psql runs.
  return String(dsn || '').replace(/sslmode=no-verify/gi, 'sslmode=require');
}

// Allow CI / operators to tune how long we wait for the
// cloud database to accept connections. Defaults to 60s.
function resolveDbReadyTimeoutSeconds(env = process.env) {
  const raw = env.PGTAP_DB_READY_TIMEOUT_SECONDS || env.DB_READY_TIMEOUT_SECONDS || '60';
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

function resolveStatementTimeoutMs(env = process.env) {
  const raw = String(env.PGTAP_STATEMENT_TIMEOUT_MS || '').trim();
  if (!raw) return 180_000; // 3 minutes
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 180_000;
}

function resolveBootstrapStatementTimeoutMs(env = process.env) {
  const raw = String(env.PGTAP_BOOTSTRAP_STATEMENT_TIMEOUT_MS || '').trim();
  if (!raw) return 900_000; // 15 minutes
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 900_000;
}

function resolveNodeFileTransientRetries(env = process.env) {
  const raw = String(env.PGTAP_NODE_FILE_RETRIES || env.PGTAP_RETRY_TRANSIENT || '').trim();
  if (!raw) return 3;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
}

function resolveNodeFileTransientMaxWaitMs(env = process.env) {
  const raw = String(env.PGTAP_NODE_FILE_MAX_WAIT_MS || '').trim();
  if (!raw) {
    return resolveDbReadyTimeoutSeconds(env) * 1000;
  }
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : resolveDbReadyTimeoutSeconds(env) * 1000;
}

function resolveNodeFileTransientRetryDelayMs(env = process.env) {
  const raw = String(env.PGTAP_NODE_FILE_RETRY_DELAY_MS || '').trim();
  if (!raw) return 1000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

function resolveNodeFileDbReadyTimeoutSeconds(env = process.env) {
  const raw = String(
    env.PGTAP_NODE_FILE_DB_READY_TIMEOUT_SECONDS || env.PGTAP_DB_READY_TIMEOUT_SECONDS || '15'
  ).trim();
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
}

const repoRoot = path.resolve(__dirname, '..', '..');
const testsDir = path.join(repoRoot, 'supabase', 'tests', 'pgtap');

if (!fs.existsSync(testsDir)) {
  console.error(`[pgTAP] Tests directory not found: ${testsDir}`);
  process.exit(1);
}

function loadSkipList(dir) {
  const out = [];
  const skipFile = path.join(String(dir || '').trim(), '.pgtap-skip.json');
  if (!fs.existsSync(skipFile)) return out;
  try {
    const parsed = JSON.parse(fs.readFileSync(skipFile, 'utf8')) || [];
    return Array.isArray(parsed) ? parsed : out;
  } catch (e) {
    console.warn('[pgTAP] Failed to parse .pgtap-skip.json. Ignoring.');
    return out;
  }
}

function computeLocalSkip(databaseUrl) {
  const isLocalDatabase = /localhost|127\.0\.0\.1/.test(String(databaseUrl || ''));
  if (!isLocalDatabase) return [];
  return [
    '014_storage_policies.sql',
    '015_privileges.sql',
    '024_webhook_ingest_ack_defaults.sql',
    '024_webhook_intake_dynamic.sql',
    '025_webhook_policy_ladder.sql',
  ];
}

function discoverTapFiles({ testsDir, skipList, localSkip }) {
  const dir = String(testsDir || '').trim();
  const skip = Array.isArray(skipList) ? skipList : [];
  const local = Array.isArray(localSkip) ? localSkip : [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.sql'))
    .filter((file) => !skip.includes(file))
    .filter((file) => !local.includes(file))
    .sort();
}

function parseRequestedTapFiles(env = process.env) {
  const raw =
    String(env.PGTAP_ONLY_FILES || '').trim() ||
    String(env.PGTAP_TEST_FILES || '').trim() ||
    '';
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/\r?\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

function normalizeTapFileInput(raw) {
  const value = String(raw || '').trim().replace(/\\/g, '/');
  if (!value) return '';
  const withoutDotPrefix = value.replace(/^\.\/+/, '');
  const canonicalPrefix = 'supabase/tests/pgtap/';
  if (withoutDotPrefix.startsWith(canonicalPrefix)) {
    return withoutDotPrefix.slice(canonicalPrefix.length);
  }
  return withoutDotPrefix;
}

function resolveRequestedTapFiles({ requestedFiles, availableFiles, testsDir }) {
  const requested = Array.isArray(requestedFiles) ? requestedFiles : [];
  const available = Array.isArray(availableFiles) ? availableFiles : [];
  const dir = String(testsDir || '').trim();
  const availableSet = new Set(available);
  const selected = [];
  const selectedSet = new Set();
  const missing = [];
  const ambiguous = [];

  const addSelected = (file) => {
    if (!file || selectedSet.has(file)) return;
    selected.push(file);
    selectedSet.add(file);
  };

  for (const rawInput of requested) {
    let normalized = String(rawInput || '').trim();
    if (!normalized) continue;

    if (dir && path.isAbsolute(normalized)) {
      const relative = path.relative(dir, normalized).replace(/\\/g, '/');
      if (
        relative &&
        !relative.startsWith('../') &&
        relative !== '..' &&
        !path.isAbsolute(relative)
      ) {
        normalized = relative;
      }
    }

    normalized = normalizeTapFileInput(normalized);
    if (!normalized) continue;

    if (availableSet.has(normalized)) {
      addSelected(normalized);
      continue;
    }

    const baseName = path.posix.basename(normalized);
    const candidates = available.filter((file) => path.posix.basename(file) === baseName);
    if (candidates.length === 1) {
      addSelected(candidates[0]);
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.push({ input: rawInput, candidates });
      continue;
    }
    missing.push(rawInput);
  }

  return { selected, missing, ambiguous };
}

function summarizeDatabaseUrl(dsn) {
  if (!dsn) return '<missing>';
  try {
    const url = new URL(dsn);
    const host = url.hostname || '<unknown-host>';
    const port = url.port ? `:${url.port}` : '';
    const db = url.pathname && url.pathname !== '/' ? url.pathname : '';
    return `${host}${port}${db}`;
  } catch {
    // Fall back to a conservative redaction for non-URL DSNs.
    const withoutCreds = String(dsn).replace(/:\/\/[^@]+@/, '://REDACTED@');
    return withoutCreds.slice(0, 120);
  }
}

function waitForDatabaseReady(libpqDatabaseUrl, maxSeconds = 60) {
  const start = Date.now();
  const deadline = start + maxSeconds * 1000;

  // Quick no-op when talking to cloud: connection failures here are
  // typically auth / network, not startup timing. We still try once.
  // For local stacks, this gives supabase start time to bring Postgres up.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = spawnSync('psql', ['--no-psqlrc', '--dbname', libpqDatabaseUrl, '-c', 'select 1'], {
      env: { ...process.env, DATABASE_URL: libpqDatabaseUrl },
      stdio: 'ignore',
    });

    if (result.status === 0) {
      return;
    }

    if (Date.now() > deadline) {
      console.error('[pgTAP] Database did not become ready within', maxSeconds, 'seconds');
      exitRunner(result.status || 1);
    }

    // Brief backoff before retrying.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}

function isPsqlAvailable() {
  const probe = spawnSync('psql', ['--version'], { stdio: 'ignore' });
  if (probe.error && probe.error.code === 'ENOENT') return false;
  return true;
}

async function resolveDatabaseUrlCandidates(env = process.env, options = {}) {
  const buildCandidatesFn = options.buildDbConnectionCandidatesFn || buildDbConnectionCandidates;
  const selectedPinnedName = String(
    env.DB_SMOKE_SELECTED_DSN_NAME || env.DATABASE_URL_SELECTED_DSN_NAME || '',
  ).trim();
  const pinnedDsn = String(
    env.PG_CONN_STRING || (selectedPinnedName ? env.DATABASE_URL : '') || '',
  ).trim();
  const out = [];
  const seen = new Set();

  const addCandidate = (name, dsn) => {
    const normalizedName = String(name || '').trim();
    const normalizedDsn = normalizeDatabaseUrlForLibpq(dsn);
    if (!normalizedName || !normalizedDsn || seen.has(normalizedDsn)) return;
    seen.add(normalizedDsn);
    out.push({ name: normalizedName, dsn: normalizedDsn });
  };

  if (pinnedDsn) {
    // db:connect:smoke already proved this exact DSN in the current preview env.
    // Keep it first verbatim instead of re-expanding it through the generic ladder.
    addCandidate(selectedPinnedName || 'PG_CONN_STRING', pinnedDsn);
  }

  // pgTAP relies on session-level behavior; prefer direct Postgres over poolers
  // to avoid backend/session state bleed between invocations.
  const rawCandidates = [
    { name: 'DATABASE_URL_DIRECT', dsn: String(env.DATABASE_URL_DIRECT || '').trim() },
    { name: 'DATABASE_URL', dsn: String(env.DATABASE_URL || '').trim() },
    { name: 'DATABASE_URL_POOLER', dsn: String(env.DATABASE_URL_POOLER || '').trim() },
  ].filter((candidate) => Boolean(candidate.dsn));

  if (rawCandidates.length === 0) return out;

  const candidates = await buildCandidatesFn(rawCandidates);
  for (const candidate of candidates) {
    addCandidate(candidate.name, candidate.dsn);
  }
  return out;
}

function orderDatabaseCandidates(candidates, preferredCandidateName = '') {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const preferred = String(preferredCandidateName || '').trim();
  if (!preferred || list.length <= 1) return list;

  const ordered = [];
  let preferredAdded = false;
  for (const candidate of list) {
    if (!preferredAdded && String(candidate?.name || '').trim() === preferred) {
      ordered.unshift(candidate);
      preferredAdded = true;
      continue;
    }
    ordered.push(candidate);
  }
  return ordered;
}

function waitForDatabaseReadyWithFallback(candidates, maxSeconds = 60) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length === 0) {
    console.error('[pgTAP] Missing DATABASE_URL/DATABASE_URL_DIRECT/DATABASE_URL_POOLER.');
    exitRunner(1);
  }

  const start = Date.now();
  const deadline = start + maxSeconds * 1000;

  let lastFailure = { name: list[0].name, status: 1 };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const candidate of list) {
      const result = spawnSync('psql', ['--no-psqlrc', '--dbname', candidate.dsn, '-c', 'select 1'], {
        env: { ...process.env, DATABASE_URL: candidate.dsn },
        stdio: 'ignore',
      });

      if (result.status === 0) {
        return candidate;
      }

      lastFailure = { name: candidate.name, status: result.status || 1 };
    }

    if (Date.now() > deadline) {
      console.error(
        '[pgTAP] Database did not become ready within',
        maxSeconds,
        'seconds (last_candidate=',
        lastFailure.name,
        ')'
      );
      exitRunner(lastFailure.status || 1);
    }

    // Brief backoff before retrying.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}

function shouldUseSslForPg(env = process.env) {
  const mode = String(env.PGSSLMODE || '').trim().toLowerCase();
  if (mode === 'disable') return false;
  if (['require', 'verify-ca', 'verify-full'].includes(mode)) return true;
  return true;
}

function sanitizeErrorMessage(error) {
  return String((error && error.message) || error || 'unknown');
}

function isRetryableDbConnectError(error) {
  const code = String(error?.code || error?.sqlState || '').trim().toUpperCase();
  if (code === '57P03') return true;
  const message = sanitizeErrorMessage(error).toLowerCase();
  if (!message) return false;
  return [
    'tenant or user not found',
    'the database system is starting up',
    'the database system is in recovery mode',
    'the database system is not accepting connections',
    'password authentication failed',
    'too many authentication errors',
    'network is unreachable',
    'no route to host',
    'failed to write startup message',
    'failed to receive message',
    'econnreset',
    'econnrefused',
    'enotfound',
    'eai_again',
    'etimedout',
    'timeout expired',
    'connection terminated unexpectedly',
    'connect enetunreach',
    'i/o timeout',
    'context deadline exceeded',
    'the database system is starting up',
    'the database system is in recovery mode',
    'the database system is not accepting connections',
    'temporary failure in name resolution',
    'getaddrinfo enotfound',
].some((pattern) => message.includes(pattern));
}

function shouldRetryNodeFileTransientError(options = {}) {
  const retryable = Boolean(options.retryable);
  if (!retryable) return false;

  const attempt = Number(options.attempt);
  const maxRetries = Number(options.maxRetries);
  const startedAtMs = Number(options.startedAtMs);
  const nowMs = Number(options.nowMs);
  const maxWaitMs = Number(options.maxWaitMs);

  if (Number.isFinite(attempt) && Number.isFinite(maxRetries) && attempt < maxRetries) {
    return true;
  }
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(maxWaitMs)) {
    return false;
  }
  return nowMs - startedAtMs < maxWaitMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPgClientErrorTracker(client, options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : console.warn;
  let lastError = null;
  const onError = (error) => {
    lastError = error || new Error('Unknown pg client error');
    const message = sanitizeErrorMessage(lastError);
    if (isRetryableDbConnectError(lastError)) {
      logger(`[pgTAP] Captured transient pg client error event: ${message}`);
      return;
    }
    logger(`[pgTAP] Captured pg client error event: ${message}`);
  };

  if (client && typeof client.on === 'function') {
    client.on('error', onError);
  }

  return {
    consumeError() {
      const error = lastError;
      lastError = null;
      return error;
    },
    dispose() {
      if (!client) return;
      if (typeof client.off === 'function') {
        client.off('error', onError);
        return;
      }
      if (typeof client.removeListener === 'function') {
        client.removeListener('error', onError);
      }
    },
  };
}

async function withPgClientRuntimeErrorCapture(client, callback) {
  let runtimeError = null;
  const onError = (error) => {
    if (runtimeError) return;
    runtimeError = error instanceof Error ? error : new Error(String(error || 'unknown pg client error'));
  };
  client.on('error', onError);
  try {
    const result = await callback(client);
    if (runtimeError) throw runtimeError;
    return result;
  } finally {
    client.off('error', onError);
  }
}

async function probeDatabaseCandidateWithPg(candidate, options = {}) {
  const timeoutMs = Number(options.connectionTimeoutMs) || 10000;
  const sslEnabled = options.sslEnabled === undefined ? shouldUseSslForPg() : Boolean(options.sslEnabled);
  const queryText = String(options.queryText || 'select 1 as ok');

  const client = new Client({
    connectionString: candidate.dsn,
    connectionTimeoutMillis: timeoutMs,
    ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
  });
  await withPgClientRuntimeErrorCapture(client, async () => {
    try {
      await client.connect();
      await client.query(queryText);
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  });
}

async function waitForDatabaseReadyWithFallbackPg(candidates, maxSeconds = 60) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length === 0) {
    throw new Error('Missing DATABASE_URL/DATABASE_URL_DIRECT/DATABASE_URL_POOLER');
  }

  const startedAt = Date.now();
  const deadline = startedAt + maxSeconds * 1000;
  let lastError = null;

  while (Date.now() <= deadline) {
    for (const candidate of list) {
      try {
        // Keep this tight: we are just verifying DB readiness.
        await probeDatabaseCandidateWithPg(candidate, { connectionTimeoutMs: 10000, queryText: 'select 1' });
        return candidate;
      } catch (err) {
        lastError = err;
        if (!isRetryableDbConnectError(err)) {
          throw err;
        }
      }
    }
    await sleep(500);
  }

  const lastMessage = sanitizeErrorMessage(lastError);
  throw new Error(`DB did not become ready within ${maxSeconds}s: ${lastMessage}`);
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quotePsqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  const raw = value instanceof Date ? value.toISOString() : String(value);
  return `'${raw.replace(/'/g, "''")}'`;
}

function substitutePsqlVariables(sql, vars) {
  let out = String(sql || '');
  const entries = vars && typeof vars === 'object' ? Object.entries(vars) : [];
  for (const [key, value] of entries) {
    const name = String(key || '').trim();
    if (!name) continue;
    const escaped = escapeRegExp(name);
    const quoted = quotePsqlLiteral(value);
    // psql quoted variable form: :'var'
    out = out.replace(new RegExp(`:'${escaped}'`, 'g'), quoted);
    // raw variable form: :var
    out = out.replace(new RegExp(`:${escaped}\\b`, 'g'), String(value instanceof Date ? value.toISOString() : value));
  }
  return out;
}

function extractTextFromPgQueryResult(result) {
  const results = Array.isArray(result) ? result : [result];
  const lines = [];
  for (const res of results) {
    if (!res || !Array.isArray(res.rows)) continue;
    for (const row of res.rows) {
      if (!row || typeof row !== 'object') continue;
      for (const value of Object.values(row)) {
        if (value === null || value === undefined) continue;
        lines.push(value instanceof Date ? value.toISOString() : String(value));
      }
    }
  }
  return lines.join('\n');
}

async function execSqlWithPsqlVariables(client, sql, vars = {}) {
  const lines = String(sql || '').split(/\r?\n/);
  const gsetIndex = (() => {
    for (let i = 0; i < lines.length; i += 1) {
      // Support both standalone "\gset" and inline "...\gset" forms.
      if (/\\gset\b/i.test(lines[i])) return i;
    }
    return -1;
  })();
  if (gsetIndex < 0) {
    const resolved = substitutePsqlVariables(sql, vars);
    const result = await client.query(resolved);
    return { result, vars };
  }

  const beforeLines = lines.slice(0, gsetIndex + 1);
  beforeLines[gsetIndex] = beforeLines[gsetIndex].replace(/\\gset\b.*$/i, '').trimEnd();
  const before = beforeLines.join('\n');
  const after = lines.slice(gsetIndex + 1).join('\n');
  const beforeTerminated = before.trimEnd().endsWith(';') ? before : `${before}\n;\n`;

  const resBefore = await client.query(beforeTerminated);
  const results = Array.isArray(resBefore) ? resBefore : [resBefore];
  const last = results[results.length - 1];
  const row = last && Array.isArray(last.rows) ? last.rows[0] : null;
  if (!row || typeof row !== 'object') {
    throw new Error('psql variable block (\\gset) did not return a row');
  }
  const mergedVars = { ...(vars || {}), ...row };

  const next = await execSqlWithPsqlVariables(client, after, mergedVars);
  const beforeResults = Array.isArray(resBefore) ? resBefore : [resBefore];
  const afterResults = Array.isArray(next.result) ? next.result : [next.result];
  return { result: [...beforeResults, ...afterResults], vars: next.vars };
}

async function runTapFileWithPg(client, filePath, options = {}) {
  const statementTimeoutMs = Number(options.statementTimeoutMs) || 0;
  const prefix = [
    statementTimeoutMs >= 0 ? `SET statement_timeout TO ${statementTimeoutMs};` : '',
    'SET jit = off;',
    'SET search_path TO public, extensions, pgtap, pg_temp;',
  ]
    .filter(Boolean)
    .join('\n');

  let body = fs.readFileSync(filePath, 'utf8');
  // Some SQL files may include a UTF-8 BOM; Postgres does not accept it as syntax.
  if (body.charCodeAt(0) === 0xfeff) {
    body = body.slice(1);
  }
  const notices = [];
  const onNotice = (notice) => {
    const message = String(notice?.message || '').trim();
    if (!message) return;
    notices.push(message);
  };
  client.on('notice', onNotice);
  try {
    const { result } = await execSqlWithPsqlVariables(client, `${prefix}\n${body}\n`, {});
    const combinedText = extractTextFromPgQueryResult(result);
    return [combinedText, notices.join('\n')].filter(Boolean).join('\n');
  } finally {
    client.off('notice', onNotice);
  }
}

function resolveFilesPerSession(env = process.env) {
  const raw =
    String(env.PGTAP_FILES_PER_SESSION || '').trim() ||
    String(env.PGTAP_BATCH_SIZE || '').trim() ||
    '';
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function chunkArray(items, size) {
  const list = Array.isArray(items) ? items : [];
  const n = Number(size) || 0;
  if (n <= 0) return [list];
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

function hasTapFailures(text) {
  const combined = String(text || '');
  return (
    /\bnot ok\s+\d+\b/i.test(combined) ||
    /looks like you failed/i.test(combined) ||
    /looks like you planned/i.test(combined)
  );
}

function isPlanTwiceError(text) {
  return /\byou tried to plan twice\b/i.test(String(text || ''));
}

function toPsqlPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function quotePsqlString(value) {
  return String(value || '').replace(/'/g, "''");
}

function stripSqlLineComment(line) {
  const idx = String(line || '').indexOf('--');
  return idx >= 0 ? String(line || '').slice(0, idx) : String(line || '');
}

function tapFileHasBeginRollback(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map(stripSqlLineComment)
    .map((line) => line.trim())
    .filter(Boolean);

  let hasBegin = false;
  let hasRollback = false;
  for (const line of lines) {
    if (!hasBegin && /^BEGIN\b/i.test(line)) hasBegin = true;
    if (!hasRollback && /^ROLLBACK\b/i.test(line)) hasRollback = true;
    if (hasBegin && hasRollback) return true;
  }
  return false;
}

function tapFileHasFinish(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map(stripSqlLineComment)
    .join('\n');
  return (
    /\bSELECT\s+\*\s+FROM\s+finish\s*\(\s*\)\s*;/i.test(lines) ||
    /\bSELECT\s+finish\s*\(\s*\)\s*;/i.test(lines)
  );
}

function tapFileHasExplicitPlan(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map(stripSqlLineComment)
    .join('\n');
  return (
    /\bSELECT\s+plan\s*\(/i.test(lines) ||
    /\bSELECT\s+no_plan\s*\(/i.test(lines)
  );
}

function isTapFileBatchable({ testsDir, file }) {
  const dir = String(testsDir || '').trim();
  const name = String(file || '').trim();
  if (!dir || !name) return false;
  try {
    const body = fs.readFileSync(path.join(dir, name), 'utf8');
    return (
      tapFileHasBeginRollback(body) &&
      tapFileHasFinish(body) &&
      !tapFileHasExplicitPlan(body)
    );
  } catch {
    return false;
  }
}

function planBatchedRuns({ files, testsDir, filesPerSession }) {
  const list = Array.isArray(files) ? files : [];
  const per = Number(filesPerSession) || 0;
  if (per <= 1) return [{ type: 'batch', files: list }];

  const runs = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    runs.push({ type: 'batch', files: current });
    current = [];
  };

  for (const file of list) {
    const batchable = isTapFileBatchable({ testsDir, file });
    if (!batchable) {
      flush();
      runs.push({ type: 'single', file });
      continue;
    }
    current.push(file);
    if (current.length >= per) flush();
  }

  flush();
  return runs;
}

function buildBatchDriverSql({ files, testsDir, statementTimeout }) {
  const list = Array.isArray(files) ? files : [];
  const baseDir = String(testsDir || '').trim();
  const timeoutMs = Number(statementTimeout) || 0;
  const lines = [];
  for (const file of list) {
    const absPath = toPsqlPath(path.join(baseDir, file));
    lines.push(`\\echo __MASARX_PGTAP_FILE_START__ ${file}`);
    if (timeoutMs >= 0) lines.push(`SET statement_timeout TO ${timeoutMs};`);
    lines.push('SET jit = off;');
    lines.push('SET search_path TO public, extensions, pgtap, pg_temp;');
    lines.push(`\\i '${quotePsqlString(absPath)}'`);
    lines.push(`\\echo __MASARX_PGTAP_FILE_END__ ${file}`);
  }
  return lines.join('\n') + '\n';
}

function parseBatchOutputSegments(output) {
  const segments = new Map();
  let current = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    const start = line.match(/^__MASARX_PGTAP_FILE_START__\s+(.+?)\s*$/);
    if (start) {
      current = String(start[1] || '').trim();
      if (current) segments.set(current, '');
      continue;
    }
    const end = line.match(/^__MASARX_PGTAP_FILE_END__\s+(.+?)\s*$/);
    if (end) {
      current = null;
      continue;
    }
    if (current && segments.has(current)) {
      segments.set(current, segments.get(current) + line + '\n');
    }
  }
  return segments;
}

function runPsqlCapture(libpqDatabaseUrl, args, description) {
  const maxRetries = (() => {
    const raw = process.env.PGTAP_RETRY_DEADLOCKS || '2';
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
  })();

  const sleepMs = (ms) => {
    const dur = Number(ms) || 0;
    if (dur <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, dur);
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = spawnSync('psql', args, {
      env: { ...process.env, DATABASE_URL: libpqDatabaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = result.stdout ? result.stdout.toString('utf8') : '';
    const stderr = result.stderr ? result.stderr.toString('utf8') : '';
    const combined = `${stdout}\n${stderr}`;
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    if (result.error) {
      throw new Error(`[pgTAP] Failed to run ${description}: ${result.error.message}`);
    }

    if (result.status === 0) {
      return { status: 0, stdout, stderr, combined };
    }

    const canRetry = attempt < maxRetries && isRetryablePsqlFailure(combined);
    if (!canRetry) {
      return { status: result.status || 1, stdout, stderr, combined };
    }

    const delay = 750 * (attempt + 1);
    console.warn(
      `[pgTAP] ${description} hit retryable transient DB error; retrying ${attempt + 1}/${maxRetries} after ${delay}ms...`,
    );
    sleepMs(delay);
  }

  return { status: 1, stdout: '', stderr: '', combined: '' };
}

function runPsqlCaptureAcrossCandidates(candidates, buildArgs, description, options = {}) {
  const orderedCandidates = orderDatabaseCandidates(
    candidates,
    options.preferredCandidateName || options.preferredCandidate?.name || '',
  );
  if (orderedCandidates.length === 0) {
    throw new Error('[pgTAP] Missing DATABASE_URL/DATABASE_URL_DIRECT/DATABASE_URL_POOLER.');
  }

  const runPsqlCaptureFn = options.runPsqlCaptureFn || runPsqlCapture;
  let lastAttempt = null;

  for (let index = 0; index < orderedCandidates.length; index += 1) {
    const candidate = orderedCandidates[index];
    const args =
      typeof buildArgs === 'function' ? buildArgs(candidate.dsn, candidate) : buildArgs;
    const result = runPsqlCaptureFn(candidate.dsn, args, description);
    const tapFailures = hasTapFailures(result.combined);
    const retryableFailure = result.status !== 0 && isRetryablePsqlFailure(result.combined);

    lastAttempt = {
      candidate,
      result,
      tapFailures,
      retryableFailure,
    };

    if (result.status === 0 && !tapFailures) {
      return lastAttempt;
    }
    if (tapFailures) {
      return lastAttempt;
    }

    const hasMoreCandidates = index < orderedCandidates.length - 1;
    if (retryableFailure && hasMoreCandidates) {
      console.warn(
        `[pgTAP] ${description} hit retryable transient DB failure on ${candidate.name}; trying the next candidate.`,
      );
      continue;
    }
    return lastAttempt;
  }

  return lastAttempt;
}

function runPsqlWithCandidateFallback(candidates, buildArgs, description, options = {}) {
  const attempt = runPsqlCaptureAcrossCandidates(candidates, buildArgs, description, options);
  if (!attempt) {
    throw new Error(`[pgTAP] ${description} did not execute.`);
  }
  const outputLines = String(attempt.result.combined || '').split(/\r?\n/);
  const firstError = outputLines.find(line => /ERROR:|FATAL:/i.test(line))
    || outputLines.find(line => /\bnot ok\b|looks like you (failed|planned)/i.test(line));
  const detail = firstError ? `\n${firstError}` : '';
  const assessment = options.assessResult?.(attempt.result);
  if (assessment?.ok) return { ...attempt, assessment };
  let error;
  if (assessment?.errors.length) {
    error = new Error(`[pgTAP] ${description}: ${assessment.errors.join('; ')}${detail}`);
  } else if (attempt.result.status !== 0) {
    error = new Error(`[pgTAP] ${description} exited with status ${attempt.result.status} via ${attempt.candidate?.name || 'unknown'}${detail}`);
  } else if (attempt.tapFailures || assessment) {
    const firstFailure = assessment?.failures[0];
    error = new Error(`[pgTAP] TAP test failures detected in ${description}${firstFailure ? `\nnot ok ${firstFailure.number} - ${firstFailure.assertion}` : detail}`);
  }
  if (error) { error.assessment = assessment; throw error; }
  return attempt;
}

function isRetryablePsqlFailure(text) {
  const s = String(text || '').toLowerCase();
  return (
    isRetryableDbConnectError(s) ||
    s.includes('deadlock detected') ||
    s.includes('could not serialize access due to concurrent update') ||
    s.includes('canceling statement due to lock timeout') ||
    s.includes('canceling statement due to statement timeout') ||
    s.includes('server closed the connection unexpectedly') ||
    s.includes('connection to server was lost') ||
    s.includes('connection terminated unexpectedly') ||
    s.includes('terminating connection due to administrator command')
  );
}

function runPsql(libpqDatabaseUrl, args, description) {
  const res = runPsqlCapture(libpqDatabaseUrl, args, description);
  if (res.status !== 0) {
    throw new Error(`[pgTAP] ${description} exited with status ${res.status}`);
  }
  if (hasTapFailures(res.combined)) {
    throw new Error(`[pgTAP] TAP test failures detected in ${description}`);
  }
  return res;
}

function runFixtureBootstrapScript(scriptPath, env) {
  const res = spawnSync(process.execPath, [scriptPath], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (res.error) {
    throw new Error(`[pgTAP] fixture bootstrap failed to start: ${res.error.message}`);
  }
  const status = typeof res.status === 'number' ? res.status : 1;
  if (status !== 0) {
    throw new Error(`[pgTAP] fixture bootstrap failed with exit code ${status}`);
  }
}


async function withFullLocalQualification(candidates, run, options = {}) {
  const env = options.env || process.env;
  const fail = (capability) => { throw new Error(`[pgTAP] full_local_blocked: ${capability}`); };
  const stages = ['DEPLOY_ENV', 'DEPLOY_ENV_NAME', 'GITHUB_ENVIRONMENT_NAME', 'GITHUB_ENVIRONMENT']
    .map(key => String(env[key] || '').trim().toLowerCase()).filter(Boolean);
  if (stages.some(stage => stage !== 'local') || String(env.PROD_DEPLOY_GUARD || '').trim().toLowerCase() === 'enabled') fail('local_environment_required');
  const workspaceId = String(env.WORKSPACE_NAME || '').trim();
  if (!workspaceId || !candidates.length) fail('workspace_and_database_required');
  if (resolveFilesPerSession(env) !== 1) fail('serialized_per_file_execution_required');
  const cwd = options.cwd || process.cwd();
  const acquire = options.acquireLock || (() => { throw new Error('Explicit qualification adapters are required'); });
  const identify = options.identify || (() => { throw new Error('Explicit qualification adapters are required'); });
  const inspect = options.inspect || (() => { throw new Error('Explicit qualification adapters are required'); });
  const assertMutation = options.assertMutation || (() => { throw new Error('Explicit qualification adapters are required'); });
  const lock = await acquire({ cwd, workspaceId, env, operation: 'pgtap-full-local' });
  try {
    for (const candidate of candidates) {
      const identity = identify(workspaceId, candidate.dsn, { cwd, env });
      if (identity.database !== (options.hostedDatabase ?? 'postgres')) fail('canonical_postgres_database_required');
    }
    const ownership = inspect(workspaceId, { cwd, env });
    assertMutation(ownership, 'pgtap-full-local');
    if (ownership.pending_intent) fail('settled_runtime_required');
    await (options.probe || probeFullLocalCapabilities)(candidates[0].dsn);
    return await run();
  } finally {
    await lock.release();
  }
}

async function probeFullLocalCapabilities(dsn) {
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT name FROM (VALUES
        ('storage_schema', to_regclass('storage.buckets') IS NOT NULL AND to_regclass('storage.objects') IS NOT NULL),
        ('authenticated_role', EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')),
        ('settings_schema', to_regclass('public.settings') IS NOT NULL AND to_regclass('public.settings_versions') IS NOT NULL),
        ('webhook_schema', to_regclass('public.webhook_sources') IS NOT NULL AND to_regclass('public.operation_templates') IS NOT NULL),
        ('webhook_intake', EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='workflow_intake_webhook')),
        ('pgtap_available', EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pgtap'))
      ) AS capabilities(name, ready) WHERE NOT ready`);
    if (rows.length) throw new Error('[pgTAP] full_local_blocked: ' + rows.map(row => row.name).join(', '));
  } finally {
    await client.end();
  }
}

function exitRunner(code) {
  if (process.env.PGTAP_FULL_LOCAL_QUALIFICATION === '1') {
    const error = new Error(`[pgTAP] Runner stopped with status ${code}`);
    error.exitCode = code;
    throw error;
  }
  process.exit(code);
}

async function main() {
  loadEnv();
  const dbCandidates = await resolveDatabaseUrlCandidates(process.env);
  if (process.env.PGTAP_FULL_LOCAL_QUALIFICATION === '1') {
    const admittedEnv = { ...process.env };
    return withFullLocalQualification(dbCandidates, () => runSuite(dbCandidates, true, admittedEnv), { env: admittedEnv });
  }
  return runSuite(dbCandidates);
}

async function runSuite(dbCandidates, fullLocal = false, env = process.env, reporter) {
  if (dbCandidates.length === 0) {
    console.error('[pgTAP] Missing DATABASE_URL/DATABASE_URL_DIRECT/DATABASE_URL_POOLER. Ensure .env.cloud is loaded.');
    exitRunner(1);
  }
  const databaseUrl = dbCandidates[0].dsn;

  const dbReadyTimeoutSeconds = resolveDbReadyTimeoutSeconds(env);
  const statementTimeoutMs = resolveStatementTimeoutMs(env);
  const bootstrapStatementTimeoutMs = resolveBootstrapStatementTimeoutMs(env);

  const skipList = loadSkipList(testsDir);
  const localSkip = fullLocal ? [] : computeLocalSkip(databaseUrl);
  if (fullLocal && computeLocalSkip(databaseUrl).some(file => skipList.includes(file))) {
    throw new Error('[pgTAP] full_local_blocked: required_file_in_skip_list');
  }
  let tapFiles = discoverTapFiles({ testsDir, skipList, localSkip });
  const requestedTapFiles = parseRequestedTapFiles(env);

  if (requestedTapFiles.length > 0) {
    const resolved = resolveRequestedTapFiles({
      requestedFiles: requestedTapFiles,
      availableFiles: tapFiles,
      testsDir,
    });

    if (resolved.ambiguous.length > 0) {
      for (const entry of resolved.ambiguous) {
        console.error(
          `[pgTAP] Ambiguous requested file "${entry.input}"; matches: ${entry.candidates.join(', ')}`
        );
      }
      exitRunner(1);
    }

    if (resolved.missing.length > 0) {
      console.error(
        `[pgTAP] Requested file(s) not found in suite: ${resolved.missing.join(', ')}`
      );
      exitRunner(1);
    }

    tapFiles = resolved.selected;
    console.log(
      `[pgTAP] Targeted mode enabled via PGTAP_ONLY_FILES/PGTAP_TEST_FILES (${tapFiles.length} file(s)).`
    );
  }

  if (tapFiles.length === 0) {
    console.warn('[pgTAP] No pgTAP files discovered.');
    return;
  }

  const qaSuiteKey = env.QA_SUITE_KEY || 'pgtap';
  const qa = reporter || createQaLogger({ runId: env.QA_RUN_ID, disabled: !env.QA_RUN_ID,
    ...(fullLocal ? { env: { ...env, DATABASE_URL: databaseUrl } } : {}),
  });
  let suiteError;
  try {
  const filesPerSession = resolveFilesPerSession(env);
  const batched = filesPerSession > 1;
  const psqlAvailable = isPsqlAvailable();
  if (reporter?.assessResult && (batched || !psqlAvailable)) throw new Error('Assertion exceptions require the per-file psql runner');

  console.log('[pgTAP] Using database:', summarizeDatabaseUrl(databaseUrl));
  if (batched) {
    console.log(`[pgTAP] Runner mode: batched (${filesPerSession} files per psql session)`);
  } else {
    console.log('[pgTAP] Runner mode: per-file (set PGTAP_FILES_PER_SESSION to enable batching)');
  }
  console.log(
    '[pgTAP] Waiting for database to become ready (max',
    dbReadyTimeoutSeconds,
    'seconds)...'
  );
  if (!psqlAvailable) {
    console.warn('[pgTAP] psql not found on PATH; using Node pg runner (no libpq required).');
    let dbReadyCandidate = await waitForDatabaseReadyWithFallbackPg(dbCandidates, dbReadyTimeoutSeconds);
    console.log('[pgTAP] Database ready via', dbReadyCandidate.name);
    if (!/^(1|true|yes)$/i.test(String(env.PGTAP_SKIP_FIXTURE_BOOTSTRAP || '').trim())) {
      runFixtureBootstrapScript(
        path.join('scripts', 'tests', 'bootstrap', 'seed-pgtap-fixtures.js'),
        { ...(fullLocal ? { ...env, ENV_FILE: os.devNull, ENV_FILE_OVERRIDE: '0', ENV_FILE_APPEND: '0' } : {}), DATABASE_URL: dbReadyCandidate.dsn },
      );
    }
    const nodeFileTransientRetries = resolveNodeFileTransientRetries(env);
    const nodeFileTransientMaxWaitMs = resolveNodeFileTransientMaxWaitMs(env);
    const nodeFileTransientRetryDelayMs = resolveNodeFileTransientRetryDelayMs(env);
    const nodeFileDbReadyTimeoutSeconds = resolveNodeFileDbReadyTimeoutSeconds(env);

    const clientConfig = {
      connectionString: dbReadyCandidate.dsn,
      connectionTimeoutMillis: 10000,
      ssl: shouldUseSslForPg() ? { rejectUnauthorized: false } : undefined,
    };

    // Bootstrap using a dedicated session.
    {
      const bootstrapClient = new Client(clientConfig);
      await withPgClientRuntimeErrorCapture(bootstrapClient, async () => {
        try {
          await bootstrapClient.connect();
          console.log('[pgTAP] Ensuring pgTAP extension is available...');
          await bootstrapClient.query('CREATE EXTENSION IF NOT EXISTS pgtap;');

          console.log('[pgTAP] Ensuring partitions ahead are present...');
          await bootstrapClient.query(
            `SET statement_timeout TO ${bootstrapStatementTimeoutMs}; SELECT COUNT(*) FROM public.create_next_partitions();`
          );
        } finally {
          try { await bootstrapClient.end(); } catch { /* ignore */ }
        }
      });
    }

    console.log(`[pgTAP] Executing ${tapFiles.length} pgTAP files from ${testsDir}`);
    const failures = [];

    for (const file of tapFiles) {
      const filePath = path.join(testsDir, file);
      console.log(`[pgTAP] Running ${file}...`);
      const startedAt = Date.now();
      const transientRetryStartedAt = Date.now();
      let status = 'passed';
      let errorSummary = null;

      for (let attempt = 0; ; attempt += 1) {
        const fileClient = new Client(clientConfig);
        try {
          const combinedText = await withPgClientRuntimeErrorCapture(fileClient, async () => {
            try {
              await fileClient.connect();
              return await runTapFileWithPg(fileClient, filePath, { statementTimeoutMs });
            } finally {
              try { await fileClient.end(); } catch { /* ignore */ }
            }
          });
          if (hasTapFailures(combinedText)) {
            throw new Error(`[pgTAP] TAP test failures detected in ${file}`);
          }
          status = 'passed';
          errorSummary = null;
          break;
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          const retryable = isRetryableDbConnectError(err);
          const nowMs = Date.now();
          if (
            shouldRetryNodeFileTransientError({
              retryable,
              attempt,
              maxRetries: nodeFileTransientRetries,
              startedAtMs: transientRetryStartedAt,
              nowMs,
              maxWaitMs: nodeFileTransientMaxWaitMs,
            })
          ) {
            const remainingMs = Math.max(nodeFileTransientMaxWaitMs - (nowMs - transientRetryStartedAt), 0);
            const delayMs = remainingMs
              ? Math.min(
                  nodeFileTransientRetryDelayMs * (attempt + 1),
                  nodeFileTransientRetryDelayMs * 5,
                  remainingMs,
                )
              : 0;
            console.warn(
              `[pgTAP] ${file} transient DB error: ${msg} (attempt ${attempt + 1}, base_retries=${nodeFileTransientRetries}, max_wait_ms=${nodeFileTransientMaxWaitMs}, sleep ${delayMs}ms)`
            );
            try {
              dbReadyCandidate = await waitForDatabaseReadyWithFallbackPg(
                [dbReadyCandidate],
                nodeFileDbReadyTimeoutSeconds
              );
              clientConfig.connectionString = dbReadyCandidate.dsn;
            } catch (waitErr) {
              const waitMessage = sanitizeErrorMessage(waitErr);
              console.warn(
                `[pgTAP] ${file} readiness probe still pending before retry: ${waitMessage}`
              );
            }
            if (delayMs > 0) {
              await sleep(delayMs);
            }
            continue;
          }
          status = 'failed';
          errorSummary = `[pgTAP] ${file} failed: ${msg}`;
          break;
        }
      }

      await qa.recordCaseResults(qaSuiteKey, [
        {
          case_key: file,
          status,
          started_at: new Date(startedAt).toISOString(),
          ended_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          metadata: { file, suite: qaSuiteKey, runner: 'pg' },
          error_summary: errorSummary,
        },
      ]);

      if (status === 'failed') {
        failures.push(errorSummary || `pgTAP failed in ${file}`);
      }
    }

    if (failures.length) {
      throw new AggregateError(
        failures.map((failure) => new Error(failure)),
        `[pgTAP] ${failures.length} selected test execution(s) failed:\n${failures.join('\n')}`,
      );
    }
    console.log('[pgTAP] All tests completed successfully.');
    return;
  }

  let activePsqlCandidate = waitForDatabaseReadyWithFallback(dbCandidates, dbReadyTimeoutSeconds);
  let libpqDatabaseUrl = activePsqlCandidate.dsn;
  console.log('[pgTAP] Database ready via', activePsqlCandidate.name);
  if (!reporter?.prepared) {
    if (!/^(1|true|yes)$/i.test(String(env.PGTAP_SKIP_FIXTURE_BOOTSTRAP || '').trim())) {
      runFixtureBootstrapScript(
        path.join('scripts', 'tests', 'bootstrap', 'seed-pgtap-fixtures.js'),
        { ...(fullLocal ? { ...env, ENV_FILE: os.devNull, ENV_FILE_OVERRIDE: '0', ENV_FILE_APPEND: '0' } : {}), DATABASE_URL: libpqDatabaseUrl },
      );
    }
    console.log('[pgTAP] Ensuring pgTAP extension is available...');
    {
      const initAttempt = runPsqlWithCandidateFallback(
        dbCandidates,
        (candidateDsn) => [
          '--set',
          'ON_ERROR_STOP=1',
          '--no-psqlrc',
          '--dbname',
          candidateDsn,
          '-c',
          'CREATE EXTENSION IF NOT EXISTS pgtap;',
        ],
        'extension initializer',
        { preferredCandidateName: activePsqlCandidate.name },
      );
      activePsqlCandidate = initAttempt.candidate;
      libpqDatabaseUrl = activePsqlCandidate.dsn;
    }

    // Ensure tests can resolve functions from the extensions schema (pgTAP installed there)
    {
      const searchPathAttempt = runPsqlWithCandidateFallback(
        dbCandidates,
        (candidateDsn) => [
          '--set',
          'ON_ERROR_STOP=1',
          '--no-psqlrc',
          '--dbname',
          candidateDsn,
          '-c',
          `SET statement_timeout TO ${statementTimeoutMs}`,
          '-c',
          'SET jit = off',
          '-c',
          'SET search_path TO public, extensions, pgtap, pg_temp',
        ],
        'session search_path setup',
        { preferredCandidateName: activePsqlCandidate.name },
      );
      activePsqlCandidate = searchPathAttempt.candidate;
      libpqDatabaseUrl = activePsqlCandidate.dsn;
    }

    console.log('[pgTAP] Ensuring partitions ahead are present...');
    {
      const partitionAttempt = runPsqlWithCandidateFallback(
        dbCandidates,
        (candidateDsn) => [
          '--set',
          'ON_ERROR_STOP=1',
          '--no-psqlrc',
          '--dbname',
          candidateDsn,
          '-c',
          `SET statement_timeout TO ${bootstrapStatementTimeoutMs}`,
          '-c',
          'SELECT COUNT(*) FROM public.create_next_partitions();',
        ],
        'partition bootstrap',
        { preferredCandidateName: activePsqlCandidate.name },
      );
      activePsqlCandidate = partitionAttempt.candidate;
      libpqDatabaseUrl = activePsqlCandidate.dsn;
    }
  }
  if (reporter?.prepareOnly) return;
  console.log(`[pgTAP] Executing ${tapFiles.length} pgTAP files from ${testsDir}`);
  if (skipList.length) {
    console.log('[pgTAP] Skipping files (deprecated):', skipList.join(', '));
  }
  if (localSkip.length) {
    console.log('[pgTAP] Skipping files for local baseline:', localSkip.join(', '));
  }

  const failures = [];
  if (!batched) {
    for (const file of tapFiles) {
      const filePath = path.join(testsDir, file);
      console.log(`[pgTAP] Running ${file}...`);
      const startedAt = Date.now();
      let status = 'passed';
      let errorSummary = null;
      let assessment;
      try {
        const fileAttempt = runPsqlWithCandidateFallback(
          dbCandidates,
          (candidateDsn) => [
            '--set',
            'ON_ERROR_STOP=1',
            '--no-psqlrc',
            '--dbname',
            candidateDsn,
            '-c',
            'DISCARD ALL',
            '-c',
            `SET statement_timeout TO ${statementTimeoutMs}`,
            '-c',
            'SET jit = off',
            '-c',
            'SET search_path TO public, extensions, pgtap, pg_temp',
            '-f',
            filePath,
          ],
          file,
          { preferredCandidateName: activePsqlCandidate.name,
            assessResult: reporter?.assessResult ? result => reporter.assessResult(file, result) : undefined },
        );
        assessment = fileAttempt.assessment;
        activePsqlCandidate = fileAttempt.candidate;
        libpqDatabaseUrl = activePsqlCandidate.dsn;
      } catch (err) {
        assessment = err.assessment;
        status = 'failed';
        errorSummary = err.message;
      }

      await qa.recordCaseResults(qaSuiteKey, [
        {
          case_key: file,
          status,
          started_at: new Date(startedAt).toISOString(),
          ended_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          metadata: { file, suite: qaSuiteKey, ...(assessment ? { assessment } : {}) },
          error_summary: errorSummary,
        },
      ]);

      if (status === 'failed') {
        failures.push(errorSummary || `pgTAP failed in ${file}`);
      }
    }
  } else {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-pgtap-batch-'));
    try {
      const plan = planBatchedRuns({ files: tapFiles, testsDir, filesPerSession });
      const plannedBatches = plan.filter((run) => run.type === 'batch');
      let batchIdx = 0;

      for (const run of plan) {
        if (run.type === 'single') {
          const file = run.file;
          const filePath = path.join(testsDir, file);
          console.log(`[pgTAP] Running isolated ${file}...`);
          const startedAt = Date.now();
          let status = 'passed';
          let errorSummary = null;
          try {
            const isolatedAttempt = runPsqlWithCandidateFallback(
              dbCandidates,
              (candidateDsn) => [
                '--set',
                'ON_ERROR_STOP=1',
                '--no-psqlrc',
                '--dbname',
                candidateDsn,
                '-c',
                'DISCARD ALL',
                '-c',
                `SET statement_timeout TO ${statementTimeoutMs}`,
                '-c',
                'SET jit = off',
                '-c',
                'SET search_path TO public, extensions, pgtap, pg_temp',
                '-f',
                filePath,
              ],
              file,
              { preferredCandidateName: activePsqlCandidate.name },
            );
            activePsqlCandidate = isolatedAttempt.candidate;
            libpqDatabaseUrl = activePsqlCandidate.dsn;
          } catch (err) {
            status = 'failed';
            errorSummary = err.message;
          }

          await qa.recordCaseResults(qaSuiteKey, [
            {
              case_key: file,
              status,
              started_at: new Date(startedAt).toISOString(),
              ended_at: new Date().toISOString(),
              duration_ms: Date.now() - startedAt,
              metadata: { file, suite: qaSuiteKey, batch: 'isolated' },
              error_summary: errorSummary,
            },
          ]);

          if (status === 'failed') {
            failures.push(errorSummary || `pgTAP failed in ${file}`);
          }
          continue;
        }

        batchIdx += 1;
        const batchFiles = run.files;
        const batchLabel = `batch ${batchIdx}/${plannedBatches.length}`;
        console.log(`[pgTAP] Running ${batchLabel} (${batchFiles.length} files)...`);
        const driverSql = buildBatchDriverSql({
          files: batchFiles,
          testsDir,
          statementTimeout: statementTimeoutMs,
        });
        const driverPath = path.join(workDir, `pgtap-batch-${batchIdx}.sql`);
        fs.writeFileSync(driverPath, driverSql, 'utf8');

        const startedAt = Date.now();
        const batchAttempt = runPsqlCaptureAcrossCandidates(
          dbCandidates,
          (candidateDsn) => [
            '--set',
            'ON_ERROR_STOP=1',
            '--no-psqlrc',
            '--dbname',
            candidateDsn,
            '-f',
            driverPath,
          ],
          batchLabel,
          { preferredCandidateName: activePsqlCandidate.name },
        );
        activePsqlCandidate = batchAttempt.candidate || activePsqlCandidate;
        libpqDatabaseUrl = activePsqlCandidate.dsn;
        const res = batchAttempt.result;
        const endedAt = Date.now();
        const durationMs = endedAt - startedAt;

        const results = [];
        if (res.status !== 0) {
          const summary = res.combined ? res.combined.slice(-1500) : '';
          const errorSummary = summary ? `[pgTAP] ${batchLabel} exited with status ${res.status}: ${summary}` : `[pgTAP] ${batchLabel} exited with status ${res.status}`;
          const planTwiceDetected = isPlanTwiceError(res.combined);
          if (planTwiceDetected) {
            console.warn(`[pgTAP] ${batchLabel} hit plan-state collision in batched mode; retrying files in isolated mode.`);
            const fallbackErrors = [];
            for (const file of batchFiles) {
              const filePath = path.join(testsDir, file);
              const singleStartedAt = Date.now();
              let status = 'passed';
              let singleErrorSummary = null;
              try {
                const fallbackAttempt = runPsqlWithCandidateFallback(
                  dbCandidates,
                  (candidateDsn) => [
                    '--set',
                    'ON_ERROR_STOP=1',
                    '--no-psqlrc',
                    '--dbname',
                    candidateDsn,
                    '-c',
                    `SET statement_timeout TO ${statementTimeoutMs}`,
                    '-c',
                    'SET jit = off',
                    '-c',
                    'SET search_path TO public, extensions, pgtap, pg_temp',
                    '-f',
                    filePath,
                  ],
                  `${batchLabel} fallback ${file}`,
                  { preferredCandidateName: activePsqlCandidate.name },
                );
                activePsqlCandidate = fallbackAttempt.candidate;
                libpqDatabaseUrl = activePsqlCandidate.dsn;
              } catch (err) {
                status = 'failed';
                singleErrorSummary = err.message;
                fallbackErrors.push(`[pgTAP] ${batchLabel} fallback failed in ${file}: ${singleErrorSummary}`);
              }

              await qa.recordCaseResults(qaSuiteKey, [
                {
                  case_key: file,
                  status,
                  started_at: new Date(singleStartedAt).toISOString(),
                  ended_at: new Date().toISOString(),
                  duration_ms: Date.now() - singleStartedAt,
                  metadata: { file, suite: qaSuiteKey, batch: `${batchLabel}-fallback` },
                  error_summary: singleErrorSummary,
                },
              ]);
            }

            if (!fallbackErrors.length) {
              continue;
            }
            failures.push(...fallbackErrors);
            continue;
          }

          for (const file of batchFiles) {
            results.push({
              case_key: file,
              status: 'failed',
              started_at: new Date(startedAt).toISOString(),
              ended_at: new Date(endedAt).toISOString(),
              duration_ms: durationMs,
              metadata: { file, suite: qaSuiteKey, batch: batchLabel },
              error_summary: errorSummary,
            });
          }
          await qa.recordCaseResults(qaSuiteKey, results);
          failures.push(errorSummary);
          continue;
        }

        const segments = parseBatchOutputSegments(res.combined);
        const batchFailureFiles = [];
        for (let i = 0; i < batchFiles.length; i++) {
          const file = batchFiles[i];
          const seg = segments.get(file) || '';
          const fileFailed = hasTapFailures(seg) || !segments.has(file);
          if (fileFailed) batchFailureFiles.push(file);
          const sliceStart = startedAt + Math.floor((durationMs * i) / batchFiles.length);
          const sliceEnd = startedAt + Math.floor((durationMs * (i + 1)) / batchFiles.length);
          results.push({
            case_key: file,
            status: fileFailed ? 'failed' : 'passed',
            started_at: new Date(sliceStart).toISOString(),
            ended_at: new Date(sliceEnd).toISOString(),
            duration_ms: Math.max(0, sliceEnd - sliceStart),
            metadata: { file, suite: qaSuiteKey, batch: batchLabel },
            error_summary: fileFailed
              ? (segments.has(file) ? `[pgTAP] TAP failures detected in ${file}` : `[pgTAP] Missing output markers for ${file}`)
              : null,
          });
        }

        await qa.recordCaseResults(qaSuiteKey, results);

        if (batchFailureFiles.length) {
          failures.push(
            ...batchFailureFiles.map((file) => `[pgTAP] TAP test failure detected in ${file}`),
          );
        }
      }
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  if (failures.length) {
    throw new AggregateError(
      failures.map((failure) => new Error(failure)),
      `[pgTAP] ${failures.length} selected test execution(s) failed:\n${failures.join('\n')}`,
    );
  }
  console.log('[pgTAP] All tests completed successfully.');
  } catch (error) {
    suiteError = error;
    throw error;
  } finally {
    try { await qa.close(); } catch (closeError) {
      if (!suiteError) throw closeError;
      console.error('[pgTAP] QA cleanup also failed:', sanitizeErrorMessage(closeError));
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  main,
  runSuite,
  withFullLocalQualification,
  probeFullLocalCapabilities,
  computeLocalSkip,
  discoverTapFiles,
  isRetryableDbConnectError,
  resolveNodeFileTransientRetries,
  resolveNodeFileTransientMaxWaitMs,
  resolveNodeFileTransientRetryDelayMs,
  resolveNodeFileDbReadyTimeoutSeconds,
  resolveDatabaseUrlCandidates,
  orderDatabaseCandidates,
  resolveFilesPerSession,
  parseRequestedTapFiles,
  normalizeTapFileInput,
  resolveRequestedTapFiles,
  chunkArray,
  withPgClientRuntimeErrorCapture,
  hasTapFailures,
  isPlanTwiceError,
  createPgClientErrorTracker,
  tapFileHasBeginRollback,
  tapFileHasFinish,
  tapFileHasExplicitPlan,
  isTapFileBatchable,
  planBatchedRuns,
  buildBatchDriverSql,
  parseBatchOutputSegments,
  toPsqlPath,
  quotePsqlString,
  runTapFileWithPg,
  isRetryableDbConnectError,
  isRetryablePsqlFailure,
  shouldRetryNodeFileTransientError,
  runPsqlCapture,
  runPsqlCaptureAcrossCandidates,
  runPsqlWithCandidateFallback,
};
