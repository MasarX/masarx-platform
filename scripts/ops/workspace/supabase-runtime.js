#!/usr/bin/env node
/* eslint-disable no-console */
const DEFAULT_JWT_PROPAGATION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_JWT_PROPAGATION_INTERVAL_MS = 5000;

function normalizeSupabaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function parseJsonSafe(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function resolveEnvNumber(env, keys, fallback) {
  const list = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    const raw = String(env?.[key] || '').trim();
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function resolveJwtPropagationOptions(env, opts = {}) {
  const timeoutKeys = opts.timeoutKeys || ['SUPABASE_JWT_PROPAGATION_TIMEOUT_MS'];
  const intervalKeys = opts.intervalKeys || ['SUPABASE_JWT_PROPAGATION_INTERVAL_MS'];
  return {
    timeoutMs: resolveEnvNumber(env, timeoutKeys, DEFAULT_JWT_PROPAGATION_TIMEOUT_MS),
    intervalMs: resolveEnvNumber(env, intervalKeys, DEFAULT_JWT_PROPAGATION_INTERVAL_MS),
  };
}

function formatErrorBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object') {
    const msg = body.message || body.error || body.details;
    if (msg) return String(msg);
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }
  return String(body);
}

function shouldRetryJwtError(status, body) {
  const code = Number(status || 0);
  const msg = String(formatErrorBody(body)).toLowerCase();
  const isJwtSignatureFailure = Boolean(
    msg.includes('signature verification failed') ||
    msg.includes('invalid signature') ||
    msg.includes('invalid jwt') ||
    msg.includes('no suitable key') ||
    msg.includes('decode the jwt') ||
    msg.includes('invalid api key') ||
    (msg.includes('jwt') && msg.includes('signature'))
  );
  if (isJwtSignatureFailure) return true;
  // Fresh Supabase projects can briefly return storage auth readiness errors
  // while the storage tenant config is still being provisioned. Treat these as
  // transient so workspace provisioning (JWT minting, storage checks) can retry.
  const isMissingTenantConfig = Boolean(
    msg.includes('missing tenant config') ||
    msg.includes('missing tenant configuration') ||
    (msg.includes('tenant') && msg.includes('config') && msg.includes('missing'))
  );
  if (isMissingTenantConfig && (code === 400 || code === 404)) return true;
  if (code === 404) return true; // storage route may not be ready yet
  if ([502, 503, 504].includes(code)) return true;
  return false;
}

function isTransientFetchError(err) {
  const code = String(err?.code || '').toUpperCase();
  if (['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) {
    return true;
  }
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('fetch failed') || msg.includes('network') || msg.includes('socket');
}

async function checkStorageAuth({ supabaseUrl, serviceKey }) {
  const base = normalizeSupabaseUrl(supabaseUrl);
  if (!base) throw new Error('supabaseUrl is required to verify storage auth');
  if (!serviceKey) throw new Error('serviceKey is required to verify storage auth');
  const res = await fetch(`${base}/storage/v1/bucket`, {
    method: 'GET',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
    },
  });
  const text = await res.text();
  const body = parseJsonSafe(text) || text;
  return { ok: res.ok, status: res.status, body };
}

async function checkRestAuth({ supabaseUrl, serviceKey }) {
  const base = normalizeSupabaseUrl(supabaseUrl);
  if (!base) throw new Error('supabaseUrl is required to verify rest auth');
  if (!serviceKey) throw new Error('serviceKey is required to verify rest auth');
  const res = await fetch(`${base}/rest/v1/`, {
    method: 'GET',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
    },
  });
  const text = await res.text();
  const body = parseJsonSafe(text) || text;
  return { ok: res.ok, status: res.status, body };
}

async function waitForStorageAuth({ supabaseUrl, serviceKey, timeoutMs, intervalMs } = {}) {
  const base = normalizeSupabaseUrl(supabaseUrl);
  if (!base || !serviceKey) return { ok: false, skipped: true, attempts: 0 };
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_JWT_PROPAGATION_TIMEOUT_MS;
  const interval =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_JWT_PROPAGATION_INTERVAL_MS;
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < timeout) {
    attempt += 1;
    try {
      const res = await checkStorageAuth({ supabaseUrl: base, serviceKey });
      if (res.ok) return { ok: true, attempts: attempt, status: res.status };
      if (shouldRetryJwtError(res.status, res.body)) {
        if (attempt === 1 || attempt % 5 === 0) {
          console.log('[supabase-runtime] Waiting for storage JWT propagation...');
        }
        await new Promise((r) => setTimeout(r, interval));
        continue;
      }
      throw new Error(`Storage auth check failed (status ${res.status}): ${formatErrorBody(res.body)}`);
    } catch (err) {
      if (isTransientFetchError(err)) {
        if (attempt === 1 || attempt % 5 === 0) {
          console.log('[supabase-runtime] Waiting for storage auth network readiness...');
        }
        await new Promise((r) => setTimeout(r, interval));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Timeout waiting for storage auth after ${attempt} attempts`);
}

async function waitForRestAuth({ supabaseUrl, serviceKey, timeoutMs, intervalMs } = {}) {
  const base = normalizeSupabaseUrl(supabaseUrl);
  if (!base || !serviceKey) return { ok: false, skipped: true, attempts: 0 };
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_JWT_PROPAGATION_TIMEOUT_MS;
  const interval =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_JWT_PROPAGATION_INTERVAL_MS;
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < timeout) {
    attempt += 1;
    try {
      const res = await checkRestAuth({ supabaseUrl: base, serviceKey });
      if (res.ok) return { ok: true, attempts: attempt, status: res.status };
      if (shouldRetryJwtError(res.status, res.body)) {
        if (attempt === 1 || attempt % 5 === 0) {
          console.log('[supabase-runtime] Waiting for rest JWT propagation...');
        }
        await new Promise((r) => setTimeout(r, interval));
        continue;
      }
      throw new Error(`Rest auth check failed (status ${res.status}): ${formatErrorBody(res.body)}`);
    } catch (err) {
      if (isTransientFetchError(err)) {
        if (attempt === 1 || attempt % 5 === 0) {
          console.log('[supabase-runtime] Waiting for rest auth network readiness...');
        }
        await new Promise((r) => setTimeout(r, interval));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Timeout waiting for rest auth after ${attempt} attempts`);
}

module.exports = {
  waitForStorageAuth,
  waitForRestAuth,
  resolveJwtPropagationOptions,
  shouldRetryJwtError,
  normalizeSupabaseUrl,
};
