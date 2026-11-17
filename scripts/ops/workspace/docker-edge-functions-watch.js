#!/usr/bin/env node
/* eslint-disable no-console */

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token.startsWith('--')) continue;
    const [rawKey, ...inline] = token.slice(2).split('=');
    const key = rawKey.trim();
    let value = inline.length ? inline.join('=') : null;
    if (value == null) {
      const next = argv[index + 1];
      if (next == null || String(next).startsWith('--')) value = true;
      else {
        value = String(next);
        index += 1;
      }
    }
    out[key] = value;
    out[key.replace(/-/g, '_')] = value;
  }
  return out;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/g, '');
  if (!raw) return '';
  return raw.endsWith('/functions/v1') ? raw : `${raw}/functions/v1`;
}

function resolveBaseUrl(args = {}, env = process.env) {
  return normalizeBaseUrl(
    args.url ||
    args.base_url ||
    env.SUPABASE_FUNCTIONS_INTERNAL_URL ||
    env.SUPABASE_FUNCTIONS_URL ||
    env.EDGE_FUNCTIONS_URL ||
    env.SUPABASE_URL ||
    env.VITE_SUPABASE_URL,
  );
}

function buildProbeUrl(baseUrl, functionName) {
  return `${baseUrl}/${String(functionName || 'metrics-echo-test').replace(/^\/+/g, '')}`;
}

async function probeEdgeFunction(url, env = process.env) {
  const token = String(env.EDGE_FUNCTION_HEALTH_TOKEN || env.SUPABASE_SERVICE_ROLE_KEY || env.EDGE_DB_JWT || '').trim();
  const headers = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
    headers.apikey = token;
  }
  const response = await fetch(url, {
    method: 'GET',
    headers,
  });
  const okStatuses = new Set([200, 204, 401, 403, 405]);
  return {
    ok: okStatuses.has(response.status),
    status: response.status,
    url,
  };
}

async function waitForReady(args = {}, env = process.env) {
  const baseUrl = resolveBaseUrl(args, env);
  if (!baseUrl) throw new Error('missing_edge_functions_url');
  const functionName = String(args.function || args.function_name || env.EDGE_FUNCTION_HEALTH_FUNCTION || 'metrics-echo-test');
  const url = buildProbeUrl(baseUrl, functionName);
  const deadlineMs = Date.now() + parsePositiveInteger(args['startup-timeout-ms'] || args.startup_timeout_ms, 180000);
  const intervalMs = parsePositiveInteger(args['interval-ms'] || args.interval_ms, 30000);
  let last = null;

  while (Date.now() <= deadlineMs) {
    try {
      last = await probeEdgeFunction(url, env);
      if (last.ok) {
        console.log(JSON.stringify({
          status: 'ready',
          service: 'edge-functions',
          ownership: 'supabase-cli-local-runtime-v1',
          url,
          http_status: last.status,
        }));
        return { ...last, intervalMs };
      }
    } catch (error) {
      last = { ok: false, url, error: error?.message || String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, intervalMs)));
  }

  throw new Error(`edge_functions_not_ready:${url}:${last?.status || last?.error || 'unknown'}`);
}

async function main() {
  const args = parseArgs();
  const ready = await waitForReady(args);
  if (args.once) return;
  const intervalMs = ready.intervalMs;
  setInterval(async () => {
    try {
      const result = await probeEdgeFunction(ready.url);
      console.log(JSON.stringify({
        status: result.ok ? 'ready' : 'degraded',
        service: 'edge-functions',
        ownership: 'supabase-cli-local-runtime-v1',
        url: ready.url,
        http_status: result.status,
      }));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(JSON.stringify({
        status: 'degraded',
        service: 'edge-functions',
        ownership: 'supabase-cli-local-runtime-v1',
        url: ready.url,
        error: error?.message || String(error),
      }));
      process.exitCode = 1;
    }
  }, intervalMs);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  buildProbeUrl,
  normalizeBaseUrl,
  probeEdgeFunction,
  resolveBaseUrl,
  waitForReady,
};
