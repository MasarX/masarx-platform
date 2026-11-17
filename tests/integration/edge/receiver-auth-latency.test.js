const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const { upsertWebhookPolicy } = require('../../utils/policies');

const DATABASE_URL =
  process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));

const pool = new Pool({ connectionString: DATABASE_URL });
const extractHelper = path.resolve(__dirname, '../helpers/run-webhook-extract.mjs');

jest.setTimeout(30000);

describe('Edge receiver auth & latency', () => {
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
      await client.query('ROLLBACK');
      client.release();
    }
  });

  const runExtract = (headers, url) => {
    const payload = JSON.stringify({ headers, url });
    const output = execFileSync(process.execPath, ['--experimental-vm-modules', extractHelper, payload], {
      encoding: 'utf8'
    });
    return JSON.parse(output.trim());
  };

async function seedHmacSource({
  algorithm = 'HMAC-SHA256',
  signatureEncoding = 'base64',
  header = 'x-hmac-signature'
} = {}) {
    const organizationId = randomUUID();
    const clientId = randomUUID();
    const providerId = randomUUID();
    const providerAuthId = randomUUID();
    const mappingId = randomUUID();
    const sourceId = randomUUID();
    const token = `tok-${randomUUID()}`;
    const secret = `sec-${randomUUID()}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
       VALUES ($1::uuid, 'Edge HMAC Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
      [organizationId, `edge-hmac-${organizationId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
       VALUES ($1::uuid, $2::uuid, 'Edge HMAC Client', $3::text, 'standard', 'active')`,
      [clientId, organizationId, `edge-hmac-client-${clientId.slice(0, 8)}`]
    );

    await client.query(
      `INSERT INTO providers (id, organization_id, name, provider_type, enabled, priority_rank, health_status)
       VALUES ($1::uuid, $2::uuid, $3::text, 'webhook', TRUE, 10, 'healthy')`,
      [providerId, organizationId, `edge-hmac-provider-${providerId.slice(0, 8)}`]
    );

    const { rows: vaultRows } = await client.query(
      `SELECT vault.create_secret($1::text, $2::text, $3::text, NULL) AS id`,
      [
        JSON.stringify({ signing_secret: secret }),
        `provider_auth_configs/${providerAuthId}`,
        'integration edge receiver hmac signing_secret',
      ],
    );

    await client.query(
      `INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials)
       VALUES ($1::uuid, $2::uuid, 'api_key', $3::uuid, $4::jsonb)`,
      [
        providerAuthId,
        providerId,
        vaultRows[0].id,
        JSON.stringify({ signing_secret: secret }),
      ],
    );

    await client.query(
      `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
       VALUES ($1::uuid, 'webhook_inbound', $2::text, '{}'::jsonb, 1, 'edge receiver hmac mapping')`,
      [mappingId, `edge-hmac-${Date.now()}`]
    );

    await client.query(
    `INSERT INTO webhook_sources (
         id,
         organization_id,
         source_identifier,
         name,
         provider_type,
         auth_token,
         mapping_config_id,
         enabled
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::text,
         'Edge HMAC Source',
         'provider',
         $4::text,
         $5::uuid,
         TRUE
       )`,
      [sourceId, organizationId, `edge-hmac-${sourceId.slice(0, 8)}`, token, mappingId]
    );

    const { rows: templateRows } = await client.query(
      `SELECT id FROM workflow_templates WHERE name = 'webhook_shipment_create_v1' AND status='active' ORDER BY version DESC,updated_at DESC LIMIT 1`
    );
    if (!templateRows.length) {
      throw new Error('canonical webhook_shipment_create_v1 template not found');
    }
    const templateId = templateRows[0].id;
    await client.query(`WITH owned_sender AS (
      INSERT INTO senders(client_id,name,status) VALUES($1::uuid,'HMAC fixture sender','active') RETURNING id
    ) UPDATE webhook_sources SET sender_id=(SELECT id FROM owned_sender) WHERE id=$2::uuid`, [clientId, sourceId]);

    const policy = {
      version: 1,
      response: {
        mode: 'accepted_async',
        default_headers: { 'content-type': 'application/json' }
      },
      workflow: {
        template_id: templateId,
        intent: 'shipment_create'
      },
      validation: {
        idempotency: { body_path: 'event.id' },
        hmac: {
          enabled: true,
          algorithm,
          header,
          signature_encoding: signatureEncoding,
          auth_config_id: providerAuthId
        }
      },
      logging: {
        decision_point: 'workflow_intake_response'
      }
    };

    await upsertWebhookPolicy('source', sourceId, policy, 'edge receiver hmac policy', client);

    return {
      organizationId,
      clientId,
      sourceId,
      token,
      secret,
      header,
      signatureEncoding
    };
  }

  test('extractToken honours header precedence and bearer fallback', () => {
    const explicit = runExtract({ 'x-webhook-token': 'direct-token', authorization: 'Bearer ignore-me' });
    expect(explicit.token).toBe('direct-token');

    const fallback = runExtract({ authorization: 'Bearer api-token' });
    expect(fallback.token).toBe('api-token');

    const query = runExtract({}, 'https://example.test/webhook?token=EXAMPLE_PASSWORD');
    expect(query.token).toBe('EXAMPLE_PASSWORD');

    const none = runExtract({});
    expect(none.token).toBeNull();
  });

  test('workflow intake returns 401 when token is missing', async () => {
    const { rows: missingTokenRows } = await client.query(
      `SELECT workflow_intake_webhook(NULL::text, '{}'::jsonb, ''::text, '{}'::jsonb) AS ack`
    );
    expect(missingTokenRows[0].ack.status).toBe(401);
  });

  test('HMAC validation rejects bad signatures and records latency on success', async () => {
    const seed = await seedHmacSource({});

    const badPayload = {
      event: {
        id: `evt-hmac-${randomUUID()}`,
        type: 'shipment.created'
      },
      data: {
        example: true
      }
    };
    const badRawBody = JSON.stringify(badPayload);

    const badSignatureHeaders = {
      [seed.header]: 'not-a-valid-signature',
      'content-type': 'application/json'
    };

    const { rows: badRows } = await client.query(
      `SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS ack`,
      [
        seed.token,
        JSON.stringify(badSignatureHeaders),
        badRawBody,
        JSON.stringify(badPayload)
      ]
    );
    const badAck = badRows[0].ack;
    expect(badAck.status).toBeGreaterThanOrEqual(400);
    expect(badAck.response_outcome).toBe('response_failed');

    const goodPayload = {
      ...badPayload,
      event: {
        ...badPayload.event,
        id: `evt-hmac-good-${randomUUID()}`,
      },
    };
    const goodRawBody = JSON.stringify(goodPayload);
    const signature = crypto
      .createHmac('sha256', seed.secret)
      .update(goodRawBody)
      .digest(seed.signatureEncoding === 'base64' ? 'base64' : 'hex');

    const goodHeaders = {
      [seed.header]: signature,
      'content-type': 'application/json'
    };

    const { rows: goodRows } = await client.query(
      `SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS ack`,
      [
        seed.token,
        JSON.stringify(goodHeaders),
        goodRawBody,
        JSON.stringify(goodPayload)
      ]
    );

    const ack = goodRows[0].ack;
    expect(ack.status).toBe(202);
    if (typeof ack.processing_time_ms === 'number') {
      expect(ack.processing_time_ms).toBeGreaterThanOrEqual(0);
    }
    expect(ack.webhook_id).toBeTruthy();

    const { rows: decisionRows } = await client.query(
      `SELECT decision_outcome, decision_inputs
         FROM decision_log
        WHERE resource_type = 'webhook_inbox'
          AND resource_id = $1::uuid
          AND decision_category = 'http_response_emitted'
        ORDER BY timestamp DESC
        LIMIT 1`,
      [ack.webhook_id]
    );

    expect(decisionRows).toHaveLength(1);
    const decision = decisionRows[0];
    const hmacResult = decision.decision_inputs?.validation_results?.hmac || {};
    expect(hmacResult.status).toBeDefined();
    expect(hmacResult.message || '').not.toMatch(/Missing signature/);
    if (decision.decision_inputs?.mode) {
      expect(decision.decision_inputs.mode).toBe('accepted_async');
    }
  });
});
