const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { skipIfMissing } = require('../utils/test-env');

loadEnv();

const missing = skipIfMissing(['SUPABASE_URL', 'DATABASE_URL'], 'api-gateway edge e2e');
const httpEnabled = process.env.RUN_API_GATEWAY_HTTP_TESTS === 'true' && !missing;

const { SUPABASE_URL, DATABASE_URL } = process.env;
const OUTER_AUTH_VALUE =
  process.env.API_GATEWAY_TEST_AUTH ||
  process.env.WEBHOOK_TEST_AUTH ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  null;

const pool = new Pool({ connectionString: DATABASE_URL });

jest.setTimeout(150000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const describeIfHttp = httpEnabled ? describe : describe.skip;

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

async function insertGatewayFixture(client, fixture) {
  await client.query(
    `DELETE FROM api_routes
      WHERE method = 'POST'
        AND path_template = '/api/ship/request/by-email'
        AND scope_type = 'global'
        AND scope_id IS NULL`,
  );

  await client.query(
    `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
     VALUES ($1::uuid, 'UC026 API Gateway Org', $2, 'Asia/Riyadh', 'en-US', 'active')`,
    [fixture.organizationId, fixture.organizationSlug],
  );

  await client.query(
    `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
     VALUES ($1::uuid, $2::uuid, 'UC026 API Gateway Client', $3, 'standard', 'active')`,
    [fixture.clientId, fixture.organizationId, fixture.clientSlug],
  );

  await client.query(
    `INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
     VALUES ($1::uuid, $2::uuid, 'UC026 API Gateway Sender', 'UC026 API Gateway Sender', true, 'active')`,
    [fixture.senderId, fixture.clientId],
  );

  await client.query(
    `INSERT INTO providers (id, organization_id, name, provider_type, enabled, metadata)
     VALUES ($1::uuid, $2::uuid, 'UC026 API Gateway Provider', 'delivery', true, $3::jsonb)`,
    [
      fixture.providerId,
      fixture.organizationId,
      JSON.stringify({ base_url: 'https://example.test' }),
    ],
  );

  await client.query(
    `INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
     VALUES ($1::uuid, 'webhook_inbound', $2, '{}'::jsonb, 1, 'UC026 api-gateway mapping fixture')`,
    [fixture.mappingConfigId, fixture.mappingKey],
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
      'UC026 API Gateway Source',
      'api_gateway',
      $4,
      $5::uuid,
      $6::uuid,
      1000,
      true
    )`,
    [
      fixture.sourceId,
      fixture.organizationId,
      fixture.sourceIdentifier,
      fixture.sourceToken,
      fixture.mappingConfigId,
      fixture.senderId,
    ],
  );

  await client.query(
    `INSERT INTO api_route_packs (id, name, description, enabled)
     VALUES ($1::uuid, $2, 'UC026 api-gateway intake fixture pack', true)`,
    [fixture.packId, fixture.packName],
  );

  const policy = {
    priority: 100,
    max_retries: 1,
    delivery: {
      mode: 'accepted_async',
      status_code: 202,
      headers: { 'content-type': 'application/json' },
    },
    postprocess: {
      enabled: true,
      mode: 'shipment_create_v1',
      service_type: 'delivery',
      shipment_status: 'pending',
      geocoding: { enabled: false },
      label: { enabled: false },
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
    },
  };

  await client.query(
    `INSERT INTO api_routes (
        id,
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
        $2::uuid,
        'uc026_api_gateway_create',
        true,
        'POST',
        '/api/ship/request/by-email',
        'global',
        NULL,
        $3::uuid,
        'POST',
        '/provider/ship/request/by-email',
        $4::jsonb
      )`,
    [fixture.routeId, fixture.packId, fixture.providerId, JSON.stringify(policy)],
  );
}

async function cleanupGatewayArtifacts(fixture) {
  const requestRows = await pool.query(
    `SELECT id, outbound_call_id, correlation_id
       FROM api_gateway_requests
      WHERE source_id = $1::uuid`,
    [fixture.sourceId],
  );
  const requestIds = requestRows.rows.map((row) => row.id).filter(Boolean);
  const outboundIds = requestRows.rows.map((row) => row.outbound_call_id).filter(Boolean);
  const correlationIds = requestRows.rows.map((row) => row.correlation_id).filter(Boolean);

  await pool.query(
    `DELETE FROM shipment_reference_numbers
      WHERE client_id = $1::uuid`,
    [fixture.clientId],
  );
  await pool.query(
    `DELETE FROM shipments
      WHERE client_id = $1::uuid`,
    [fixture.clientId],
  );

  if (correlationIds.length) {
    await pool.query(
      `DELETE FROM api_call_log
        WHERE correlation_id = ANY($1::uuid[])`,
      [correlationIds],
    );
  }

  if (requestIds.length) {
    await pool.query(
      `DELETE FROM decision_log
        WHERE resource_type = 'api_gateway_request'
          AND resource_id = ANY($1::uuid[])`,
      [requestIds],
    );
    await pool.query(
      `DELETE FROM api_gateway_requests
        WHERE id = ANY($1::uuid[])`,
      [requestIds],
    );
  }

  if (outboundIds.length) {
    await pool.query(
      `DELETE FROM outbound_calls
        WHERE id = ANY($1::uuid[])`,
      [outboundIds],
    );
  }

  await pool.query(
    `DELETE FROM api_gateway_rate_limits
      WHERE source_id = $1::uuid`,
    [fixture.sourceId],
  );
}

async function cleanupGatewayFixture(fixture) {
  await cleanupGatewayArtifacts(fixture);

  await pool.query(
    `DELETE FROM api_routes
      WHERE method = 'POST'
        AND path_template = '/api/ship/request/by-email'
        AND scope_type = 'global'
        AND scope_id IS NULL`,
  );

  await pool.query(
    `DELETE FROM decision_log
      WHERE organization_id = $1::uuid`,
    [fixture.organizationId],
  );
  await pool.query(
    `DELETE FROM settings_resolution_log
      WHERE organization_id = $1::uuid
        AND category = 'api_gateway_route'`,
    [fixture.organizationId],
  );
  await pool.query(`DELETE FROM api_routes WHERE id = $1::uuid`, [fixture.routeId]);
  await pool.query(`DELETE FROM api_route_packs WHERE id = $1::uuid`, [fixture.packId]);
  await pool.query(`DELETE FROM webhook_sources WHERE id = $1::uuid`, [fixture.sourceId]);
  await pool.query(`DELETE FROM mapping_configs WHERE id = $1::uuid`, [fixture.mappingConfigId]);
  await pool.query(`DELETE FROM providers WHERE id = $1::uuid`, [fixture.providerId]);
  // Keep sender/client/org rows to avoid cascades into address_versions.
}

async function executeGatewayFetch(token, payload, options = {}) {
  const {
    upstreamPath = '/api/ship/request/by-email',
    usePathToken = true,
    includeFunctionAuthorization = true,
  } = options;

  const normalizedPath = upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`;
  const routePath = usePathToken
    ? `/functions/v1/api-gateway/t/${token}${normalizedPath}`
    : `/functions/v1/api-gateway${normalizedPath}`;
  const url = `${SUPABASE_URL.replace(/\/$/, '')}${routePath}`;

  const headers = {
    'content-type': 'application/json',
    ...(process.env.SUPABASE_ANON_KEY ? { apikey: process.env.SUPABASE_ANON_KEY } : {}),
  };

  if (includeFunctionAuthorization) {
    headers.authorization = `Bearer ${OUTER_AUTH_VALUE || token}`;
  }

  let response;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      break;
    } catch (error) {
      if (!isTransientFetchError(error) || attempt >= 5) {
        throw error;
      }
      await sleep(1000 * attempt);
    }
  }

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { response, body };
}

