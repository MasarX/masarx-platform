const crypto = require('crypto');
const { Pool } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { upsertWebhookPolicy, upsertSettings } = require('../../utils/policies');

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const buildIds = () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  return {
    orgId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    senderId: crypto.randomUUID(),
    shipmentId: crypto.randomUUID(),
    webhookSourceId: crypto.randomUUID(),
    sourceIdentifier: `logestechs-status-${suffix}`,
    sourceName: `Logestechs Status ${suffix}`,
    webhookToken: `logestechs-status-token-${crypto.randomBytes(6).toString('hex')}`,
    trackingNumber: `LGS${Date.now()}${Math.floor(Math.random() * 1000)}`
  };
};

async function fetchMappingConfigId(client) {
  const { rows } = await client.query(
    `SELECT id
       FROM public.mapping_configs
      WHERE mapping_type = 'webhook_inbound'
        AND mapping_key = 'logestechs_status_update_v1'
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`
  );
  if (!rows.length) {
    throw new Error('mapping_configs missing logestechs_status_update_v1');
  }
  return rows[0].id;
}

async function fetchWorkflowTemplateId(client) {
  const { rows } = await client.query(
    `SELECT id
       FROM public.workflow_templates
      WHERE name = 'shipment_update_status_v1'
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`
  );
  if (!rows.length) {
    throw new Error('workflow_templates missing shipment_update_status_v1');
  }
  return rows[0].id;
}

async function seedBase(client, ids) {
  await client.query(
    `INSERT INTO public.organizations (id, name, slug)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [ids.orgId, `Logestechs Status Org ${ids.sourceIdentifier}`, `logestechs-${ids.sourceIdentifier}`]
  );

  await client.query(
    `INSERT INTO public.clients (id, organization_id, name, slug, status)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [ids.clientId, ids.orgId, `Logestechs Status Client ${ids.sourceIdentifier}`, `logestechs-client-${ids.sourceIdentifier}`]
  );

  await client.query(
    `INSERT INTO public.senders (
        id,
        client_id,
        name,
        brand_name,
        auto_provisioned,
        auto_recreate,
        status
     ) VALUES (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        TRUE,
        TRUE,
        'active'
     )
     ON CONFLICT (id) DO NOTHING`,
    [ids.senderId, ids.clientId, `${ids.sourceName} Sender`, `${ids.sourceName} Sender`]
  );
}

async function seedWebhookSource(client, ids, mappingConfigId) {
  await client.query(
    `INSERT INTO public.webhook_sources (
        id,
        organization_id,
        source_identifier,
        name,
        provider_type,
        auth_token,
        mapping_config_id,
        sender_id,
        enabled,
        rate_limit_per_hour
     ) VALUES (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        'logestechs_3pl',
        $5,
        $6::uuid,
        $7::uuid,
        TRUE,
        1000
     )
     ON CONFLICT (id) DO NOTHING`,
    [
      ids.webhookSourceId,
      ids.orgId,
      ids.sourceIdentifier,
      ids.sourceName,
      ids.webhookToken,
      mappingConfigId,
      ids.senderId
    ]
  );
}

async function seedShipment(client, ids) {
  await client.query(
    `INSERT INTO public.shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        service_type,
        tracking_number,
        status
     ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        'delivery',
        $5,
        'pending'
     )`,
    [ids.shipmentId, ids.orgId, ids.clientId, ids.senderId, ids.trackingNumber]
  );
}

async function applyIngestPolicy(client, ids, templateId) {
  const policyValue = {
    version: 1,
    validation: {
      idempotency: { body_path: 'time' }
    },
    workflow: {
      template_id: templateId,
      context_patch: {
        organization_id: ids.orgId,
        client_id: ids.clientId,
        sender_id: ids.senderId,
        webhook_source_id: ids.webhookSourceId,
        source_identifier: ids.sourceIdentifier
      }
    }
  };
  await upsertWebhookPolicy(
    'source',
    ids.webhookSourceId,
    policyValue,
    'logestechs status webhook ingest policy',
    client
  );
}

function buildClientWebhookPolicy(options) {
  return {
    version: 1,
    enabled: true,
    url: 'https://client.example.com/webhooks/logestechs',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    auth: {
      mode: 'bearer_token_header',
      auth_config_id: options.authConfigId,
      credential_key: 'token'
    },
    payload: { mode: 'passthrough_raw' },
    filter: {
      mode: options.filterMode,
      statuses: options.statuses || []
    }
  };
}

