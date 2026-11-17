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

async function insertGatewayFixture(client, fixture) {
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
        $5,
        'global',
        NULL,
        $3::uuid,
        'POST',
        '/provider/ship/request/by-email',
        $4::jsonb
      )`,
    [fixture.routeId, fixture.packId, fixture.providerId, JSON.stringify(policy), fixture.routePath],
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
    `DELETE FROM shipment_actions
      WHERE client_id = $1::uuid
        AND shipment_id IN (
          SELECT id
            FROM shipments
           WHERE client_id = $1::uuid
        )`,
    [fixture.clientId],
  );

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
    upstreamPath,
    usePathToken = true,
    includeFunctionAuthorization = true,
  } = options;

  if (!upstreamPath) throw new Error('Owned gateway fixture path required');
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

  const signal = AbortSignal.timeout(30000);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (response.status === 503) throw new Error('Gateway runtime unavailable: HTTP 503');
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { response, body };
}

async function waitForGatewayRequest(fixture, clientReferenceNumber, timeoutMs = 15000, excludedRequestId = null) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { rows } = await pool.query(
      `SELECT id,
              client_id,
              sender_id,
              outbound_call_id,
              workflow_run_id,
              correlation_id,
              method,
              path,
              request_body,
              created_at
         FROM api_gateway_requests
        WHERE source_id = $1::uuid
          AND request_body #>> '{client_reference_number}' = $2
          AND ($3::uuid IS NULL OR id <> $3::uuid)
        ORDER BY created_at DESC
        LIMIT 1`,
      [fixture.sourceId, clientReferenceNumber, excludedRequestId],
    );
    if (rows[0]) return rows[0];
    await sleep(200);
  }
  return null;
}

const GATEWAY_DISPATCH_SETUP_OPERATIONS = new Set([
  'materialize_addresses',
  'dispatch_create',
]);

function gatewayDispatchFailure(code, receipt = {}, worker = {}) {
  const error = new Error(code);
  error.receipt = {
    code,
    request_id: receipt.request_id ?? null,
    workflow_run_id: receipt.workflow_run_id ?? null,
    workflow_status: receipt.workflow_status ?? null,
    operation_name: receipt.operation_name ?? null,
    step_status: receipt.step_status ?? null,
    step_ready: receipt.step_ready ?? null,
    worker_status: worker.status ?? null,
    worker_items_processed: Number.isInteger(worker.items_processed) ? worker.items_processed : null,
    worker_progress_status: worker.progress?.status ?? null,
    worker_has_step: Boolean(worker.progress?.step_id),
  };
  console.warn('gateway_dispatch_state', {
    workflow_failed: receipt.workflow_status === 'failed',
    step_ready: receipt.step_ready === true,
    setup_operation: GATEWAY_DISPATCH_SETUP_OPERATIONS.has(receipt.operation_name),
    worker_idle: worker.status === 'idle',
    worker_error: worker.status === 'error',
    worker_items_processed: Number.isInteger(worker.items_processed) ? worker.items_processed : null,
    worker_progress_failed: worker.progress?.status === 'failed',
    worker_has_step: Boolean(worker.progress?.step_id),
  });
  return error;
}

async function readGatewayDispatchReceipt(fixture, requestId) {
  const { rows } = await pool.query(
    `SELECT request.id AS request_id,
            request.workflow_run_id,
            request.outbound_call_id,
            run.workflow_status,
            pending.operation_name,
            pending.step_status,
            pending.run_at,
            COALESCE(pending.run_at <= now(), FALSE) AS step_ready
       FROM api_gateway_requests request
       LEFT JOIN workflow_runs run ON run.id = request.workflow_run_id
       LEFT JOIN LATERAL (
         SELECT step.operation_name, step.step_status, step.run_at
           FROM workflow_run_steps step
          WHERE step.workflow_run_id = request.workflow_run_id
            AND step.step_status = 'pending'
          ORDER BY step.sequence_order
          LIMIT 1
       ) pending ON TRUE
      WHERE request.id = $1::uuid
        AND request.source_id = $2::uuid`,
    [requestId, fixture.sourceId],
  );
  return rows[0] || null;
}

async function completeGatewayDispatch(fixture, requestRow) {
  // The production cron calls run_workflow_engine_worker_batch_v1 every minute.
  // This fixture advances only its own accepted-async workflow and only through
  // the two setup steps that can precede outbound_call_id attachment.
  let progressedSteps = 0;
  let contentionRetryUsed = false;
  while (progressedSteps <= GATEWAY_DISPATCH_SETUP_OPERATIONS.size) {
    const receipt = await readGatewayDispatchReceipt(fixture, requestRow.id);
    if (!receipt) throw gatewayDispatchFailure('gateway_request_missing_after_accept', { request_id: requestRow.id });
    if (receipt.outbound_call_id) return { ...requestRow, ...receipt };
    if (!receipt.workflow_run_id) throw gatewayDispatchFailure('gateway_dispatch_authority_missing', receipt);
    if (receipt.workflow_status === 'failed') throw gatewayDispatchFailure('gateway_workflow_failed', receipt);
    if (receipt.step_ready === false) {
      throw gatewayDispatchFailure('gateway_workflow_not_ready', receipt);
    }
    if (!receipt.operation_name || !GATEWAY_DISPATCH_SETUP_OPERATIONS.has(receipt.operation_name)) {
      throw gatewayDispatchFailure('gateway_workflow_no_dispatch_progress', receipt);
    }
    if (progressedSteps === GATEWAY_DISPATCH_SETUP_OPERATIONS.size) {
      throw gatewayDispatchFailure('gateway_workflow_setup_budget_exhausted', receipt);
    }

    const { rows } = await pool.query(
      `SELECT public.run_workflow_engine_worker_step_v1($1::uuid) AS result`,
      [receipt.workflow_run_id],
    );
    const worker = rows[0]?.result || {};
    const progress = worker.progress || {};
    if (worker.error_occurred === true || worker.status === 'error' || progress.status === 'failed') {
      throw gatewayDispatchFailure('gateway_workflow_progress_failed', receipt, worker);
    }
    if (worker.status === 'idle' || worker.items_processed !== 1 || !progress.step_id) {
      const concurrentReceipt = await readGatewayDispatchReceipt(fixture, requestRow.id);
      if (concurrentReceipt?.outbound_call_id) return { ...requestRow, ...concurrentReceipt };
      const current = concurrentReceipt || receipt;
      if (current.workflow_status === 'failed') {
        throw gatewayDispatchFailure('gateway_workflow_failed', current, worker);
      }
      if (current.step_ready === false) {
        throw gatewayDispatchFailure('gateway_workflow_not_ready', current, worker);
      }
      if (!current.operation_name || !GATEWAY_DISPATCH_SETUP_OPERATIONS.has(current.operation_name)) {
        throw gatewayDispatchFailure('gateway_workflow_no_dispatch_progress', current, worker);
      }
      if (!contentionRetryUsed) {
        // The canonical worker uses FOR UPDATE SKIP LOCKED. One bounded retry
        // admits a concurrently owned exact run without hiding stable no-progress.
        contentionRetryUsed = true;
        await sleep(100);
        continue;
      }
      throw gatewayDispatchFailure('gateway_workflow_no_dispatch_progress', current, worker);
    }
    progressedSteps += 1;
  }
  throw gatewayDispatchFailure('gateway_workflow_setup_budget_exhausted', {
    request_id: requestRow.id,
    workflow_run_id: requestRow.workflow_run_id,
  });
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

  fixture.routePath = `/api/ship/request/by-email/${fixture.routeId}`;

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

    const { response, body } = await executeGatewayFetch(fixture.sourceToken, payload, { upstreamPath: fixture.routePath });

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      status: 'accepted_async',
      correlation_id: expect.any(String),
    });

    let requestRow = await waitForGatewayRequest(fixture, clientReferenceNumber);
    expect(requestRow).toBeTruthy();
    expect(requestRow.path).toBe(fixture.routePath);
    expect(requestRow.method).toBe('POST');
    expect(requestRow.client_id).toBe(fixture.clientId);
    expect(requestRow.sender_id).toBe(fixture.senderId);
    expect(requestRow.correlation_id).toBe(body.correlation_id);
    requestRow = await completeGatewayDispatch(fixture, requestRow);
    expect(requestRow.outbound_call_id).toEqual(expect.any(String));

    const { rows: observabilityRows } = await pool.query(
      `SELECT event_source, event_type, resource_type, resource_id, status, correlation_id, metadata
         FROM observability_events_v
        WHERE event_source = 'decision_log'
          AND event_type = 'settings_resolution'
          AND resource_type = 'api_gateway_request'
          AND resource_id = $1::uuid
          AND metadata->>'decision_point' = 'api_gateway_workflow_enqueued'
        ORDER BY event_time DESC
        LIMIT 1`,
      [requestRow.id],
    );
    expect(observabilityRows).toHaveLength(1);
    expect(observabilityRows[0].event_source).toBe('decision_log');
    expect(observabilityRows[0].event_type).toBe('settings_resolution');
    expect(observabilityRows[0].resource_type).toBe('api_gateway_request');
    expect(observabilityRows[0].resource_id).toBe(requestRow.id);
    expect(observabilityRows[0].status).toBe('enqueued');
    expect(observabilityRows[0].correlation_id).toBe(requestRow.correlation_id);
    expect(observabilityRows[0].metadata?.decision_point).toBe('api_gateway_workflow_enqueued');
    expect(observabilityRows[0].metadata?.decision_inputs?.workflow_run_id).toBe(requestRow.workflow_run_id);
    expect(observabilityRows[0].metadata?.decision_inputs?.path).toBe(fixture.routePath);

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

    const first = await executeGatewayFetch(fixture.sourceToken, buildPayload('A'), { upstreamPath: fixture.routePath });
    expect(first.response.status).toBe(202);

    let firstRequest = await waitForGatewayRequest(fixture, clientReferenceNumber);
    expect(firstRequest).toBeTruthy();
    firstRequest = await completeGatewayDispatch(fixture, firstRequest);
    const firstResult = await materializeGatewayResponse(firstRequest.outbound_call_id, {
      id: `PROV-A-${clientReferenceNumber}`,
      barcode: `TRACK-A-${Date.now()}`,
      reference_id: `REF-A-${Date.now()}`,
    });
    expect(firstResult?.postprocess?.operation).toBe('inserted');
    const shipmentId = firstResult?.postprocess?.shipment_id;
    expect(shipmentId).toBeTruthy();

    const second = await executeGatewayFetch(fixture.sourceToken, buildPayload('B'), { upstreamPath: fixture.routePath });
    expect(second.response.status).toBe(202);

    let secondRequest = await waitForGatewayRequest(fixture, clientReferenceNumber, 15000, firstRequest.id);
    expect(secondRequest).toBeTruthy();
    expect(secondRequest.id).not.toBe(firstRequest.id);
    secondRequest = await completeGatewayDispatch(fixture, secondRequest);

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

    const { response, body } = await executeGatewayFetch('uc026-invalid-token', payload, { upstreamPath: fixture.routePath });

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
