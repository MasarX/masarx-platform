const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { createWorkflowContext } = require('../helpers/tenant-utils');

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be defined for api-gateway provider update tests');
}

const maxPool = Number(process.env.TEST_DB_POOL_MAX || '4');
const pool = new Pool({ connectionString: DATABASE_URL, max: maxPool });

function slug(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearPolicyCache(client, category) {
  await client.query(
    `DELETE FROM settings_cache
      WHERE cache_key LIKE $1`,
    [`${category}:%`],
  );
}

async function resolveCanonicalUpdateRoute(client) {
  const { rows } = await client.query(
    `SELECT r.id, r.provider_id, r.route_name
       FROM public.api_routes r
       JOIN public.api_route_packs p ON p.id = r.pack_id
      WHERE p.name = 'logestechs_v2_mirror'
        AND upper(r.method) = 'PUT'
        AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}'
        AND r.scope_type = 'global'
        AND r.enabled = TRUE
      ORDER BY r.updated_at DESC
      LIMIT 1`,
  );

  if (!rows.length) {
    throw new Error('Canonical Logestechs provider update route is missing');
  }

  return rows[0];
}

async function seedGatewaySource(client, { orgId, clientId, senderId, sourceId, sourceToken, providerId }) {
  const mappingConfigId = randomUUID();
  const providerAuthConfigId = randomUUID();

  await client.query(
    `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
     VALUES ($1::uuid, 'Provider Update Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
    [orgId, slug('provider-update-org')],
  );

  await client.query(
    `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
     VALUES ($1::uuid, $2::uuid, 'Provider Update Client', $3, 'standard', 'active')`,
    [clientId, orgId, slug('provider-update-client')],
  );

  await client.query(
    `INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
     VALUES ($1::uuid, $2::uuid, 'Provider Update Sender', 'Provider Update Sender', true, 'active')`,
    [senderId, clientId],
  );

  await client.query(
    `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
     VALUES ($1::uuid, 'webhook_inbound', $2, '{}'::jsonb, 1, 'provider update test mapping')`,
    [mappingConfigId, slug('provider-update-mapping')],
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
        sender_id,
        rate_limit_per_hour,
        enabled
      )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3,
       'Provider Update Source',
       'api_gateway',
       $4,
       $5::uuid,
       $6::uuid,
       1000,
       true
     )`,
    [sourceId, orgId, slug('provider-update-source'), sourceToken, mappingConfigId, senderId],
  );

  const { rows: secretRows } = await client.query(
    `SELECT vault.create_secret($1::text, $2::text, $3::text, NULL) AS id`,
    [
      JSON.stringify({ username: 'provider-update@example.test', password: 'provider-update-pass' }),
      `provider_auth_configs/${providerAuthConfigId}`,
      'provider update test basic_auth',
    ],
  );

  await client.query(
    `INSERT INTO provider_auth_configs (
        id,
        provider_id,
        auth_type,
        credentials_vault_id,
        credentials,
        expires_at
      )
     VALUES (
       $1::uuid,
       $2::uuid,
       'basic_auth',
       $3::uuid,
       NULL,
       NULL
     )`,
    [providerAuthConfigId, providerId, secretRows[0].id],
  );

  const settingsVersionId = randomUUID();
  await client.query(
    `INSERT INTO settings_versions_p0 (
        id,
        category,
        scope_type,
        scope_id,
        scope_hash,
        version,
        value,
        schema_version,
        change_reason,
        approved_at,
        effective_from
      )
     VALUES (
       $1::uuid,
       'logestechs_v2_account',
       'source',
       $2::uuid,
       $2::uuid,
       1,
       $3::jsonb,
       1,
       'integration provider update binding',
       now(),
       now()
     )`,
    [
      settingsVersionId,
      sourceId,
      JSON.stringify({
        auth_config_id: providerAuthConfigId,
        company_id: '362',
        enabled: true,
      }),
    ],
  );

  await client.query(
    `INSERT INTO settings (
        category,
        scope_type,
        scope_id,
        scope_hash,
        settings_version_id,
        cached_value,
        last_updated
      )
     VALUES (
       'logestechs_v2_account',
       'source',
       $1::uuid,
       $1::uuid,
       $2::uuid,
       $3::jsonb,
       now()
     )`,
    [
      sourceId,
      settingsVersionId,
      JSON.stringify({
        auth_config_id: providerAuthConfigId,
        company_id: '362',
        enabled: true,
      }),
    ],
  );
}

async function insertAddress(client, organizationId, clientId, overrides = {}) {
  const addressId = randomUUID();
  const rawPayload = {
    line1: overrides.line1 || 'Unknown street',
    line2: overrides.line2 || '',
    city: overrides.city || null,
    district: overrides.district || null,
    province: overrides.province || null,
    country: overrides.country || 'SA',
  };

  await client.query(
    `INSERT INTO addresses (
        id,
        organization_id,
        client_id,
        raw_input,
        line1,
        line2,
        normalized_line1,
        normalized_line2,
        city,
        province,
        country,
        district,
        validation_status,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::jsonb,
        $5::text,
        $6::text,
        $5::text,
        $6::text,
        $7::text,
        $8::text,
        $9::text,
        $10::text,
        'unvalidated',
        now(),
        now()
      )`,
    [
      addressId,
      organizationId,
      clientId,
      JSON.stringify(rawPayload),
      overrides.line1 || 'Unknown street',
      overrides.line2 || '',
      overrides.city || null,
      overrides.province || null,
      overrides.country || 'SA',
      overrides.district || null,
    ],
  );

  return addressId;
}

async function seedShipmentForProviderUpdate(client, params) {
  const {
    orgId,
    clientId,
    senderId,
    providerId,
    logisticsReference,
    destinationAddressId,
  } = params;

  const shipmentId = randomUUID();
  const trackingNumber = `TRACK-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  await client.query(
    `INSERT INTO public.shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        tracking_number,
        service_type,
        status,
        destination_address_id,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5,
        'delivery',
        'pending',
        $6::uuid,
        now(),
        now()
      )`,
    [shipmentId, orgId, clientId, senderId, trackingNumber, destinationAddressId],
  );

  await client.query(
    `SELECT public.upsert_shipment_reference_number_v1(
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'logistics_reference_number',
        $4::text,
        'provider',
        $5::uuid,
        $6::jsonb
      )`,
    [
      orgId,
      clientId,
      shipmentId,
      logisticsReference,
      providerId,
      JSON.stringify({ source: 'integration-test' }),
    ],
  );

  return { shipmentId, trackingNumber };
}

async function intakeProviderUpdate(client, { sourceToken, shipmentId, requestBody }) {
  const { rows } = await client.query(
    `SELECT public.workflow_intake_api_gateway_v1(
        $1::text,
        'PUT',
        $2::text,
        '',
        jsonb_build_object('content-type', 'application/json', 'x-webhook-token', $1::text),
        $3::jsonb
      ) AS result`,
    [sourceToken, `/api/guests/362/packages/${shipmentId}`, JSON.stringify(requestBody)],
  );

  return rows[0].result;
}

async function waitForProviderUpdateOutbound(client, intakeResult, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await client.query(`SELECT public.progress_workflow_run($1::uuid)`, [
      intakeResult.workflow_run_id,
    ]);

    const { rows } = await client.query(
      `SELECT agr.route_id,
              agr.outbound_call_id,
              oc.method,
              oc.url,
              oc.body
         FROM public.api_gateway_requests agr
         LEFT JOIN public.outbound_calls oc
           ON oc.id = agr.outbound_call_id
        WHERE agr.id = $1::uuid`,
      [intakeResult.api_gateway_request_id],
    );

    if (rows[0]?.outbound_call_id) {
      return rows[0];
    }

    await sleep(100);
  }

  throw new Error(`Provider update outbound call was not created for ${intakeResult.api_gateway_request_id}`);
}

describe('API gateway provider update postprocess', () => {
  let client;

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT public.create_next_partitions()');
    await clearPolicyCache(client, 'logestechs_v2_account');
  });

  afterEach(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    client.release();
    client = null;
  });

  test('dispatches canonical provider update and reconciles shipment destination address on success', async () => {
    const route = await resolveCanonicalUpdateRoute(client);
    const orgId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const sourceId = randomUUID();
    const sourceToken = `provider-update-token-${randomUUID()}`;
    const externalShipmentId = `PROV-UPD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

    const { stepId: workflowStepId } = await createWorkflowContext(client, {
      scopeType: 'global',
      context: {},
      local: true,
    });
    expect(workflowStepId).toBeTruthy();

    await seedGatewaySource(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      sourceToken,
      providerId: route.provider_id,
    });

    const oldAddressId = await insertAddress(client, orgId, clientId, {
      line1: 'Old Street 1',
      city: 'Riyadh',
      province: 'Riyadh',
      country: 'SA',
    });

    const { shipmentId } = await seedShipmentForProviderUpdate(client, {
      orgId,
      clientId,
      senderId,
      providerId: route.provider_id,
      logisticsReference: externalShipmentId,
      destinationAddressId: oldAddressId,
    });

    const intakeResult = await intakeProviderUpdate(client, {
      sourceToken,
      shipmentId: externalShipmentId,
      requestBody: {
        email: 'provider-update@example.test',
        password: 'provider-update-pass',
        destinationAddress: {
          addressLine1: 'New Update Street 99',
          addressLine2: 'Floor 4',
          city: 'Jeddah',
          region: 'Makkah',
          country: 'SA',
          zipCode: '21577',
        },
      },
    });

    expect(intakeResult).toMatchObject({
      action: 'accepted_async',
      status: 202,
      api_gateway_request_id: expect.any(String),
      workflow_run_id: expect.any(String),
    });

    const outbound = await waitForProviderUpdateOutbound(client, intakeResult);
    const outboundCallId = outbound.outbound_call_id;
    expect(outbound.route_id).toBe(route.id);
    expect(outbound).toMatchObject({
      method: 'PUT',
      url: `https://apisv2.logestechs.com/api/guests/362/packages/${externalShipmentId}`,
    });
    expect(outbound.body.email).toBeUndefined();
    expect(outbound.body.password).toBeUndefined();

    await client.query(
      `UPDATE public.outbound_calls
          SET status = 'completed',
              response_status_code = 200,
              updated_at = now()
        WHERE id = $1::uuid`,
      [outboundCallId],
    );

    const { rows: postRows } = await client.query(
      `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
          (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
          '{}'::jsonb
        ) AS result`,
      [outboundCallId],
    );

    expect(postRows[0].result?.postprocess).toMatchObject({
      mode: 'shipment_update_v1',
      shipment_id: shipmentId,
      status: 'updated',
    });

    const { rows: shipmentRows } = await client.query(
      `SELECT destination_address_id, metadata #>> '{provider_update,api_gateway_request_id}' AS request_id
         FROM public.shipments
        WHERE id = $1::uuid`,
      [shipmentId],
    );

    expect(shipmentRows[0].destination_address_id).toBeTruthy();
    expect(shipmentRows[0].destination_address_id).not.toBe(oldAddressId);
    expect(shipmentRows[0].request_id).toBe(String(intakeResult.api_gateway_request_id));

    const { rows: addressRows } = await client.query(
      `SELECT line1, line2, city, province, postal_code, country
         FROM public.addresses
        WHERE id = $1::uuid`,
      [shipmentRows[0].destination_address_id],
    );
    expect(addressRows[0]).toMatchObject({
      line1: 'New Update Street 99',
      line2: 'Floor 4',
      city: 'Jeddah',
      province: 'Makkah',
      postal_code: '21577',
      country: 'SA',
    });

    const { rows: actionRows } = await client.query(
      `SELECT action_type, action_category, action_data
         FROM public.shipment_actions
        WHERE shipment_id = $1::uuid
          AND action_type = 'address_update'
        ORDER BY created_at DESC
        LIMIT 1`,
      [shipmentId],
    );
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0].action_category).toBe('administrative');
    expect(actionRows[0].action_data).toMatchObject({
      api_gateway_request_id: intakeResult.api_gateway_request_id,
      provider_shipment_id: externalShipmentId,
      address_id: shipmentRows[0].destination_address_id,
    });
  });

  test('skips shipment mutation when provider update upstream call is not successful', async () => {
    const route = await resolveCanonicalUpdateRoute(client);
    const orgId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const sourceId = randomUUID();
    const sourceToken = `provider-update-token-${randomUUID()}`;
    const externalShipmentId = `PROV-UPD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

    await createWorkflowContext(client, {
      scopeType: 'global',
      context: {},
      local: true,
    });

    await seedGatewaySource(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      sourceToken,
      providerId: route.provider_id,
    });

    const oldAddressId = await insertAddress(client, orgId, clientId, {
      line1: 'Old Guard Street 1',
      city: 'Riyadh',
      province: 'Riyadh',
      country: 'SA',
    });

    const { shipmentId } = await seedShipmentForProviderUpdate(client, {
      orgId,
      clientId,
      senderId,
      providerId: route.provider_id,
      logisticsReference: externalShipmentId,
      destinationAddressId: oldAddressId,
    });

    const intakeResult = await intakeProviderUpdate(client, {
      sourceToken,
      shipmentId: externalShipmentId,
      requestBody: {
        email: 'provider-update@example.test',
        password: 'provider-update-pass',
        destinationAddress: {
          addressLine1: 'Should Not Apply',
          city: 'Dammam',
          region: 'Eastern Province',
          country: 'SA',
        },
      },
    });

    expect(intakeResult).toMatchObject({
      action: 'accepted_async',
      status: 202,
      api_gateway_request_id: expect.any(String),
      workflow_run_id: expect.any(String),
    });

    const outboundCallId = (await waitForProviderUpdateOutbound(client, intakeResult)).outbound_call_id;
    expect(outboundCallId).toBeTruthy();

    await client.query(
      `UPDATE public.outbound_calls
          SET status = 'failed',
              response_status_code = 500,
              updated_at = now()
        WHERE id = $1::uuid`,
      [outboundCallId],
    );

    const { rows: postRows } = await client.query(
      `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
          (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
          jsonb_build_object('error', 'provider_down')
        ) AS result`,
      [outboundCallId],
    );

    expect(postRows[0].result?.postprocess).toMatchObject({
      mode: 'shipment_update_v1',
      status: 'skipped',
      reason: 'upstream_not_successful',
    });

    const { rows: shipmentRows } = await client.query(
      `SELECT destination_address_id
         FROM public.shipments
        WHERE id = $1::uuid`,
      [shipmentId],
    );
    expect(shipmentRows[0].destination_address_id).toBe(oldAddressId);

    const { rows: actionCountRows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM public.shipment_actions
        WHERE shipment_id = $1::uuid
          AND action_type = 'address_update'`,
      [shipmentId],
    );
    expect(actionCountRows[0].count).toBe(0);

    const { rows: addressCountRows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM public.addresses
        WHERE client_id = $1::uuid`,
      [clientId],
    );
    expect(addressCountRows[0].count).toBe(1);
  });
});