async function applyClientWebhookPolicy(client, clientId, policyValue) {
  await upsertSettings(
    'client_webhook_policy',
    'client',
    clientId,
    policyValue,
    'logestechs client webhook policy',
    client
  );
}

async function intakeAndRun(client, token, payload) {
  const { rows } = await client.query(
    'SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS response',
    [
      token,
      { 'content-type': 'application/json' },
      JSON.stringify(payload),
      payload
    ]
  );
  const response = rows[0].response;
  if (response.followup_workflow_run_id) {
    await client.query('SELECT progress_workflow_run($1::uuid)', [
      response.followup_workflow_run_id
    ]);
  }
  return response;
}

describe('logestechs status webhook mirror', () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  test('updates shipment and enqueues outbound when allowlist matches', async () => {
    const ids = buildIds();
    await seedBase(client, ids);
    const mappingConfigId = await fetchMappingConfigId(client);
    const templateId = await fetchWorkflowTemplateId(client);
    await seedWebhookSource(client, ids, mappingConfigId);
    await seedShipment(client, ids);
    await applyIngestPolicy(client, ids, templateId);

    const authConfigId = crypto.randomUUID();
    await applyClientWebhookPolicy(
      client,
      ids.clientId,
      buildClientWebhookPolicy({
        authConfigId,
        filterMode: 'allowlist',
        statuses: ['delivered']
      })
    );

    const eventTime = Date.now();
    const payload = {
      packageId: 101,
      newStatus: 'DELIVERED_TO_RECIPIENT',
      barcode: ids.trackingNumber,
      time: eventTime,
      driverName: 'Driver A'
    };

    const response = await intakeAndRun(client, ids.webhookToken, payload);

    expect(response.followup_workflow_run_id).toBeTruthy();

    const shipment = await client.query(
      'SELECT status, status_updated_at FROM shipments WHERE id = $1::uuid',
      [ids.shipmentId]
    );
    expect(shipment.rows[0].status).toBe('delivered');
    const updatedAtMs = new Date(shipment.rows[0].status_updated_at).getTime();
    expect(Math.abs(updatedAtMs - eventTime)).toBeLessThan(2000);

    const actions = await client.query(
      'SELECT canonical_status, action_data FROM shipment_actions WHERE shipment_id = $1::uuid',
      [ids.shipmentId]
    );
    expect(actions.rows.length).toBe(1);
    expect(actions.rows[0].canonical_status).toBe('delivered');
    expect(actions.rows[0].action_data.webhook_id).toBe(response.webhook_id);

    const outbound = await client.query(
      `SELECT call_type, target_type, workflow_run_step_id, context, body
         FROM outbound_calls
        WHERE shipment_id = $1::uuid`,
      [ids.shipmentId]
    );
    expect(outbound.rows.length).toBe(1);
    expect(outbound.rows[0].call_type).toBe('client_webhook');
    expect(outbound.rows[0].target_type).toBe('client');
    expect(outbound.rows[0].workflow_run_step_id).toBeTruthy();
    expect(outbound.rows[0].context?.auth?.auth_config_id).toBe(authConfigId);
    expect(outbound.rows[0].body?.newStatus).toBe('DELIVERED_TO_RECIPIENT');
  });

  test('skips outbound when filter mode is none', async () => {
    const ids = buildIds();
    await seedBase(client, ids);
    const mappingConfigId = await fetchMappingConfigId(client);
    const templateId = await fetchWorkflowTemplateId(client);
    await seedWebhookSource(client, ids, mappingConfigId);
    await seedShipment(client, ids);
    await applyIngestPolicy(client, ids, templateId);

    const authConfigId = crypto.randomUUID();
    await applyClientWebhookPolicy(
      client,
      ids.clientId,
      buildClientWebhookPolicy({
        authConfigId,
        filterMode: 'none',
        statuses: []
      })
    );

    const payload = {
      packageId: 202,
      newStatus: 'DELIVERED',
      barcode: ids.trackingNumber,
      time: Date.now()
    };

    await intakeAndRun(client, ids.webhookToken, payload);

    const shipment = await client.query(
      'SELECT status FROM shipments WHERE id = $1::uuid',
      [ids.shipmentId]
    );
    expect(shipment.rows[0].status).toBe('delivered');

    const outbound = await client.query(
      'SELECT id FROM outbound_calls WHERE shipment_id = $1::uuid',
      [ids.shipmentId]
    );
    expect(outbound.rows.length).toBe(0);
  });

  test('skips outbound when blocklist matches canonical status', async () => {
    const ids = buildIds();
    await seedBase(client, ids);
    const mappingConfigId = await fetchMappingConfigId(client);
    const templateId = await fetchWorkflowTemplateId(client);
    await seedWebhookSource(client, ids, mappingConfigId);
    await seedShipment(client, ids);
    await applyIngestPolicy(client, ids, templateId);

    const authConfigId = crypto.randomUUID();
    await applyClientWebhookPolicy(
      client,
      ids.clientId,
      buildClientWebhookPolicy({
        authConfigId,
        filterMode: 'blocklist',
        statuses: ['delivery_failed']
      })
    );

    const payload = {
      packageId: 404,
      newStatus: 'FAILED Phone is turned off',
      barcode: ids.trackingNumber,
      time: Date.now()
    };

    await intakeAndRun(client, ids.webhookToken, payload);

    const shipment = await client.query(
      'SELECT status FROM shipments WHERE id = $1::uuid',
      [ids.shipmentId]
    );
    expect(shipment.rows[0].status).toBe('delivery_failed');

    const outbound = await client.query(
      'SELECT id FROM outbound_calls WHERE shipment_id = $1::uuid',
      [ids.shipmentId]
    );
    expect(outbound.rows.length).toBe(0);
  });

  test('enqueues outbound when filter mode is all', async () => {
    const ids = buildIds();
    await seedBase(client, ids);
    const mappingConfigId = await fetchMappingConfigId(client);
    const templateId = await fetchWorkflowTemplateId(client);
    await seedWebhookSource(client, ids, mappingConfigId);
    await seedShipment(client, ids);
    await applyIngestPolicy(client, ids, templateId);

    const authConfigId = crypto.randomUUID();
    await applyClientWebhookPolicy(
      client,
      ids.clientId,
      buildClientWebhookPolicy({
        authConfigId,
        filterMode: 'all',
        statuses: []
      })
    );

    const payload = {
      packageId: 505,
      newStatus: 'DELIVERED',
      barcode: ids.trackingNumber,
      time: Date.now()
    };

    await intakeAndRun(client, ids.webhookToken, payload);

    const outbound = await client.query(
      'SELECT target_type, target_id FROM outbound_calls WHERE shipment_id = $1::uuid',
      [ids.shipmentId]
    );
    expect(outbound.rows.length).toBe(1);
    expect(outbound.rows[0].target_type).toBe('client');
    expect(outbound.rows[0].target_id).toBe(ids.clientId);
  });

  test('dedupes repeated events by time idempotency key', async () => {
    const ids = buildIds();
    await seedBase(client, ids);
    const mappingConfigId = await fetchMappingConfigId(client);
    const templateId = await fetchWorkflowTemplateId(client);
    await seedWebhookSource(client, ids, mappingConfigId);
    await seedShipment(client, ids);
    await applyIngestPolicy(client, ids, templateId);

    const authConfigId = crypto.randomUUID();
    await applyClientWebhookPolicy(
      client,
      ids.clientId,
      buildClientWebhookPolicy({
        authConfigId,
        filterMode: 'allowlist',
        statuses: ['delivered']
      })
    );

    const eventTime = Date.now();
    const payload = {
      packageId: 303,
      newStatus: 'DELIVERED',
      barcode: ids.trackingNumber,
      time: eventTime
    };

    const first = await intakeAndRun(client, ids.webhookToken, payload);
    expect(first.followup_workflow_run_id).toBeTruthy();

    const second = await intakeAndRun(client, ids.webhookToken, payload);
    expect(second.response_outcome).toBe('response_replayed');

    const inboxCount = await client.query(
      'SELECT count(*)::int AS count FROM webhook_inbox WHERE webhook_source_id = $1::uuid',
      [ids.webhookSourceId]
    );
    expect(inboxCount.rows[0].count).toBe(1);

    const actionsCount = await client.query(
      'SELECT count(*)::int AS count FROM shipment_actions WHERE shipment_id = $1::uuid',
      [ids.shipmentId]
    );
    expect(actionsCount.rows[0].count).toBe(1);

    const outboundCount = await client.query(
      'SELECT count(*)::int AS count FROM outbound_calls WHERE shipment_id = $1::uuid',
      [ids.shipmentId]
    );
    expect(outboundCount.rows[0].count).toBe(1);
  });
});