async function waitForGatewayRequest(fixture, clientReferenceNumber, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { rows } = await pool.query(
      `SELECT id,
              client_id,
              sender_id,
              outbound_call_id,
              correlation_id,
              method,
              path,
              request_body,
              created_at
         FROM api_gateway_requests
        WHERE source_id = $1::uuid
          AND request_body #>> '{client_reference_number}' = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [fixture.sourceId, clientReferenceNumber],
    );
    if (rows[0]) return rows[0];
    await sleep(200);
  }
  return null;
}

async function materializeGatewayResponse(outboundCallId, providerResponse) {
  const { rows } = await pool.query(
    `SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
        (SELECT oc FROM public.outbound_calls oc WHERE oc.id = $1::uuid),
        $2::jsonb
      ) AS result`,
    [outboundCallId, JSON.stringify(providerResponse)],
  );
  return rows[0]?.result || null;
}

async function fetchShipmentByClientReference(clientId, clientReferenceNumber) {
  const { rows } = await pool.query(
    `SELECT id, tracking_number, client_reference_number
       FROM shipments
      WHERE client_id = $1::uuid
        AND client_reference_upper = upper($2)
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientId, clientReferenceNumber],
  );
  return rows[0] || null;
}

describeIfHttp('API gateway shipment create ingress', () => {
  const fixture = {
    organizationId: randomUUID(),
    organizationSlug: `uc026-org-${Date.now().toString(36)}`,
    clientId: randomUUID(),
    clientSlug: `uc026-client-${Date.now().toString(36)}`,
    senderId: randomUUID(),
    providerId: randomUUID(),
    mappingConfigId: randomUUID(),
    mappingKey: `uc026::api-gateway::${randomUUID()}`,
    sourceId: randomUUID(),
    sourceIdentifier: `uc026-api-gateway-${randomUUID().slice(0, 8)}`,
    sourceToken: `uc026-api-gateway-token-${randomUUID()}`,
    packId: randomUUID(),
    packName: `uc026-pack-${randomUUID().slice(0, 8)}`,
    routeId: randomUUID(),
  };

  beforeAll(async () => {
    await cleanupGatewayFixture(fixture);
    await insertGatewayFixture(pool, fixture);
  });

  beforeEach(async () => {
    await cleanupGatewayArtifacts(fixture);
  });

  afterAll(async () => {
    try {
      await cleanupGatewayFixture(fixture);
    } finally {
      await pool.end();
    }
  });

  test('accepts shipment create over real HTTP, records route observability, and materializes shipment creation', async () => {
    const clientReferenceNumber = `INV-UC026-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      recipient: {
        name: 'UC026 Receiver',
        phone: `+9665${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      },
      client_reference_number: clientReferenceNumber,
      origin: { line1: 'Origin', city: 'Riyadh', province: 'Riyadh', country: 'SA' },
      destination: { line1: 'Destination', city: 'Jeddah', province: 'Makkah', country: 'SA' },
    };

    const { response, body } = await executeGatewayFetch(fixture.sourceToken, payload);
    if (response.status === 503) {
      console.warn('[api-gateway-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      status: 'accepted_async',
      correlation_id: expect.any(String),
    });

    const requestRow = await waitForGatewayRequest(fixture, clientReferenceNumber);
    expect(requestRow).toBeTruthy();
    expect(requestRow.path).toBe('/api/ship/request/by-email');
    expect(requestRow.method).toBe('POST');
    expect(requestRow.client_id).toBe(fixture.clientId);
    expect(requestRow.sender_id).toBe(fixture.senderId);
    expect(requestRow.correlation_id).toBe(body.correlation_id);
    expect(requestRow.outbound_call_id).toEqual(expect.any(String));

    const { rows: observabilityRows } = await pool.query(
      `SELECT event_source, event_type, resource_type, resource_id, status, correlation_id, metadata
         FROM observability_events_v
        WHERE event_source = 'decision_log'
          AND event_type = 'settings_resolution'
          AND resource_type = 'api_gateway_request'
          AND resource_id = $1::uuid
        ORDER BY event_time DESC
        LIMIT 1`,
      [requestRow.id],
    );
    expect(observabilityRows).toHaveLength(1);
    expect(observabilityRows[0].event_source).toBe('decision_log');
    expect(observabilityRows[0].event_type).toBe('settings_resolution');
    expect(observabilityRows[0].resource_type).toBe('api_gateway_request');
    expect(observabilityRows[0].resource_id).toBe(requestRow.id);
    expect(observabilityRows[0].status).toBe('resolved');
    expect(observabilityRows[0].correlation_id).toBe(requestRow.correlation_id);
    expect(observabilityRows[0].metadata?.decision_point).toBe('api_gateway_route_resolved');
    expect(observabilityRows[0].metadata?.decision_inputs?.outbound_call_id).toBe(requestRow.outbound_call_id);

    const postprocessResult = await materializeGatewayResponse(requestRow.outbound_call_id, {
      id: `PROV-${clientReferenceNumber}`,
      barcode: `TRACK-${Date.now()}`,
      reference_id: `REF-${Date.now()}`,
    });

    expect(postprocessResult?.postprocess?.operation).toBe('inserted');
    expect(postprocessResult?.postprocess?.shipment_id).toEqual(expect.any(String));

    const shipmentRow = await fetchShipmentByClientReference(fixture.clientId, clientReferenceNumber);
    expect(shipmentRow).toBeTruthy();
    expect(shipmentRow.id).toBe(postprocessResult.postprocess.shipment_id);
  });

  test('reuses the authoritative shipment-create contract for duplicate client references after real HTTP intake', async () => {
    const clientReferenceNumber = `INV-DUPE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const buildPayload = (label) => ({
      recipient: {
        name: `UC026 Receiver ${label}`,
        phone: `+9665${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      },
      client_reference_number: clientReferenceNumber,
      origin: { line1: 'Origin', city: 'Riyadh', province: 'Riyadh', country: 'SA' },
      destination: { line1: `Destination ${label}`, city: 'Dammam', province: 'Eastern', country: 'SA' },
    });

    const first = await executeGatewayFetch(fixture.sourceToken, buildPayload('A'));
    if (first.response.status === 503) {
      console.warn('[api-gateway-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }
    expect(first.response.status).toBe(202);

    const firstRequest = await waitForGatewayRequest(fixture, clientReferenceNumber);
    expect(firstRequest).toBeTruthy();
    const firstResult = await materializeGatewayResponse(firstRequest.outbound_call_id, {
      id: `PROV-A-${clientReferenceNumber}`,
      barcode: `TRACK-A-${Date.now()}`,
      reference_id: `REF-A-${Date.now()}`,
    });
    expect(firstResult?.postprocess?.operation).toBe('inserted');
    const shipmentId = firstResult?.postprocess?.shipment_id;
    expect(shipmentId).toBeTruthy();

    const second = await executeGatewayFetch(fixture.sourceToken, buildPayload('B'));
    if (second.response.status === 503) {
      console.warn('[api-gateway-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }
    expect(second.response.status).toBe(202);

    let secondRequest = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      secondRequest = await waitForGatewayRequest(fixture, clientReferenceNumber);
      if (secondRequest && secondRequest.id !== firstRequest.id) break;
      await sleep(200);
    }
    expect(secondRequest).toBeTruthy();
    expect(secondRequest.id).not.toBe(firstRequest.id);

    const secondResult = await materializeGatewayResponse(secondRequest.outbound_call_id, {
      id: `PROV-B-${clientReferenceNumber}`,
      barcode: `TRACK-B-${Date.now()}`,
      reference_id: `REF-B-${Date.now()}`,
    });
    expect(secondResult?.postprocess?.operation).toBe('reused_client_reference');
    expect(secondResult?.postprocess?.shipment_id).toBe(shipmentId);

    const { rows: shipmentCountRows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt
         FROM shipments
        WHERE client_id = $1::uuid
          AND client_reference_upper = upper($2)`,
      [fixture.clientId, clientReferenceNumber],
    );
    expect(shipmentCountRows[0].cnt).toBe(1);
  });

  test('rejects invalid api-gateway tokens without persisting a request', async () => {
    const clientReferenceNumber = `INV-INVALID-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      recipient: {
        name: 'UC026 Invalid Token Receiver',
        phone: `+9665${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      },
      client_reference_number: clientReferenceNumber,
      origin: { line1: 'Origin', city: 'Riyadh', province: 'Riyadh', country: 'SA' },
      destination: { line1: 'Destination', city: 'Riyadh', province: 'Riyadh', country: 'SA' },
    };

    const { response, body } = await executeGatewayFetch('uc026-invalid-token', payload);
    if (response.status === 503) {
      console.warn('[api-gateway-ingest] Edge runtime not available (503). Skipping assertions.');
      return;
    }

    expect(response.status).toBe(401);
    if (body && typeof body === 'object') {
      const hasErrorProp = Object.prototype.hasOwnProperty.call(body, 'error');
      const hasMessageProp = Object.prototype.hasOwnProperty.call(body, 'message');
      expect(hasErrorProp || hasMessageProp).toBe(true);
    }

    const requestRow = await waitForGatewayRequest(fixture, clientReferenceNumber, 1500);
    expect(requestRow).toBeNull();
  });
});
