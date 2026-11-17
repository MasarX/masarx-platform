#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { parseArgs } = require('util');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { buildDbConnectionCandidates } = require('../utils/pg-candidates');
const { removeStoragePaths } = require('../utils/supabase-storage');

loadEnv();

const { upsertSettings } = require('../../tests/utils/policies');

const ENV = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_PROJECT_ID: process.env.SUPABASE_PROJECT_ID,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_URL_DIRECT: process.env.DATABASE_URL_DIRECT,
  BENCHMARK_DATABASE_URL: process.env.BENCHMARK_DATABASE_URL,
  BENCHMARK_DATABASE_URL_DIRECT: process.env.BENCHMARK_DATABASE_URL_DIRECT,
  PREVIEW_SUPABASE_DB_PASSWORD: process.env.PREVIEW_SUPABASE_DB_PASSWORD,
  LABEL_RENDERER_BENCHMARK_AUTH_JWT: process.env.LABEL_RENDERER_BENCHMARK_AUTH_JWT,
  LABEL_RENDERER_DB_JWT: process.env.LABEL_RENDERER_DB_JWT,
  LABEL_RENDERER_TOKEN: process.env.LABEL_RENDERER_TOKEN,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  SERVICE_ROLE_KEY: process.env.SERVICE_ROLE_KEY,
  LABEL_RENDER_BUCKET: process.env.LABEL_RENDER_BUCKET,
  LABEL_RENDERER_BUCKET: process.env.LABEL_RENDERER_BUCKET,
  LABEL_PRINT_BENCHMARK_REQUEST_TIMEOUT_MS: process.env.LABEL_PRINT_BENCHMARK_REQUEST_TIMEOUT_MS,
  LABEL_PRINT_BENCHMARK_RETRY_ATTEMPTS: process.env.LABEL_PRINT_BENCHMARK_RETRY_ATTEMPTS,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseFloatSafe = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const parseIntegerSafe = (value) => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const parseBooleanFlag = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const buildLabelPrintPolicyOverride = ({
  renderMaxJobs,
  renderJobConcurrency,
  renderLeaseSeconds,
  renderMaxCalls,
  edgeDbMode,
  quickPollAttempts,
  quickPollIntervalMs,
  prepareInlineProgressEnabled,
  prepareInlineProgressBudgetMs,
  prepareInlineProgressMaxSteps,
  executeDispatchMode,
  executeWaitSeconds,
  executeInitialDeferMs,
} = {}) => {
  const policy = {};
  if (Number.isFinite(renderMaxJobs) && renderMaxJobs > 0) {
    policy.render_max_jobs = Math.min(200, Math.max(1, Math.trunc(renderMaxJobs)));
  }
  if (Number.isFinite(renderJobConcurrency) && renderJobConcurrency > 0) {
    policy.render_job_concurrency = Math.min(50, Math.max(1, Math.trunc(renderJobConcurrency)));
  }
  if (Number.isFinite(renderLeaseSeconds) && renderLeaseSeconds > 0) {
    policy.render_lease_seconds = Math.min(600, Math.max(60, Math.trunc(renderLeaseSeconds)));
  }
  if (Number.isFinite(renderMaxCalls) && renderMaxCalls > 0) {
    policy.render_max_calls = Math.min(50, Math.max(1, Math.trunc(renderMaxCalls)));
  }
  if (typeof edgeDbMode === 'string') {
    const normalized = edgeDbMode.trim().toLowerCase();
    if (['rest_rpc', 'direct_pooler'].includes(normalized)) {
      policy.edge_db_mode = normalized;
    }
  }
  if (Number.isFinite(quickPollAttempts) && quickPollAttempts >= 0) {
    policy.quick_poll_attempts = Math.min(20, Math.max(0, Math.trunc(quickPollAttempts)));
  }
  if (Number.isFinite(quickPollIntervalMs) && quickPollIntervalMs > 0) {
    policy.quick_poll_interval_ms = Math.min(2000, Math.max(25, Math.trunc(quickPollIntervalMs)));
  }
  if (typeof prepareInlineProgressEnabled === 'boolean') {
    policy.prepare_inline_progress_enabled = prepareInlineProgressEnabled;
  }
  if (Number.isFinite(prepareInlineProgressBudgetMs) && prepareInlineProgressBudgetMs > 0) {
    policy.prepare_inline_progress_budget_ms = Math.min(
      5000,
      Math.max(25, Math.trunc(prepareInlineProgressBudgetMs)),
    );
  }
  if (Number.isFinite(prepareInlineProgressMaxSteps) && prepareInlineProgressMaxSteps > 0) {
    policy.prepare_inline_progress_max_steps = Math.min(
      50,
      Math.max(1, Math.trunc(prepareInlineProgressMaxSteps)),
    );
  }
  if (typeof executeDispatchMode === 'string') {
    const normalized = executeDispatchMode.trim().toLowerCase();
    if (['async', 'sync_wait'].includes(normalized)) {
      policy.execute_dispatch_mode = normalized;
    }
  }
  if (Number.isFinite(executeWaitSeconds) && executeWaitSeconds > 0) {
    policy.execute_wait_seconds = Math.min(60, Math.max(1, Math.trunc(executeWaitSeconds)));
  }
  if (Number.isFinite(executeInitialDeferMs) && executeInitialDeferMs >= 0) {
    policy.execute_initial_defer_ms = Math.min(5000, Math.max(0, Math.trunc(executeInitialDeferMs)));
  }
  return Object.keys(policy).length > 0 ? policy : null;
};

const buildWorkflowStartOverride = ({
  inlineKickEnabled,
  inlineKickMaxAttempts,
  inlineKickBudgetMs,
  inlineKickPollMs,
} = {}) => {
  const workflowStart = {};
  if (typeof inlineKickEnabled === 'boolean') {
    workflowStart.inline_kick_enabled = inlineKickEnabled;
  }
  if (Number.isFinite(inlineKickMaxAttempts) && inlineKickMaxAttempts > 0) {
    workflowStart.inline_kick_max_attempts = Math.min(20, Math.max(1, Math.trunc(inlineKickMaxAttempts)));
  }
  if (Number.isFinite(inlineKickBudgetMs) && inlineKickBudgetMs > 0) {
    workflowStart.inline_kick_budget_ms = Math.min(5000, Math.max(25, Math.trunc(inlineKickBudgetMs)));
  }
  if (Number.isFinite(inlineKickPollMs) && inlineKickPollMs > 0) {
    workflowStart.inline_kick_poll_ms = Math.min(500, Math.max(10, Math.trunc(inlineKickPollMs)));
  }
  return Object.keys(workflowStart).length > 0 ? workflowStart : null;
};

const normalizeOutputArtifact = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const querySplit = raw.split('?')[0];
  try {
    const parsed = new URL(raw);
    const path = decodeURIComponent(parsed.pathname || '');
    const signMarker = '/storage/v1/object/sign/';
    const publicMarker = '/storage/v1/object/public/';
    if (path.includes(signMarker)) {
      const signedPath = path.slice(path.indexOf(signMarker) + signMarker.length);
      const segments = signedPath.split('/').filter(Boolean);
      return segments.length > 1 ? segments.slice(1).join('/') : signedPath;
    }
    if (path.includes(publicMarker)) {
      const publicPath = path.slice(path.indexOf(publicMarker) + publicMarker.length);
      const segments = publicPath.split('/').filter(Boolean);
      return segments.length > 1 ? segments.slice(1).join('/') : publicPath;
    }
    return `${parsed.origin}${path}`;
  } catch {
    return querySplit;
  }
};

const decodeJwtPayload = (token) => {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padLen = normalized.length % 4;
    const padded = padLen === 0 ? normalized : normalized + '='.repeat(4 - padLen);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return decoded ? JSON.parse(decoded) : null;
  } catch {
    return null;
  }
};

const getJwtRole = (token) => {
  const payload = decodeJwtPayload(token);
  const role = payload?.role ?? payload?.user_role ?? null;
  return typeof role === 'string' ? role.trim().toLowerCase() : '';
};

const percentile = (sortedValues, ratio) => {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
};

