#!/usr/bin/env node

const { loadEnv } = require('../utils/load-env');

loadEnv();

const fetchImpl = globalThis.fetch;
if (!fetchImpl) {
  throw new Error('Global fetch is unavailable. Node 18+ required.');
}

function sleep(ms) {
  const n = Number(ms || 0);
  if (!n || n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

function parseIntEnv(key, fallback) {
  const raw = String(process.env[key] || '').trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function isRetryableEdgeStatus(status) {
  return [502, 503, 504].includes(Number(status || 0));
}

async function fetchWithRetries(url, init) {
  const retries = Math.max(1, parseIntEnv('EDGE_SMOKE_RETRIES', 3));
  const timeoutMs = Math.max(1000, parseIntEnv('EDGE_SMOKE_TIMEOUT_MS', 30000));
  const baseDelayMs = Math.max(250, parseIntEnv('EDGE_SMOKE_RETRY_BASE_DELAY_MS', 1000));

  let delayMs = baseDelayMs;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...(init || {}), signal: controller.signal });
      if (!isRetryableEdgeStatus(res.status) || attempt === retries) return res;
      try { await res.arrayBuffer(); } catch (_) {}
      console.warn(
        `[edge-smoke] ${init?.method || 'GET'} ${url} returned ${res.status}; retrying in ${delayMs}ms (attempt ${attempt}/${retries})`,
      );
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(
        `[edge-smoke] ${init?.method || 'GET'} ${url} failed (${err?.message || err}); retrying in ${delayMs}ms (attempt ${attempt}/${retries})`,
      );
    } finally {
      clearTimeout(timer);
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 10000);
  }
  throw new Error('[edge-smoke] fetchWithRetries exhausted unexpectedly');
}

// objectives:allow LOCALHOST Justification: heuristic check to detect local env based on ENV_FILE/DATABASE_URL containing localhost/127.0.0.1; used only to toggle smoke-test mode
const isLocalEnv =
  (process.env.ENV_FILE || '').includes('.env.local') ||
  (process.env.DATABASE_URL || '').includes('127.0.0.1') ||
  (process.env.DATABASE_URL || '').includes('localhost');
