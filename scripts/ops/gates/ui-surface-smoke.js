#!/usr/bin/env node
/**
 * ui-surface-smoke.js
 *
 * Read-only smoke check for hosted UI surfaces (Console + Portal).
 *
 * Default inputs (env):
 * - CONSOLE_BASE_URL
 * - PORTAL_BASE_URL
 *
 * Usage:
 *   node scripts/ops/gates/ui-surface-smoke.js
 *   node scripts/ops/gates/ui-surface-smoke.js --urls "https://console.example.com,https://portal.example.com"
 *   node scripts/ops/gates/ui-surface-smoke.js --out artifacts/ui-surface-smoke.json
 *   node scripts/ops/gates/ui-surface-smoke.js --max-attempts 8 --retry-delay-ms 5000
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../../utils/load-env');

loadEnv();

function die(msg) {
  console.error(`[ui-surface-smoke] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    urls: '',
    out: '',
    timeoutMs: '',
    retries: '',
    maxAttempts: '',
    retryDelayMs: '',
  };

  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] || '');
    if (!a.startsWith('--')) continue;

    if (a === '--urls') out.urls = String(args[++i] || '');
    else if (a.startsWith('--urls=')) out.urls = a.split('=').slice(1).join('=');
    else if (a === '--out') out.out = String(args[++i] || '');
    else if (a.startsWith('--out=')) out.out = a.split('=').slice(1).join('=');
    else if (a === '--timeout-ms') out.timeoutMs = String(args[++i] || '');
    else if (a.startsWith('--timeout-ms=')) out.timeoutMs = a.split('=').slice(1).join('=');
    else if (a === '--retries') out.retries = String(args[++i] || '');
    else if (a.startsWith('--retries=')) out.retries = a.split('=').slice(1).join('=');
    else if (a === '--max-attempts') out.maxAttempts = String(args[++i] || '');
    else if (a.startsWith('--max-attempts=')) out.maxAttempts = a.split('=').slice(1).join('=');
    else if (a === '--retry-delay-ms') out.retryDelayMs = String(args[++i] || '');
    else if (a.startsWith('--retry-delay-ms=')) out.retryDelayMs = a.split('=').slice(1).join('=');
  }

  return out;
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function isStrictEnv(env) {
  return isTruthy(env.CI) || isTruthy(env.GITHUB_ACTIONS);
}

function requireAbsoluteUrl(raw, label, { strict, requireRoot = false }) {
  const value = String(raw || '').trim();
  if (!value) throw new Error(`Missing required ${label}`);
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL (got: ${value})`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`${label} must be http(s) (got: ${value})`);
  }
  const pathname = String(u.pathname || '').replace(/\/+$/g, '');
  if (requireRoot && pathname && pathname !== '/') {
    throw new Error(`${label} must be host-root (remove path "${pathname}")`);
  }
  if (strict) {
    const host = String(u.hostname || '').toLowerCase();
    // objectives:allow LOCALHOST Justification: strict guard rejects localhost for CI smoke checks
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
      throw new Error(`${label} must point to a hosted URL in CI (got host=${host})`);
    }
  }
  return u.toString();
}

function parseTimeoutMs(raw, fallbackMs) {
  const value = String(raw || '').trim();
  if (!value) return fallbackMs;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

function parseIntBounded(raw, fallbackValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = String(raw || '').trim();
  if (!value) return fallbackValue;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallbackValue;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function describeError(err) {
  const message = String(err && err.message ? err.message : err || 'unknown error').trim() || 'unknown error';
  const code = String((err && err.code) || '').trim();
  const causeMessage = String((err && err.cause && err.cause.message) || '').trim();
  const details = [message];
  if (code) details.push(`code=${code}`);
  if (causeMessage && causeMessage !== message) details.push(`cause=${causeMessage}`);
  return details.join(' ');
}

function sleep(delayMs) {
  const ms = Number.isFinite(Number(delayMs)) ? Number(delayMs) : 0;
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTextWithTimeout(url, { timeoutMs, fetchImpl, redirectMode = 'follow' }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch is not available (Node >= 18.17 / 20 recommended)');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestHeaders = { 'user-agent': 'masarx-ui-surface-smoke/1.0' };
    const host = (() => {
      try {
        return String(new URL(url).hostname || '').toLowerCase();
      } catch {
        return '';
      }
    })();
    const vercelBypass = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || process.env.VERCEL_PROTECTION_BYPASS_SECRET || '').trim();
    const vercelToken = String(process.env.VERCEL_TOKEN || '').trim();
    if (host.endsWith('.vercel.app')) {
      if (vercelBypass) {
        requestHeaders['x-vercel-protection-bypass'] = vercelBypass;
        requestHeaders['x-vercel-set-bypass-cookie'] = 'true';
      } else if (vercelToken) {
        requestHeaders.authorization = `Bearer ${vercelToken}`;
      }
    }
    const res = await fetchFn(url, {
      method: 'GET',
      redirect: redirectMode,
      signal: controller.signal,
      headers: requestHeaders,
    });
    const body = await res.text();
    return { res, body };
  } finally {
    clearTimeout(timer);
  }
}

function isRedirectLoopError(err) {
  const message = describeError(err).toLowerCase();
  return message.includes('redirect count exceeded');
}

async function probeManualRedirect(url, { timeoutMs, fetchImpl }) {
  const { res, body } = await fetchTextWithTimeout(url, {
    timeoutMs,
    fetchImpl,
    redirectMode: 'manual',
  });
  const status = Number(res && res.status);
  if (!Number.isFinite(status) || status < 300 || status >= 400) return null;
  const location =
    res && res.headers && typeof res.headers.get === 'function'
      ? String(res.headers.get('location') || '').trim()
      : '';
  if (!location) return null;
  const contentType =
    res && res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('content-type')
      : '';
  return {
    status,
    location,
    contentType: String(contentType || ''),
    bytes: Buffer.byteLength(String(body || ''), 'utf8'),
  };
}

function looksLikeHtml({ contentType, body }) {
  const ct = String(contentType || '').toLowerCase();
  const text = String(body || '');
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) return true;
  const sample = text.slice(0, 1024).toLowerCase();
  return sample.includes('<!doctype html') || sample.includes('<html');
}

function isAuthGatedHtmlSurface({ status, contentType, body, bytes }) {
  const httpStatus = Number(status);
  if (httpStatus !== 401 && httpStatus !== 403) return false;
  if (!looksLikeHtml({ contentType, body })) return false;
  return Number(bytes || 0) >= 200;
}

async function checkUrl({ label, url, timeoutMs, retries, retryDelayMs, fetchImpl, sleepFn }) {
  const startedAt = Date.now();
  const attemptLimit = Math.max(1, parseIntBounded(retries, 1, { min: 1, max: 60 }));
  const pause = typeof sleepFn === 'function' ? sleepFn : sleep;
  let lastErr = null;

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    try {
      const { res, body } = await fetchTextWithTimeout(url, { timeoutMs, fetchImpl });
      const status = Number(res && res.status);
      const contentType = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '';
      const bytes = Buffer.byteLength(String(body || ''), 'utf8');

      if (!Number.isFinite(status)) {
        throw new Error(`Invalid response for ${label} (${url})`);
      }
      if (isAuthGatedHtmlSurface({ status, contentType, body, bytes })) {
        const elapsedMs = Date.now() - startedAt;
        console.warn(
          `[ui-surface-smoke] accepting auth-gated surface for ${label} status=${status} (${url})`,
        );
        return {
          label,
          url,
          status,
          content_type: String(contentType || ''),
          bytes,
          elapsed_ms: elapsedMs,
          ok: true,
          attempts: attempt,
          auth_gate: true,
        };
      }
      if (status < 200 || status >= 400) {
        throw new Error(`${label} returned HTTP ${status} (${url})`);
      }
      if (!looksLikeHtml({ contentType, body })) {
        throw new Error(`${label} returned unexpected content-type (${contentType || 'unknown'}) (${url})`);
      }
      if (bytes < 200) {
        throw new Error(`${label} response too small (${bytes} bytes) (${url})`);
      }

      const elapsedMs = Date.now() - startedAt;
      return {
        label,
        url,
        status,
        content_type: String(contentType || ''),
        bytes,
        elapsed_ms: elapsedMs,
        ok: true,
        attempts: attempt,
      };
    } catch (err) {
      lastErr = err;
      if (isRedirectLoopError(err)) {
        try {
          const redirectProbe = await probeManualRedirect(url, { timeoutMs, fetchImpl });
          if (redirectProbe) {
            const elapsedMs = Date.now() - startedAt;
            console.warn(
              `[ui-surface-smoke] accepting redirect-reachable surface for ${label} status=${redirectProbe.status} location=${redirectProbe.location}`,
            );
            return {
              label,
              url,
              status: redirectProbe.status,
              content_type: redirectProbe.contentType,
              bytes: redirectProbe.bytes,
              elapsed_ms: elapsedMs,
              ok: true,
              redirect_probe: true,
            };
          }
        } catch (probeErr) {
          lastErr = probeErr;
        }
      }
      const message = describeError(err);
      if (attempt >= attemptLimit) break;
      console.warn(`[ui-surface-smoke] retry ${attempt}/${attemptLimit - 1} ${label}: ${message}`);
      if (retryDelayMs > 0) {
        await pause(retryDelayMs);
      }
    }
  }

  throw new Error(
    `Smoke check failed for ${label} (${url}) after ${attemptLimit} attempt(s): ${describeError(lastErr)}`,
  );
}

async function checkUrlWithRetry({
  label,
  url,
  timeoutMs,
  fetchImpl,
  maxAttempts,
  retryDelayMs,
  sleepFn,
}) {
  return checkUrl({
    label,
    url,
    timeoutMs,
    retries: maxAttempts,
    retryDelayMs,
    fetchImpl,
    sleepFn,
  });
}

function splitUrls(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean);
}

function resolveDefaultChecks(env, strict) {
  const consoleUrl = requireAbsoluteUrl(env.CONSOLE_BASE_URL, 'CONSOLE_BASE_URL', {
    strict,
    requireRoot: true,
  });
  const portalUrl = requireAbsoluteUrl(env.PORTAL_BASE_URL, 'PORTAL_BASE_URL', {
    strict,
    requireRoot: true,
  });
  return [
    { label: 'console', url: consoleUrl },
    { label: 'portal', url: portalUrl },
  ];
}

async function run({ argv, env, fetchImpl, sleepFn }) {
  const args = parseArgs(argv);
  const strict = isStrictEnv(env);
  const timeoutMs = parseTimeoutMs(args.timeoutMs, 15_000);
  const retries = parseIntBounded(
    args.maxAttempts || args.retries || env.UI_SURFACE_SMOKE_MAX_ATTEMPTS || env.UI_SURFACE_SMOKE_RETRIES,
    strict ? 24 : 3,
    {
    min: 1,
    max: 60,
    },
  );
  const retryDelayMs = parseIntBounded(
    args.retryDelayMs || env.UI_SURFACE_SMOKE_RETRY_DELAY_MS,
    strict ? 5000 : 2000,
    { min: 0, max: 120000 },
  );

  const checks = (() => {
    const urls = splitUrls(args.urls);
    if (urls.length) {
      return urls.map((u, idx) => ({
        label: `url_${idx + 1}`,
        url: requireAbsoluteUrl(u, `urls[${idx}]`, { strict }),
      }));
    }
    return resolveDefaultChecks(env, strict);
  })();

  const results = [];
  for (const c of checks) {
    const out = await checkUrl({
      label: c.label,
      url: c.url,
      timeoutMs,
      retries,
      retryDelayMs,
      fetchImpl,
      sleepFn,
    });
    results.push(out);
    console.log(
      `[ui-surface-smoke] OK ${out.label} status=${out.status} bytes=${out.bytes} elapsed_ms=${out.elapsed_ms} attempts=${out.attempts}`,
    );
  }

  const summary = {
    generated_at: new Date().toISOString(),
    strict,
    timeout_ms: timeoutMs,
    retries,
    max_attempts: retries,
    retry_delay_ms: retryDelayMs,
    results,
  };

  const outPath = String(args.out || '').trim();
  if (outPath) {
    const abs = path.resolve(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`[ui-surface-smoke] Wrote ${abs}`);
  }

  return summary;
}

async function main() {
  try {
    await run({ argv: process.argv.slice(2), env: process.env });
  } catch (e) {
    die(e && e.message ? e.message : String(e));
  }
}

if (require.main === module) {
  // eslint-disable-next-line promise/prefer-await-to-then
  main();
}

module.exports = {
  parseArgs,
  isStrictEnv,
  requireAbsoluteUrl,
  looksLikeHtml,
  isAuthGatedHtmlSurface,
  splitUrls,
  checkUrl,
  checkUrlWithRetry,
  run,
};
