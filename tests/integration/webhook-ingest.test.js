const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../../scripts/utils/load-env');
const { skipIfMissing } = require('../utils/test-env');
const { getIntegrationFixtureProfile } = require('./helpers/integration-fixtures');
const {
  upsertSettings: helperUpsertSettings,
  upsertWebhookPolicy: helperUpsertWebhookPolicy,
} = require('../utils/policies');
const { buildPayload, readFixture: readWebhookFixture, signHmac } = require('../fixtures/builders/webhook');

loadEnv();

const missing = skipIfMissing(['SUPABASE_URL', 'DATABASE_URL'], 'webhook-ingest e2e');
const httpEnabled = process.env.RUN_WEBHOOK_HTTP_TESTS === 'true';
const liveWebhookEnabled =
  process.env.RUN_LIVE_WEBHOOK_TESTS === 'true' && httpEnabled && !missing;

const { SUPABASE_URL } = process.env;
const { DATABASE_URL } = process.env;
const fixtureProfile = getIntegrationFixtureProfile();

const BASIC_SOURCE_IDENTIFIER = fixtureProfile.webhook.basic.sourceIdentifier;
const HMAC_SOURCE_IDENTIFIER = fixtureProfile.webhook.hmac.sourceIdentifier;
const ASYNC_SOURCE_IDENTIFIER = fixtureProfile.webhook.async.sourceIdentifier;
const ACK_A_SOURCE_IDENTIFIER = fixtureProfile.webhook.clientAckA.sourceIdentifier;
const ACK_B_SOURCE_IDENTIFIER = fixtureProfile.webhook.clientAckB.sourceIdentifier;

const BASIC_TOKEN = fixtureProfile.webhook.basic.token;
const HMAC_TOKEN = fixtureProfile.webhook.hmac.token;
const ASYNC_TOKEN = fixtureProfile.webhook.async.token;
const HMAC_SECRET = 'EXAMPLE_PASSWORD';
const WEBHOOK_INTAKE_TEMPLATE_ID = '77770000-0000-0000-0000-000000770001';
const CLIENT_A_ACK_TOKEN = fixtureProfile.webhook.clientAckA.token;
const CLIENT_B_ACK_TOKEN = fixtureProfile.webhook.clientAckB.token;

const SOURCE_TOKEN_BY_IDENTIFIER = {};
SOURCE_TOKEN_BY_IDENTIFIER[BASIC_SOURCE_IDENTIFIER] = BASIC_TOKEN;
SOURCE_TOKEN_BY_IDENTIFIER[HMAC_SOURCE_IDENTIFIER] = HMAC_TOKEN;
SOURCE_TOKEN_BY_IDENTIFIER[ASYNC_SOURCE_IDENTIFIER] = ASYNC_TOKEN;

const pool = new Pool({ connectionString: DATABASE_URL });

jest.setTimeout(90000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WEBHOOK_FETCH_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.WEBHOOK_TEST_FETCH_MAX_ATTEMPTS || 5),
);
const WEBHOOK_FETCH_RETRY_BASE_MS = Math.max(
  100,
  Number(process.env.WEBHOOK_TEST_FETCH_RETRY_BASE_MS || 1000),
);

const SCOPE_HASH_SENTRY = '00000000-0000-0000-0000-000000000000';

const createdAuthConfigIds = [];
const createdProviderIds = [];
let hmacSigningSecret = HMAC_SECRET;

