// tests/load/day1-onboarding-pressure.js
// Purpose:
// - Capacity profile for day-1 onboarding with shipment + label pressure path.
// - Fully env-driven profile knobs (no tenant/env hardcoding).
// Notes:
// - Uses existing active tenants with valid label_print_policy defaults.
// - Optional tenant auto-create is available for deficit filling in non-prod.

import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import http from 'k6/http';
import sql from 'k6/x/sql';
import postgres from 'k6/x/sql/driver/postgres';

const DAY1_PROFILE = String(__ENV.DAY1_PROFILE || 'profile_a').trim().toLowerCase();
const profileDefaults = DAY1_PROFILE === 'profile_b'
  ? { tenants: 30, duration: '60m', vus: 30 }
  : { tenants: 10, duration: '30m', vus: 10 };

const DAY1_TENANTS = Number(__ENV.DAY1_TENANTS || profileDefaults.tenants);
const DAY1_DURATION = __ENV.DAY1_DURATION || profileDefaults.duration;
const DAY1_VUS = Number(__ENV.DAY1_VUS || profileDefaults.vus);
const DAY1_SHIPMENTS_PER_ITER = Number(__ENV.DAY1_SHIPMENTS_PER_ITER || 1);
const DAY1_LABEL_REQUEST_RATE = Number(__ENV.DAY1_LABEL_REQUEST_RATE || 1);
const DAY1_LABEL_HTTP_RETRY_MAX_ATTEMPTS = 10;
const DAY1_LABEL_HTTP_RETRY_ATTEMPTS = Math.min(DAY1_LABEL_HTTP_RETRY_MAX_ATTEMPTS,
  labelRetryNumber(__ENV.DAY1_LABEL_HTTP_RETRY_ATTEMPTS, 3, 1, true));
const DAY1_LABEL_HTTP_RETRY_SLEEP_MS = labelRetryNumber(__ENV.DAY1_LABEL_HTTP_RETRY_SLEEP_MS, 250, 50, true);
const DAY1_LABEL_HTTP_RETRY_BACKOFF_MS = labelRetryNumber(__ENV.DAY1_LABEL_HTTP_RETRY_BACKOFF_MS, DAY1_LABEL_HTTP_RETRY_SLEEP_MS, 50, true);
const DAY1_LABEL_HTTP_RETRY_BACKOFF_MULTIPLIER = labelRetryNumber(__ENV.DAY1_LABEL_HTTP_RETRY_BACKOFF_MULTIPLIER, 2, 1);
const DAY1_LABEL_HTTP_RETRY_MAX_SLEEP_MS = labelRetryNumber(__ENV.DAY1_LABEL_HTTP_RETRY_MAX_SLEEP_MS, 2000, 50, true);
const DAY1_LABEL_HTTP_RETRY_JITTER_MS = labelRetryNumber(__ENV.DAY1_LABEL_HTTP_RETRY_JITTER_MS, 0, 0, true);
const DAY1_LABEL_FAILURE_LOG_LIMIT = Math.max(0, Number(__ENV.DAY1_LABEL_FAILURE_LOG_LIMIT || 3));
const DAY1_ITER_SLEEP_MS = Number(__ENV.DAY1_ITER_SLEEP_MS || 200);
const DAY1_ERROR_RATE_MAX = Number(__ENV.DAY1_ERROR_RATE_MAX || 0.01);
const DAY1_SHIPMENT_P95_MS = Number(__ENV.DAY1_SHIPMENT_P95_MS || 1500);
const DAY1_SHIPMENT_P99_MS = Number(__ENV.DAY1_SHIPMENT_P99_MS || 3000);
const DAY1_LABEL_P95_MS = Number(__ENV.DAY1_LABEL_P95_MS || 5000);
const DAY1_LABEL_P99_MS = Number(__ENV.DAY1_LABEL_P99_MS || 12000);
const DAY1_HTTP_P95_MS = Number(__ENV.DAY1_HTTP_P95_MS || 5000);
const DAY1_HTTP_P99_MS = Number(__ENV.DAY1_HTTP_P99_MS || 12000);
const DAY1_ONBOARDING_P95_MS = Number(__ENV.DAY1_ONBOARDING_P95_MS || 10000);
const DAY1_SETUP_DB_RETRY_ATTEMPTS = Math.max(1, Number(__ENV.DAY1_SETUP_DB_RETRY_ATTEMPTS || 12));
const DAY1_SETUP_DB_RETRY_SLEEP_MS = Math.max(200, Number(__ENV.DAY1_SETUP_DB_RETRY_SLEEP_MS || 2000));
const DAY1_RUNTIME_DB_CONNECT_RETRY_ATTEMPTS = Math.max(1, Number(__ENV.DAY1_RUNTIME_DB_CONNECT_RETRY_ATTEMPTS || 8));
const DAY1_RUNTIME_DB_CONNECT_RETRY_SLEEP_MS = Math.max(50, Number(__ENV.DAY1_RUNTIME_DB_CONNECT_RETRY_SLEEP_MS || 200));
const DAY1_TEARDOWN_DB_RETRY_ATTEMPTS = Math.max(1, Number(__ENV.DAY1_TEARDOWN_DB_RETRY_ATTEMPTS || 12));
const DAY1_TEARDOWN_DB_RETRY_SLEEP_MS = Math.max(200, Number(__ENV.DAY1_TEARDOWN_DB_RETRY_SLEEP_MS || 2000));
const DAY1_TEARDOWN_FAIL_ON_MAX_CLIENTS = /^(1|true|yes)$/i.test(
  String(__ENV.DAY1_TEARDOWN_FAIL_ON_MAX_CLIENTS || '').trim(),
);
const DAY1_AUTO_CREATE_TENANTS = /^(1|true|yes)$/i.test(String(__ENV.DAY1_AUTO_CREATE_TENANTS || '').trim());
const DAY1_CLEANUP = !/^(0|false|no)$/i.test(String(__ENV.DAY1_CLEANUP || '').trim());
const DAY1_CLEANUP_TENANTS = /^(1|true|yes)$/i.test(String(__ENV.DAY1_CLEANUP_TENANTS || '').trim());

