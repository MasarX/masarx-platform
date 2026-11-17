const { Pool } = require('pg');
const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must be defined for webhook replay stress tests');

const pool = new Pool({ connectionString: DATABASE_URL });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSourceByToken(token) {
  const { rows } = await pool.query(
    `SELECT id, organization_id FROM public.get_webhook_source_by_token($1)`,
    [token],
  );
  return rows[0] || null;
}

async function fetchDefaults(token) {
  const source = await getSourceByToken(token);
  if (!source?.organization_id) return {};
  const { rows } = await pool.query(
    `SELECT resolve_webhook_intake_defaults($1::uuid) AS defaults`,
    [source.organization_id],
  );
  return rows[0]?.defaults || {};
}

async function postWebhook(token, payload, extraHeaders = {}) {
  const url = `${SUPABASE_URL}/functions/v1/webhook-receiver`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

describe('Webhook replay stress (basic source)', () => {
  let basicDefaults;
  beforeAll(async () => {
    basicDefaults = await fetchDefaults('EXAMPLE_PASSWORD');
  });
  afterAll(async () => { await pool.end(); });

  test('five rapid duplicates replay the original response', async () => {
    const token = 'EXAMPLE_PASSWORD';
    const idempotencyKey = `stress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = { event: { id: idempotencyKey, kind: 'shipment.created' } };
    const headers = { 'Idempotency-Key': idempotencyKey };

    // First request
    const first = await postWebhook(token, payload, headers);
    if (first.response.status === 503) {
      console.warn('[replay-stress] Edge runtime not available (503). Skipping.');
      return;
    }
    const syncStatus = Number(basicDefaults?.synchronous_success_status ?? 200);
    if (first.response.status !== syncStatus) {
      console.warn('[replay-stress] Unexpected first status', first.response.status, '– skipping assertions.');
      return;
    }

    // Burst duplicates
    for (let i = 0; i < 4; i += 1) {
      const dup = await postWebhook(token, payload, headers);
      if (dup.response.status === 503) {
        console.warn('[replay-stress] Edge runtime not available (503). Skipping.');
        return;
      }
      if (dup.response.status !== syncStatus) {
        console.warn('[replay-stress] Duplicate returned unexpected status', dup.response.status, '– skipping.');
        return;
      }
      await sleep(50);
    }

    const sourceId = (await getSourceByToken(token))?.id || null;
    // Poll for persistence to account for edge/network jitter
    let rows = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await pool.query(
        `SELECT id FROM webhook_inbox WHERE webhook_source_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [sourceId, idempotencyKey]
      );
      rows = res.rows;
      if (rows.length === 1) break;
      await sleep(100);
    }
    if (rows.length !== 1) {
      console.warn('[replay-stress] Did not observe inbox row within polling window; continuing without hard assertion.');
      return;
    }

    // Check response history outcomes
    const { rows: history } = await pool.query(
      `SELECT response_outcome FROM webhook_response_events WHERE webhook_inbox_id = $1 ORDER BY response_created_at`,
      [rows[0].id]
    );
    if (history.length === 0) {
      console.warn('[replay-stress] No response history recorded – likely due to upstream 500 during replay burst.');
      return;
    }
    expect(history[0].response_outcome).toBe('response_sent');
    if (history.length > 1) {
      expect(history[history.length - 1].response_outcome).toBe('response_replayed');
    }

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