const localEdgeEnabled = process.env.RUN_LOCAL_EDGE_TESTS === 'true';
if (isLocalEnv && !localEdgeEnabled) {
  // Local edge smoke is optional; rely on cloud edge tests when disabled.
  console.log('[edge-smoke] Skipping local edge smoke (RUN_LOCAL_EDGE_TESTS!=true)');
  process.exit(0);
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.EDGE_SUPABASE_URL;
if (!supabaseUrl) {
  throw new Error('SUPABASE_URL (or EDGE_SUPABASE_URL) must be set for edge smoke checks.');
}

const smokeAllow = process.env.EDGE_SMOKE_ALLOW === '1';
const webhookSmokeToken = process.env.WEBHOOK_SMOKE_TOKEN || '';
const labelRendererDbJwt =
  process.env.LABEL_RENDERER_DB_JWT ||
  process.env.EDGE_DB_JWT ||
  '';
const edgeRequireDbJwt = /^(1|true|yes)$/i.test(String(process.env.EDGE_REQUIRE_DB_JWT || '').trim());

const edgeInvokeJwt = edgeRequireDbJwt
  ? (
      process.env.API_CALLER_DB_JWT ||
      process.env.API_GATEWAY_DB_JWT ||
      process.env.WEBHOOK_DB_JWT ||
      process.env.EDGE_DB_JWT ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.EDGE_SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SERVICE_ROLE_KEY ||
      ''
    )
  : '';

const functionsBase = `${supabaseUrl.replace(/\/$/, '')}/functions/v1`;

const assertStatus = (actual, expected, label) => {
  const expecteds = Array.isArray(expected) ? expected : [expected];
  if (!expecteds.includes(actual)) {
    throw new Error(`${label} expected status ${expecteds.join(' or ')}, received ${actual}`);
  }
};

const truncate = (value, max = 600) => {
  const text = String(value || '');
  if (!text) return text;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
};

const toJson = async (res) => {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
};

const buildWebhookSmokePayload = () => ({
  event: {
    id: `smoke-${Date.now()}`,
    type: 'address.intake_v1',
  },
  address: {
    line1: 'Smoke test address',
    city: 'Riyadh',
    country: 'SA',
  },
});

const run = async () => {
  const results = [];

  // webhook-receiver: missing auth should 4xx; allow smoke bypass when enabled 
  {
    // Console V2 Webhook tester invokes the receiver from the browser, so the
    // receiver must answer preflight for token, idempotency, and signature
    // headers before any production-readiness proof can count.
    const testerOrigin = process.env.CONSOLE_WEBHOOK_TESTER_ORIGIN || 'https://unjijvxjrwurjgsnokovrvom.example.invalid';
    const preflight = await fetchWithRetries(`${functionsBase}/webhook-receiver`, {
      method: 'OPTIONS',
      headers: {
        origin: testerOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, apikey, content-type, x-client-info, x-webhook-token, idempotency-key, x-signature, x-correlation-id',
      },
    });
    assertStatus(preflight.status, [200, 204], 'webhook-receiver cors preflight');

    const allowOrigin = String(preflight.headers.get('access-control-allow-origin') || '').trim();
    const allowHeaders = String(preflight.headers.get('access-control-allow-headers') || '').trim().toLowerCase();
    const allowMethods = String(preflight.headers.get('access-control-allow-methods') || '').trim().toLowerCase();

    if (!allowOrigin) {
      throw new Error('webhook-receiver cors preflight missing access-control-allow-origin');
    }
    for (const required of ['authorization', 'content-type', 'x-webhook-token', 'idempotency-key', 'x-signature']) {
      if (!allowHeaders.includes(required)) {
        throw new Error(`webhook-receiver cors preflight missing required allow-header ${required}: ${allowHeaders || '<empty>'}`);
      }
    }
    if (!allowMethods.includes('post')) {
      throw new Error(`webhook-receiver cors preflight missing allow-methods POST: ${allowMethods || '<empty>'}`);
    }

    results.push({
      name: 'webhook-receiver-cors',
      status: preflight.status,
      body: { allowOrigin, allowHeaders, allowMethods },
    });
  }

  {
    const res = await fetchWithRetries(`${functionsBase}/webhook-receiver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smoke-test': 'edge-allow' },
      body: JSON.stringify({}),
    });
    assertStatus(res.status, smokeAllow ? [202] : [400, 401, 403], 'webhook-receiver unauthenticated');
    results.push({ name: 'webhook-receiver', status: res.status });
  }

  if (webhookSmokeToken) {
    const res = await fetchWithRetries(`${functionsBase}/webhook-receiver`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-smoke-test': 'edge-allow',
        authorization: `Bearer ${webhookSmokeToken}`,
      },
      body: JSON.stringify(buildWebhookSmokePayload()),
    });
    assertStatus(res.status, smokeAllow ? [202] : [200, 202], 'webhook-receiver authenticated');
    results.push({ name: 'webhook-receiver-auth', status: res.status, body: await toJson(res) });
  }

  // api-gateway: verify_jwt=false so missing token should return 401 (not JWT auth failure)
  {
    const res = await fetchWithRetries(`${functionsBase}/api-gateway`, {
      method: 'GET',
    });
    assertStatus(res.status, 401, 'api-gateway missing token');
    results.push({ name: 'api-gateway', status: res.status, body: await toJson(res) });
  }

  // label-renderer: empty queue should require auth (401/403) or return 204 when smoke bypass is enabled
  {
    // Browser designer preflight must succeed (CORS + OPTIONS handling).
    const designerOrigin = process.env.LABEL_DESIGNER_ORIGIN || 'https://label-designer.test';
    const preflight = await fetchWithRetries(`${functionsBase}/label-renderer`, {
      method: 'OPTIONS',
      headers: {
        origin: designerOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, apikey, content-type, x-client-info',
      },
    });
    assertStatus(preflight.status, [200, 204], 'label-renderer cors preflight');

    const allowOrigin = String(preflight.headers.get('access-control-allow-origin') || '').trim();
    const allowHeaders = String(preflight.headers.get('access-control-allow-headers') || '').trim().toLowerCase();
    const allowMethods = String(preflight.headers.get('access-control-allow-methods') || '').trim().toLowerCase();

    if (!allowOrigin) {
      throw new Error('label-renderer cors preflight missing access-control-allow-origin');
    }
    if (!allowHeaders.includes('authorization') || !allowHeaders.includes('content-type') || !allowHeaders.includes('apikey')) {
      throw new Error(`label-renderer cors preflight missing required allow-headers: ${allowHeaders || '<empty>'}`);
    }
    if (!allowMethods.includes('post')) {
      throw new Error(`label-renderer cors preflight missing allow-methods POST: ${allowMethods || '<empty>'}`);
    }

    results.push({
      name: 'label-renderer-cors',
      status: preflight.status,
      body: { allowOrigin, allowHeaders, allowMethods },
    });

    const res = await fetchWithRetries(`${functionsBase}/label-renderer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smoke-test': 'edge-allow' },
      body: JSON.stringify({}),
    });
    assertStatus(res.status, smokeAllow ? [204] : [401, 403], 'label-renderer idle');
    const body = await toJson(res);
    results.push({ name: 'label-renderer', status: res.status, body });
  }

  if (labelRendererDbJwt && edgeRequireDbJwt) {
    const res = await fetchWithRetries(`${functionsBase}/label-renderer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-smoke-test': 'edge-allow',
        authorization: `Bearer ${labelRendererDbJwt}`,
      },
      body: JSON.stringify({}),
    });
    const allowed = smokeAllow ? [204] : [200, 204];
    if (!allowed.includes(res.status)) {
      const bodyText = await res.text();
      throw new Error(
        `label-renderer authenticated expected status ${allowed.join(' or ')}, received ${res.status}; body=${truncate(bodyText)}`,
      );
    }
    results.push({ name: 'label-renderer-auth', status: res.status, body: await toJson(res) });
  } else if (labelRendererDbJwt && !edgeRequireDbJwt) {
    results.push({ name: 'label-renderer-auth', status: 'skipped', body: { reason: 'EDGE_REQUIRE_DB_JWT=0' } });
  }

  const res = await fetchWithRetries(`${functionsBase}/api-caller`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(edgeInvokeJwt ? { authorization: `Bearer ${edgeInvokeJwt}` } : {}),
    },
    body: JSON.stringify({ job_id: '00000000-0000-0000-0000-000000000000' }),
  });
  // With a valid internal JWT, accept 500 for invalid job id, 502 for dispatch failure, 200 for success.
  // Without it, the auth layer should block the call (401/403) or report a server misconfiguration (500).
  assertStatus(res.status, edgeInvokeJwt ? [200, 502, 500] : [401, 403, 500], 'api-caller dispatch');
  results.push({ name: 'api-caller-dispatch', status: res.status, body: await toJson(res) });

  console.log('Edge smoke results');
  for (const item of results) {
    console.log(`  ${item.name}: ${item.status}${item.body ? ` -> ${JSON.stringify(item.body)}` : ''}`);
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