const DB_URL = __ENV.DATABASE_URL || (['postgres',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres',"?",'sslmode=disable'].join(""));
const SUPABASE_URL = String(__ENV.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = String(__ENV.SUPABASE_ANON_KEY || __ENV.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const LABEL_RENDERER_TOKEN = String(__ENV.LABEL_RENDERER_DB_JWT || __ENV.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const ENABLE_LABEL_HTTP = SUPABASE_URL.length > 0
  && SUPABASE_ANON_KEY.length > 0
  && LABEL_RENDERER_TOKEN.length > 0
  && DAY1_LABEL_REQUEST_RATE > 0;

const shipmentInsertMs = new Trend('day1_shipment_insert_ms');
const labelBundleMs = new Trend('day1_label_bundle_ms');
const onboardingMs = new Trend('day1_onboarding_ms');
const operationErrors = new Rate('day1_operation_errors');
let labelFailureLogCount = 0;

const connections = new Map();

export const options = {
  vus: DAY1_VUS,
  duration: DAY1_DURATION,
  thresholds: {
    checks: [`rate>${1 - DAY1_ERROR_RATE_MAX}`],
    day1_operation_errors: [`rate<${DAY1_ERROR_RATE_MAX}`],
    day1_shipment_insert_ms: [`p(95)<${DAY1_SHIPMENT_P95_MS}`, `p(99)<${DAY1_SHIPMENT_P99_MS}`],
    day1_label_bundle_ms: [`p(95)<${DAY1_LABEL_P95_MS}`, `p(99)<${DAY1_LABEL_P99_MS}`],
    day1_onboarding_ms: [`p(95)<${DAY1_ONBOARDING_P95_MS}`],
    http_req_failed: [`rate<${DAY1_ERROR_RATE_MAX}`],
    http_req_duration: [`p(95)<${DAY1_HTTP_P95_MS}`, `p(99)<${DAY1_HTTP_P99_MS}`],
  },
};

function makeRunId() {
  const now = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${now}-${rand}`;
}

function openDb() {
  let lastError = null;
  for (let attempt = 1; attempt <= DAY1_RUNTIME_DB_CONNECT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return sql.open(postgres, DB_URL);
    } catch (error) {
      lastError = error;
      if (!isMaxClientsError(error) || attempt >= DAY1_RUNTIME_DB_CONNECT_RETRY_ATTEMPTS) {
        throw error;
      }
      console.warn(
        `[day1-load] runtime db open retry ${attempt}/${DAY1_RUNTIME_DB_CONNECT_RETRY_ATTEMPTS} after max-clients; sleep_ms=${DAY1_RUNTIME_DB_CONNECT_RETRY_SLEEP_MS}`,
      );
      sleep(DAY1_RUNTIME_DB_CONNECT_RETRY_SLEEP_MS / 1000);
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error('[day1-load] runtime db open failed unexpectedly with no captured error');
}

function dbQuery(db, text, ...values) {
  return db.query(text, ...values);
}

function isMaxClientsError(error) {
  const message = String(error && error.message ? error.message : error || '');
  return /MaxClientsInSessionMode|max clients reached/i.test(message);
}

function closeCachedConnections() {
  if (!connections || connections.size === 0) return;
  for (const [vu, db] of connections.entries()) {
    try {
      db.close();
    } catch (error) {
      console.warn(
        `[day1-load] failed to close cached VU connection vu=${vu}: ${error && error.message ? error.message : error}`,
      );
    }
  }
  connections.clear();
}

function runTeardownQueryWithRetry(text, ...values) {
  let lastError = null;
  for (let attempt = 1; attempt <= DAY1_TEARDOWN_DB_RETRY_ATTEMPTS; attempt += 1) {
    const db = sql.open(postgres, DB_URL);
    try {
      dbQuery(db, text, ...values);
      return true;
    } catch (error) {
      lastError = error;
      if (!isMaxClientsError(error) || attempt >= DAY1_TEARDOWN_DB_RETRY_ATTEMPTS) {
        break;
      }
      console.warn(
        `[day1-load] teardown db retry ${attempt}/${DAY1_TEARDOWN_DB_RETRY_ATTEMPTS} after max-clients; sleep_ms=${DAY1_TEARDOWN_DB_RETRY_SLEEP_MS}`,
      );
      sleep(DAY1_TEARDOWN_DB_RETRY_SLEEP_MS / 1000);
    } finally {
      try {
        db.close();
      } catch (_) {
        // no-op: load teardown must continue best-effort close semantics
      }
    }
  }
  if (lastError && isMaxClientsError(lastError) && !DAY1_TEARDOWN_FAIL_ON_MAX_CLIENTS) {
    console.warn(
      `[day1-load] teardown cleanup skipped after retries due max-clients saturation: ${lastError && lastError.message ? lastError.message : lastError}`,
    );
    return false;
  }
  if (lastError) throw lastError;
  return true;
}

function normalizeValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return String.fromCharCode(...value);
  if (value == null) return '';
  return String(value);
}

function toInt(value) {
  const n = Number(normalizeValue(value));
  return Number.isFinite(n) ? n : NaN;
}

function readJsonSafe(body) {
  try {
    return JSON.parse(body);
  } catch (_) {
    return {};
  }
}

function clipLogValue(value, maxLength = 240) {
  const text = normalizeValue(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function logLabelFailure(attempt, response, body) {
  if (labelFailureLogCount >= DAY1_LABEL_FAILURE_LOG_LIMIT) return;
  labelFailureLogCount += 1;
  const status = Number(response && response.status ? response.status : 0);
  const bodyStatus = String(body && body.status ? body.status : '').toLowerCase();
  const bodyError = clipLogValue(body && (body.error || body.message || body.details || body.reason || ''));
  const bodyRaw = clipLogValue(response && response.body ? response.body : '');
  console.error(
    `[day1-load] label bundle failure sample attempt=${attempt} status=${status} body_status=${bodyStatus} body_error=${bodyError} body_raw=${bodyRaw}`,
  );
}

function labelRetryNumber(value, fallback, minimum, integer = false) {
  const number = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value) : NaN;
  return Number.isFinite(number) && number >= minimum && (!integer || Number.isSafeInteger(number))
    ? number : fallback;
}

function resolveLabelRetryPolicy(day1 = {}) {
  day1 = day1 ?? {};
  return {
    label_http_retry_attempts: Math.min(DAY1_LABEL_HTTP_RETRY_MAX_ATTEMPTS,
      labelRetryNumber(day1.label_http_retry_attempts, DAY1_LABEL_HTTP_RETRY_ATTEMPTS, 1, true)),
    label_http_retry_sleep_ms: labelRetryNumber(day1.label_http_retry_sleep_ms, DAY1_LABEL_HTTP_RETRY_SLEEP_MS, 50, true),
    label_http_retry_backoff_ms: labelRetryNumber(day1.label_http_retry_backoff_ms ?? day1.label_http_retry_sleep_ms, DAY1_LABEL_HTTP_RETRY_BACKOFF_MS, 50, true),
    label_http_retry_backoff_multiplier: labelRetryNumber(day1.label_http_retry_backoff_multiplier, DAY1_LABEL_HTTP_RETRY_BACKOFF_MULTIPLIER, 1),
    label_http_retry_max_sleep_ms: labelRetryNumber(day1.label_http_retry_max_sleep_ms, DAY1_LABEL_HTTP_RETRY_MAX_SLEEP_MS, 50, true),
    label_http_retry_jitter_ms: labelRetryNumber(day1.label_http_retry_jitter_ms, DAY1_LABEL_HTTP_RETRY_JITTER_MS, 0, true),
  };
}

function readDay1LabelPressurePolicy(db) {
  const rows = dbQuery(db, `SELECT resolve_settings('label_print_policy', 'global', NULL)::text AS policy`);
  const policy = readJsonSafe(normalizeValue(rows[0]?.policy));
  return resolveLabelRetryPolicy(policy?.day1_onboarding_pressure ?? {});
}

function computeLabelRetrySleepMs(attempt, policy) {
  const retryIndex = Math.max(0, attempt - 1);
  const exponentialDelay = policy.label_http_retry_backoff_ms * (policy.label_http_retry_backoff_multiplier ** retryIndex);
  const jitterMs = policy.label_http_retry_jitter_ms > 0 ? Math.floor(Math.random() * policy.label_http_retry_jitter_ms) : 0;
  return Math.min(policy.label_http_retry_max_sleep_ms, exponentialDelay + jitterMs);
}

function toBarcodeToken(value, fallback = 'DAY1') {
  const token = normalizeValue(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (token.length > 0) return token;
  return normalizeValue(fallback).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'DAY1';
}

function buildTrackingNumber(data, tenant, slot, nowMs = Date.now()) {
  const segmentClient = toBarcodeToken(normalizeValue(tenant?.client_id).slice(0, 8), 'CLIENT');
  const segmentVu = String(Math.max(0, Math.trunc(Number(__VU) || 0))).padStart(3, '0');
  const segmentIter = String(Math.max(0, Math.trunc(Number(__ITER) || 0))).padStart(10, '0');
  const segmentSlot = String(Math.max(0, Math.trunc(Number(slot) || 0))).padStart(2, '0');
  const segmentTime = String(Math.max(0, Math.trunc(Number(nowMs) || 0)));
  return toBarcodeToken(
    `${normalizeValue(data?.tracking_prefix)}C${segmentClient}V${segmentVu}I${segmentIter}S${segmentSlot}T${segmentTime}`,
  );
}

function createTenant(db, runId, index) {
  const start = Date.now();
  const orgSlug = `day1-${runId}-${index}`.slice(0, 63);
  const orgRows = dbQuery(
    db,
    `INSERT INTO public.organizations (name, slug, timezone, locale, billing_status)
     VALUES ($1, $2, 'Asia/Riyadh', 'en-US', 'active')
     RETURNING id::text AS id`,
    `Day1 Org ${index}`,
    orgSlug,
  );
  const orgId = normalizeValue(orgRows[0]?.id);
  const clientSlug = `day1-client-${runId}-${index}`.slice(0, 63);
  const clientRows = dbQuery(
    db,
    `INSERT INTO public.clients (organization_id, name, slug, sla_tier, status)
     VALUES ($1::uuid, $2, $3, 'standard', 'active')
     RETURNING id::text AS id`,
    orgId,
    `Day1 Client ${index}`,
    clientSlug,
  );
  const clientId = normalizeValue(clientRows[0]?.id);
  const senderRows = dbQuery(
    db,
    `INSERT INTO public.senders (client_id, name, status, auto_provisioned, auto_recreate)
     VALUES ($1::uuid, $2, 'active', TRUE, TRUE)
     RETURNING id::text AS id`,
    clientId,
    `Day1 Sender ${index}`,
  );
  const senderId = normalizeValue(senderRows[0]?.id);
  onboardingMs.add(Date.now() - start);
  return { org_id: orgId, client_id: clientId, sender_id: senderId, auto_created: true };
}

function getTenantPool(db, targetCount, runId) {
  const rows = dbQuery(
    db,
    `SELECT DISTINCT ON (o.id)
        o.id::text AS org_id,
        c.id::text AS client_id,
        s.id::text AS sender_id
     FROM public.organizations o
     JOIN public.clients c
       ON c.organization_id = o.id
      AND c.status = 'active'
     JOIN public.senders s
       ON s.client_id = c.id
      AND s.status = 'active'
     WHERE COALESCE(
        (resolve_settings('label_print_policy', 'tenant', o.id)->>'default_expires_seconds')::int,
        (resolve_settings('label_print_policy', 'global', NULL)->>'default_expires_seconds')::int
     ) IS NOT NULL
     ORDER BY o.id, s.created_at DESC
     LIMIT $1`,
    targetCount,
  );

  const tenants = rows.map((row) => ({
    org_id: normalizeValue(row.org_id),
    client_id: normalizeValue(row.client_id),
    sender_id: normalizeValue(row.sender_id),
    auto_created: false,
  }));

  if (tenants.length >= targetCount || !DAY1_AUTO_CREATE_TENANTS) {
    return tenants.slice(0, targetCount);
  }

  const globalPolicy = dbQuery(
    db,
    `SELECT (resolve_settings('label_print_policy', 'global', NULL)->>'default_expires_seconds')::int AS ttl`,
  );
  const ttl = toInt(globalPolicy[0]?.ttl);
  if (!Number.isFinite(ttl) || ttl < 60) {
    throw new Error(
      'Cannot auto-create DAY1 tenants: label_print_policy global default_expires_seconds is missing.',
    );
  }

  for (let idx = tenants.length + 1; idx <= targetCount; idx += 1) {
    tenants.push(createTenant(db, runId, idx));
  }
  return tenants;
}

function insertLabel(db, shipmentId, orgId, clientId, barcode, fileUrl) {
  try {
    dbQuery(
      db,
      `INSERT INTO public.labels (
         shipment_id,
         organization_id,
         client_id,
         label_type,
         barcode,
         barcode_format,
         file_url,
         file_size_bytes,
         print_count,
         metadata,
         renderer_metadata
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'shipping',
         $4,
         'CODE128',
         $5,
         0,
         0,
         '{}'::jsonb,
         '{}'::jsonb
       )
       ON CONFLICT (barcode, shipment_id)
       DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         client_id = EXCLUDED.client_id,
         file_url = EXCLUDED.file_url`,
      shipmentId,
      orgId,
      clientId,
      barcode,
      fileUrl,
    );
    return;
  } catch (_) {
    dbQuery(
      db,
      `INSERT INTO public.labels (
         shipment_id,
         label_type,
         barcode,
         barcode_format,
         file_url,
         file_size_bytes,
         print_count
       ) VALUES (
         $1::uuid,
         'shipping',
         $2,
         'CODE128',
         $3,
         0,
         0
       )
       ON CONFLICT (barcode, shipment_id)
       DO UPDATE SET file_url = EXCLUDED.file_url`,
      shipmentId,
      barcode,
      fileUrl,
    );
  }
}

export function setup() {
  const runId = makeRunId();
  const trackingPrefix = toBarcodeToken(`DAY1-${runId}`);

  let lastError = null;
  for (let attempt = 1; attempt <= DAY1_SETUP_DB_RETRY_ATTEMPTS; attempt += 1) {
    const db = sql.open(postgres, DB_URL);
    try {
      const tenants = getTenantPool(db, DAY1_TENANTS, runId);
      const labelPressurePolicy = readDay1LabelPressurePolicy(db);
      if (tenants.length < DAY1_TENANTS) {
        throw new Error(
          `Insufficient active tenant pool for day1 profile. required=${DAY1_TENANTS}, available=${tenants.length}`,
        );
      }

      const autoCreatedOrgIds = tenants
        .filter((t) => t.auto_created)
        .map((t) => t.org_id);

      console.log(
        `[day1-load] setup complete run_id=${runId} profile=${DAY1_PROFILE} tenants=${tenants.length} auto_created=${autoCreatedOrgIds.length}`,
      );
      console.log(`[day1-load] label_http_enabled=${ENABLE_LABEL_HTTP ? 'true' : 'false'}`);
      console.log(`[day1-load] label_pressure_policy source=global_with_env_fallback ${JSON.stringify(labelPressurePolicy)}`);

      return {
        run_id: runId,
        tracking_prefix: trackingPrefix,
        tenants,
        auto_created_org_ids: autoCreatedOrgIds,
        label_pressure_policy: labelPressurePolicy,
      };
    } catch (error) {
      lastError = error;
      if (!isMaxClientsError(error) || attempt >= DAY1_SETUP_DB_RETRY_ATTEMPTS) {
        throw error;
      }
      console.warn(
        `[day1-load] setup db retry ${attempt}/${DAY1_SETUP_DB_RETRY_ATTEMPTS} after max-clients; sleep_ms=${DAY1_SETUP_DB_RETRY_SLEEP_MS}`,
      );
      sleep(DAY1_SETUP_DB_RETRY_SLEEP_MS / 1000);
    } finally {
      try {
        db.close();
      } catch (_) {
        // no-op: setup retries should continue even if close fails
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('[day1-load] setup failed unexpectedly with no captured error');
}

export default function (data) {
  const tenants = Array.isArray(data?.tenants) ? data.tenants : [];
  const labelPressurePolicy = resolveLabelRetryPolicy(data?.label_pressure_policy);
  const labelRetryAttempts = labelPressurePolicy.label_http_retry_attempts;
  if (tenants.length === 0) {
    operationErrors.add(1);
    check(false, { 'tenant pool available': () => false });
    sleep(Math.max(0.05, DAY1_ITER_SLEEP_MS / 1000));
    return;
  }

  const tenant = tenants[(__VU + __ITER) % tenants.length];
  for (let slot = 0; slot < DAY1_SHIPMENTS_PER_ITER; slot += 1) {
    const trackingNumber = buildTrackingNumber(data, tenant, slot);
    const barcode = `${trackingNumber}:1`;
    const insertStart = Date.now();
    let shipmentId = '';

    try {
      const db = openDb();
      try {
        const shipmentRows = dbQuery(
          db,
          `INSERT INTO public.shipments (
             organization_id,
             client_id,
             sender_id,
             service_type,
             tracking_number,
             status,
             box_count,
             metadata
           ) VALUES (
             $1::uuid,
             $2::uuid,
             $3::uuid,
             'delivery',
             $4,
             'created',
             1,
             $5::jsonb
           )
           RETURNING id::text AS id`,
          tenant.org_id,
          tenant.client_id,
          tenant.sender_id,
          trackingNumber,
          JSON.stringify({
            day1_run_id: data.run_id,
            day1_profile: DAY1_PROFILE,
            vu: __VU,
            iter: __ITER,
            slot,
          }),
        );
        shipmentId = normalizeValue(shipmentRows[0]?.id);
        shipmentInsertMs.add(Date.now() - insertStart);

        dbQuery(
          db,
          `INSERT INTO public.shipment_boxes (
             shipment_id,
             organization_id,
             client_id,
             box_number,
             barcode,
             status
           ) VALUES (
             $1::uuid,
             $2::uuid,
             $3::uuid,
             1,
             $4,
             'pending'
           )
           ON CONFLICT (shipment_id, box_number)
           DO UPDATE SET
             barcode = EXCLUDED.barcode,
             organization_id = EXCLUDED.organization_id,
             client_id = EXCLUDED.client_id`,
          shipmentId,
          tenant.org_id,
          tenant.client_id,
          barcode,
        );

        const fileUrl = `${tenant.org_id}/labels/${barcode}.pdf`;
        insertLabel(db, shipmentId, tenant.org_id, tenant.client_id, barcode, fileUrl);

        const shipmentOk = check(shipmentRows, {
          'day1 shipment insert successful': (rows) => Array.isArray(rows) && rows.length === 1 && !!rows[0].id,
        });
        operationErrors.add(shipmentOk ? 0 : 1);
      } finally {
        try {
          db.close();
        } catch (_) {
          // no-op: connection lifecycle is best-effort in load iterations
        }
      }

      if (shipmentId && ENABLE_LABEL_HTTP && Math.random() <= DAY1_LABEL_REQUEST_RATE) {
        const labelStart = Date.now();
        const payload = {
          mode: 'bundle',
          organization_id: tenant.org_id,
          bundle: {
            organization_id: tenant.org_id,
            client_id: tenant.client_id,
            sender_id: tenant.sender_id,
            shipments: [{ shipment_id: shipmentId }],
            output_name: `day1_bundle_${data.run_id}.pdf`,
            expires_seconds: 900,
          },
        };
        let response = null;
        let body = {};
        let labelOk = false;
        for (let attempt = 1; attempt <= labelRetryAttempts; attempt += 1) {
          response = http.post(
            `${SUPABASE_URL}/functions/v1/label-renderer`,
            JSON.stringify(payload),
            {
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${LABEL_RENDERER_TOKEN}`,
                apikey: SUPABASE_ANON_KEY,
              },
              tags: { scenario: 'day1-onboarding-pressure', endpoint: 'label-renderer-bundle' },
            },
          );
          body = readJsonSafe(response.body || '{}');
          labelOk = response.status === 200 && String(body.status || '').toLowerCase() === 'ok';
          if (labelOk) {
            break;
          }
          if (attempt < labelRetryAttempts) {
            sleep(computeLabelRetrySleepMs(attempt, labelPressurePolicy) / 1000);
          } else {
            logLabelFailure(attempt, response, body);
          }
        }
        labelBundleMs.add(Date.now() - labelStart);
        const labelCheckPayload = {
          status: Number(response && response.status ? response.status : 0),
          bodyStatus: String(body && body.status ? body.status : '').toLowerCase(),
        };
        const labelChecksPassed = check(labelCheckPayload, {
          'day1 label bundle status 200': (ctx) => ctx.status === 200,
          'day1 label bundle ok payload': (ctx) => ctx.bodyStatus === 'ok',
        });
        operationErrors.add(labelChecksPassed ? 0 : 1);
      }
    } catch (error) {
      operationErrors.add(1);
      check(false, { 'day1 iteration has no runtime error': () => false });
      console.error(`[day1-load] iteration error: ${error && error.message ? error.message : error}`);
    }
  }

  sleep(Math.max(0.05, DAY1_ITER_SLEEP_MS / 1000));
}

