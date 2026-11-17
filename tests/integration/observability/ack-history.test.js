const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const {
  DATABASE_URL,
  createOrganization,
  createClient,
  createMappingConfig,
  createWebhookSource,
  createRequestContext,
  createWebhookInboxEntry
} = require('../helpers/tenant-utils');

const pool = new Pool({ connectionString: DATABASE_URL });
pool.on('error', (err) => {
  // Prevent unhandled EventEmitter errors from crashing Jest runs when the DB
  // drops an idle connection (pool will re-establish as needed).
  // eslint-disable-next-line no-console
  console.warn('[ack-history] pg pool error:', err.message);
});

describe('Webhook ACK history compatibility view', () => {
  let client;

  beforeAll(async () => {
    const connection = await pool.connect();
    await connection.query('SELECT 1');
    connection.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      try {
        await client.query('ROLLBACK');
        client.release();
      } catch (err) {
        try {
          client.release(err);
        } catch (_) {}
      } finally {
        client = null;
      }
    }
  });

  it('maps decision_log entries into webhook_ack_history and observability events', async () => {
    const { id: orgId } = await createOrganization(client, 'Observability Org');
    const { id: clientId } = await createClient(client, orgId, 'Observability Client');

    const mappingId = await createMappingConfig(
      client,
      'webhook_inbound',
      `observability-webhook-${Date.now()}`,
      { fields: [{ pointer: '/event/id', as: 'event_id' }] }
    );

    const webhookSource = await createWebhookSource(client, {
      organizationId: orgId,
      mappingConfigId: mappingId,
      name: 'Observability Source'
    });

    const contextId = await createRequestContext(client, {
      entryPoint: 'webhook',
      clientId
    });

    const webhookInboxId = await createWebhookInboxEntry(client, {
      webhookSourceId: webhookSource.id,
      providerType: 'observability',
      correlationId: contextId,
      rawPayload: { event: { id: 'ack-test-1' } },
      processingStatus: 'in_progress'
    });

    const ackHeaders = { 'content-type': 'application/json' };
    const ackBody = { status: 'accepted', code: 'ACK-123' };
    const validationResults = { hmac: true, schema: 'pass' };
    const { rows: beforeRows } = await client.query(`SELECT clock_timestamp() AS ts`);
    const beforeTs = new Date(beforeRows[0].ts).getTime();
    const idempotencyKey = `ack-${Date.now()}`;
    const workflowRunId = randomUUID();

    await client.query(
      `
        SELECT log_decision(
          $1::uuid,
          'http_response_emitted',
          'webhook_inbox',
          $2::uuid,
          'observability-webhook',
          'response_sent',
          'workflow_intake_webhook',
          $3::uuid,
          jsonb_build_object(
            'status', $4::int,
            'mode', $5::text,
            'headers', $6::jsonb,
            'body', $7::jsonb,
            'validation_results', $8::jsonb,
            'idempotency_key', $9::text,
            'workflow_run_id', $10::uuid
          ),
          $11
        )
      `,
      [
        orgId,
        webhookInboxId,
        contextId,
        202,
        'accepted_async',
        ackHeaders,
        ackBody,
        validationResults,
        idempotencyKey,
        workflowRunId,
        'Webhook ACK emitted'
      ]
    );

    const { rows: afterRows } = await client.query(`SELECT clock_timestamp() AS ts`);
    const afterTs = new Date(afterRows[0].ts).getTime();

    const { rows: ackRows } = await client.query(
      `
        SELECT
          ack_mode,
          ack_status_code,
          ack_body,
          ack_headers,
          ack_outcome,
          ack_reason,
          validation_results,
          idempotency_key,
          workflow_run_ref,
          ack_sent_at
        FROM webhook_ack_history
        WHERE webhook_inbox_id = $1::uuid
      `,
      [webhookInboxId]
    );

    expect(ackRows).toHaveLength(1);
    const ackRow = ackRows[0];
    expect(ackRow.ack_mode).toBe('accepted_async');
    expect(ackRow.ack_status_code).toBe(202);
    expect(ackRow.ack_body).toEqual(ackBody);
    expect(ackRow.ack_headers).toBe('REDACTED');
    expect(ackRow.ack_outcome).toBe('ack_sent');
    expect(ackRow.ack_reason).toBe('Webhook ACK emitted');
    expect(ackRow.validation_results).toEqual(validationResults);
    expect(ackRow.idempotency_key).toBe(idempotencyKey);
    expect(ackRow.workflow_run_ref).toBe(workflowRunId);
    const ackTimestamp = new Date(ackRow.ack_sent_at).getTime();
    expect(Number.isNaN(ackTimestamp)).toBe(false);
    // Use database time bounds to avoid flakiness from runner-vs-db clock skew.
    expect(ackTimestamp).toBeGreaterThanOrEqual(beforeTs - 1000);
    expect(ackTimestamp).toBeLessThanOrEqual(afterTs + 1000);
    const { rows: observabilityRows } = await client.query(
      `
        SELECT event_source, event_type, status
        FROM observability_events_v
        WHERE resource_type = 'webhook_inbox'
          AND resource_id = $1::uuid
          AND event_source = 'webhook_http_response'
          AND event_type = 'http_response_emitted'
      `,
      [webhookInboxId]
    );

    expect(observabilityRows).toHaveLength(1);
    expect(observabilityRows[0]).toEqual({
      event_source: 'webhook_http_response',
      event_type: 'http_response_emitted',
      status: 'response_sent'
    });
  });
});
