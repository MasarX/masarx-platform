#!/usr/bin/env node
/**
 * pg Pool guard for tests and tooling.
 *
 * In cloud environments the underlying Postgres cluster can occasionally
 * restart or terminate connections, emitting a transient
 * `{:shutdown, :db_termination}` error. By default `pg` surfaces this as an
 * `error` event on the Pool which, when unhandled, causes Jest to treat the
 * entire test suite as failed even if individual tests are retried and pass.
 *
 * This module installs a global handler on Pool instances that:
 *   - Logs and ignores `db_termination` errors (code=XX000), treating them as
 *     transient infrastructure noise.
 *   - Re-throws all other errors so real issues remain visible.
 *
 * It is intentionally lightweight and is wired from Jest bootstrap so it only
 * affects test and tooling contexts, not application runtime code.
 */

/* eslint-disable no-console */
const { Pool } = require('pg');

let guardInstalled = false;
let originalPoolEmit = null;
let originalPoolConnect = null;

const TRANSIENT_DB_TERMINATION_CODES = new Set([
  'XX000',
  '57P01',
  '57P02',
  '57P03',
]);

const DEFAULT_CONNECT_RETRY_ATTEMPTS = 3;
const DEFAULT_CONNECT_RETRY_DELAY_MS = 250;

const TRANSIENT_DB_TERMINATION_PATTERNS = [
  'db_termination',
  'dbhandler exited',
  'database system is shutting down',
  'terminating connection due to administrator command',
  'server closed the connection unexpectedly',
  'connection terminated unexpectedly',
];

const PREVIEW_AUTH_LAG_PATTERNS = [
  'tenant or user not found',
  'password authentication failed',
  'too many authentication errors',
];

function isTransientDbTerminationMessage(message) {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) return false;
  return TRANSIENT_DB_TERMINATION_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function parseEnabledFlag(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function isPreviewAuthLagMessage(message) {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) return false;
  return PREVIEW_AUTH_LAG_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function shouldRetryPreviewAuthLag(env = process.env) {
  const explicit = String(env.PG_POOL_CONNECT_RETRY_AUTH_LAG || '').trim();
  if (explicit) {
    return parseEnabledFlag(explicit, false);
  }

  const ciLike = parseEnabledFlag(env.CI, false) || parseEnabledFlag(env.GITHUB_ACTIONS, false);
  const previewLike = Boolean(
    String(
      env.PREVIEW_SUPABASE_URL ||
        env.PREVIEW_PROJECT_REF ||
        env.DATABASE_URL_POOLER ||
        env.DB_SMOKE_SELECTED_DSN_NAME ||
        env.DATABASE_URL_SELECTED_DSN_NAME ||
        '',
    ).trim(),
  );
  return ciLike && previewLike;
}

function isTransientDbTerminationError(err) {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  if (code && !TRANSIENT_DB_TERMINATION_CODES.has(code)) {
    return false;
  }
  return isTransientDbTerminationMessage(err.message);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function parsePositiveInteger(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getPoolConnectRetryAttempts() {
  return parsePositiveInteger(process.env.PG_POOL_CONNECT_RETRY_ATTEMPTS, DEFAULT_CONNECT_RETRY_ATTEMPTS);
}

function getPoolConnectRetryDelayMs() {
  return parsePositiveInteger(process.env.PG_POOL_CONNECT_RETRY_DELAY_MS, DEFAULT_CONNECT_RETRY_DELAY_MS);
}

function isRetryablePoolConnectError(err, env = process.env) {
  if (isTransientDbTerminationError(err)) return true;
  if (!shouldRetryPreviewAuthLag(env)) return false;
  return isPreviewAuthLagMessage(err && err.message);
}

async function connectWithTransientRetry(connectFn, options = {}) {
  const attempts = parsePositiveInteger(options.attempts, getPoolConnectRetryAttempts());
  const delayMs = parsePositiveInteger(options.delayMs, getPoolConnectRetryDelayMs());
  const sleepFn = typeof options.sleepFn === 'function' ? options.sleepFn : sleep;
  const logger = typeof options.logger === 'function' ? options.logger : console.warn;
  const env = options.env || process.env;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connectFn();
    } catch (error) {
      lastError = error;
      if (!isRetryablePoolConnectError(error, env) || attempt >= attempts) {
        throw error;
      }
      logger(
        `[pg-pool-guard] Retrying transient pool.connect failure (${attempt}/${attempts - 1}): ${String(error.message || error)}`,
      );
      await sleepFn(delayMs * attempt);
    }
  }
  throw lastError;
}

function resetPoolGuardForTests() {
  if (originalPoolEmit) Pool.prototype.emit = originalPoolEmit;
  if (originalPoolConnect) Pool.prototype.connect = originalPoolConnect;
  originalPoolEmit = null;
  originalPoolConnect = null;
  guardInstalled = false;
}

function attachPoolErrorGuard() {
  if (guardInstalled) return;
  guardInstalled = true;

  originalPoolEmit = Pool.prototype.emit;
  originalPoolConnect = Pool.prototype.connect;

  Pool.prototype.emit = function guardedEmit(event, ...args) {
    if (event === 'error' && args.length) {
      const err = args[0];
      const msg = err && String(err.message || '');
      if (isTransientDbTerminationError(err)) {
        console.warn('[pg-pool-guard] Ignoring transient db termination error from Pool:', msg);
        return false;
      }
    }
    return originalPoolEmit.call(this, event, ...args);
  };

  Pool.prototype.connect = function guardedConnect(...args) {
    if (typeof args[0] === 'function') {
      return originalPoolConnect.apply(this, args);
    }
    return connectWithTransientRetry(
      () => originalPoolConnect.apply(this, args),
      {
        attempts: getPoolConnectRetryAttempts(),
        delayMs: getPoolConnectRetryDelayMs(),
      },
    );
  };
}

module.exports = {
  attachPoolErrorGuard,
  connectWithTransientRetry,
  getPoolConnectRetryAttempts,
  getPoolConnectRetryDelayMs,
  isPreviewAuthLagMessage,
  isRetryablePoolConnectError,
  isTransientDbTerminationMessage,
  isTransientDbTerminationError,
  resetPoolGuardForTests,
  shouldRetryPreviewAuthLag,
};