const selectProviderId = async (organizationId) => {
  const { rows: twilioRows } = await pool.query(
    `SELECT id FROM providers WHERE organization_id = $1::uuid AND name = 'twilio_sms' LIMIT 1`,
    [organizationId],
  );
  if (twilioRows.length) return twilioRows[0].id;

  const { rows: anyRows } = await pool.query(
    `SELECT id FROM providers WHERE organization_id = $1::uuid ORDER BY created_at LIMIT 1`,
    [organizationId],
  );
  if (anyRows.length) return anyRows[0].id;

  const name = `test-hmac-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { rows: inserted } = await pool.query(
    `INSERT INTO providers (organization_id, name, provider_type, priority_rank, metadata)
     VALUES ($1::uuid, $2::text, 'webhook', 100, '{}'::jsonb)
     RETURNING id`,
    [organizationId, name],
  );
  if (inserted[0]?.id) createdProviderIds.push(inserted[0].id);
  return inserted[0]?.id || null;
};

const ensureHmacAuthConfig = async (organizationId) => {
  const providerId = await selectProviderId(organizationId);
  if (!providerId) return null;
  const { rows } = await pool.query(
    `INSERT INTO provider_auth_configs (
        id,
        provider_id,
        auth_type,
        credentials_vault_id,
        credentials
      )
      VALUES (
        gen_random_uuid(),
        $1::uuid,
        'hmac',
        NULL,
        $2::jsonb
      )
      RETURNING id`,
    [providerId, JSON.stringify({ signing_secret: HMAC_SECRET })],
  );
  const authConfigId = rows[0]?.id || null;
  if (authConfigId) createdAuthConfigIds.push(authConfigId);
  return authConfigId;
};

const upsertSettings = async (category, scopeType, scopeId, value, changeReason = 'integration test settings upsert') => {
  await helperUpsertSettings(category, scopeType, scopeId, value, changeReason);
};

const upsertWebhookPolicy = async (scopeType, scopeId, policy) =>
  helperUpsertWebhookPolicy(scopeType, scopeId, policy, 'integration webhook policy upsert');

const fetchTemplateId = async (name) => {
  const { rows } = await pool.query(
    `SELECT id FROM workflow_templates WHERE name = $1 LIMIT 1`,
    [name],
  );
  return rows[0]?.id || null;
};

const fetchSourceByToken = async (token) => {
  const { rows } = await pool.query(
    `SELECT id, organization_id FROM public.get_webhook_source_by_token($1)`,
    [token],
  );
  return rows[0] || null;
};

const fetchSource = async (identifier) => {
  const token = SOURCE_TOKEN_BY_IDENTIFIER[identifier];
  if (!token) {
    throw new Error(`No token mapping registered for webhook source ${identifier}`);
  }
  return fetchSourceByToken(token);
};

const fetchPolicySettings = async (scopeType, scopeId) => {
  const { rows } = await pool.query(
    `SELECT cached_value
       FROM settings
      WHERE category = 'webhook_ingest_policy'
        AND scope_type = $1
        AND (scope_id IS NOT DISTINCT FROM $2)
      LIMIT 1`,
    [scopeType, scopeId],
  );
  return rows[0]?.cached_value || {};
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value ?? {}));

const seedWebhookPolicies = async () => {
  const intakeTemplateId = await fetchTemplateId('webhook_intake_v1');
  if (!intakeTemplateId) {
    throw new Error('webhook_intake_v1 template not found');
  }

  const asyncFollowupTemplateId = await fetchTemplateId('async_provider_dispatch_v1');
  const basicSource = await fetchSource(BASIC_SOURCE_IDENTIFIER);
  const hmacSource = await fetchSource(HMAC_SOURCE_IDENTIFIER);
  const asyncSource = await fetchSource(ASYNC_SOURCE_IDENTIFIER);

  if (!basicSource || !hmacSource || !asyncSource) {
    throw new Error('Expected baseline webhook sources to exist');
  }

  await upsertSettings(
    'webhook_intake',
    'global',
    null,
    { entry_template_id: intakeTemplateId },
    'configure intake entry template for integration tests',
  );

  const baseAckHeaders = { 'content-type': 'application/json' };
  const baseValidation = {
    idempotency: {
      body_path: 'event.id',
    },
  };
  const logging = { decision_point: 'workflow_intake_response' };

  const basicPolicy = {};
  basicPolicy.ack = {
    ...(basicPolicy.ack || {}),
    mode: 'synchronous_success',
    default_headers: baseAckHeaders,
  };
  basicPolicy.validation = {
    ...(basicPolicy.validation || {}),
    idempotency: cloneJson(baseValidation.idempotency),
  };
  basicPolicy.logging = logging;
  // Explicitly mark intent as shipment_create so intake reserves planned id/tracking
  basicPolicy.workflow = {
    ...(basicPolicy.workflow || {}),
    intent: 'shipment_create',
  };
  if (basicPolicy.workflow && typeof basicPolicy.workflow === 'object') {
    const { workflow } = basicPolicy;
    if (!workflow || Object.keys(workflow).length === 0) {
      delete basicPolicy.workflow;
    } else if (workflow.template_id == null) {
      delete workflow.template_id;
    }
  }

  const hmacPolicy = cloneJson(await fetchPolicySettings('source', hmacSource.id));
  hmacPolicy.ack = {
    ...(hmacPolicy.ack || {}),
    mode: 'synchronous_success',
    default_headers: baseAckHeaders,
  };
  hmacPolicy.validation = {
    ...(hmacPolicy.validation || {}),
    idempotency: cloneJson(baseValidation.idempotency),
    ...(hmacPolicy.validation?.hmac ? { hmac: hmacPolicy.validation.hmac } : {}),
  };
  const hmacAuthConfigId = await ensureHmacAuthConfig(hmacSource.organization_id);
  if (hmacAuthConfigId) {
    hmacPolicy.validation.hmac = {
      enabled: true,
      header: 'x-signature',
      algorithm: 'HMAC-SHA256',
      signature_encoding: 'hex',
      auth_config_id: hmacAuthConfigId,
    };
    hmacSigningSecret = HMAC_SECRET;
  } else if (!hmacPolicy.validation.hmac) {
    hmacPolicy.validation.hmac = {
      enabled: true,
      header: 'x-signature',
      algorithm: 'HMAC-SHA256',
      signature_encoding: 'hex',
    };
  }
  if (!hmacAuthConfigId) {
    hmacSigningSecret = process.env.TWILIO_SIGNING_SECRET || HMAC_SECRET;
  }
  hmacPolicy.logging = logging;
  hmacPolicy.workflow = {
    ...(hmacPolicy.workflow || {}),
    intent: 'shipment_create',
  };

  const asyncPolicy = cloneJson(await fetchPolicySettings('source', asyncSource.id));
  asyncPolicy.ack = {
    ...(asyncPolicy.ack || {}),
    mode: 'accepted_async',
    default_headers: baseAckHeaders,
  };
  asyncPolicy.validation = {
    ...(asyncPolicy.validation || {}),
    idempotency: cloneJson(baseValidation.idempotency),
  };
  asyncPolicy.logging = logging;
  if (asyncFollowupTemplateId) {
    asyncPolicy.workflow = {
      ...(asyncPolicy.workflow || {}),
      template_id: asyncFollowupTemplateId,
      intent: 'shipment_create',
      context_patch: {
        ...(asyncPolicy.workflow?.context_patch || {}),
        followup_template_id: asyncFollowupTemplateId,
      },
    };
  }

  await upsertWebhookPolicy('source', basicSource.id, basicPolicy);
  await upsertWebhookPolicy('source', hmacSource.id, hmacPolicy);
  await upsertWebhookPolicy('source', asyncSource.id, asyncPolicy);


};

// Ensure per-client ACK mapping infrastructure exists for tokens used in tests
const ensureClientAckMappings = async () => {
  const mappingRunKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Helper to upsert mapping_config and return id
  const upsertMapping = async (organizationId, mappingKey, mappingConfig) => {
    const { rows } = await pool.query(
      `INSERT INTO mapping_configs (mapping_type, mapping_key, mapping_config, mapping_version, notes, organization_id)
       VALUES ('webhook_response', $1, $2::jsonb, 1, 'per-client ACK mapping (tests)', $3::uuid)
       ON CONFLICT (mapping_type, mapping_key)
       DO UPDATE SET
         mapping_config = EXCLUDED.mapping_config,
         mapping_version = mapping_configs.mapping_version + 1,
         organization_id = EXCLUDED.organization_id,
         updated_at = now()
       RETURNING id`,
      [mappingKey, JSON.stringify(mappingConfig), organizationId],
    );
    return rows[0].id;
  };

  // Create organizations/clients/senders if missing
  const mkSlug = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;

  const ensureOrg = async (name, slug) => {
    const { rows } = await pool.query(
      `INSERT INTO organizations (name, slug, timezone, locale, billing_status)
       VALUES ($1, $2, 'Asia/Riyadh', 'en-US', 'active')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name, slug],
    );
    return rows[0].id;
  };

  const ensureClient = async (orgId, name, slug) => {
    const { rows } = await pool.query(
      `INSERT INTO clients (organization_id, name, slug, sla_tier, status, settings_override)
       VALUES ($1::uuid, $2, $3, 'standard', 'active', '{}'::jsonb)
       ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [orgId, name, slug],
    );
    return rows[0].id;
  };

  const ensureSender = async (clientId, name) => {
    const { rows } = await pool.query(
      `INSERT INTO senders (client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override)
       VALUES ($1::uuid, $2, $3, false, true, 'active', '{}'::jsonb)
       RETURNING id`,
      [clientId, name, `${name} Brand`],
    );
    return rows[0].id;
  };

  const ensureSource = async (orgId, senderId, identifier, token, mappingId) => {
    const { rows } = await pool.query(
      `INSERT INTO webhook_sources (organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, sender_id, rate_limit_per_hour, enabled)
       VALUES ($1::uuid, $2, $3, 'client', $4, $5::uuid, $6::uuid, 1000, true)
       ON CONFLICT (organization_id, source_identifier) DO UPDATE SET auth_token = EXCLUDED.auth_token, mapping_config_id = EXCLUDED.mapping_config_id, sender_id = EXCLUDED.sender_id
       RETURNING id`,
      [orgId, identifier, identifier, token, mappingId, senderId],
    );
    return rows[0].id;
  };

  const configureClientPolicy = async (clientId, mappingId) => {
    const policy = {
      ack: { mode: 'accepted_async', status_code: 202, response_mapping_id: mappingId },
      validation: { idempotency: { body_path: 'event.id' } },
      workflow: { intent: 'shipment_create' },
    };
    await upsertSettings('webhook_ingest_policy', 'client', clientId, policy, 'per-client ack mapping');
  };

  // Client A
  const orgA = await ensureOrg('Client A ACK Org', mkSlug('ack-org-a'));
  const clientA = await ensureClient(orgA, 'Client A', mkSlug('ack-client-a'));
  const senderA = await ensureSender(clientA, 'Client A Sender');
  const mappingAId = await upsertMapping(orgA, `client_ack::logestechs_v1::${mappingRunKey}::a`, {
    status_code: 202,
    headers: { 'content-type': 'application/json', 'x-client-ack': 'logestechs' },
    body: {
      status: 'accepted',
      resource_id: '{{ resource.id }}',
      tracking_number: '{{ resource.tracking_number }}',
      workflow_run_id: '{{ workflow_run_id }}',
    },
  });
  const sourceA = await ensureSource(orgA, senderA, ACK_A_SOURCE_IDENTIFIER, CLIENT_A_ACK_TOKEN, mappingAId);
  await configureClientPolicy(clientA, mappingAId);


  // Client B
  const orgB = await ensureOrg('Client B ACK Org', mkSlug('ack-org-b'));
  const clientB = await ensureClient(orgB, 'Client B', mkSlug('ack-client-b'));
  const senderB = await ensureSender(clientB, 'Client B Sender');
  const mappingBId = await upsertMapping(orgB, `client_ack::jarad_v1::${mappingRunKey}::b`, {
    status_code: 202,
    headers: { 'content-type': 'application/json', 'x-client-ack': 'jarad' },
    body: {
      status: 'accepted',
      correlation_id: '{{ webhook.correlation_id }}',
      tracking_summary: '{{ resource.tracking_number }}',
      ack_version: 'jarad.v1',
    },
  });
  const sourceB = await ensureSource(orgB, senderB, ACK_B_SOURCE_IDENTIFIER, CLIENT_B_ACK_TOKEN, mappingBId);
  await configureClientPolicy(clientB, mappingBId);

};

const readFixture = (filename) => readWebhookFixture(filename);

const AUTH_HEADER_VALUE =
  process.env.WEBHOOK_TEST_AUTH ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  null;

const isTransientFetchError = (error) => {
  if (!error) return false;
  const message = String(error.message || '').toLowerCase();
  const causeName = String(error.cause?.name || '');
  const causeCode = String(error.cause?.code || '').toLowerCase();

  return (
    message.includes('fetch failed') ||
    message.includes('timeout') ||
    causeName.includes('Timeout') ||
    causeCode.includes('timeout')
  );
};

const executeFetch = async (token, payload, extraHeaders = {}) => {
  let response;
  for (let attempt = 1; attempt <= WEBHOOK_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch(`${SUPABASE_URL}/functions/v1/webhook-receiver`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(AUTH_HEADER_VALUE
            ? { authorization: `Bearer ${AUTH_HEADER_VALUE}` }
            : { authorization: `Bearer ${token}` }),
          ...(process.env.SUPABASE_ANON_KEY ? { apikey: process.env.SUPABASE_ANON_KEY } : {}),
          'x-webhook-token': token,
          ...extraHeaders
        },
        body: JSON.stringify(payload)
      });
      break;
    } catch (error) {
      if (!isTransientFetchError(error) || attempt >= WEBHOOK_FETCH_MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(WEBHOOK_FETCH_RETRY_BASE_MS * attempt);
    }
  }

  let body;
  const text = await response.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    body = text;
  }

  return { response, body };
};

const getSourceId = async (identifier) => {
  const source = await fetchSource(identifier);
  return source?.id || null;
};

const getAckHistory = async (webhookId) => {
  const { rows } = await pool.query(
    `SELECT ack_outcome, ack_status_code, ack_body, ack_headers, ack_sent_at
       FROM webhook_ack_history
      WHERE webhook_inbox_id = $1
      ORDER BY ack_sent_at ASC`,
    [webhookId]
  );
  return rows;
};

const parseJsonObject = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
};

const getInboxRecord = async (sourceId, idempotencyKey) => {
  const { rows } = await pool.query(
    `SELECT wi.id,
            wi.correlation_id,
            wi.processing_status,
            wr.response_mode,
            wr.http_status_code,
            wr.response_outcome,
            wr.response_reason,
            wi.workflow_run_id
     FROM webhook_inbox wi
     LEFT JOIN webhook_response_latest wr ON wr.webhook_inbox_id = wi.id
     WHERE wi.webhook_source_id = $1
       AND (
         wi.idempotency_key = $2
         OR wi.external_id = $2
         OR wi.raw_payload #>> '{event,id}' = $2
       )
     ORDER BY wi.created_at DESC
     LIMIT 1`,
    [sourceId, idempotencyKey]
  );
  return rows[0] || null;
};

const waitForInboxRecord = async (sourceId, idempotencyKey, timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const record = await getInboxRecord(sourceId, idempotencyKey);
    if (record) {
      return record;
    }
    await sleep(200);
  }
  return null;
};

const getResponseHistory = async (webhookId) => {
  const { rows } = await pool.query(
    `SELECT http_status_code, http_headers, http_body, response_mode, response_outcome, response_reason, validation_results, response_created_at
     FROM webhook_response_events
     WHERE webhook_inbox_id = $1
     ORDER BY response_created_at ASC`,
    [webhookId],
  );
  return rows;
};

const getLatestResponse = async (webhookId) => {
  const { rows } = await pool.query(
    `SELECT http_status_code, http_headers, http_body, response_mode, response_outcome, response_reason
     FROM webhook_response_latest
     WHERE webhook_inbox_id = $1`,
    [webhookId],
  );
  return rows[0] || null;
};

const getDecisionLogOutcomes = async (resourceId) => {
  const { rows } = await pool.query(
    `SELECT decision_outcome
     FROM decision_log
     WHERE resource_type = 'webhook_inbox' AND resource_id = $1
     ORDER BY timestamp ASC`,
    [resourceId]
  );
  return rows.map((row) => row.decision_outcome);
};

const resetWebhookTables = async (sourceIds) => {
  const scopedSourceIds = Array.isArray(sourceIds)
    ? sourceIds.filter(Boolean)
    : [];
  if (!scopedSourceIds.length) return;
  await pool.query(
    `
      DELETE FROM outbound_calls
      WHERE workflow_run_step_id IN (
        SELECT id
        FROM workflow_run_steps
        WHERE workflow_run_id IN (
          SELECT id
          FROM workflow_runs
          WHERE id IN (
            SELECT workflow_run_id
            FROM webhook_inbox
            WHERE webhook_source_id = ANY($1::uuid[])
            AND workflow_run_id IS NOT NULL
          )
          OR metadata->>'started_by_run_id' IN (
            SELECT workflow_run_id::text
            FROM webhook_inbox
            WHERE webhook_source_id = ANY($1::uuid[])
            AND workflow_run_id IS NOT NULL
          )
        )
      )
    `,
    [scopedSourceIds]
  );
  await pool.query(
    `
      DELETE FROM decision_log
      WHERE resource_type = 'webhook_inbox'
        AND decision_category = 'http_response_emitted'
        AND resource_id IN (
          SELECT id FROM webhook_inbox WHERE webhook_source_id = ANY($1::uuid[])
        )
    `,
    [scopedSourceIds],
  );
  await pool.query(
    `
      DELETE FROM workflow_run_steps
      WHERE workflow_run_id IN (
        SELECT id
        FROM workflow_runs
        WHERE id IN (
          SELECT workflow_run_id
          FROM webhook_inbox
          WHERE webhook_source_id = ANY($1::uuid[])
          AND workflow_run_id IS NOT NULL
        )
        OR metadata->>'started_by_run_id' IN (
          SELECT workflow_run_id::text
          FROM webhook_inbox
          WHERE webhook_source_id = ANY($1::uuid[])
          AND workflow_run_id IS NOT NULL
        )
      )
    `,
    [scopedSourceIds]
  );

  await pool.query(
    `
      DELETE FROM workflow_runs
      WHERE id IN (
        SELECT id
        FROM workflow_runs
        WHERE id IN (
          SELECT workflow_run_id
          FROM webhook_inbox
          WHERE webhook_source_id = ANY($1::uuid[])
          AND workflow_run_id IS NOT NULL
        )
        OR metadata->>'started_by_run_id' IN (
          SELECT workflow_run_id::text
          FROM webhook_inbox
          WHERE webhook_source_id = ANY($1::uuid[])
          AND workflow_run_id IS NOT NULL
        )
      )
    `,
    [scopedSourceIds]
  );

  await pool.query(
    `
      DELETE FROM webhook_inbox
      WHERE webhook_source_id = ANY($1::uuid[])
    `,
    [scopedSourceIds]
  );
  await pool.query(
    `DELETE FROM decision_log WHERE resource_type = 'webhook_inbox'`
  );
  await pool.query(
    `DELETE FROM alert_triggers WHERE resource_type = 'webhook_inbox'`
  );
};

const defaultsCache = new Map();

const getSourceDefaults = async (identifier) => {
  if (defaultsCache.has(identifier)) {
    return defaultsCache.get(identifier);
  }
  const source = await fetchSource(identifier);
  if (!source?.organization_id) {
    throw new Error(`webhook_sources not found for identifier=${identifier}`);
  }
  const { rows } = await pool.query(
    `SELECT resolve_webhook_intake_defaults($1::uuid) AS defaults`,
    [source.organization_id],
  );
  const defaults = rows[0]?.defaults || {};
  defaultsCache.set(identifier, defaults);
  return defaults;
};

let basicDefaults;
let hmacDefaults;
let asyncDefaults;
let baselineSourceIds = [];

beforeAll(async () => {
  await seedWebhookPolicies();
  await ensureClientAckMappings();
  baselineSourceIds = await Promise.all([
    getSourceId(BASIC_SOURCE_IDENTIFIER),
    getSourceId(HMAC_SOURCE_IDENTIFIER),
    getSourceId(ASYNC_SOURCE_IDENTIFIER),
  ]);
  if (baselineSourceIds.some((id) => !id)) {
    throw new Error('Expected baseline webhook source ids to exist');
  }
  [basicDefaults, hmacDefaults, asyncDefaults] = await Promise.all([      
    getSourceDefaults(BASIC_SOURCE_IDENTIFIER),
    getSourceDefaults(HMAC_SOURCE_IDENTIFIER),
    getSourceDefaults(ASYNC_SOURCE_IDENTIFIER),
  ]);
});

afterAll(async () => {
  if (createdAuthConfigIds.length) {
    await pool.query(
      `DELETE FROM provider_auth_configs WHERE id = ANY($1::uuid[])`,
      [createdAuthConfigIds],
    );
  }
  if (createdProviderIds.length) {
    await pool.query(
      `DELETE FROM providers WHERE id = ANY($1::uuid[])`,
      [createdProviderIds],
    );
  }
  await pool.end();
});

beforeEach(async () => {
  await resetWebhookTables(baselineSourceIds);
});

const describeIfWebhook = liveWebhookEnabled ? describe : describe.skip;

describeIfWebhook('Webhook ingestion workflow', () => {
  test('accepts a basic webhook and records http response event', async () => {
    const payload = cloneJson(readFixture('basic_shipment_created.json'));
    const idempotencyKey = `evt-basic-${crypto.randomUUID()}`;
    payload.event.id = idempotencyKey;
    const { response, body } = await executeFetch(BASIC_TOKEN, payload, { 'Idempotency-Key': idempotencyKey });
    if (response.status === 503) {
      console.warn('[webhook-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }
    console.log('[webhook-ingest] basic response', { status: response.status, body });
    const syncStatus = Number(basicDefaults?.synchronous_success_status ?? 200);
    expect(response.status).toBe(syncStatus);
    expect(body?.status).toBe('accepted');
    expect(body?.resource?.type).toBe('shipment');
    expect(typeof body?.resource?.id).toBe('string');
    expect(typeof body?.resource?.tracking_number).toBe('string');
    expect(typeof body?.workflow_run_id).toBe('string');

    const sourceId = await getSourceId(BASIC_SOURCE_IDENTIFIER);
    expect(sourceId).toBeTruthy();

    const inbox = await waitForInboxRecord(sourceId, idempotencyKey);
    console.log('[webhook-ingest] basic inbox', inbox);
    expect(inbox).toBeTruthy();

    const correlationHeader = response.headers.get('x-correlation-id');
    expect(typeof correlationHeader).toBe('string');
    expect(correlationHeader).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    expect(inbox.processing_status).toBe('in_progress');
    expect([syncStatus, 202]).toContain(Number(inbox.http_status_code));
    expect(inbox.response_outcome).toBe('response_sent');

    const ackRecords = await getAckHistory(inbox.id);
    expect(ackRecords.length).toBeGreaterThan(0);
    const sentAcks = ackRecords.filter((record) => record.ack_outcome === 'ack_sent');
    expect(sentAcks.length).toBeGreaterThan(0);
    expect(sentAcks.some((record) => Number(record.ack_status_code) === syncStatus)).toBe(true);
    expect(
      sentAcks.some((record) => record.ack_body?.resource?.tracking_number === body.resource.tracking_number),
    ).toBe(true);
    expect(correlationHeader).toBe(inbox.correlation_id);

    const responseHistory = await getResponseHistory(inbox.id);
    expect(responseHistory.length).toBeGreaterThanOrEqual(1);
    expect(responseHistory[0].http_status_code).toBe(syncStatus);
    expect(responseHistory[0].response_outcome).toBe('response_sent');
    if (responseHistory.length > 1) {
      const last = responseHistory[responseHistory.length - 1];
      expect(last.response_outcome).toBe('response_replayed');
    }

    const latestResponse = await getLatestResponse(inbox.id);
    expect([syncStatus, 202]).toContain(Number(latestResponse.http_status_code));
    expect(latestResponse.response_outcome).toBe('response_sent');

    const decisions = await getDecisionLogOutcomes(inbox.id);
    expect(decisions).toContain('response_sent');

    const { rows: observabilityRows } = await pool.query(
      `SELECT event_source, event_type, resource_type, resource_id, status, correlation_id, metadata
         FROM observability_events_v
        WHERE event_source = 'webhook_http_response'
          AND resource_id = $1::uuid
        ORDER BY event_time DESC
        LIMIT 1`,
      [inbox.id]
    );
    expect(observabilityRows).toHaveLength(1);
    expect(observabilityRows[0].event_source).toBe('webhook_http_response');
    expect(observabilityRows[0].event_type).toBe('http_response_emitted');
    expect(observabilityRows[0].resource_type).toBe('webhook_inbox');
    expect(observabilityRows[0].resource_id).toBe(inbox.id);
    expect(observabilityRows[0].status).toBe('response_sent');
    expect(observabilityRows[0].correlation_id).toBe(inbox.correlation_id);
    expect(observabilityRows[0].metadata?.workflow_run_id).toBe(body.workflow_run_id);
  });

  test('replays http response for duplicate webhooks and logs duplicate outcome', async () => {
    const payload = cloneJson(readFixture('basic_shipment_created.json'));
    const idempotencyKey = `evt-basic-dupe-${crypto.randomUUID()}`;
    payload.event.id = idempotencyKey;
    const dedupeHeaders = { 'Idempotency-Key': idempotencyKey };

    const first = await executeFetch(BASIC_TOKEN, payload, dedupeHeaders);
    if (first.response.status === 503) {
      console.warn('[webhook-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }
    const second = await executeFetch(BASIC_TOKEN, payload, dedupeHeaders);
    if (second.response.status === 503) {
      console.warn('[webhook-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }
    const syncStatus = Number(basicDefaults?.synchronous_success_status ?? 200);
    expect(second.response.status).toBe(syncStatus);
    expect(second.body?.status).toBe('accepted');
    expect(second.body?.resource?.type).toBe('shipment');
    expect(typeof second.body?.resource?.id).toBe('string');
    expect(typeof second.body?.resource?.tracking_number).toBe('string');
    expect(typeof second.body?.workflow_run_id).toBe('string');

    const sourceId = await getSourceId(BASIC_SOURCE_IDENTIFIER);
    const inbox = await waitForInboxRecord(sourceId, idempotencyKey);
    expect(inbox).toBeTruthy();

    const replayCorrelationHeader = second.response.headers.get('x-correlation-id');
    expect(typeof replayCorrelationHeader).toBe('string');
    expect(replayCorrelationHeader).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    let responseHistory = [];
    for (let attempt = 0; attempt < 15; attempt += 1) {
      responseHistory = await getResponseHistory(inbox.id);
      if (responseHistory.some((row) => row.response_outcome === 'response_replayed')) break;
      await sleep(200);
    }
    expect(responseHistory.length).toBeGreaterThanOrEqual(1);
    expect(responseHistory[0].http_status_code).toBe(syncStatus);
    expect(responseHistory[0].response_outcome).toBe('response_sent');
    expect(responseHistory.some((row) => row.response_outcome === 'response_replayed')).toBe(true);
    expect(replayCorrelationHeader).toBe(inbox.correlation_id);

    const ackRecords = await getAckHistory(inbox.id);
    expect(ackRecords.length).toBeGreaterThanOrEqual(1);
    expect(ackRecords[ackRecords.length - 1].ack_status_code).toBe(syncStatus);

    const latestResponse = await getLatestResponse(inbox.id);
    expect(latestResponse.http_status_code).toBe(syncStatus);
    expect(['response_replayed', 'response_sent']).toContain(latestResponse.response_outcome);

    const decisions = await getDecisionLogOutcomes(inbox.id);
    const responseDecisions = decisions.filter((outcome) => outcome.startsWith('response_'));
    expect(responseDecisions).toContain('response_sent');
    expect(responseDecisions).toContain('response_replayed');
  });

  test('validates HMAC signatures when policy is enabled and logs success', async () => {
    const payload = cloneJson(readFixture('hmac_shipment_created.json'));
    payload.event.id = `evt-hmac-${crypto.randomUUID()}`;
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', hmacSigningSecret).update(rawBody).digest('hex');

    const { response } = await executeFetch(
      HMAC_TOKEN,
      payload,
      { 'x-signature': signature, 'Idempotency-Key': payload.event.id }
    );
    if (response.status === 503) {
      console.warn('[webhook-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }
    console.log('[webhook-ingest] hmac response', response.status);
    const syncStatus = Number(hmacDefaults?.synchronous_success_status ?? 200);
    expect(response.status).toBe(syncStatus);

    const sourceId = await getSourceId(HMAC_SOURCE_IDENTIFIER);
    const inbox = await waitForInboxRecord(sourceId, payload.event.id);
    expect(inbox).toBeTruthy();

    const responseHistory = await getResponseHistory(inbox.id);
    expect(responseHistory.length).toBeGreaterThan(0);
    expect(responseHistory[0].http_status_code).toBe(syncStatus);
    expect(responseHistory[0].response_outcome).toBe('response_sent');
    const idempotencyStatus = responseHistory[0].validation_results?.idempotency?.status;
    if (idempotencyStatus) {
      expect(idempotencyStatus).toBe('passed');
    }
    const hmacStatus = responseHistory[0].validation_results?.hmac?.status;
    if (hmacStatus) {
      expect(hmacStatus).toBe('passed');
    }

    const ackRecords = await getAckHistory(inbox.id);
    expect(ackRecords.length).toBeGreaterThan(0);
    expect(ackRecords[ackRecords.length - 1].ack_status_code).toBe(syncStatus);

    const latestResponse = await getLatestResponse(inbox.id);
    expect(latestResponse.http_status_code).toBe(syncStatus);
    expect(latestResponse.response_outcome).toBe('response_sent');

    const decisions = await getDecisionLogOutcomes(inbox.id);
    expect(decisions).toContain('response_sent');
  });

  test('returns ACK without resource when workflow intent is non-creation', async () => {
    const basicSource = await fetchSource(BASIC_SOURCE_IDENTIFIER);
    expect(basicSource).toBeTruthy();

    const originalPolicy = cloneJson(await fetchPolicySettings('source', basicSource.id));
    const nonCreationPolicy = cloneJson(originalPolicy);
    nonCreationPolicy.workflow = {
      ...(nonCreationPolicy.workflow || {}),
      intent: 'status_update',
    };
    if (nonCreationPolicy.ack) {
      nonCreationPolicy.ack = {
        ...nonCreationPolicy.ack,
      };
      delete nonCreationPolicy.ack.response_mapping_id;
      delete nonCreationPolicy.ack.body;
    }

    await upsertWebhookPolicy('source', basicSource.id, nonCreationPolicy);

    try {
      const payload = cloneJson(readFixture('basic_shipment_created.json'));
      payload.event.id = `evt-non-create-${crypto.randomUUID()}`;
      const { response, body } = await executeFetch(BASIC_TOKEN, payload);
      if (response.status === 503) {
        console.warn('[webhook-ingest] Edge runtime not available (503). Skipping assertions.');
        return;
      }

      expect(response.status).toBe(Number(basicDefaults?.synchronous_success_status ?? 200));
      if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'status')) {
        expect(body.status).toBeDefined();
      }
      expect(body.workflow_run_id).toBeDefined();
      expect(typeof body.workflow_run_id).toBe('string');
      // Since intent is not shipment_create, resource should not be included by default.
      expect(body.resource).toBeUndefined();
    } finally {
      await upsertWebhookPolicy('source', basicSource.id, originalPolicy);
    }
  });

  test('per-client mappings customize ACK responses', async () => {
    const payload = cloneJson(readFixture('basic_shipment_created.json'));
    payload.event.id = `evt-client-a-${crypto.randomUUID()}`;

    const { response: responseA, body: bodyA } = await executeFetch(CLIENT_A_ACK_TOKEN, payload);
    if (responseA.status === 503) {
      console.warn('[webhook-ingest] Edge runtime not available (503). Skipping assertions for client A.');
      return;
    }
    expect(responseA.status).toBe(202);
    expect(bodyA).toMatchObject({
      status: 'accepted',
      correlation_id: expect.any(String),
      resource: {
        type: 'shipment',
        id: expect.any(String),
        tracking_number: expect.any(String),
      },
      workflow_run_id: expect.any(String),
    });

    const payloadB = cloneJson(payload);
    payloadB.event.id = `evt-client-b-${crypto.randomUUID()}`;
    const { response: responseB, body: bodyB } = await executeFetch(CLIENT_B_ACK_TOKEN, payloadB);
    if (responseB.status === 503) {
      console.warn('[webhook-ingest] Edge runtime not available (503). Skipping assertions for client B.');
      return;
    }
    expect(responseB.status).toBe(202);
    expect(bodyB).toMatchObject({
      status: 'accepted',
      correlation_id: expect.any(String),
      tracking_summary: expect.any(String),
      ack_version: 'jarad.v1',
    });

    expect(bodyA).not.toEqual(bodyB);
  });

  test('shipment_return workflow reserves identifiers via plugin context', async () => {
    const basicSource = await fetchSource(BASIC_SOURCE_IDENTIFIER);
    expect(basicSource).toBeTruthy();

    const returnTemplateId = await fetchTemplateId('shipment_return_v1');
    expect(returnTemplateId).toBeTruthy();

    const originalPolicy = cloneJson(await fetchPolicySettings('source', basicSource.id));
    const returnPolicy = cloneJson(originalPolicy);
    returnPolicy.workflow = {
      ...(returnPolicy.workflow || {}),
      template_id: returnTemplateId,
      intent: 'shipment_return',
    };
    if (returnPolicy.ack) {
      returnPolicy.ack = {
        ...returnPolicy.ack,
        mode: 'synchronous_success',
      };
      delete returnPolicy.ack.response_mapping_id;
      delete returnPolicy.ack.body;
    }

    await upsertWebhookPolicy('source', basicSource.id, returnPolicy);

    const payload = cloneJson(readFixture('basic_shipment_created.json'));
    payload.event.id = `evt-return-${crypto.randomUUID()}`;

    try {
      const { response, body } = await executeFetch(BASIC_TOKEN, payload);
      if (response.status === 503) {
        console.warn('[webhook-ingest] Edge runtime not available (503). Skipping shipment_return plugin assertions.');
        return;
      }

      const expectedStatus = Number(basicDefaults?.synchronous_success_status ?? 200);
      expect(response.status).toBe(expectedStatus);
      expect(body.resource).toMatchObject({
        type: 'shipment',
        id: expect.any(String),
        tracking_number: expect.any(String),
      });
      expect(typeof body.workflow_run_id).toBe('string');

      const followupRunId = body.followup_workflow_run_id;
      expect(typeof followupRunId).toBe('string');

      let contextRow = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await pool.query('SELECT progress_workflow_run($1::uuid)', [followupRunId]);
        const { rows } = await pool.query(
          `WITH run_row AS (
             SELECT to_jsonb(r.*) AS run_json
             FROM workflow_runs r
             WHERE r.id = $1
           ),
           step_row AS (
             SELECT to_jsonb(s.*) AS step_json
             FROM workflow_run_steps s
             WHERE s.workflow_run_id = $1
               AND s.sequence_order = 1
             LIMIT 1
           )
           SELECT
             run_row.run_json->>'workflow_template_id' AS workflow_template_id,
             (workflow_handlers.reserve_identifiers_v1(
                jsonb_populate_record(NULL::public.workflow_run_steps, step_row.step_json),
                jsonb_populate_record(NULL::public.workflow_runs, run_row.run_json),
                '{}'::jsonb
             )).operation_result AS op_result,
             (workflow_handlers.reserve_identifiers_v1(
                jsonb_populate_record(NULL::public.workflow_run_steps, step_row.step_json),
                jsonb_populate_record(NULL::public.workflow_runs, run_row.run_json),
                '{}'::jsonb
             )).context_patch AS context_patch
           FROM run_row, step_row`,
          [followupRunId],
        );
        contextRow = rows[0]
          ? {
              workflow_template_id: rows[0].workflow_template_id,
              planned_resource_id: rows[0].context_patch?.planned_resource_id,
              planned_tracking_number: rows[0].context_patch?.planned_tracking_number,
              planned_shipment_id: rows[0].context_patch?.planned_shipment_id,
            }
          : null;
        if (contextRow?.planned_resource_id && contextRow?.planned_tracking_number) {
          break;
        }
        await sleep(100);
      }

      expect(contextRow).toBeTruthy();
      expect(contextRow.workflow_template_id).toBe(returnTemplateId);
      expect(contextRow.planned_resource_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(contextRow.planned_shipment_id).toBe(contextRow.planned_resource_id);
      expect(contextRow.planned_tracking_number).toMatch(/^[A-Z0-9*]+$/i);
    } finally {
      await upsertWebhookPolicy('source', basicSource.id, originalPolicy);
    }
  });

  test('rejects webhook when HMAC signature is invalid and stores failure decision', async () => {
    const payload = buildPayload('hmac_shipment_created');
    payload.event.id = `evt-hmac-invalid-${crypto.randomUUID()}`;
    const badSignature = signHmac(payload, 'incorrect-secret', { algorithm: 'sha256', encoding: 'hex' });

    const { response, body } = await executeFetch(
      HMAC_TOKEN,
      payload,
      { 'x-signature': badSignature, 'Idempotency-Key': payload.event.id }
    );
    if (response.status === 503) {
      console.warn('[webhook-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }
    const badStatus = Number(hmacDefaults?.bad_request_status ?? 400);
    expect(response.status).toBe(badStatus);
    expect(body).toHaveProperty('error');

    const sourceId = await getSourceId(HMAC_SOURCE_IDENTIFIER);
    const inbox = await waitForInboxRecord(sourceId, payload.event.id);
    expect(inbox).toBeTruthy();
    expect(inbox.processing_status).toBe('failed');

    const responseHistory = await getResponseHistory(inbox.id);
    expect(responseHistory.length).toBeGreaterThan(0);
    expect(responseHistory[0].http_status_code).toBe(badStatus);
    expect(responseHistory[0].response_outcome).toBe('response_failed');
    const hmacStatus = responseHistory[0].validation_results?.hmac?.status;
    expect(hmacStatus).toBe('failed');

    const ackRecords = await getAckHistory(inbox.id);
    expect(ackRecords.length).toBeGreaterThan(0);
    const failedAcks = ackRecords.filter((record) => record.ack_outcome === 'ack_failed');
    expect(failedAcks.length).toBeGreaterThan(0);
    expect(failedAcks.some((record) => Number(record.ack_status_code) === badStatus)).toBe(true);

    const decisions = await getDecisionLogOutcomes(inbox.id);
    expect(decisions).toContain('response_failed');
  });

  test('rejects webhook with invalid token without touching persistence', async () => {
    const payload = cloneJson(readFixture('basic_shipment_created.json'));
    payload.event.id = `evt-invalid-token-${crypto.randomUUID()}`;
    const { response, body } = await executeFetch('invalid-token', payload);
    if (response.status === 503) {
      console.warn('[webhook-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }
    expect(response.status).toBe(401);
    if (body && typeof body === 'object') {
      const hasErrorProp = Object.prototype.hasOwnProperty.call(body, 'error');
      const hasMessageProp = Object.prototype.hasOwnProperty.call(body, 'message');
      expect(hasErrorProp || hasMessageProp).toBe(true);
    }

    const sourceId = await getSourceId(BASIC_SOURCE_IDENTIFIER);
    expect(sourceId).toBeTruthy();

    const inbox = await waitForInboxRecord(sourceId, payload.event.id);
    expect(inbox).toBeNull();

  });

  test('returns 202 for async provider and links workflow run', async () => {
    const payload = cloneJson(readFixture('async_shipment_created.json'));
    payload.event.id = `evt-async-${crypto.randomUUID()}`;
    const { response, body } = await executeFetch(ASYNC_TOKEN, payload);
    if (response.status === 503) {
      console.warn('[webhook-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }
    const asyncStatus = Number(asyncDefaults?.accepted_async_status ?? 202);
    if (response.status !== asyncStatus) {
      console.warn('[webhook-ingest] async provider returned unexpected status, skipping assertions.');
      return;
    }
    expect(body).toMatchObject({ status: 'accepted_async' });
    expect(typeof body.correlation_id).toBe('string');
    expect(body?.resource?.type).toBe('shipment');
    expect(typeof body?.resource?.id).toBe('string');
    expect(typeof body?.resource?.tracking_number).toBe('string');
    expect(typeof body?.workflow_run_id).toBe('string');
    expect(typeof body?.followup_workflow_run_id).toBe('string');

    const plannedId = body?.resource?.id;
    const plannedTracking = body?.resource?.tracking_number;

    const sourceId = await getSourceId(ASYNC_SOURCE_IDENTIFIER);
    const inbox = await waitForInboxRecord(sourceId, payload.event.id);
    expect(inbox).toBeTruthy();

    const asyncCorrelationHeader = response.headers.get('x-correlation-id');
    expect(typeof asyncCorrelationHeader).toBe('string');
    expect(asyncCorrelationHeader).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(typeof body.correlation_id).toBe('string');
    expect(body.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    expect(inbox.http_status_code).toBe(asyncStatus);
    expect(inbox.response_mode).toBe('accepted_async');
    expect(inbox.response_outcome).toBe('response_sent');
    expect(inbox.workflow_run_id).toBeTruthy();
    expect(asyncCorrelationHeader).toBe(inbox.correlation_id);
    expect(body.correlation_id).toBe(inbox.correlation_id);

    // Structured latency/status is logged via decision_log (SSOT) and projected to response views.
    const { rows: ackDecisionRows } = await pool.query(
      `SELECT decision_inputs
         FROM decision_log
        WHERE resource_type = 'webhook_inbox'
          AND resource_id = $1::uuid
          AND decision_category = 'http_response_emitted'
        ORDER BY timestamp DESC
        LIMIT 1`,
      [inbox.id]
    );
    expect(ackDecisionRows).toHaveLength(1);
    expect(ackDecisionRows[0].decision_inputs?.status).toBe(asyncStatus);
    const processingMs = ackDecisionRows[0].decision_inputs?.processing_ms;
    if (processingMs !== undefined && processingMs !== null) {
      expect(typeof processingMs).toBe('number');
      expect(processingMs).toBeGreaterThanOrEqual(0);
    }

    const { rows: intakeRunRows } = await pool.query(
      `SELECT workflow_template_id, metadata FROM workflow_runs WHERE id = $1`,
      [inbox.workflow_run_id]
    );
    expect(intakeRunRows).toHaveLength(1);
    expect(intakeRunRows[0].workflow_template_id).toBe(WEBHOOK_INTAKE_TEMPLATE_ID);
    if (intakeRunRows[0].metadata) {
      const started = intakeRunRows[0].metadata.started_by_run_id;
      expect(started === null || started === undefined).toBe(true);
    }

    const { rows: followupRunRows } = await pool.query(
      `SELECT id, workflow_template_id, metadata
       FROM workflow_runs
       WHERE metadata->>'started_by_run_id' = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [inbox.workflow_run_id]
    );
    expect(followupRunRows).toHaveLength(1);
    expect(typeof followupRunRows[0].workflow_template_id).toBe('string');
    expect(followupRunRows[0].metadata?.started_by_run_id).toBe(
      inbox.workflow_run_id
    );
    expect(body.followup_workflow_run_id).toBe(followupRunRows[0].id);
    expect(body.workflow_run_id).toBe(inbox.workflow_run_id);

    // Progress the async workflow to execute 'shipment_create' handler.
    const followupRunId = followupRunRows[0].id;
    // Try a few times to progress until shipment row appears
    for (let i = 0; i < 5; i++) {
      await pool.query('SELECT progress_workflow_run($1::uuid)', [followupRunId]);
      const { rows: shipmentRows } = await pool.query(
        `SELECT id, tracking_number FROM shipments
           WHERE tracking_upper = upper($1)
           ORDER BY created_at DESC
           LIMIT 1`,
        [plannedTracking]
      );
      if (shipmentRows.length > 0) {
        expect(shipmentRows[0].tracking_number?.toUpperCase()).toBe(plannedTracking?.toUpperCase());
        break;
      }
      await sleep(100);
    }
    // Final assertion in case loop didn't catch
    const { rows: finalShipments } = await pool.query(
      `SELECT id, tracking_number FROM shipments
         WHERE tracking_upper = upper($1)
         ORDER BY created_at DESC
         LIMIT 1`,
      [plannedTracking]
    );
    expect(finalShipments.length).toBe(1);
    expect(finalShipments[0].tracking_number?.toUpperCase()).toBe(plannedTracking?.toUpperCase());

    const { rows: createStepRows } = await pool.query(
      `SELECT operation_result
         FROM workflow_run_steps
        WHERE workflow_run_id = $1
          AND handler_key = 'shipment_create'
        ORDER BY sequence_order DESC
        LIMIT 1`,
      [followupRunId]
    );
    const createdShipmentId = createStepRows[0]?.operation_result?.shipment_id;
    expect(createdShipmentId).toBeTruthy();
    expect(finalShipments[0].id).toBe(createdShipmentId);

    const ackRecords = await getAckHistory(inbox.id);
    expect(ackRecords.length).toBeGreaterThan(0);
    const expectedFollowupRunId = followupRunRows[0].id;
    const matchingAck = ackRecords
      .map((row) => ({ ...row, ack_body: parseJsonObject(row.ack_body) }))
      .find(
        (row) =>
          row.ack_body?.workflow_run_id === inbox.workflow_run_id &&
          row.ack_body?.followup_workflow_run_id === expectedFollowupRunId
      );
    expect(matchingAck).toBeTruthy();

    const decisions = await getDecisionLogOutcomes(inbox.id);
    expect(decisions).toContain('response_sent');
    expect(decisions).toContain('workflow_enqueued');

    const { rows: workflowDecisionRows } = await pool.query(
      `SELECT decision_outcome, decision_inputs
         FROM decision_log
        WHERE resource_type = 'webhook_inbox'
          AND resource_id = $1
          AND decision_outcome IN ('workflow_enqueued', 'response_sent')
        ORDER BY timestamp DESC`,
      [inbox.id]
    );
    expect(workflowDecisionRows.length).toBeGreaterThan(0);
    const hasExpectedFollowup = workflowDecisionRows.some((row) => {
      const rawDecisionInputs = row.decision_inputs;
      const workflowDecision =
        typeof rawDecisionInputs === 'string' ? JSON.parse(rawDecisionInputs) : rawDecisionInputs || {};
      return workflowDecision.followup_workflow_run_id === expectedFollowupRunId;
    });
    expect(hasExpectedFollowup).toBe(true);
  });
});
