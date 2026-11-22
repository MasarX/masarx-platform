const { Pool } = require('pg');
const { loadEnv } = require('../../scripts/utils/load-env');
const { buildPayload } = require('../fixtures/builders/webhook');
const { redactRuntimeOutput } = require('../../scripts/ops/workspace/docker-runtime/redaction');

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must be defined for webhook replay stress tests');

const WEBHOOK_DB_JWT = String(process.env.WEBHOOK_DB_JWT || '').trim();
const pool = new Pool({ connectionString: DATABASE_URL });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQUEST_TIMEOUT_MS = 15000;
const WARMUP_REQUEST_TIMEOUT_MS = 60000;

function requireEdgeWebhookDbJwt() {
  if (!WEBHOOK_DB_JWT) {
    throw new Error('webhook replay stress API probes require WEBHOOK_DB_JWT');
  }
  const segments = WEBHOOK_DB_JWT.split('.');
  if (segments.length !== 3) {
    throw new Error('WEBHOOK_DB_JWT must be a JWT');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('WEBHOOK_DB_JWT payload is invalid');
  }
  if (!payload || typeof payload !== 'object' || payload.role !== 'edge_webhook_role') {
    throw new Error('WEBHOOK_DB_JWT must carry role=edge_webhook_role');
  }
  return WEBHOOK_DB_JWT;
}

