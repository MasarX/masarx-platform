const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const { applySetting, createWorkflowContext } = require('../helpers/tenant-utils');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must be defined for shipment reference tests');

const maxPool = Number(process.env.TEST_DB_POOL_MAX || '4');
const pool = new Pool({ connectionString: DATABASE_URL, max: maxPool });

function slug(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function clearPolicyCache(client, category) {
  await client.query(
    `DELETE FROM settings_cache
      WHERE cache_key LIKE $1`,
    [`${category}:%`],
  );
}

async function insertGatewayFixture(client, { orgId, clientId, senderId, providerId, sourceId }) {
  await client.query(
    `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
     VALUES ($1::uuid, 'Refs Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
    [orgId, slug('refs-org')]
  );

  await client.query(
    `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
     VALUES ($1::uuid, $2::uuid, 'Refs Client', $3, 'standard', 'active')`,
    [clientId, orgId, slug('refs-client')]
  );

  await client.query(
    `INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
     VALUES ($1::uuid, $2::uuid, 'Refs Sender', 'Refs Sender', true, 'active')`,
    [senderId, clientId]
  );

  await client.query(
    `INSERT INTO providers (id, organization_id, name, provider_type, enabled)
     VALUES ($1::uuid, $2::uuid, 'Refs Provider', 'delivery', true)`,
    [providerId, orgId]
  );

  const { rows: mappingRows } = await client.query(
    `INSERT INTO mapping_configs (mapping_type, mapping_key, mapping_config, mapping_version, notes)
     VALUES ('webhook_inbound', $1, '{}'::jsonb, 1, 'refs test mapping')
     RETURNING id`,
    [slug('refs-mapping')]
  );
  const mappingConfigId = mappingRows[0].id;

  await client.query(
    `INSERT INTO webhook_sources (
        id,
        organization_id,
        source_identifier,
        name,
        provider_type,
        auth_token,
        mapping_config_id,
        rate_limit_per_hour,
        enabled
      )
     VALUES ($1::uuid, $2::uuid, $3, 'Refs Source', 'api_gateway', $4, $5::uuid, 1000, true)`,
    [sourceId, orgId, slug('refs-source'), slug('refs-token'), mappingConfigId]
  );

  const { rows: packRows } = await client.query(
    `INSERT INTO api_route_packs (name, description, enabled)
     VALUES ($1, 'refs test pack', true)
     RETURNING id`,
    [slug('refs-pack')]
  );
  const packId = packRows[0].id;

  const policy = {
    postprocess: {
      enabled: true,
      mode: 'shipment_create_v1',
      service_type: 'delivery',
      shipment_status: 'pending',
      extract: {
        recipient_name_path: 'recipient.name',
        recipient_phone_path: 'recipient.phone',
        client_reference_path: 'client_reference_number',
        provider_shipment_id_path: 'id',
        provider_reference_id_path: 'reference_id',
        provider_tracking_number_path: 'barcode',
        origin_line1_path: 'origin.line1',
        origin_city_path: 'origin.city',
        origin_province_path: 'origin.province',
        origin_country_path: 'origin.country',
        destination_line1_path: 'destination.line1',
        destination_city_path: 'destination.city',
        destination_province_path: 'destination.province',
        destination_country_path: 'destination.country',
      },
      geocoding: { enabled: false },
      label: { enabled: false },
    },
  };

  const { rows: routeRows } = await client.query(
    `INSERT INTO api_routes (
        pack_id,
        route_name,
        enabled,
        method,
        path_template,
        scope_type,
        scope_id,
        provider_id,
        upstream_method,
        upstream_path_template,
        policy
      )
     VALUES (
        $1::uuid,
        'refs_test_route',
        true,
        'POST',
        '/api/refs/test',
        'global',
        NULL,
        $2::uuid,
        'POST',
        '/upstream/refs/test',
        $3::jsonb
      )
     RETURNING id`,
    [packId, providerId, JSON.stringify(policy)]
  );
  return { routeId: routeRows[0].id };
}

async function insertGatewayRequestAndOutboundCall(client, params) {
  const {
    orgId,
    clientId,
    senderId,
    sourceId,
    routeId,
    providerId,
    workflowStepId,
    clientReferenceNumber,
    requestId = randomUUID(),
    outboundCallId = randomUUID(),
    correlationId = randomUUID(),
  } = params;

  const requestBody = {
    recipient: { name: 'QA Receiver', phone: `+966${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}` },
    client_reference_number: clientReferenceNumber,
    origin: { line1: 'Origin', city: 'Riyadh', province: 'Riyadh', country: 'SA' },
    destination: { line1: 'Destination', city: 'Riyadh', province: 'Riyadh', country: 'SA' },
  };

  await client.query(
    `INSERT INTO api_gateway_requests (
        id,
        organization_id,
        client_id,
        sender_id,
        source_id,
        correlation_id,
        route_id,
        method,
        path,
        query_string,
        request_headers,
        request_body,
        received_at,
        created_at,
        updated_at
      )
     VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        'POST',
        '/api/refs/test',
        NULL,
        '{}'::jsonb,
        $8::jsonb,
        now(),
        now(),
        now()
      )`,
    [requestId, orgId, clientId, senderId, sourceId, correlationId, routeId, JSON.stringify(requestBody)]
  );

  await client.query(
    `INSERT INTO outbound_calls (
        id,
        call_type,
        target_type,
        target_id,
        method,
        url,
        headers,
        body,
        status,
        priority,
        retry_count,
        max_retries,
        scheduled_at,
        correlation_id,
        context,
        created_at,
        workflow_run_step_id
      )
     VALUES (
        $1::uuid,
        'provider_api',
        'provider',
        $2::uuid,
        'POST',
        'https://example.test/upstream/refs/test',
        '{}'::jsonb,
        $3::jsonb,
        'completed',
        100,
        0,
        1,
        now(),
        $4::uuid,
        jsonb_build_object('api_gateway_request_id', $5::uuid),
        now(),
        $6::uuid
      )`,
    [outboundCallId, providerId, JSON.stringify(requestBody), correlationId, requestId, workflowStepId]
  );

  await client.query(
    `UPDATE api_gateway_requests
     SET outbound_call_id = $1::uuid, updated_at = now()
     WHERE id = $2::uuid`,
    [outboundCallId, requestId]
  );

  return { requestId, outboundCallId, correlationId };
}

describe('Shipment references (SSOT + client reference uniqueness)', () => {
  let client;

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT public.create_next_partitions()');
    await clearPolicyCache(client, 'shipment_reference_policy');
  });

  afterEach(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    client.release();
    client = null;
  });

  test('duplicate client_reference_number reuses shipment and keeps multiple logistics refs', async () => {
    const orgId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const providerId = randomUUID();
    const sourceId = randomUUID();

    const { stepId: workflowStepId } = await createWorkflowContext(client, {
      scopeType: 'global',
      context: {},
      local: true,
    });

    const { routeId } = await insertGatewayFixture(client, {
      orgId,
      clientId,
      senderId,
      providerId,
      sourceId,
    });

    const clientReferenceNumber = `INV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const call1 = await insertGatewayRequestAndOutboundCall(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      routeId,
      providerId,
      workflowStepId,
      clientReferenceNumber,
    });

    const providerResponse1 = { id: 'PROV-SHIP-1', barcode: 'TRACK-1', reference_id: 'REF-1' };
    const { rows: r1 } = await client.query(
      `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
        (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
        $2::jsonb
      ) AS result`,
      [call1.outboundCallId, JSON.stringify(providerResponse1)]
    );

    expect(r1[0].result?.postprocess?.operation).toBe('inserted');
    const shipmentId1 = r1[0].result?.postprocess?.shipment_id;
    expect(shipmentId1).toBeTruthy();

    const call2 = await insertGatewayRequestAndOutboundCall(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      routeId,
      providerId,
      workflowStepId,
      clientReferenceNumber,
    });

    const providerResponse2 = { id: 'PROV-SHIP-2', barcode: 'TRACK-2', reference_id: 'REF-2' };
    const { rows: r2 } = await client.query(
      `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
        (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
        $2::jsonb
      ) AS result`,
      [call2.outboundCallId, JSON.stringify(providerResponse2)]
    );

    expect(r2[0].result?.postprocess?.operation).toBe('reused_client_reference');
    const shipmentId2 = r2[0].result?.postprocess?.shipment_id;
    expect(shipmentId2).toBe(shipmentId1);

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS cnt
         FROM public.shipments
        WHERE client_id = $1::uuid
          AND client_reference_upper = upper($2)`,
      [clientId, clientReferenceNumber]
    );
    expect(countRows[0].cnt).toBe(1);

    const { rows: refRows } = await client.query(
      `SELECT COUNT(*)::int AS cnt
         FROM public.shipment_reference_numbers
        WHERE client_id = $1::uuid
          AND shipment_id = $2::uuid
          AND reference_type = 'logistics_reference_number'
          AND reference_value_upper = ANY($3::text[])`,
      [clientId, shipmentId1, ['TRACK-1', 'TRACK-2']]
    );
    expect(refRows[0].cnt).toBe(2);
  });

  test('duplicate tracking_number reuses shipment under the same operation contract', async () => {
    const orgId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const providerId = randomUUID();
    const sourceId = randomUUID();

    const { stepId: workflowStepId } = await createWorkflowContext(client, {
      scopeType: 'global',
      context: {},
      local: true,
    });

    const { routeId } = await insertGatewayFixture(client, {
      orgId,
      clientId,
      senderId,
      providerId,
      sourceId,
    });

    const trackingNumber = `TRACK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const firstClientReference = `INV-A-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const call1 = await insertGatewayRequestAndOutboundCall(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      routeId,
      providerId,
      workflowStepId,
      clientReferenceNumber: firstClientReference,
    });

    const providerResponse1 = { id: 'PROV-TRACK-1', barcode: trackingNumber, reference_id: 'TRACK-REF-1' };
    const { rows: r1 } = await client.query(
      `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
        (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
        $2::jsonb
      ) AS result`,
      [call1.outboundCallId, JSON.stringify(providerResponse1)]
    );
    expect(r1[0].result?.postprocess?.operation).toBe('inserted');
    const shipmentId1 = r1[0].result?.postprocess?.shipment_id;
    expect(shipmentId1).toBeTruthy();

    const secondClientReference = `INV-B-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const call2 = await insertGatewayRequestAndOutboundCall(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      routeId,
      providerId,
      workflowStepId,
      clientReferenceNumber: secondClientReference,
    });

    const providerResponse2 = { id: 'PROV-TRACK-2', barcode: trackingNumber, reference_id: 'TRACK-REF-2' };
    const { rows: r2 } = await client.query(
      `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
        (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
        $2::jsonb
      ) AS result`,
      [call2.outboundCallId, JSON.stringify(providerResponse2)]
    );

    expect(r2[0].result?.postprocess?.operation).toBe('reused');
    expect(r2[0].result?.postprocess?.shipment_id).toBe(shipmentId1);

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS cnt
         FROM public.shipments
        WHERE client_id = $1::uuid
          AND tracking_upper = upper($2)`,
      [clientId, trackingNumber]
    );
    expect(countRows[0].cnt).toBe(1);

    const { rows: shipmentRows } = await client.query(
      `SELECT client_reference_number
         FROM public.shipments
        WHERE id = $1::uuid`,
      [shipmentId1]
    );
    expect(shipmentRows[0].client_reference_number).toBe(firstClientReference);
    expect(shipmentRows[0].client_reference_number).not.toBe(secondClientReference);
  });

  test('tracking and client reference that point to different shipments fail closed', async () => {
    const orgId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const providerId = randomUUID();
    const sourceId = randomUUID();

    const { stepId: workflowStepId } = await createWorkflowContext(client, {
      scopeType: 'global',
      context: {},
      local: true,
    });

    const { routeId } = await insertGatewayFixture(client, {
      orgId,
      clientId,
      senderId,
      providerId,
      sourceId,
    });

    const clientReferenceA = `INV-A-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const clientReferenceB = `INV-B-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const callA = await insertGatewayRequestAndOutboundCall(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      routeId,
      providerId,
      workflowStepId,
      clientReferenceNumber: clientReferenceA,
    });

    const { rows: firstRows } = await client.query(
      `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
        (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
        $2::jsonb
      ) AS result`,
      [callA.outboundCallId, JSON.stringify({ id: 'PROV-MISMATCH-1', barcode: 'TRACK-MISMATCH-1', reference_id: 'REF-MISMATCH-1' })]
    );
    expect(firstRows[0].result?.postprocess?.operation).toBe('inserted');

    const callB = await insertGatewayRequestAndOutboundCall(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      routeId,
      providerId,
      workflowStepId,
      clientReferenceNumber: clientReferenceB,
    });

    const { rows: secondRows } = await client.query(
      `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
        (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
        $2::jsonb
      ) AS result`,
      [callB.outboundCallId, JSON.stringify({ id: 'PROV-MISMATCH-2', barcode: 'TRACK-MISMATCH-2', reference_id: 'REF-MISMATCH-2' })]
    );
    expect(secondRows[0].result?.postprocess?.operation).toBe('inserted');

    const conflictingCall = await insertGatewayRequestAndOutboundCall(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      routeId,
      providerId,
      workflowStepId,
      clientReferenceNumber: clientReferenceB,
    });

    await expect(
      client.query(
        `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
          (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
          $2::jsonb
        ) AS result`,
        [conflictingCall.outboundCallId, JSON.stringify({ id: 'PROV-MISMATCH-3', barcode: 'TRACK-MISMATCH-1', reference_id: 'REF-MISMATCH-3' })]
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining('shipment_create_duplicate_key_mismatch'),
    });
  });

  test('shipment_label_payload_v reference_number follows shipment_reference_policy order', async () => {
    const orgId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const providerId = randomUUID();
    const sourceId = randomUUID();

    const { stepId: workflowStepId } = await createWorkflowContext(client, {
      scopeType: 'global',
      context: {},
      local: true,
    });

    const { routeId } = await insertGatewayFixture(client, {
      orgId,
      clientId,
      senderId,
      providerId,
      sourceId,
    });

    const clientReferenceNumber = `INV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const call = await insertGatewayRequestAndOutboundCall(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      routeId,
      providerId,
      workflowStepId,
      clientReferenceNumber,
    });

    const providerResponse = { id: 'PROV-SHIP-3', barcode: 'TRACK-3', reference_id: 'REF-3' };
    const { rows } = await client.query(
      `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
        (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
        $2::jsonb
      ) AS result`,
      [call.outboundCallId, JSON.stringify(providerResponse)]
    );
    const shipmentId = rows[0].result?.postprocess?.shipment_id;
    expect(shipmentId).toBeTruthy();

    const { rows: defaultRows } = await client.query(
      `SELECT reference_number
         FROM public.shipment_label_payload_v
        WHERE shipment_id = $1::uuid
        LIMIT 1`,
      [shipmentId]
    );
    expect(defaultRows[0].reference_number).toBe(clientReferenceNumber);

    const overridePolicy = {
      version: 1,
      label: { reference_order: ['carrier_reference_number', 'tracking_number', 'client_reference_number'] },
    };
    await applySetting(client, {
      category: 'shipment_reference_policy',
      scopeType: 'sender',
      scopeId: senderId,
      value: overridePolicy,
      version: 1,
      schemaVersion: 1,
    });
    await clearPolicyCache(client, 'shipment_reference_policy');

    const { rows: overriddenRows } = await client.query(
      `SELECT reference_number
         FROM public.shipment_label_payload_v
        WHERE shipment_id = $1::uuid
        LIMIT 1`,
      [shipmentId]
    );
    expect(overriddenRows[0].reference_number).toBe('REF-3');
  });

  test('shipment_label_payload_v reference_number falls back to canonical references when shipment columns are blank', async () => {
    const orgId = randomUUID();
    const clientId = randomUUID();
    const senderId = randomUUID();
    const providerId = randomUUID();
    const sourceId = randomUUID();

    const { stepId: workflowStepId } = await createWorkflowContext(client, {
      scopeType: 'global',
      context: {},
      local: true,
    });

    const { routeId } = await insertGatewayFixture(client, {
      orgId,
      clientId,
      senderId,
      providerId,
      sourceId,
    });

    const clientReferenceNumber = `INV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const call = await insertGatewayRequestAndOutboundCall(client, {
      orgId,
      clientId,
      senderId,
      sourceId,
      routeId,
      providerId,
      workflowStepId,
      clientReferenceNumber,
    });

    const providerResponse = { id: 'PROV-SHIP-4', barcode: 'TRACK-4', reference_id: 'REF-4' };
    const { rows } = await client.query(
      `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
        (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
        $2::jsonb
      ) AS result`,
      [call.outboundCallId, JSON.stringify(providerResponse)]
    );
    const shipmentId = rows[0].result?.postprocess?.shipment_id;
    expect(shipmentId).toBeTruthy();

    await client.query(
      `UPDATE public.shipments
          SET client_reference_number = NULL,
              carrier_reference_number = NULL,
              updated_at = now()
        WHERE id = $1::uuid
          AND client_id = $2::uuid`,
      [shipmentId, clientId]
    );

    const { rows: clearedRows } = await client.query(
      `SELECT reference_number
         FROM public.shipment_label_payload_v
        WHERE shipment_id = $1::uuid
        LIMIT 1`,
      [shipmentId]
    );
    expect(clearedRows[0].reference_number).toBe(clientReferenceNumber);

    const overridePolicy = {
      version: 1,
      label: { reference_order: ['carrier_reference_number', 'tracking_number', 'client_reference_number'] },
    };
    await applySetting(client, {
      category: 'shipment_reference_policy',
      scopeType: 'sender',
      scopeId: senderId,
      value: overridePolicy,
      version: 1,
      schemaVersion: 1,
    });
    await clearPolicyCache(client, 'shipment_reference_policy');

    const { rows: overriddenRows } = await client.query(
      `SELECT reference_number
         FROM public.shipment_label_payload_v
        WHERE shipment_id = $1::uuid
        LIMIT 1`,
      [shipmentId]
    );
    expect(overriddenRows[0].reference_number).toBe('REF-4');
  });
});