const summarize = (values, targetMs) => {
  if (!values.length) {
    return {
      sample_count: 0,
      target_download_ms: targetMs,
      hit_count: 0,
      miss_count: 0,
      hit_rate: 0,
      min_ms: null,
      max_ms: null,
      mean_ms: null,
      p50_ms: null,
      p95_ms: null,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const hitCount = values.filter((value) => value <= targetMs).length;
  const missCount = values.length - hitCount;
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  return {
    sample_count: values.length,
    target_download_ms: targetMs,
    hit_count: hitCount,
    miss_count: missCount,
    hit_rate: Number((hitCount / values.length).toFixed(4)),
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
    mean_ms: Number(mean.toFixed(2)),
    p50_ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95_ms: Number(percentile(sorted, 0.95).toFixed(2)),
  };
};

const summarizeDurations = (values) => {
  if (!Array.isArray(values) || values.length === 0) {
    return {
      sample_count: 0,
      min_ms: null,
      max_ms: null,
      mean_ms: null,
      p50_ms: null,
      p95_ms: null,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  return {
    sample_count: values.length,
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
    mean_ms: Number(mean.toFixed(2)),
    p50_ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95_ms: Number(percentile(sorted, 0.95).toFixed(2)),
  };
};

const extractStepDurations = (payload) => {
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  const out = {};
  for (const step of steps) {
    const name = String(step?.step || '').trim();
    const duration = Number(step?.duration_ms);
    if (!name || !Number.isFinite(duration) || duration < 0) continue;
    out[name] = duration;
  }
  return out;
};

const appendStageDurations = (targetMap, durationMap) => {
  for (const [stage, duration] of Object.entries(durationMap || {})) {
    const value = Number(duration);
    if (!Number.isFinite(value) || value < 0) continue;
    if (!targetMap.has(stage)) {
      targetMap.set(stage, []);
    }
    targetMap.get(stage).push(value);
  }
};

const summarizeStageMap = (stageMap) => {
  const out = {};
  for (const [stage, values] of stageMap.entries()) {
    out[stage] = summarizeDurations(values);
  }
  return out;
};

const inferProjectRefFromSupabaseUrl = () => {
  const explicit = String(ENV.SUPABASE_PROJECT_ID || '').trim();
  if (explicit) return explicit;
  const raw = String(ENV.SUPABASE_URL || '').trim();
  if (!raw) return '';
  try {
    const host = new URL(raw).hostname;
    const match = host.match(/^([a-z0-9]{20})\.supabase\.co$/i);
    return match && match[1] ? String(match[1]).toLowerCase() : '';
  } catch {
    return '';
  }
};

const buildPreviewDirectDsn = ({ projectRef, password }) => {
  const ref = String(projectRef || '').trim();
  const pass = String(password || '').trim();
  if (!ref || !pass) return '';
  const dsn = new URL('postgresql:');
  dsn.username = 'postgres';
  dsn.password = pass;
  dsn.hostname = `db.${ref}.supabase.co`;
  dsn.port = '5432';
  dsn.pathname = '/postgres';
  dsn.searchParams.set('sslmode', 'require');
  return dsn.toString();
};

const isRetryableFetchError = (err) => {
  const message = (err && err.message) || String(err || '');
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|aborted|aborterror|timed out/i.test(
    message,
  );
};

const isRetryableIterationError = (err) => {
  const message = String((err && err.message) || err || '');
  return /lease_label_jobs_by_ids_compact missing rows|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|status 5\d\d/i.test(
    message,
  );
};

async function fetchWithRetry(url, options, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const timeoutMsRaw = Number(options?.timeoutMs);
    const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 25000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      if (response.status >= 500 && response.status <= 599 && attempt < attempts) {
        const delayMs = Math.min(500 * 2 ** (attempt - 1), 4000) + Math.floor(Math.random() * 100);
        await sleep(delayMs);
        continue;
      }
      return response;
    } catch (err) {
      const maybeTimeoutError =
        err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')))
          ? new Error(`request timed out after ${timeoutMs}ms`)
          : err;
      lastError = maybeTimeoutError;
      if (!isRetryableFetchError(err) || attempt === attempts) {
        throw maybeTimeoutError;
      }
      const delayMs = Math.min(500 * 2 ** (attempt - 1), 4000) + Math.floor(Math.random() * 100);
      await sleep(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('fetch failed');
}

const resolveServiceRoleKey = () =>
  ENV.SUPABASE_SECRET_KEY ||
  ENV.SUPABASE_SERVICE_ROLE_KEY ||
  ENV.SERVICE_ROLE_KEY ||
  ENV.SUPABASE_SERVICE_KEY ||
  '';

const resolveLabelRendererAuth = () =>
  ENV.LABEL_RENDERER_BENCHMARK_AUTH_JWT || ENV.LABEL_RENDERER_DB_JWT || ENV.LABEL_RENDERER_TOKEN || '';

async function createSignedWorkflowOutputUrl({
  bucket,
  filePath,
  expiresSeconds,
}) {
  const serviceRoleKey = resolveServiceRoleKey();
  const base = String(ENV.SUPABASE_URL || '').replace(/\/$/, '');
  if (!serviceRoleKey || !base || !bucket || !filePath) {
    throw new Error('Missing configuration for workflow output signing');
  }
  const response = await fetchWithRetry(
    `${base}/storage/v1/object/sign/${encodeURIComponent(bucket)}`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expiresIn: expiresSeconds,
        paths: [filePath],
      }),
    },
  );
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = parsed?.error || parsed?.message || text || `status ${response.status}`;
    throw new Error(`Failed to create signed workflow output URL: ${message}`);
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  let signedUrl = entry?.signedURL || entry?.signedUrl || entry?.url || '';
  if (signedUrl && signedUrl.startsWith('/')) {
    signedUrl = `${base}/storage/v1${signedUrl}`;
  } else if (signedUrl && !/^https?:\/\//i.test(signedUrl)) {
    signedUrl = `${base}/storage/v1/${String(signedUrl).replace(/^\/+/, '')}`;
  }
  if (!signedUrl) {
    throw new Error('Signed workflow output URL missing');
  }
  return {
    signedUrl,
    expiresAt: entry?.expires_at || entry?.expiration || null,
  };
}

async function ensureStorageBucketViaApi({ labelBucket, serviceRoleKey }) {
  const base = String(ENV.SUPABASE_URL || '').replace(/\/$/, '');
  const response = await fetchWithRetry(`${base}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: labelBucket, public: false }),
  });

  const text = await response.text();
  const ok =
    [200, 409].includes(response.status) ||
    (response.status === 400 && text.includes('Duplicate'));
  if (!ok) {
    throw new Error(`Failed to ensure bucket ${labelBucket}: ${response.status} ${text}`);
  }
}

async function ensureStorageBucket({ client, labelBucket, serviceRoleKey, logPrefix }) {
  try {
    await client.query(
      `
        INSERT INTO storage.buckets (id, name, public)
        VALUES ($1::text, $1::text, false)
        ON CONFLICT (id) DO UPDATE
        SET public = EXCLUDED.public
      `,
      [labelBucket],
    );
    return;
  } catch (dbErr) {
    const dbMessage = dbErr instanceof Error ? dbErr.message : String(dbErr || 'unknown error');
    console.error(
      `[${logPrefix}] DB bucket ensure failed for ${labelBucket}; trying storage API fallback: ${dbMessage}`,
    );
  }

  await ensureStorageBucketViaApi({ labelBucket, serviceRoleKey });
}

async function callLabelRendererPrintSync({
  organizationId,
  shipmentId,
  boxIds,
  shipments,
  outputName,
  expiresSeconds,
  labelRendererAuth,
  apiKey,
  requestTimeoutMs,
}) {
  const base = String(ENV.SUPABASE_URL || '').replace(/\/$/, '');
  const normalizedShipments = Array.isArray(shipments)
    ? shipments
        .map((entry) => ({
          shipment_id: String(entry?.shipment_id || '').trim(),
          box_ids: Array.isArray(entry?.box_ids)
            ? entry.box_ids.map((boxId) => String(boxId || '').trim()).filter(Boolean)
            : [],
        }))
        .filter((entry) => entry.shipment_id && entry.box_ids.length > 0)
    : [];
  const requestShipments =
    normalizedShipments.length > 0
      ? normalizedShipments
      : [
          {
            shipment_id: shipmentId,
            box_ids: boxIds,
          },
        ];
  const response = await fetchWithRetry(`${base}/functions/v1/label-renderer`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${labelRendererAuth}`,
      apikey: apiKey,
    },
    body: JSON.stringify({
      mode: 'print',
      organization_id: organizationId,
      shipments: requestShipments,
      output_name: outputName,
      expires_seconds: expiresSeconds,
    }),
    timeoutMs: requestTimeoutMs,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const err = new Error(`print_sync failed: ${response.status} ${body}`);
    err.status = response.status;
    err.payload = payload;
    const retryableBody = `${body}`.toLowerCase();
    err.retryable =
      response.status === 500 &&
      retryableBody.includes('lease_label_jobs_by_ids_compact missing rows');
    throw err;
  }
  return payload;
}

async function callLabelRendererPrintSyncWithRetry(params, { attempts = 8, logPrefix } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await callLabelRendererPrintSync(params);
    } catch (err) {
      lastError = err;
      const retryable = Boolean(err && err.retryable);
      if (!retryable || attempt === attempts) {
        throw err;
      }
      const delayMs = Math.min(300 * 2 ** (attempt - 1), 3000) + Math.floor(Math.random() * 150);
      console.error(
        `[${logPrefix}] print_sync retry ${attempt}/${attempts} after transient lease miss; waiting ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError || new Error('print_sync failed');
}

async function prepareFixture({
  client,
  shipmentCount,
  boxesPerShipment,
  userType = 'ops_admin',
  labelPrintPolicyOverride = null,
}) {
  const labelProviderSecret = resolveLabelRendererAuth();
  const organizationId = randomUUID();
  const clientId = randomUUID();
  const addressId = randomUUID();
  const userId = randomUUID();
  const safeShipmentCount = Math.max(1, Number.parseInt(String(shipmentCount || 1), 10) || 1);
  const safeBoxesPerShipment = Math.max(1, Number.parseInt(String(boxesPerShipment || 1), 10) || 1);

  await client.query(
    `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
     VALUES ($1::uuid, 'Print Sync Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
    [organizationId, `print-sync-org-${organizationId.slice(0, 8)}`],
  );
  await client.query(
    `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
     VALUES ($1::uuid, $2::uuid, 'Print Sync Client', $3, 'standard', 'active')`,
    [clientId, organizationId, `print-sync-client-${clientId.slice(0, 8)}`],
  );
  await client.query(
    `INSERT INTO addresses (
       id, organization_id, client_id, raw_input, city, province, country, validation_status
     )
     VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       'Print Sync Address', 'Riyadh', 'Riyadh', 'SA', 'pending'
     )`,
    [addressId, organizationId, clientId],
  );
  await client.query(
    `INSERT INTO users (
       id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id
     )
     VALUES (
       $1::uuid, $2::uuid, $3, 'Benchmark User', $4, 'active', 'tenant', NULL
    )`,
    [userId, organizationId, `bench-${userId.slice(0, 8)}@example.com`, userType],
  );

  await upsertSettings(
    'label_provider',
    'tenant',
    organizationId,
    {
      providers: [
        {
          name: 'internal_renderer',
          invoke_url: `${ENV.SUPABASE_URL}/functions/v1/label-renderer`,
          invoke_secret: labelProviderSecret,
          timeout_ms: 20000,
        },
      ],
    },
    'benchmark fixture label_provider override',
    client,
  );

  if (labelPrintPolicyOverride && typeof labelPrintPolicyOverride === 'object') {
    await upsertSettings(
      'label_print_policy',
      'tenant',
      organizationId,
      labelPrintPolicyOverride,
      'benchmark fixture label_print_policy override',
      client,
    );
  }

  const shipments = [];
  for (let shipmentIndex = 0; shipmentIndex < safeShipmentCount; shipmentIndex += 1) {
    const shipmentId = randomUUID();
    const trackingNumber = `DLX${shipmentId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    await client.query(
      `INSERT INTO shipments (
         id, organization_id, client_id, service_type, tracking_number, status,
         box_count, origin_address_id, destination_address_id, created_at, updated_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'delivery', $4, 'pending',
         $5, $6::uuid, $6::uuid, now(), now()
       )`,
      [shipmentId, organizationId, clientId, trackingNumber, safeBoxesPerShipment, addressId],
    );

    const { rows: boxRows } = await client.query(
      `INSERT INTO shipment_boxes (
         id, shipment_id, organization_id, client_id, box_number, barcode, created_at
       )
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, gs, $4 || ':' || gs, now()
         FROM generate_series(1, $5::int) AS gs
       RETURNING id`,
      [shipmentId, organizationId, clientId, trackingNumber, safeBoxesPerShipment],
    );

    shipments.push({
      shipmentId,
      boxIds: boxRows.map((row) => row.id),
    });
  }

  return {
    organizationId,
    clientId,
    addressId,
    userId,
    shipments,
    shipmentIds: shipments.map((entry) => entry.shipmentId),
    shipmentPayload: shipments.map((entry) => ({
      shipment_id: entry.shipmentId,
      box_ids: entry.boxIds,
    })),
  };
}

async function cleanupFixture({
  client,
  fixture,
  labelBucket,
  serviceRoleKey,
  outputPaths,
  keepObject,
}) {
  try {
    const paths = Array.from(
      new Set(
        (Array.isArray(outputPaths) ? outputPaths : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    );
    if (!keepObject && paths.length > 0) {
      await removeStoragePaths(
        {
          supabaseUrl: ENV.SUPABASE_URL,
          serviceRoleKey,
          bucket: labelBucket,
          paths,
        },
        { bestEffort: true },
      );
    }

    const shipmentIds = Array.isArray(fixture?.shipmentIds) ? fixture.shipmentIds : [];
    if (shipmentIds.length > 0) {
      await client.query(`DELETE FROM labels WHERE shipment_id = ANY($1::uuid[])`, [shipmentIds]);
      await client.query(`DELETE FROM label_jobs WHERE shipment_id = ANY($1::uuid[])`, [shipmentIds]);
      await client.query(`DELETE FROM shipment_actions WHERE shipment_id = ANY($1::uuid[])`, [shipmentIds]);
      await client.query(`DELETE FROM shipment_boxes WHERE shipment_id = ANY($1::uuid[])`, [shipmentIds]);
      await client.query(`DELETE FROM shipments WHERE id = ANY($1::uuid[])`, [shipmentIds]);
    }
    if (fixture?.userId) {
      await client.query(`DELETE FROM rbac_user_role_assignments WHERE user_id = $1::uuid`, [fixture.userId]);
      await client.query(`DELETE FROM users WHERE id = $1::uuid`, [fixture.userId]);
    }
    await client.query(`DELETE FROM addresses WHERE id = $1::uuid`, [fixture.addressId]);
    await client.query(`DELETE FROM clients WHERE id = $1::uuid`, [fixture.clientId]);
    await client.query(`DELETE FROM decision_log WHERE organization_id = $1::uuid`, [fixture.organizationId]);
    await client.query(`DELETE FROM settings_resolution_log WHERE organization_id = $1::uuid`, [fixture.organizationId]);
    await client.query(`DELETE FROM organizations WHERE id = $1::uuid`, [fixture.organizationId]);
  } catch {
    // Best-effort cleanup only.
  }
}

const extractOutputPath = (payload) =>
  String(
    payload?.bundle?.output_file_url ||
      payload?.bundle?.file_path ||
      payload?.bundle?.file_url ||
      '',
  ).trim();

async function selectDbConnection({ logPrefix }) {
  const projectRef = inferProjectRefFromSupabaseUrl();
  const previewDirectDsn = buildPreviewDirectDsn({
    projectRef,
    password: ENV.PREVIEW_SUPABASE_DB_PASSWORD,
  });

  const rawDbCandidates = [];
  if (String(ENV.DATABASE_URL || '').trim()) {
    rawDbCandidates.push({ name: 'DATABASE_URL', dsn: String(ENV.DATABASE_URL).trim() });
  }
  if (String(ENV.DATABASE_URL_DIRECT || '').trim()) {
    rawDbCandidates.push({ name: 'DATABASE_URL_DIRECT', dsn: String(ENV.DATABASE_URL_DIRECT).trim() });
  }
  if (String(ENV.BENCHMARK_DATABASE_URL || '').trim()) {
    rawDbCandidates.push({ name: 'BENCHMARK_DATABASE_URL', dsn: String(ENV.BENCHMARK_DATABASE_URL).trim() });
  }
  if (String(ENV.BENCHMARK_DATABASE_URL_DIRECT || '').trim()) {
    rawDbCandidates.push({
      name: 'BENCHMARK_DATABASE_URL_DIRECT',
      dsn: String(ENV.BENCHMARK_DATABASE_URL_DIRECT).trim(),
    });
  }
  if (previewDirectDsn) {
    rawDbCandidates.push({
      name: 'PREVIEW_SUPABASE_DB_PASSWORD+SUPABASE_URL',
      dsn: previewDirectDsn,
    });
  }
  if (rawDbCandidates.length === 0) {
    throw new Error('Missing database connection candidates (DATABASE_URL or preview-derived DSN).');
  }

  const dbCandidates = await buildDbConnectionCandidates(rawDbCandidates, { projectRef });
  if (!Array.isArray(dbCandidates) || dbCandidates.length === 0) {
    throw new Error('Failed to build database connection candidates.');
  }

  console.error(
    `[${logPrefix}] DB candidate ladder: ${dbCandidates
      .map((candidate) => String(candidate?.name || '').trim())
      .filter(Boolean)
      .join(' -> ')}`,
  );

  const errors = [];
  for (const candidate of dbCandidates) {
    const connectionString = String(candidate?.dsn || '').trim();
    if (!connectionString) continue;
    const pool = new Pool({ connectionString });
    try {
      const client = await pool.connect();
      return { pool, client, dbCandidate: String(candidate?.name || 'unknown') };
    } catch (err) {
      errors.push(`${String(candidate?.name || 'unknown')}: ${err?.message || err}`);
      await pool.end().catch(() => {});
    }
  }

  throw new Error(`Unable to connect to database via candidate ladder: ${errors.join(' | ')}`);
}

function assertRequiredEnv(logPrefix) {
  const labelRendererAuth = resolveLabelRendererAuth();
  const serviceRoleKey = resolveServiceRoleKey();

  const required = {
    SUPABASE_URL: ENV.SUPABASE_URL,
    SUPABASE_ANON_KEY: ENV.SUPABASE_ANON_KEY,
    labelRendererAuth,
    serviceRoleKey,
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      throw new Error(`[${logPrefix}] Missing ${key} in ENV_FILE`);
    }
  }

  const authRole = getJwtRole(labelRendererAuth);
  const requireDbJwt = String(process.env.EDGE_REQUIRE_DB_JWT || '1').trim() === '1';
  const allowedRoles = requireDbJwt
    ? new Set(['edge_label_renderer_role'])
    : new Set(['edge_label_renderer_role', 'service_role']);
  if (!allowedRoles.has(authRole)) {
    throw new Error(
      `[${logPrefix}] label-renderer auth token must be role JWT (${Array.from(allowedRoles).join(
        ' | ',
      )}); got role=${authRole || 'missing'}`,
    );
  }

  return { labelRendererAuth, serviceRoleKey };
}

async function runDownloadLatencyScenario({
  client,
  labelBucket,
  expiresSeconds,
  iterations,
  shipmentCount,
  boxesPerShipment,
  cleanup,
  keepObject,
  targetDownloadMs,
  logPrefix,
  labelRendererAuth,
  apiKey,
  serviceRoleKey,
  requestTimeoutMs,
  printSyncRetryAttempts,
}) {
  const firstRequestSamples = [];
  const secondRequestSamples = [];
  const firstFunctionTotalSamples = [];
  const secondFunctionTotalSamples = [];
  const firstEdgeOverheadSamples = [];
  const secondEdgeOverheadSamples = [];
  const iterationsDetail = [];
  const transientRetries = [];
  const firstStageDurations = new Map();
  const secondStageDurations = new Map();

  for (let index = 0; index < iterations; index += 1) {
    const iterationMaxAttempts = 3;
    let iterationComplete = false;
    for (let attempt = 1; attempt <= iterationMaxAttempts; attempt += 1) {
      const fixture = await prepareFixture({
        client,
        shipmentCount,
        boxesPerShipment,
      });
      const outputPaths = [];
      try {
        const coldOutputName = `print_sync_cold_${index + 1}_${Date.now()}.pdf`;
        const coldStartedAtMs = Date.now();
        const coldPayload = await callLabelRendererPrintSyncWithRetry(
          {
            organizationId: fixture.organizationId,
            shipments: fixture.shipmentPayload,
            outputName: coldOutputName,
            expiresSeconds,
            labelRendererAuth,
            apiKey,
            requestTimeoutMs,
          },
          { attempts: printSyncRetryAttempts, logPrefix },
        );
        const coldApiMs = Date.now() - coldStartedAtMs;
        const coldTotalMs = parseFloatSafe(coldPayload?.timings?.total_ms);
        const coldEdgeOverheadMs =
          Number.isFinite(coldTotalMs) && coldTotalMs !== null
            ? Number(Math.max(0, coldApiMs - coldTotalMs).toFixed(2))
            : null;
        const coldOutputPath = extractOutputPath(coldPayload);
        const coldStepDurations = extractStepDurations(coldPayload);
        if (coldOutputPath) outputPaths.push(coldOutputPath);

        const warmOutputName = `print_sync_warm_${index + 1}_${Date.now()}.pdf`;
        const warmStartedAtMs = Date.now();
        const warmPayload = await callLabelRendererPrintSyncWithRetry(
          {
            organizationId: fixture.organizationId,
            shipments: fixture.shipmentPayload,
            outputName: warmOutputName,
            expiresSeconds,
            labelRendererAuth,
            apiKey,
            requestTimeoutMs,
          },
          { attempts: printSyncRetryAttempts, logPrefix },
        );
        const warmApiMs = Date.now() - warmStartedAtMs;
        const warmTotalMs = parseFloatSafe(warmPayload?.timings?.total_ms);
        const warmEdgeOverheadMs =
          Number.isFinite(warmTotalMs) && warmTotalMs !== null
            ? Number(Math.max(0, warmApiMs - warmTotalMs).toFixed(2))
            : null;
        const warmOutputPath = extractOutputPath(warmPayload);
        const warmStepDurations = extractStepDurations(warmPayload);
        if (warmOutputPath) outputPaths.push(warmOutputPath);

        if (coldOutputPath && warmOutputPath && coldOutputPath === warmOutputPath) {
          throw new Error(
            `fresh_label_regeneration_required: warm output matched cold output path (${warmOutputPath})`,
          );
        }

        firstRequestSamples.push(coldApiMs);
        secondRequestSamples.push(warmApiMs);
        if (coldTotalMs !== null) firstFunctionTotalSamples.push(coldTotalMs);
        if (warmTotalMs !== null) secondFunctionTotalSamples.push(warmTotalMs);
        if (coldEdgeOverheadMs !== null) firstEdgeOverheadSamples.push(coldEdgeOverheadMs);
        if (warmEdgeOverheadMs !== null) secondEdgeOverheadSamples.push(warmEdgeOverheadMs);
        appendStageDurations(firstStageDurations, coldStepDurations);
        appendStageDurations(secondStageDurations, warmStepDurations);
        iterationsDetail.push({
          iteration: index + 1,
          first_request: {
            click_to_download_start_ms: coldApiMs,
            api_ms: coldApiMs,
            renderer_total_ms: coldTotalMs,
            function_total_ms: coldTotalMs,
            edge_overhead_ms: coldEdgeOverheadMs,
            stage_transport_ms: coldEdgeOverheadMs,
            classification: coldApiMs <= targetDownloadMs ? 'hit' : 'miss',
            step_durations_ms: coldStepDurations,
          },
          second_request: {
            click_to_download_start_ms: warmApiMs,
            api_ms: warmApiMs,
            renderer_total_ms: warmTotalMs,
            function_total_ms: warmTotalMs,
            edge_overhead_ms: warmEdgeOverheadMs,
            stage_transport_ms: warmEdgeOverheadMs,
            classification: warmApiMs <= targetDownloadMs ? 'hit' : 'miss',
            step_durations_ms: warmStepDurations,
          },
        });

        iterationComplete = true;
      } catch (err) {
        const message = String((err && err.message) || err || 'unknown benchmark error');
        const retryable = isRetryableIterationError(err);
        transientRetries.push({
          iteration: index + 1,
          attempt,
          retryable,
          error: message,
        });
        if (!retryable || attempt >= iterationMaxAttempts) {
          throw err;
        }
        const delayMs = Math.min(300 * 2 ** (attempt - 1), 2000);
        console.error(
          `[${logPrefix}] iteration ${index + 1} retry ${attempt}/${iterationMaxAttempts} after transient error: ${message}; waiting ${delayMs}ms`,
        );
        await sleep(delayMs);
      } finally {
        if (cleanup) {
          await cleanupFixture({
            client,
            fixture,
            labelBucket,
            serviceRoleKey,
            outputPaths,
            keepObject,
          });
        }
      }
      if (iterationComplete) break;
    }
  }

  return {
    retries: transientRetries,
    metrics: {
      first_request: summarize(firstRequestSamples, targetDownloadMs),
      second_request: summarize(secondRequestSamples, targetDownloadMs),
      ready_label: summarize(secondRequestSamples, targetDownloadMs),
      first_request_function_total: summarizeDurations(firstFunctionTotalSamples),
      second_request_function_total: summarizeDurations(secondFunctionTotalSamples),
      first_request_edge_overhead: summarizeDurations(firstEdgeOverheadSamples),
      second_request_edge_overhead: summarizeDurations(secondEdgeOverheadSamples),
      stage_duration_ms: {
        first_request: summarizeStageMap(firstStageDurations),
        second_request: summarizeStageMap(secondStageDurations),
      },
    },
    samples: iterationsDetail,
  };
}

async function runSyncScenario({
  client,
  labelBucket,
  expiresSeconds,
  count,
  outputName,
  pollSeconds,
  cleanup,
  keepObject,
  labelRendererAuth,
  apiKey,
  serviceRoleKey,
  requestTimeoutMs,
  printSyncRetryAttempts,
}) {
  let fixture = null;
  let payload = null;
  const runStart = Date.now();
  try {
    fixture = await prepareFixture({
      client,
      shipmentCount: 1,
      boxesPerShipment: count,
    });

    const apiStart = Date.now();
    payload = await callLabelRendererPrintSyncWithRetry(
      {
        organizationId: fixture.organizationId,
        shipments: fixture.shipmentPayload,
        outputName,
        expiresSeconds,
        labelRendererAuth,
        apiKey,
        requestTimeoutMs,
      },
      { attempts: printSyncRetryAttempts, logPrefix: 'labels-print-sync-benchmark' },
    );
    const apiMs = Date.now() - apiStart;

    const signedUrl = payload?.bundle?.signed_url;
    if (!signedUrl) {
      throw new Error(`print_sync missing bundle.signed_url: ${JSON.stringify(payload)}`);
    }

    const { rows: metaRows } = await client.query(
      `SELECT
         COUNT(*)::int AS job_count,
         COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_count,
         MAX(COALESCE((renderer_metadata->>'template_version')::int, (renderer_metadata->>'templateVersion')::int)) AS template_version,
         MAX(COALESCE(renderer_metadata->>'barcode_mode', renderer_metadata->>'barcodeMode')) AS barcode_mode
       FROM label_jobs
       WHERE shipment_id = ANY($1::uuid[])`,
      [fixture.shipmentIds],
    );

    const checks = metaRows[0] || {};
    const summary = {
      ok: true,
      run: {
        started_at: payload.started_at || new Date(runStart).toISOString(),
        completed_at: payload.completed_at || new Date().toISOString(),
        api_call_ms: apiMs,
        total_wall_ms: Date.now() - runStart,
        total_ms: payload?.timings?.total_ms ?? null,
      },
      checks: {
        job_count: checks.job_count ?? null,
        succeeded_count: checks.succeeded_count ?? null,
        template_version: checks.template_version ?? null,
        barcode_mode: checks.barcode_mode ?? null,
      },
      bundle: {
        signed_url: signedUrl,
        expires_at: payload?.bundle?.expires_at ?? null,
        output_file_url: payload?.bundle?.output_file_url ?? null,
        counts: payload?.bundle?.counts ?? null,
        timings: payload?.bundle?.timings ?? null,
      },
      steps: payload.steps ?? null,
    };

    if (pollSeconds > 0) {
      console.log(`[labels-print-sync-benchmark] Sleeping ${pollSeconds}s before exit...`);
      await sleep(pollSeconds * 1000);
    }

    return summary;
  } finally {
    if (cleanup && fixture) {
      const outputPath = extractOutputPath(payload);
      await cleanupFixture({
        client,
        fixture,
        labelBucket,
        serviceRoleKey,
        outputPaths: outputPath ? [outputPath] : [],
        keepObject,
      });
    }
  }
}

async function withAuthenticatedUser(client, userId, fn) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    throw new Error('withAuthenticatedUser requires userId');
  }
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE authenticated');
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1::text, true)`, [normalizedUserId]);
    await client.query(`SELECT set_config('request.jwt.claims', $1::text, true)`, [
      JSON.stringify({
        role: 'authenticated',
        sub: normalizedUserId,
      }),
    ]);
    const output = await fn(client);
    await client.query('COMMIT');
    return output;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function resolvePrintWorkflowContract({
  client,
  organizationId,
  actionKey,
  targetDownloadMs,
  workflowPollTimeoutMs,
  workflowStartOverride = null,
}) {
  const { rows } = await client.query(
    `SELECT public.resolve_settings_merged(
       'ui_command_registry',
       'tenant',
       $1::uuid
     ) AS registry`,
    [organizationId],
  );
  const contract = rows?.[0]?.registry ?? {};

  const commands = Array.isArray(contract?.commands) ? contract.commands : [];
  const command = commands.find((entry) => String(entry?.key || '') === actionKey) || null;
  if (!command) {
    throw new Error(`Missing command contract for action=${actionKey}`);
  }
  const execution = command && typeof command.execution === 'object' ? command.execution : {};
  const params = execution && typeof execution.params === 'object' ? execution.params : {};

  const outputUrlPaths = Array.isArray(params.output_url_paths)
    ? params.output_url_paths.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (outputUrlPaths.length === 0) {
    throw new Error(`Invalid print command contract for ${actionKey}: output_url_paths missing`);
  }

  const pollScheduleMs = Array.isArray(params.poll_schedule_ms)
    ? params.poll_schedule_ms
        .map((value) => Number.parseInt(String(value || ''), 10))
        .filter((value) => Number.isFinite(value) && value > 0)
    : [];
  if (pollScheduleMs.length === 0) {
    throw new Error(`Invalid print command contract for ${actionKey}: poll_schedule_ms missing`);
  }

  const fallbackMode = String(params.fallback_mode || '').trim().toLowerCase();
  if (fallbackMode !== 'none') {
    throw new Error(`Invalid print command contract for ${actionKey}: fallback_mode must be none`);
  }
  if (!Object.prototype.hasOwnProperty.call(params, 'poll_progress_enabled')) {
    throw new Error(`Invalid print command contract for ${actionKey}: poll_progress_enabled missing`);
  }
  if (!Object.prototype.hasOwnProperty.call(params, 'poll_progress_budget_ms')) {
    throw new Error(`Invalid print command contract for ${actionKey}: poll_progress_budget_ms missing`);
  }
  if (!Object.prototype.hasOwnProperty.call(params, 'poll_progress_max_steps')) {
    throw new Error(`Invalid print command contract for ${actionKey}: poll_progress_max_steps missing`);
  }

  const pollIntervalMs = Math.max(1, parseNumber(params.poll_interval_ms, 100));
  const contractPollTimeoutMs = Math.max(1000, parseNumber(params.poll_timeout_ms, 45000));
  const pollProgressEnabled = parseBooleanFlag(params.poll_progress_enabled, false);
  const pollProgressBudgetMs = Math.max(
    25,
    Math.min(5000, parseNumber(params.poll_progress_budget_ms, 250)),
  );
  const pollProgressMaxSteps = Math.max(
    1,
    Math.min(50, parseNumber(params.poll_progress_max_steps, 3)),
  );
  const effectivePollTimeoutMs =
    workflowPollTimeoutMs === null
      ? contractPollTimeoutMs
      : Math.max(1000, Math.min(180000, workflowPollTimeoutMs));
  const contractTargetDownloadMs = Math.max(
    1,
    parseNumber(params.target_download_ms, targetDownloadMs),
  );
  const effectiveParams =
    params && typeof params === 'object'
      ? JSON.parse(JSON.stringify(params))
      : {};
  const workflowStartBase =
    effectiveParams.workflow_start && typeof effectiveParams.workflow_start === 'object'
      ? effectiveParams.workflow_start
      : {};
  if (workflowStartOverride && typeof workflowStartOverride === 'object') {
    effectiveParams.workflow_start = {
      ...workflowStartBase,
      ...workflowStartOverride,
    };
  }
  const workflowStart =
    effectiveParams.workflow_start && typeof effectiveParams.workflow_start === 'object'
      ? effectiveParams.workflow_start
      : {};

  return {
    commandParams: effectiveParams,
    outputUrlPaths,
    pollScheduleMs,
    pollIntervalMs,
    pollTimeoutMs: effectivePollTimeoutMs,
    pollProgressEnabled,
    pollProgressBudgetMs,
    pollProgressMaxSteps,
    targetDownloadMs: contractTargetDownloadMs,
    workflowStart,
    fallbackMode,
    autoDownload: parseBooleanFlag(params.auto_download, false),
  };
}

async function executePrintWorkflowCommand({
  client,
  userId,
  actionKey,
  resourceKey,
  selectionIds,
  commandParams,
}) {
  const payload = await withAuthenticatedUser(client, userId, async (authClient) => {
    const rpcPayload =
      commandParams && typeof commandParams === 'object'
        ? commandParams
        : {};
    const { rows } = await authClient.query(
      `SELECT api.ui_execute_command_v1(
         $1::text,
         $2::text,
         $3::text[],
         NULL,
         $4::integer,
         $5::jsonb
       ) AS payload`,
      [
        actionKey,
        resourceKey,
        selectionIds.map((entry) => String(entry || '').trim()).filter(Boolean),
        selectionIds.length,
        JSON.stringify(rpcPayload),
      ],
    );
    return rows?.[0]?.payload ?? null;
  });

  if (!payload || typeof payload !== 'object') {
    throw new Error('ui_execute_command_v1 returned empty payload');
  }
  const workflowRunId = String(payload.workflow_run_id || '').trim();
  if (!workflowRunId) {
    throw new Error(`ui_execute_command_v1 missing workflow_run_id: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function fetchWorkflowOutputStatus({
  client,
  userId,
  workflowRunId,
  outputUrlPaths,
}) {
  return withAuthenticatedUser(client, userId, async (authClient) => {
    const { rows } = await authClient.query(
      `SELECT api.ui_get_workflow_run_output_status_v1($1::uuid, $2::text[]) AS payload`,
      [workflowRunId, outputUrlPaths],
    );
    return rows?.[0]?.payload ?? null;
  });
}

async function pollWorkflowOutput({
  client,
  userId,
  workflowRunId,
  outputUrlPaths,
  pollScheduleMs,
  pollIntervalMs,
  pollTimeoutMs,
  pollProgressEnabled,
  pollProgressBudgetMs,
  pollProgressMaxSteps,
  startedAtMs,
  allowTerminalFailure = false,
}) {
  const schedule = Array.isArray(pollScheduleMs) && pollScheduleMs.length > 0 ? pollScheduleMs : [pollIntervalMs];
  const startMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  const timeoutAt = startMs + Math.max(1000, pollTimeoutMs);
  let firstStatusAtMs = null;
  let lastStatus = null;
  let attempt = 0;
  let completedNoOutputGraceCount = 0;
  const completedNoOutputGraceMax = 4;

  while (Date.now() <= timeoutAt) {
    const status = await fetchWorkflowOutputStatus({
      client,
      userId,
      workflowRunId,
      outputUrlPaths,
    });
    const nowMs = Date.now();
    lastStatus = status && typeof status === 'object' ? status : null;
    if (firstStatusAtMs === null) {
      firstStatusAtMs = nowMs;
    }

    const outputUrl = String(lastStatus?.output_url || '').trim();
    const outputFilePath = String(lastStatus?.output_file_path || '').trim();
    const outputBucket = String(lastStatus?.output_bucket || '').trim() || 'labels';
    const pollProgressManaged = parseBooleanFlag(lastStatus?.poll_progress_managed, false);
    const outputReady =
      Boolean(lastStatus?.output_ready) ||
      /^https?:\/\//i.test(outputUrl) ||
      outputFilePath.length > 0;
    const workflowStatus = String(lastStatus?.workflow_status || '').trim().toLowerCase();
    const terminal = Boolean(lastStatus?.terminal) || ['completed', 'failed', 'cancelled'].includes(workflowStatus);

    if (outputReady && outputUrl) {
      return {
        status: lastStatus,
        firstStatusAtMs,
        outputReadyAtMs: nowMs,
      };
    }

    if (outputReady && !outputUrl && outputFilePath) {
      const signed = await createSignedWorkflowOutputUrl({
        bucket: outputBucket,
        filePath: outputFilePath,
        expiresSeconds: 900,
      });
      lastStatus = {
        ...lastStatus,
        output_url: signed.signedUrl,
        output_source: lastStatus?.output_source || 'workflow_output_sign',
      };
      return {
        status: lastStatus,
        firstStatusAtMs,
        outputReadyAtMs: nowMs,
      };
    }

    if (terminal) {
      const failureReason = String(lastStatus?.failure_reason || '').trim();
      if (
        workflowStatus === 'completed' &&
        !failureReason &&
        completedNoOutputGraceCount < completedNoOutputGraceMax
      ) {
        completedNoOutputGraceCount += 1;
        const graceDelayMs = schedule[Math.min(attempt, schedule.length - 1)] ?? pollIntervalMs;
        attempt += 1;
        await sleep(Math.max(1, graceDelayMs));
        continue;
      }
      if (allowTerminalFailure) {
        return {
          status: lastStatus,
          firstStatusAtMs,
          outputReadyAtMs: null,
          terminalFailure: true,
          failureReason: failureReason || `workflow_status=${workflowStatus || 'unknown'}`,
        };
      }
      throw new Error(
        `workflow run ${workflowRunId} reached terminal status ${workflowStatus || 'unknown'} without output (${failureReason || 'no reason'})`,
      );
    }

    try {
      if (pollProgressEnabled && !pollProgressManaged) {
        await client.query(
          `SELECT public.progress_workflow_run_until_wait_v1($1::uuid, $2::jsonb, $3::int, $4::int)`,
          [
            workflowRunId,
            { source: 'labels_print_workflow_benchmark_poll' },
            pollProgressBudgetMs,
            pollProgressMaxSteps,
          ],
        );
      } else {
        await client.query(`SELECT public.progress_workflow_run($1::uuid)`, [workflowRunId]);
      }
    } catch {
      // Best-effort tick only; status polling still determines readiness/failure.
    }

    const delayMs = schedule[Math.min(attempt, schedule.length - 1)] ?? pollIntervalMs;
    attempt += 1;
    await sleep(Math.max(1, delayMs));
  }

  throw new Error(
    `workflow output polling timed out after ${pollTimeoutMs}ms for run ${workflowRunId}; last_status=${JSON.stringify(lastStatus)}`,
  );
}

async function executeWorkflowPrintAttempt({
  client,
  userId,
  actionKey,
  resourceKey,
  shipmentIds,
  workflowContract,
  targetDownloadMs,
}) {
  const startedAtMs = Date.now();
  const commandStartedAtMs = Date.now();
  const commandPayload = await executePrintWorkflowCommand({
    client,
    userId,
    actionKey,
    resourceKey,
    selectionIds: shipmentIds,
    commandParams: workflowContract.commandParams,
  });
  const commandDurationMs = Date.now() - commandStartedAtMs;
  const workflowRunId = String(commandPayload.workflow_run_id || '').trim();
  const polled = await pollWorkflowOutput({
    client,
    userId,
    workflowRunId,
    outputUrlPaths: workflowContract.outputUrlPaths,
    pollScheduleMs: workflowContract.pollScheduleMs,
    pollIntervalMs: workflowContract.pollIntervalMs,
    pollTimeoutMs: workflowContract.pollTimeoutMs,
    pollProgressEnabled: workflowContract.pollProgressEnabled,
    pollProgressBudgetMs: workflowContract.pollProgressBudgetMs,
    pollProgressMaxSteps: workflowContract.pollProgressMaxSteps,
    startedAtMs,
    allowTerminalFailure: true,
  });

  const elapsedMs = Date.now() - startedAtMs;
  const firstStatusMs =
    polled.firstStatusAtMs === null ? null : Math.max(0, polled.firstStatusAtMs - startedAtMs);
  const outputReadyMs =
    polled.outputReadyAtMs === null ? null : Math.max(0, polled.outputReadyAtMs - startedAtMs);
  const stageTransportMs =
    outputReadyMs === null ? null : Math.max(0, Number((elapsedMs - outputReadyMs).toFixed(2)));
  const functionTotalMs = parseFloatSafe(polled.status?.function_total_ms);
  const edgeOverheadMs =
    functionTotalMs === null ? null : Math.max(0, Number((elapsedMs - functionTotalMs).toFixed(2)));
  const outputUrl = String(polled.status?.output_url || '').trim();
  const stagePrepareMs = parseFloatSafe(polled.status?.stage_prepare_ms);
  const stageExecuteMs = parseFloatSafe(polled.status?.stage_execute_ms);
  const stageEnqueueMs = parseFloatSafe(polled.status?.stage_enqueue_ms);
  const stageRenderMs = parseFloatSafe(polled.status?.stage_render_ms);
  const stageBundleMs = parseFloatSafe(polled.status?.stage_bundle_ms);
  const stageCompleteMs = parseFloatSafe(polled.status?.stage_complete_ms);
  const stageRenderWaitMs = parseFloatSafe(polled.status?.stage_render_wait_ms);
  const stageBundleWaitMs = parseFloatSafe(polled.status?.stage_bundle_wait_ms);
  const stageFinalizeMs = parseFloatSafe(polled.status?.stage_finalize_ms);
  const artifactPersisted = parseBooleanFlag(polled.status?.artifact_persisted, false);
  const jobCompletionPending = parseBooleanFlag(polled.status?.job_completion_pending, false);
  const timingSource = String(polled.status?.timing_source || '').trim() || null;
  const printMode = String(polled.status?.print_mode || '').trim() || null;
  if (printMode === 'print_sync' && stageExecuteMs === null && !timingSource) {
    throw new Error(
      `workflow status missing execute timing for run ${workflowRunId} (print_mode=print_sync)`,
    );
  }

  return {
    workflow_run_id: workflowRunId,
    click_to_download_start_ms: elapsedMs,
    api_ms: elapsedMs,
    stage_command_ms: commandDurationMs,
    stage_first_status_ms: firstStatusMs,
    stage_output_ready_ms: outputReadyMs,
    stage_transport_ms: stageTransportMs,
    stage_prepare_ms: stagePrepareMs,
    stage_execute_ms: stageExecuteMs,
    stage_enqueue_ms: stageEnqueueMs,
    stage_render_ms: stageRenderMs,
    stage_bundle_ms: stageBundleMs,
    stage_complete_ms: stageCompleteMs,
    stage_render_wait_ms: stageRenderWaitMs,
    stage_bundle_wait_ms: stageBundleWaitMs,
    stage_finalize_ms: stageFinalizeMs,
    artifact_persisted: artifactPersisted,
    job_completion_pending: jobCompletionPending,
    timing_source: timingSource,
    function_total_ms: functionTotalMs,
    edge_overhead_ms: edgeOverheadMs,
    output_source: String(polled.status?.output_source || '').trim() || null,
    print_mode: printMode,
    artifact_kind: String(polled.status?.artifact_kind || '').trim() || null,
    phase: String(polled.status?.phase || '').trim() || null,
    fresh_expected_count: parseIntegerSafe(polled.status?.fresh_expected_count),
    fresh_ready_count: parseIntegerSafe(polled.status?.fresh_ready_count),
    fresh_failed_count: parseIntegerSafe(polled.status?.fresh_failed_count),
    fresh_bundle_requested_count: parseIntegerSafe(polled.status?.fresh_bundle_requested_count),
    fresh_bundle_bundled_count: parseIntegerSafe(polled.status?.fresh_bundle_bundled_count),
    fresh_bundle_request_label_count: parseIntegerSafe(polled.status?.fresh_bundle_request_label_count),
    terminal_failure: Boolean(polled.terminalFailure),
    failure_reason: String(polled.failureReason || polled.status?.failure_reason || '').trim() || null,
    output_url: outputUrl || null,
    output_artifact: normalizeOutputArtifact(outputUrl),
    classification: polled.terminalFailure ? 'failed' : elapsedMs <= targetDownloadMs ? 'hit' : 'miss',
  };
}

async function runWorkflowLatencyScenario({
  client,
  labelBucket,
  expiresSeconds,
  iterations,
  shipmentCount,
  boxesPerShipment,
  cleanup,
  keepObject,
  targetDownloadMs,
  actionKey,
  resourceKey,
  workflowUserType,
  workflowPollTimeoutMs,
  warmupSeedLabels,
  labelRendererAuth,
  apiKey,
  requestTimeoutMs,
  printSyncRetryAttempts,
  serviceRoleKey,
  labelPrintPolicyOverride,
  workflowStartOverride,
}) {
  const firstRequestSamples = [];
  const secondRequestSamples = [];
  const firstFunctionTotalSamples = [];
  const secondFunctionTotalSamples = [];
  const firstEdgeOverheadSamples = [];
  const secondEdgeOverheadSamples = [];
  const firstStageDurations = new Map();
  const secondStageDurations = new Map();
  const transientRetries = [];
  const iterationsDetail = [];

  for (let index = 0; index < iterations; index += 1) {
    const iterationMaxAttempts = 2;
    let iterationComplete = false;

    for (let attempt = 1; attempt <= iterationMaxAttempts; attempt += 1) {
      const fixture = await prepareFixture({
        client,
        shipmentCount,
        boxesPerShipment,
        userType: workflowUserType,
        labelPrintPolicyOverride,
      });
      const outputPaths = [];

      try {
        if (warmupSeedLabels) {
          const warmupPayload = await callLabelRendererPrintSyncWithRetry(
            {
              organizationId: fixture.organizationId,
              shipments: fixture.shipmentPayload,
              outputName: `workflow_seed_${index + 1}_${Date.now()}.pdf`,
              expiresSeconds,
              labelRendererAuth,
              apiKey,
              requestTimeoutMs,
            },
            { attempts: printSyncRetryAttempts, logPrefix: 'labels-print-workflow-benchmark:seed' },
          );
          const warmupPath = extractOutputPath(warmupPayload);
          if (warmupPath) {
            outputPaths.push(warmupPath);
          }
        }

        const workflowContract = await resolvePrintWorkflowContract({
          client,
          organizationId: fixture.organizationId,
          actionKey,
          targetDownloadMs,
          workflowPollTimeoutMs,
          workflowStartOverride,
        });
        const effectiveTargetDownloadMs = workflowContract.targetDownloadMs;
        const firstAttempt = await executeWorkflowPrintAttempt({
          client,
          userId: fixture.userId,
          actionKey,
          resourceKey,
          shipmentIds: fixture.shipmentIds,
          workflowContract,
          targetDownloadMs: effectiveTargetDownloadMs,
        });
        const secondAttempt = await executeWorkflowPrintAttempt({
          client,
          userId: fixture.userId,
          actionKey,
          resourceKey,
          shipmentIds: fixture.shipmentIds,
          workflowContract,
          targetDownloadMs: effectiveTargetDownloadMs,
        });

        if (
          firstAttempt.output_artifact &&
          secondAttempt.output_artifact &&
          firstAttempt.output_artifact === secondAttempt.output_artifact
        ) {
          throw new Error(
            `fresh_label_regeneration_required: warm output matched cold output path (${secondAttempt.output_artifact})`,
          );
        }

        if (firstAttempt.output_artifact) outputPaths.push(firstAttempt.output_artifact);
        if (secondAttempt.output_artifact) outputPaths.push(secondAttempt.output_artifact);

        firstRequestSamples.push(firstAttempt.click_to_download_start_ms);
        secondRequestSamples.push(secondAttempt.click_to_download_start_ms);
        if (firstAttempt.function_total_ms !== null) {
          firstFunctionTotalSamples.push(firstAttempt.function_total_ms);
        }
        if (secondAttempt.function_total_ms !== null) {
          secondFunctionTotalSamples.push(secondAttempt.function_total_ms);
        }
        if (firstAttempt.edge_overhead_ms !== null) {
          firstEdgeOverheadSamples.push(firstAttempt.edge_overhead_ms);
        }
        if (secondAttempt.edge_overhead_ms !== null) {
          secondEdgeOverheadSamples.push(secondAttempt.edge_overhead_ms);
        }

        appendStageDurations(firstStageDurations, {
          command: firstAttempt.stage_command_ms,
          first_status: firstAttempt.stage_first_status_ms,
          output_ready: firstAttempt.stage_output_ready_ms,
          transport: firstAttempt.stage_transport_ms,
          prepare: firstAttempt.stage_prepare_ms,
          execute: firstAttempt.stage_execute_ms,
          enqueue: firstAttempt.stage_enqueue_ms,
          render: firstAttempt.stage_render_ms,
          bundle: firstAttempt.stage_bundle_ms,
          complete: firstAttempt.stage_complete_ms,
          render_wait: firstAttempt.stage_render_wait_ms,
          bundle_wait: firstAttempt.stage_bundle_wait_ms,
          finalize: firstAttempt.stage_finalize_ms,
        });
        appendStageDurations(secondStageDurations, {
          command: secondAttempt.stage_command_ms,
          first_status: secondAttempt.stage_first_status_ms,
          output_ready: secondAttempt.stage_output_ready_ms,
          transport: secondAttempt.stage_transport_ms,
          prepare: secondAttempt.stage_prepare_ms,
          execute: secondAttempt.stage_execute_ms,
          enqueue: secondAttempt.stage_enqueue_ms,
          render: secondAttempt.stage_render_ms,
          bundle: secondAttempt.stage_bundle_ms,
          complete: secondAttempt.stage_complete_ms,
          render_wait: secondAttempt.stage_render_wait_ms,
          bundle_wait: secondAttempt.stage_bundle_wait_ms,
          finalize: secondAttempt.stage_finalize_ms,
        });

        iterationsDetail.push({
          iteration: index + 1,
          first_request: firstAttempt,
          second_request: secondAttempt,
          workflow_contract: {
            poll_schedule_ms: workflowContract.pollScheduleMs,
            poll_interval_ms: workflowContract.pollIntervalMs,
            poll_timeout_ms: workflowContract.pollTimeoutMs,
            poll_progress_enabled: workflowContract.pollProgressEnabled,
            poll_progress_budget_ms: workflowContract.pollProgressBudgetMs,
            poll_progress_max_steps: workflowContract.pollProgressMaxSteps,
            target_download_ms: workflowContract.targetDownloadMs,
            fallback_mode: workflowContract.fallbackMode,
            auto_download: workflowContract.autoDownload,
            workflow_start: workflowContract.workflowStart,
          },
        });
        iterationComplete = true;
      } catch (err) {
        const message = String((err && err.message) || err || 'unknown workflow benchmark error');
        const retryable = isRetryableIterationError(err);
        transientRetries.push({
          iteration: index + 1,
          attempt,
          retryable,
          error: message,
        });
        if (!retryable || attempt >= iterationMaxAttempts) {
          throw err;
        }
        const delayMs = Math.min(300 * 2 ** (attempt - 1), 2000);
        await sleep(delayMs);
      } finally {
        if (cleanup) {
          await cleanupFixture({
            client,
            fixture,
            labelBucket,
            serviceRoleKey,
            outputPaths,
            keepObject,
          });
        }
      }

      if (iterationComplete) break;
    }
  }

  return {
    retries: transientRetries,
    metrics: {
      first_request: summarize(firstRequestSamples, targetDownloadMs),
      second_request: summarize(secondRequestSamples, targetDownloadMs),
      ready_label: summarize(secondRequestSamples, targetDownloadMs),
      first_request_function_total: summarizeDurations(firstFunctionTotalSamples),
      second_request_function_total: summarizeDurations(secondFunctionTotalSamples),
      first_request_edge_overhead: summarizeDurations(firstEdgeOverheadSamples),
      second_request_edge_overhead: summarizeDurations(secondEdgeOverheadSamples),
      stage_duration_ms: {
        first_request: summarizeStageMap(firstStageDurations),
        second_request: summarizeStageMap(secondStageDurations),
      },
    },
    samples: iterationsDetail,
  };
}

async function runBenchmarkCli({ defaultScenario = 'download-latency', logPrefix = 'labels-print-workflow-benchmark' } = {}) {
  const { labelRendererAuth, serviceRoleKey } = assertRequiredEnv(logPrefix);

  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      scenario: { type: 'string' },
      'scenario-tag': { type: 'string' },
      iterations: { type: 'string' },
      shipments: { type: 'string' },
      boxes: { type: 'string' },
      'boxes-per-shipment': { type: 'string' },
      count: { type: 'string' },
      'target-download-ms': { type: 'string' },
      'expires-seconds': { type: 'string' },
      'output-name': { type: 'string' },
      'action-key': { type: 'string' },
      'resource-key': { type: 'string' },
      'workflow-user-type': { type: 'string' },
      'workflow-poll-timeout-ms': { type: 'string' },
      'warmup-seed-labels': { type: 'boolean' },
      'render-max-jobs': { type: 'string' },
      'render-job-concurrency': { type: 'string' },
      'render-lease-seconds': { type: 'string' },
      'render-max-calls': { type: 'string' },
      'edge-db-mode': { type: 'string' },
      'quick-poll-attempts': { type: 'string' },
      'quick-poll-interval-ms': { type: 'string' },
      'prepare-inline-progress-enabled': { type: 'string' },
      'prepare-inline-progress-budget-ms': { type: 'string' },
      'prepare-inline-progress-max-steps': { type: 'string' },
      'execute-dispatch-mode': { type: 'string' },
      'execute-wait-seconds': { type: 'string' },
      'execute-initial-defer-ms': { type: 'string' },
      'inline-kick-enabled': { type: 'string' },
      'inline-kick-max-attempts': { type: 'string' },
      'inline-kick-budget-ms': { type: 'string' },
      'inline-kick-poll-ms': { type: 'string' },
      'label-bucket': { type: 'string' },
      cleanup: { type: 'boolean' },
      'keep-object': { type: 'boolean' },
      'poll-seconds': { type: 'string' },
      'request-timeout-ms': { type: 'string' },
      'retry-attempts': { type: 'string' },
      out: { type: 'string' },
    },
    strict: false,
  });

  const scenario = String(values.scenario || defaultScenario).trim().toLowerCase();
  const supportedScenarios = new Set(['download-latency', 'print-sync', 'workflow-latency']);
  if (!supportedScenarios.has(scenario)) {
    throw new Error(
      `Unsupported --scenario=${scenario}. Supported: download-latency, print-sync, workflow-latency`,
    );
  }

  const scenarioTag = String(values['scenario-tag'] || '').trim() || null;
  const expiresSeconds = Math.max(60, Math.min(3600, parseNumber(values['expires-seconds'], 900)));
  const pollSeconds = Math.max(0, Math.min(60, parseNumber(values['poll-seconds'], 0)));
  const iterations = Math.max(1, Math.min(200, parseNumber(values.iterations, 20)));
  const shipmentCount = Math.max(1, Math.min(1000, parseNumber(values.shipments, 1)));
  const boxesPerShipment = Math.max(
    1,
    Math.min(400, parseNumber(values['boxes-per-shipment'] ?? values.boxes ?? values.count, 1)),
  );
  const count = Math.max(1, Math.min(400, parseNumber(values.count ?? values.boxes, 100)));
  const targetDownloadMs = Math.max(1, Math.min(60000, parseNumber(values['target-download-ms'], 100)));
  const workflowPollTimeoutMsRaw = String(values['workflow-poll-timeout-ms'] || '').trim();
  const workflowPollTimeoutMs =
    workflowPollTimeoutMsRaw === ''
      ? null
      : Math.max(1000, Math.min(180000, parseNumber(workflowPollTimeoutMsRaw, 45000)));
  const actionKey = String(values['action-key'] || 'shipments.print_labels').trim();
  const resourceKey = String(values['resource-key'] || 'shipments').trim();
  const workflowUserType = String(values['workflow-user-type'] || 'ops_admin').trim();
  const warmupSeedLabels =
    values['warmup-seed-labels'] === undefined ? true : Boolean(values['warmup-seed-labels']);
  const labelPrintPolicyOverride = buildLabelPrintPolicyOverride({
    renderMaxJobs:
      values['render-max-jobs'] === undefined ? null : parseNumber(values['render-max-jobs'], null),
    renderJobConcurrency:
      values['render-job-concurrency'] === undefined
        ? null
        : parseNumber(values['render-job-concurrency'], null),
    renderLeaseSeconds:
      values['render-lease-seconds'] === undefined
        ? null
        : parseNumber(values['render-lease-seconds'], null),
    renderMaxCalls:
      values['render-max-calls'] === undefined ? null : parseNumber(values['render-max-calls'], null),
    edgeDbMode:
      values['edge-db-mode'] === undefined ? null : String(values['edge-db-mode'] || '').trim().toLowerCase(),
    quickPollAttempts:
      values['quick-poll-attempts'] === undefined ? null : parseNumber(values['quick-poll-attempts'], null),
    quickPollIntervalMs:
      values['quick-poll-interval-ms'] === undefined
        ? null
        : parseNumber(values['quick-poll-interval-ms'], null),
    prepareInlineProgressEnabled:
      values['prepare-inline-progress-enabled'] === undefined
        ? undefined
        : parseBooleanFlag(values['prepare-inline-progress-enabled'], false),
    prepareInlineProgressBudgetMs:
      values['prepare-inline-progress-budget-ms'] === undefined
        ? null
        : parseNumber(values['prepare-inline-progress-budget-ms'], null),
    prepareInlineProgressMaxSteps:
      values['prepare-inline-progress-max-steps'] === undefined
        ? null
        : parseNumber(values['prepare-inline-progress-max-steps'], null),
    executeDispatchMode:
      values['execute-dispatch-mode'] === undefined
        ? null
        : String(values['execute-dispatch-mode'] || '').trim().toLowerCase(),
    executeWaitSeconds:
      values['execute-wait-seconds'] === undefined
        ? null
        : parseNumber(values['execute-wait-seconds'], null),
    executeInitialDeferMs:
      values['execute-initial-defer-ms'] === undefined
        ? null
        : parseNumber(values['execute-initial-defer-ms'], null),
  });
  const workflowStartOverride = buildWorkflowStartOverride({
    inlineKickEnabled:
      values['inline-kick-enabled'] === undefined
        ? undefined
        : parseBooleanFlag(values['inline-kick-enabled'], false),
    inlineKickMaxAttempts:
      values['inline-kick-max-attempts'] === undefined
        ? null
        : parseNumber(values['inline-kick-max-attempts'], null),
    inlineKickBudgetMs:
      values['inline-kick-budget-ms'] === undefined ? null : parseNumber(values['inline-kick-budget-ms'], null),
    inlineKickPollMs:
      values['inline-kick-poll-ms'] === undefined ? null : parseNumber(values['inline-kick-poll-ms'], null),
  });
  const requestTimeoutMs = Math.max(
    1000,
    Math.min(
      120000,
      parseNumber(
        values['request-timeout-ms'],
        parseNumber(ENV.LABEL_PRINT_BENCHMARK_REQUEST_TIMEOUT_MS, 25000),
      ),
    ),
  );
  const printSyncRetryAttempts = Math.max(
    1,
    Math.min(
      10,
      parseNumber(
        values['retry-attempts'],
        parseNumber(ENV.LABEL_PRINT_BENCHMARK_RETRY_ATTEMPTS, 4),
      ),
    ),
  );
  const cleanup = values.cleanup === undefined ? true : Boolean(values.cleanup);
  const keepObjectDefault = scenario === 'print-sync';
  const keepObject = values['keep-object'] === undefined ? keepObjectDefault : Boolean(values['keep-object']);
  const labelBucket =
    String(values['label-bucket'] || ENV.LABEL_RENDER_BUCKET || ENV.LABEL_RENDERER_BUCKET || 'labels').trim() ||
    'labels';
  const outputName =
    String(
      values['output-name'] ||
        `print_sync_${count}_${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`,
    ).trim() || `print_sync_${count}.pdf`;
  const outPathRaw = String(values.out || '').trim();

  const { pool, client, dbCandidate } = await selectDbConnection({ logPrefix });
  const runStartedAt = new Date().toISOString();

  let output;
  try {
    await ensureStorageBucket({ client, labelBucket, serviceRoleKey, logPrefix });

    if (scenario === 'download-latency') {
      const scenarioOutput = await runDownloadLatencyScenario({
        client,
        labelBucket,
        expiresSeconds,
        iterations,
        shipmentCount,
        boxesPerShipment,
        cleanup,
        keepObject,
        targetDownloadMs,
        logPrefix,
        labelRendererAuth,
        apiKey: ENV.SUPABASE_ANON_KEY || serviceRoleKey,
        serviceRoleKey,
        requestTimeoutMs,
        printSyncRetryAttempts,
      });
      output = {
        ok: true,
        scenario,
        generated_at: new Date().toISOString(),
        started_at: runStartedAt,
        environment: {
          supabase_url: ENV.SUPABASE_URL,
          project_id: ENV.SUPABASE_PROJECT_ID || null,
          db_candidate: dbCandidate,
        },
        config: {
          iterations,
          shipment_count: shipmentCount,
          boxes_per_shipment: boxesPerShipment,
          target_download_ms: targetDownloadMs,
          expires_seconds: expiresSeconds,
          cleanup,
          keep_object: keepObject,
          label_bucket: labelBucket,
          scenario_tag: scenarioTag,
          fresh_label_regeneration_required: true,
          label_print_policy_override: labelPrintPolicyOverride,
          workflow_start_override: workflowStartOverride,
          request_timeout_ms: requestTimeoutMs,
          retry_attempts: printSyncRetryAttempts,
          benchmark_note:
            'Measured via label-renderer print_sync request-to-signed_url readiness. Both requests enforce fresh generation (no label reuse).',
        },
        ...scenarioOutput,
      };
    } else if (scenario === 'workflow-latency') {
      const scenarioOutput = await runWorkflowLatencyScenario({
        client,
        labelBucket,
        expiresSeconds,
        iterations,
        shipmentCount,
        boxesPerShipment,
        cleanup,
        keepObject,
        targetDownloadMs,
        actionKey,
        resourceKey,
        workflowUserType,
        workflowPollTimeoutMs,
        warmupSeedLabels,
        labelRendererAuth,
        apiKey: ENV.SUPABASE_ANON_KEY || serviceRoleKey,
        requestTimeoutMs,
        printSyncRetryAttempts,
        serviceRoleKey,
        labelPrintPolicyOverride,
        workflowStartOverride,
      });
      output = {
        ok: true,
        scenario,
        generated_at: new Date().toISOString(),
        started_at: runStartedAt,
        environment: {
          supabase_url: ENV.SUPABASE_URL,
          project_id: ENV.SUPABASE_PROJECT_ID || null,
          db_candidate: dbCandidate,
        },
        config: {
          iterations,
          shipment_count: shipmentCount,
          boxes_per_shipment: boxesPerShipment,
          action_key: actionKey,
          resource_key: resourceKey,
          workflow_user_type: workflowUserType,
          workflow_poll_timeout_ms: workflowPollTimeoutMs,
          warmup_seed_labels: warmupSeedLabels,
          target_download_ms: targetDownloadMs,
          label_print_policy_override: labelPrintPolicyOverride,
          workflow_start_override: workflowStartOverride,
          cleanup,
          keep_object: keepObject,
          label_bucket: labelBucket,
          scenario_tag: scenarioTag,
          fresh_label_regeneration_required: true,
          benchmark_note:
            'Measured via ui_execute_command_v1 -> workflow_run -> ui_get_workflow_run_output_status_v1 until output URL readiness (fresh generation enforced per click).',
        },
        ...scenarioOutput,
      };
    } else {
      const scenarioOutput = await runSyncScenario({
        client,
        labelBucket,
        expiresSeconds,
        count,
        outputName,
        pollSeconds,
        cleanup,
        keepObject,
        labelRendererAuth,
        apiKey: ENV.SUPABASE_ANON_KEY || serviceRoleKey,
        serviceRoleKey,
        requestTimeoutMs,
        printSyncRetryAttempts,
      });
      output = {
        scenario,
        generated_at: new Date().toISOString(),
        environment: {
          supabase_url: ENV.SUPABASE_URL,
          project_id: ENV.SUPABASE_PROJECT_ID || null,
          db_candidate: dbCandidate,
        },
        config: {
          count,
          expires_seconds: expiresSeconds,
          poll_seconds: pollSeconds,
          cleanup,
          keep_object: keepObject,
          label_bucket: labelBucket,
          output_name: outputName,
          request_timeout_ms: requestTimeoutMs,
          retry_attempts: printSyncRetryAttempts,
          scenario_tag: scenarioTag,
        },
        ...scenarioOutput,
      };
    }

    const rendered = `${JSON.stringify(output, null, 2)}\n`;
    process.stdout.write(rendered);

    if (outPathRaw) {
      const outPath = path.resolve(process.cwd(), outPathRaw);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, rendered, 'utf8');
      console.error(`[${logPrefix}] Wrote ${outPath}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = {
  runBenchmarkCli,
};

if (require.main === module) {
  runBenchmarkCli({
    defaultScenario: 'download-latency',
    logPrefix: 'labels-print-workflow-benchmark',
  }).catch((err) => {
    console.error('[labels-print-workflow-benchmark] Failed:', err?.message || err);
    process.exit(1);
  });
}