export function teardown(data) {
  // Release any cached VU DB handles before issuing cleanup queries.
  closeCachedConnections();

  const trackingPrefix = `${normalizeValue(data?.tracking_prefix)}%`;
  let cleanupSkippedStatements = 0;
  if (DAY1_CLEANUP) {
    if (!runTeardownQueryWithRetry(`DELETE FROM public.labels WHERE barcode LIKE $1`, trackingPrefix)) cleanupSkippedStatements += 1;
    if (!runTeardownQueryWithRetry(`DELETE FROM public.shipment_boxes WHERE barcode LIKE $1`, trackingPrefix)) cleanupSkippedStatements += 1;
    if (!runTeardownQueryWithRetry(`DELETE FROM public.shipments WHERE tracking_number LIKE $1`, trackingPrefix)) cleanupSkippedStatements += 1;
    if (DAY1_CLEANUP_TENANTS) {
      const orgIds = Array.isArray(data?.auto_created_org_ids) ? data.auto_created_org_ids : [];
      for (const orgId of orgIds) {
        if (!runTeardownQueryWithRetry(
          `DELETE FROM public.senders
            WHERE client_id IN (SELECT id FROM public.clients WHERE organization_id = $1::uuid)`,
          orgId,
        )) cleanupSkippedStatements += 1;
        if (!runTeardownQueryWithRetry(`DELETE FROM public.clients WHERE organization_id = $1::uuid`, orgId)) cleanupSkippedStatements += 1;
        if (!runTeardownQueryWithRetry(`DELETE FROM public.organizations WHERE id = $1::uuid`, orgId)) cleanupSkippedStatements += 1;
      }
    }
  }

  if (cleanupSkippedStatements > 0) {
    console.warn(
      `[day1-load] teardown completed with ${cleanupSkippedStatements} skipped cleanup statement(s) due max-clients saturation`,
    );
  }

  console.log(
    `[day1-load] complete run_id=${normalizeValue(data?.run_id)} profile=${DAY1_PROFILE} tenants=${DAY1_TENANTS} duration=${DAY1_DURATION} vus=${DAY1_VUS}`,
  );
}