async function postApiRpc(name, body) {
  const dbJwt = requireEdgeWebhookDbJwt();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: dbJwt,
      Authorization: `Bearer ${dbJwt}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'api',
      'Content-Profile': 'api',
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function sanitizeFailureEnvelope(result) {
  const body = result?.body && typeof result.body === 'object' ? result.body : {};
  const details = body.details && typeof body.details === 'object' ? body.details : {};
  const safeText = (value, maxLength) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    return redactRuntimeOutput(value).slice(0, maxLength);
  };
  return {
    status: Number.isInteger(result?.response?.status) ? result.response.status : null,
    code: safeText(body.code, 128),
    rpc_status: Number.isInteger(details.rpc_status)
      ? details.rpc_status
      : (Number.isInteger(body.rpc_status) ? body.rpc_status : null),
    message: safeText(body.message || body.error, 512),
    correlation: safeText(result?.correlationId, 128),
  };
}

function expectWebhookStatus(result, expectedStatus) {
  if (result.response.status !== expectedStatus) {
    console.error(
      `[replay-stress] failure=${JSON.stringify(sanitizeFailureEnvelope(result))}`,
    );
  }
  expect(result.response.status).toBe(expectedStatus);
}

async function getSourceByToken(token) {
  const { rows } = await pool.query(
    `SELECT id, organization_id FROM public.get_webhook_source_by_token($1)`,
    [token],
  );
  return rows[0] || null;
}

async function fetchWebhookContract(token) {
  const source = await getSourceByToken(token);
  if (!source?.id || !source?.organization_id) {
    throw new Error(`webhook source not found for token: ${token}`);
  }
  const { rows } = await pool.query(
    `
      SELECT
        public.resolve_webhook_intake_defaults($1::uuid) AS defaults,
        policy.policy
      FROM public.resolve_webhook_ingest_policy($2::uuid) AS policy
      LIMIT 1
    `,
    [source.organization_id, source.id],
  );
  if (!rows[0]?.policy) {
    throw new Error(`webhook ingest policy not found for source: ${source.id}`);
  }
  return {
    source,
    defaults: rows[0]?.defaults || {},
    policy: rows[0].policy,
  };
}

function resolveExpectedStatus(contract) {
  const ack = contract?.policy?.ack || {};
  const mode = String(ack.mode || 'accepted_async').trim() || 'accepted_async';
  const configuredStatus = Number(ack.status_code);
  const fallbackKey = mode === 'accepted_async'
    ? 'accepted_async_status'
    : 'synchronous_success_status';
  const fallbackStatus = Number(contract?.defaults?.[fallbackKey]);
  const expectedStatus = Number.isInteger(configuredStatus)
    ? configuredStatus
    : fallbackStatus;
  if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
    throw new Error(`invalid webhook response status for mode=${mode}`);
  }
  return expectedStatus;
}

function semanticAckBody(body) {
  const ack = { ...body };
  // The receiver appends request correlation independently of the persisted ACK.
  delete ack.correlation_id;
  return ack;
}

async function postWebhook(
  token,
  payload,
  extraHeaders = {},
  requestIndex = 0,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const url = `${SUPABASE_URL}/functions/v1/webhook-receiver`;
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`request ${requestIndex} exceeded ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    const elapsedMs = Date.now() - startedAt;
    const correlationId = response.headers.get('x-correlation-id') || body?.correlation_id || null;
    console.info(
      `[replay-stress] request=${requestIndex} status=${response.status} elapsed_ms=${elapsedMs} correlation_id=${correlationId || '<none>'}`,
    );
    return { response, body, elapsedMs, correlationId, requestIndex };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    throw new Error(
      `[replay-stress] request=${requestIndex} failed after ${elapsedMs}ms: ${error?.message || error}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildUniqueShipmentPayload(prefix) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const idempotencyKey = `${prefix}-${suffix}`;
  const payload = buildPayload('basic_shipment_created');
  payload.event.id = idempotencyKey;
  payload.shipment.tracking_number = `${prefix.toUpperCase()}-${suffix}`;
  return { idempotencyKey, payload };
}

describe('Webhook replay stress (basic source)', () => {
  let basicContract;
  beforeAll(async () => {
    const intakeProbe = await postApiRpc('workflow_intake_webhook', {
      p_token: null,
      p_headers: {},
      p_raw_body: '',
      p_payload: {},
    });
    expect(intakeProbe.response.status).toBe(200);
    expect(intakeProbe.data?.status).toBe(401);

    const dispatchProbe = await postApiRpc('get_webhook_edge_dispatch_jobs', {
      p_webhook_id: null,
    });
    expect(dispatchProbe.response.status).toBe(200);
    expect(dispatchProbe.data).toEqual([]);

    basicContract = await fetchWebhookContract('EXAMPLE_PASSWORD');
    const token = 'EXAMPLE_PASSWORD';
    const { idempotencyKey, payload } = buildUniqueShipmentPayload('warmup');
    const warmup = await postWebhook(
      token,
      payload,
      { 'Idempotency-Key': idempotencyKey },
      'warmup',
      WARMUP_REQUEST_TIMEOUT_MS,
    );
    expectWebhookStatus(warmup, resolveExpectedStatus(basicContract));
  }, WARMUP_REQUEST_TIMEOUT_MS + 5000);
  afterAll(async () => { await pool.end(); });

  test('five rapid duplicates replay the original response', async () => {
    const token = 'EXAMPLE_PASSWORD';
    const { idempotencyKey, payload } = buildUniqueShipmentPayload('stress');
    const headers = { 'Idempotency-Key': idempotencyKey };

    // First request
    const first = await postWebhook(token, payload, headers, 0);
    const expectedStatus = resolveExpectedStatus(basicContract);
    expectWebhookStatus(first, expectedStatus);

    // Burst duplicates
    const duplicateResults = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) => postWebhook(token, payload, headers, index + 1)),
    );
    const duplicateFailures = duplicateResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (duplicateFailures.length > 0) {
      throw new AggregateError(duplicateFailures, 'one or more duplicate webhook requests failed');
    }
    const duplicates = duplicateResults.map((result) => result.value);
    for (const duplicate of duplicates) {
      expectWebhookStatus(duplicate, first.response.status);
      expect(semanticAckBody(duplicate.body)).toEqual(semanticAckBody(first.body));
    }

    const sourceId = basicContract.source.id;
    // Count raw events independently of the mutable inbox key projection.
    let rows = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await pool.query(
        `SELECT id FROM public.webhook_inbox
          WHERE webhook_source_id = $1 AND organization_id = $3
            AND raw_payload #>> '{event,id}' = $2`,
        [sourceId, idempotencyKey, basicContract.source.organization_id]
      );
      rows = res.rows;
      if (rows.length > 0) break;
      await sleep(100);
    }
    expect(rows).toHaveLength(1);

    const { rows: ackRows } = await pool.query(
      `SELECT DISTINCT webhook_inbox_id FROM public.webhook_ack_history
        WHERE webhook_source_id = $1 AND organization_id = $3 AND idempotency_key = $2`,
      [sourceId, idempotencyKey, basicContract.source.organization_id],
    );
    expect(ackRows).toEqual([{ webhook_inbox_id: rows[0].id }]);

    // Check response history outcomes
    let history = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await pool.query(
        `SELECT response_outcome FROM webhook_response_events WHERE webhook_inbox_id = $1 ORDER BY response_created_at`,
        [rows[0].id],
      );
      history = result.rows;
      if (
        history.some((row) => row.response_outcome === 'response_sent') &&
        history.filter((row) => row.response_outcome === 'response_replayed').length === duplicates.length
      ) {
        break;
      }
      await sleep(100);
    }
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].response_outcome).toBe('response_sent');
    expect(history.map((row) => row.response_outcome)).toContain('response_replayed');
    expect(history.filter((row) => row.response_outcome === 'response_replayed'))
      .toHaveLength(duplicates.length);

    const { rows: latestRows } = await pool.query(
      `SELECT response_outcome, http_status_code, http_body, idempotency_key
         FROM public.webhook_response_latest
        WHERE webhook_inbox_id = $1`,
      [rows[0].id],
    );
    expect(latestRows).toHaveLength(1);
    expect(latestRows[0]).toMatchObject({
      response_outcome: 'response_replayed',
      http_status_code: first.response.status,
      idempotency_key: idempotencyKey,
    });
    expect(semanticAckBody(latestRows[0].http_body)).toEqual(semanticAckBody(first.body));

    const { rows: decisionRows } = await pool.query(
      `SELECT decision_outcome, decision_inputs
         FROM decision_log
        WHERE resource_type = 'webhook_inbox'
          AND resource_id = $1
        ORDER BY timestamp ASC`,
      [rows[0].id]
    );
    expect(decisionRows.length).toBeGreaterThan(0);
    const decisionOutcomes = decisionRows.map((row) => row.decision_outcome);
    expect(decisionOutcomes).toContain('response_sent');
    expect(decisionOutcomes).toContain('response_replayed');
    const replayDecision = decisionRows.find((row) => row.decision_outcome === 'response_replayed');
    expect(replayDecision?.decision_inputs).toBeTruthy();
  }, 60000);
});
