import { translateAdapterMessage } from '../i18n-catalog';
import {
  backendOutcomeError,
  liveBackendUnavailableError,
  liveRpc,
  nextCorrelationId,
  nextResourceId,
  objectRecord,
  readFunctionErrorMessage,
  readLiveResourceListReadback,
  requireLiveEvidence,
  requireLiveResourceReadback,
  requireLiveRpcRecord,
  type RunPluginTestResult,
  sleep,
  ui_list_resource_v1,
} from '../data-source';
import { asNonEmptyString, type ResourceRow } from './shared';
import {
  API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_INTERVAL_MS,
  API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_TIMEOUT_MS,
  API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE,
  API_GATEWAY_EDGE_INVOKE_TIMEOUT_MS,
  API_GATEWAY_REQUEST_READBACK_AFTER_INVOKE_TIMEOUT_MS,
  API_GATEWAY_REQUEST_READBACK_INTERVAL_MS,
  API_GATEWAY_REQUEST_READBACK_TIMEOUT_MS,
  API_GATEWAY_TERMINAL_SETTLE_AFTER_FIRST_READBACK_MS,
  apiGatewayAuthRejectionMessage,
  apiGatewayEdgeAuthErrorMessage,
  type ApiGatewayInvokeMethod,
  apiGatewayReadbackOccurredAfter,
  apiGatewayReadbackTerminal,
  assertApiGatewaySelectedSourceMatchesReadback,
  buildApiGatewayRequestResult,
  buildApiGatewaySyntheticResult,
  buildWebhookReceiverSyntheticResult,
  buildWebhookReceiverTestResult,
  findNestedNumber,
  findNestedString,
  normalizeApiGatewayMethod,
  type RunApiGatewayRequestTestArgs,
  type RunApiGatewayRequestTestResult,
  type RunWebhookReceiverTestArgs,
  type RunWebhookReceiverTestResult,
  splitApiGatewayPath,
  WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_INTERVAL_MS,
  WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_TIMEOUT_MS,
  WEBHOOK_RECEIVER_EDGE_INVOKE_TIMEOUT_MS,
  WEBHOOK_RECEIVER_READBACK_AFTER_INVOKE_TIMEOUT_MS,
  WEBHOOK_RECEIVER_READBACK_INTERVAL_MS,
  WEBHOOK_RECEIVER_TERMINAL_READBACK_TIMEOUT_MS,
  withApiGatewayInvokeTimeout,
} from './external-intake-readback';
import { getSupabaseClient } from '../supabase';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { isShipmentCreateIntent } from '../webhook-intents';

export async function runPluginTest(
  pluginId: string,
  payload: unknown,
  pluginVersionId?: string | null,
): Promise<RunPluginTestResult> {
  const args: Record<string, unknown> = {
    plugin_id: pluginId,
    payload: payload ?? {},
  };
  if (typeof pluginVersionId === 'string' && pluginVersionId.trim()) {
    args.plugin_version_id = pluginVersionId.trim();
  }
  const live = await liveRpc<RunPluginTestResult>('test_integration_plugin_v1', { p_args: args });
  if (live) {
    const result = requireLiveRpcRecord(
      live.data,
      'test_integration_plugin_v1 returned no backend outcome',
    ) as RunPluginTestResult;
    const outcomeError = backendOutcomeError(result, 'test_integration_plugin_v1 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    requireLiveEvidence(result, [
      'validation_run_id',
      'integration_plugin_validation_run_id',
      'plugin_validation_run_id',
    ], 'test_integration_plugin_v1 did not return backend validation evidence');
    const validationRunId = asNonEmptyString(result.validation_run_id)
      ?? asNonEmptyString(result.integration_plugin_validation_run_id)
      ?? asNonEmptyString(result.plugin_validation_run_id);
    if (!validationRunId) {
      throw new Error('test_integration_plugin_v1 did not return validation_run_id');
    }
    await requireLiveResourceReadback(
      'integration_plugin_validation_runs',
      validationRunId,
      'test_integration_plugin_v1',
    );
    if (!Array.isArray(result.steps) || result.steps.length === 0) {
      throw new Error('test_integration_plugin_v1 did not return backend trace steps');
    }
    return {
      ok: true,
      plugin_id: result.plugin_id ?? pluginId,
      plugin_version_id: result.plugin_version_id,
      validation_run_id: validationRunId,
      duration_ms: result.duration_ms ?? 0,
      steps: result.steps ?? [],
      correlation_id: result.correlation_id,
      settings_resolution_id: result.settings_resolution_id,
    };
  }
  // In-memory branch: deterministic trace mirroring the canonical RPC shape.
  await sleep(420);
  const duration = 420 + Math.floor(Math.random() * 80);
  return {
    ok: true,
    plugin_id: pluginId,
    plugin_version_id: `pv_${pluginId}_demo`,
    validation_run_id: nextResourceId('vr'),
    duration_ms: duration,
    steps: [
      { name: 'verify_signature', ok: true, ms: 12, signature_required: true },
      { name: 'parse_payload', ok: true, ms: 24, payload_size: JSON.stringify(payload ?? {}).length },
      { name: 'apply_mapping', ok: true, ms: 88, mapping_present: true },
      { name: 'validate_schema', ok: true, ms: 31, plugin_kind: 'webhook' },
      { name: 'bind_workflow', ok: true, ms: 56, workflow_template_active: true },
      { name: 'respond', ok: true, ms: 14, plugin_status: 'active' },
    ],
    correlation_id: nextCorrelationId(),
    settings_resolution_id: 'srlv_demo',
  };
}

async function readApiGatewayRequestTestReadback(
  filters: Array<Record<string, unknown>>,
): Promise<ResourceRow | null> {
  for (const filter of filters) {
    const rows = await readLiveResourceListReadback('api_gateway_requests', filter, 'api-gateway');
    const row = rows[0];
    if (row) return row;
  }
  return null;
}

async function readApiGatewayAuthRejectionReadback(
  args: {
    correlationId: string;
    method: string;
    path: string;
    startedAtMs: number;
    allowRecentFallback?: boolean;
  },
): Promise<ResourceRow | null> {
  const correlationRows = await readLiveResourceListReadback(
    'api_gateway_auth_rejections',
    { correlation_id: args.correlationId },
    'api-gateway',
  );
  const correlationRow = correlationRows.find((row) => apiGatewayReadbackOccurredAfter(row, args.startedAtMs));
  if (correlationRow) return correlationRow;

  if (!args.allowRecentFallback) return null;

  const invalidTokenRows = await readLiveResourceListReadback(
    'api_gateway_auth_rejections',
    { failure_code: 'invalid_token' },
    'api-gateway',
  );
  const normalizedMethod = args.method.toUpperCase();
  return invalidTokenRows.find((row) => {
    const rowMethod = asNonEmptyString(row.method)?.toUpperCase();
    const rowPath = asNonEmptyString(row.path);
    return (
      apiGatewayReadbackOccurredAfter(row, args.startedAtMs) &&
      (!rowMethod || rowMethod === normalizedMethod) &&
      (!rowPath || rowPath === args.path)
    );
  }) ?? null;
}

async function readWebhookReceiverAuthRejectionReadback(
  args: {
    correlationId: string;
    idempotencyKey: string;
    startedAtMs: number;
  },
): Promise<ResourceRow | null> {
  const filters: Array<Record<string, unknown>> = [
    { correlation_id: args.correlationId },
    args.correlationId !== args.idempotencyKey ? { correlation_id: args.idempotencyKey } : null,
    { request_id: args.idempotencyKey },
  ].filter(Boolean) as Array<Record<string, unknown>>;
  for (const filter of filters) {
    const rows = await readLiveResourceListReadback('webhook_auth_rejections', filter, 'webhook-receiver');
    const row = rows.find((candidate) => apiGatewayReadbackOccurredAfter(candidate, args.startedAtMs));
    if (row) return row;
  }
  return null;
}

async function readWebhookReceiverAuthRejectionUntil(
  args: {
    correlationId: string;
    idempotencyKey: string;
    startedAtMs: number;
  },
): Promise<ResourceRow | null> {
  const deadline = performance.now() + WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_TIMEOUT_MS;
  while (performance.now() <= deadline) {
    try {
      const row = await readWebhookReceiverAuthRejectionReadback(args);
      if (row) return row;
    } catch {
      // Older deployments may not expose webhook_auth_rejections yet. Keep the
      // canonical inbox readback path authoritative for non-auth failures.
      return null;
    }
    if (performance.now() >= deadline) break;
    await sleep(WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_INTERVAL_MS);
  }
  return null;
}

function apiGatewayDirectFetchConfig(): { baseUrl: string; anonKey: string } | null {
  if (import.meta.env.MODE === 'test' && import.meta.env.VITE_API_GATEWAY_DIRECT_FETCH_TEST !== '1') {
    return null;
  }
  const baseUrl = asNonEmptyString(import.meta.env.VITE_SUPABASE_URL)?.replace(/\/+$/, '');
  const anonKey = asNonEmptyString(import.meta.env.VITE_SUPABASE_ANON_KEY);
  if (!baseUrl || !anonKey || typeof fetch !== 'function') return null;
  return { baseUrl, anonKey };
}

function webhookReceiverDirectFetchConfig(): { baseUrl: string; anonKey: string } | null {
  if (import.meta.env.MODE === 'test' && import.meta.env.VITE_WEBHOOK_RECEIVER_DIRECT_FETCH_TEST !== '1') {
    return null;
  }
  const baseUrl = asNonEmptyString(import.meta.env.VITE_SUPABASE_URL)?.replace(/\/+$/, '');
  const anonKey = asNonEmptyString(import.meta.env.VITE_SUPABASE_ANON_KEY);
  if (!baseUrl || !anonKey || typeof fetch !== 'function') return null;
  return { baseUrl, anonKey };
}

async function invokeApiGatewayEdge(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  invokeName: string,
  args: {
    method: ApiGatewayInvokeMethod;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
  },
): Promise<{ data: Record<string, unknown>; error: { message?: string } | null }> {
  const directConfig = apiGatewayDirectFetchConfig();
  if (!directConfig) {
    const { data, error } = await withApiGatewayInvokeTimeout(
      client.functions.invoke<Record<string, unknown>>(invokeName, {
        method: args.method,
        body: args.method === 'GET' ? undefined : args.payload,
        headers: args.headers,
      }),
    );
    return { data: objectRecord(data), error };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_GATEWAY_EDGE_INVOKE_TIMEOUT_MS);
  try {
    const response = await fetch(`${directConfig.baseUrl}/functions/v1/${invokeName}`, {
      method: args.method,
      headers: {
        ...args.headers,
        apikey: directConfig.anonKey,
        authorization: `Bearer ${directConfig.anonKey}`,
        'content-type': 'application/json',
        'x-client-info': 'console-v2',
      },
      body: args.method === 'GET' ? undefined : JSON.stringify(args.payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        data = objectRecord(JSON.parse(text));
      } catch {
        data = { message: text };
      }
    }
    if (!response.ok) {
      const message =
        findNestedString(data, ['message', 'error', 'code', 'failure_code']) ??
        `api-gateway failed with HTTP ${response.status}`;
      return {
        data: {
          ...data,
          status: response.status,
          status_code: response.status,
        },
        error: { message },
      };
    }
    return { data, error: null };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function invokeWebhookReceiverEdge(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  args: {
    payload: Record<string, unknown>;
    headers: Record<string, string>;
  },
): Promise<{ data: Record<string, unknown> | null; error: { message?: string } | null }> {
  const directConfig = webhookReceiverDirectFetchConfig();
  if (!directConfig) {
    const { data, error } = await client.functions.invoke<Record<string, unknown>>('webhook-receiver', {
      body: args.payload,
      headers: args.headers,
    });
    return { data: objectRecord(data), error };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_RECEIVER_EDGE_INVOKE_TIMEOUT_MS);
  try {
    const response = await fetch(`${directConfig.baseUrl}/functions/v1/webhook-receiver`, {
      method: 'POST',
      headers: {
        ...args.headers,
        apikey: directConfig.anonKey,
        authorization: `Bearer ${directConfig.anonKey}`,
        'content-type': 'application/json',
        'x-client-info': 'console-v2',
      },
      body: JSON.stringify(args.payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        data = objectRecord(JSON.parse(text));
      } catch {
        data = { message: text };
      }
    }
    if (!response.ok) {
      const message =
        findNestedString(data, ['response_reason', 'ack_reason', 'reason', 'message', 'error', 'code', 'failure_code']) ??
        `webhook-receiver failed with HTTP ${response.status}`;
      return {
        data: {
          ...data,
          status: response.status,
          status_code: response.status,
          http_status: response.status,
        },
        error: { message },
      };
    }
    return { data, error: null };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { data: null, error: null };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForApiGatewayInvokeOrAuthRejection(
  invokePromise: Promise<{ data: Record<string, unknown>; error: { message?: string } | null }>,
  args: {
    correlationId: string;
    method: ApiGatewayInvokeMethod;
    path: string;
    startedAtMs: number;
  },
): Promise<
  | { type: 'invoke'; result: { data: Record<string, unknown>; error: { message?: string } | null } }
  | { type: 'auth_rejection'; row: ResourceRow }
> {
  const wrapped = invokePromise.then(
    (result) => ({ status: 'fulfilled' as const, result }),
    (error) => ({ status: 'rejected' as const, error }),
  );
  const deadline = performance.now() + API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_TIMEOUT_MS;
  while (performance.now() <= deadline) {
    const settled = await Promise.race([
      wrapped,
      sleep(API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_INTERVAL_MS).then(() => null),
    ]);
    if (settled) {
      if (settled.status === 'fulfilled') {
        return { type: 'invoke', result: settled.result };
      }
      throw settled.error;
    }
    try {
      const authRejection = await readApiGatewayAuthRejectionReadback({
        correlationId: args.correlationId,
        method: args.method,
        path: args.path,
        startedAtMs: args.startedAtMs,
      });
      if (authRejection) return { type: 'auth_rejection', row: authRejection };
    } catch {
      // Some older API lanes may not expose the rejection projection yet. Keep
      // the main invoke/request readback path authoritative in that case.
    }
  }
  throw new Error(API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE);
}

export async function runApiGatewayRequestTest(
  args: RunApiGatewayRequestTestArgs,
): Promise<RunApiGatewayRequestTestResult> {
  const token = asNonEmptyString(args.auth_token);
  if (!token) throw new Error('API Gateway source token is required');
  const { path, query } = splitApiGatewayPath(args.path, args.query_string);
  const method = normalizeApiGatewayMethod(args.method);
  const correlationId =
    asNonEmptyString(args.correlation_id) ??
    asNonEmptyString(args.idempotency_key) ??
    `console-api-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const idempotencyKey = asNonEmptyString(args.idempotency_key) ?? correlationId;
  const client = getSupabaseClient();
  if (!client) {
    if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('edge api-gateway');
    return buildApiGatewaySyntheticResult(
      {
        ...args,
        method,
        path,
        query_string: query,
        correlation_id: correlationId,
        idempotency_key: idempotencyKey,
      },
      nextCorrelationId,
    );
  }

  const operatorHeaders = objectRecord(args.headers);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(operatorHeaders)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || value == null) continue;
    if (normalizedKey.toLowerCase() === 'content-type') continue;
    headers[normalizedKey] = String(value);
  }
  headers['x-webhook-token'] = token;
  headers['x-correlation-id'] = correlationId;
  headers['idempotency-key'] = idempotencyKey;
  const replayOf = asNonEmptyString(args.replay_of);
  if (replayOf) {
    headers['x-masarx-replay-of'] = replayOf;
  }

  const invokeName = `api-gateway${path}${query ? `?${query}` : ''}`;
  const payload = args.payload ?? {};
  const startedAtMs = Date.now();
  let response: Record<string, unknown> = {};
  let invokeErrorMessage: string | null = null;
  try {
    const invokePromise = withApiGatewayInvokeTimeout(
      invokeApiGatewayEdge(client, invokeName, { method, payload, headers }),
    );
    const invokeOutcome = await waitForApiGatewayInvokeOrAuthRejection(invokePromise, {
      correlationId,
      method,
      path,
      startedAtMs,
    });
    if (invokeOutcome.type === 'auth_rejection') {
      assertApiGatewaySelectedSourceMatchesReadback(args, invokeOutcome.row);
      throw new Error(apiGatewayAuthRejectionMessage(invokeOutcome.row));
    }
    const { data, error } = invokeOutcome.result;
    if (error) {
      invokeErrorMessage = await readFunctionErrorMessage(error, 'api-gateway failed');
      response = { ...objectRecord(data), error: invokeErrorMessage };
    } else {
      response = objectRecord(data);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('API Gateway auth rejected by backend readback')) {
      throw err;
    }
    invokeErrorMessage = err instanceof Error ? err.message : API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE;
    response = { error: invokeErrorMessage };
  }

  const responseRequestId = findNestedString(response, ['api_gateway_request_id', 'request_id']);
  const responseCorrelationId = findNestedString(response, ['correlation_id']) ?? correlationId;
  const filters = [
    responseRequestId ? { request_id: responseRequestId } : null,
    { correlation_id: responseCorrelationId },
    responseCorrelationId !== correlationId ? { correlation_id: correlationId } : null,
  ].filter(Boolean) as Array<Record<string, unknown>>;

  const expectShipment = args.expect_shipment !== false;
  const responseIsEmpty = Object.keys(response).length === 0;
  const responseStatus = findNestedNumber(response, ['status', 'status_code', 'http_status']);
  const responseHasErrorSignal =
    Boolean(findNestedString(response, ['error', 'code', 'message', 'failure_code'])) ||
    (responseStatus != null && responseStatus >= 400);
  if (invokeErrorMessage || responseIsEmpty || (!responseRequestId && responseHasErrorSignal)) {
    try {
      const exactAuthRejection = await readApiGatewayAuthRejectionReadback({
        correlationId: responseCorrelationId,
        method,
        path,
        startedAtMs,
      });
      if (exactAuthRejection) {
        assertApiGatewaySelectedSourceMatchesReadback(args, exactAuthRejection);
        throw new Error(apiGatewayAuthRejectionMessage(exactAuthRejection));
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('API Gateway auth rejected by backend readback')) {
        throw err;
      }
      // Older deployments may not expose api_gateway_auth_rejections yet.
      // Continue to the canonical request readback path when that projection
      // is unavailable instead of failing unrelated successful tests.
    }
    const edgeAuthMessage = apiGatewayEdgeAuthErrorMessage(response, invokeErrorMessage);
    if (edgeAuthMessage) {
      throw new Error(edgeAuthMessage);
    }
  }
  if (invokeErrorMessage) {
    try {
      const authRejection = await readApiGatewayAuthRejectionReadback({
        correlationId: responseCorrelationId,
        method,
        path,
        startedAtMs,
        allowRecentFallback: true,
      });
      if (authRejection) {
        assertApiGatewaySelectedSourceMatchesReadback(args, authRejection);
        throw new Error(apiGatewayAuthRejectionMessage(authRejection));
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('API Gateway auth rejected by backend readback')) {
        throw err;
      }
      // If the auth-rejection projection is temporarily unavailable, keep the
      // canonical request-readback wait below so non-auth failures still settle.
    }
  }
  const readbackTimeoutMs = invokeErrorMessage === API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE
    ? API_GATEWAY_REQUEST_READBACK_AFTER_INVOKE_TIMEOUT_MS
    : API_GATEWAY_REQUEST_READBACK_TIMEOUT_MS;
  const deadline = performance.now() + readbackTimeoutMs;
  let readback: ResourceRow | null = null;
  let firstReadbackAt: number | null = null;
  while (performance.now() <= deadline) {
    readback = await readApiGatewayRequestTestReadback(filters);
    if (readback && apiGatewayReadbackTerminal(readback, expectShipment)) break;
    if (readback) {
      firstReadbackAt ??= performance.now();
      if (performance.now() - firstReadbackAt >= API_GATEWAY_TERMINAL_SETTLE_AFTER_FIRST_READBACK_MS) break;
    }
    if (performance.now() >= deadline) break;
    await sleep(API_GATEWAY_REQUEST_READBACK_INTERVAL_MS);
  }

  if (!readback) {
    if (invokeErrorMessage) throw new Error(invokeErrorMessage);
    throw new Error('api-gateway request did not produce backend request readback');
  }
  assertApiGatewaySelectedSourceMatchesReadback(args, readback);

  const result = buildApiGatewayRequestResult(
    {
      ...args,
      method,
      path,
      query_string: query,
      correlation_id: responseCorrelationId,
      idempotency_key: idempotencyKey,
    },
    response,
    readback,
    { invokeErrorMessage },
  );
  if (result.shipment_id) {
    await requireLiveResourceReadback('shipments', result.shipment_id, 'api-gateway');
    await requireLiveResourceReadback('shipment_directory', result.shipment_id, 'api-gateway');
  }
  if (expectShipment && result.intake_state === 'shipment_materialized' && !result.shipment_id) {
    throw new Error('api-gateway materialized shipment without canonical shipment readback');
  }
  return result;
}

export async function runWebhookReceiverTest(
  args: RunWebhookReceiverTestArgs,
): Promise<RunWebhookReceiverTestResult> {
  const token = asNonEmptyString(args.auth_token);
  if (!token) throw new Error('Intake source token is required');
  const payload: Record<string, unknown> =
    args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
      ? args.payload as Record<string, unknown>
      : {};
  const fallbackUuid = (): string => {
    const timestampHex = Date.now().toString(16).padStart(12, '0').slice(-12);
    const randomHex = Math.random().toString(16).slice(2).padEnd(20, '0').slice(0, 20);
    return `${timestampHex.slice(0, 8)}-${timestampHex.slice(8, 12)}-4${randomHex.slice(0, 3)}-8${randomHex.slice(3, 6)}-${randomHex.slice(6, 18)}`;
  };
  const idempotencyKey =
    asNonEmptyString(args.idempotency_key) ?? globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
  const signature = asNonEmptyString(args.signature);
  const client = getSupabaseClient();
  if (!client) {
    if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('edge webhook-receiver');
    return buildWebhookReceiverSyntheticResult({ ...args, idempotency_key: idempotencyKey }, nextCorrelationId);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-webhook-token': token,
    'idempotency-key': idempotencyKey,
    'x-correlation-id': idempotencyKey,
  };
  if (signature) headers['x-signature'] = signature;

  const startedAt = performance.now();
  const invokeResult = await Promise.race([
    invokeWebhookReceiverEdge(client, { payload, headers }).then((result) => ({ ...result, timed_out: false as const })),
    sleep(WEBHOOK_RECEIVER_EDGE_INVOKE_TIMEOUT_MS).then(() => ({
      data: null,
      error: null,
      timed_out: true as const,
    })),
  ]);
  const invokeErrorMessage = invokeResult.error
    ? await readFunctionErrorMessage(invokeResult.error, 'webhook-receiver failed')
    : null;
  const response = invokeErrorMessage
    ? {
        ...objectRecord(invokeResult.data),
        accepted: false,
        error: invokeErrorMessage,
        ack_reason:
          findNestedString(invokeResult.data, ['response_reason', 'ack_reason', 'reason', 'message', 'error', 'code', 'failure_code']) ??
          invokeErrorMessage,
        response_outcome:
          findNestedString(invokeResult.data, ['response_outcome']) ?? 'response_failed',
        idempotency_key: idempotencyKey,
      }
    : invokeResult.timed_out
    ? {
        accepted: true,
        invoke_timeout: true,
        idempotency_key: idempotencyKey,
        message: translateAdapterMessage('adapter.webhookReceiverTimeoutReadback'),
      }
    : objectRecord(invokeResult.data);
  let workflowRunId = findNestedString(response, ['workflow_run_id']);
  const followupWorkflowRunId = findNestedString(response, ['followup_workflow_run_id']);
  const correlationId = findNestedString(response, ['correlation_id']) ?? idempotencyKey;
  let ackOutcome = findNestedString(response, ['ack_outcome']);
  let responseOutcome =
    findNestedString(response, ['response_outcome']) ??
    (response.accepted === true || findNestedString(response, ['status']) === 'accepted_async'
      ? 'accepted'
      : null);
  let ackStatusCode = findNestedNumber(response, ['ack_status_code', 'status_code']);
  let ackReason = findNestedString(response, ['ack_reason']);
  let webhookId = findNestedString(response, ['webhook_id']);
  let canonicalIntent = findNestedString(response, ['canonical_intent']);
  let authRejectionId: string | null = null;
  let authRejectionFailureCode: string | null = null;
  let authRejectionFailureMessage: string | null = null;
  let authRejectionHttpStatus: number | null = null;
  let authRejectionSourceLabel: string | null = null;
  let authRejectionSourceIdentifier: string | null = null;
  let authRejectionSourceResolved: boolean | null = null;
  let authRejectionTokenFingerprint: string | null = null;
  let authRejectionRejectionClass: string | null = null;

  let workflowSteps: ResourceRow[] = [];
  let shipmentId: string | null = null;
  let trackingNumber = findNestedString(response, ['tracking_number', 'planned_tracking_number']);
  let webhookProcessingStatus: string | null = null;
  let sourceLabel: string | null = null;
  let sourceIdentifier: string | null = null;
  let providerTypeLabel: string | null = null;
  let mappingConfigId: string | null = null;
  let mappingLabel: string | null = null;
  let mappingTarget: string | null = null;
  let mappingVersion: number | null = null;
  let mappingRulesCount: number | null = null;
  let errorMessage: string | null = invokeErrorMessage;
  let isTerminal: boolean | null = null;
  let isActionable: boolean | null = null;
  const applyWebhookDirectoryReadback = (row: ResourceRow): void => {
    const rowIsTerminal = typeof row.is_terminal === 'boolean' ? row.is_terminal : null;
    webhookId = webhookId ?? asNonEmptyString(row.id);
    workflowRunId = workflowRunId ?? asNonEmptyString(row.workflow_run_id);
    canonicalIntent = canonicalIntent ?? asNonEmptyString(row.canonical_intent);
    trackingNumber = trackingNumber ?? asNonEmptyString(row.tracking_number);
    ackOutcome = asNonEmptyString(row.ack_outcome) ?? ackOutcome;
    responseOutcome = asNonEmptyString(row.response_outcome) ?? responseOutcome;
    ackStatusCode = findNestedNumber(row, ['ack_status_code', 'response_status_code', 'status_code']) ?? ackStatusCode;
    ackReason = asNonEmptyString(row.ack_reason) ?? asNonEmptyString(row.response_reason) ?? ackReason;
    webhookProcessingStatus = asNonEmptyString(row.processing_status);
    sourceLabel = asNonEmptyString(row.source_label);
    sourceIdentifier = asNonEmptyString(row.source_identifier);
    providerTypeLabel = asNonEmptyString(row.provider_type_label);
    mappingConfigId = asNonEmptyString(row.mapping_config_id);
    mappingLabel = asNonEmptyString(row.mapping_label);
    mappingTarget = asNonEmptyString(row.mapping_target);
    mappingVersion = typeof row.mapping_version === 'number' ? row.mapping_version : null;
    mappingRulesCount = typeof row.mapping_rules_count === 'number' ? row.mapping_rules_count : null;
    errorMessage = asNonEmptyString(row.error_message);
    isTerminal = rowIsTerminal;
    isActionable = typeof row.is_actionable === 'boolean' ? row.is_actionable : null;
    if (rowIsTerminal === true) {
      shipmentId = shipmentId ?? asNonEmptyString(row.shipment_id);
    }
  };
  const readWebhookDirectory = async (
    filters: Array<Record<string, unknown>>,
  ): Promise<boolean> => {
    for (const filter of filters) {
      const readback = await ui_list_resource_v1<ResourceRow>('webhook_inbox_directory', {
        filter,
        page_size: 1,
      });
      const row = readback.rows[0];
      if (!row) continue;
      applyWebhookDirectoryReadback(row);
      return true;
    }
    return false;
  };
  const readWebhookDirectoryUntil = async (
    filters: Array<Record<string, unknown>>,
    timeoutMs: number,
    requireWorkflowRun = false,
  ): Promise<boolean> => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() <= deadline) {
      const found = await readWebhookDirectory(filters);
      if (found && (!requireWorkflowRun || Boolean(workflowRunId))) return true;
      if (performance.now() >= deadline) break;
      await sleep(WEBHOOK_RECEIVER_READBACK_INTERVAL_MS);
    }
    return false;
  };
  const isWebhookReceiverTerminalFailure = (status: string | null): boolean => {
    const value = String(status ?? '').trim().toLowerCase();
    return (
      value.includes('fail') ||
      value === 'error' ||
      value === 'errored' ||
      value === 'rejected' ||
      value === 'dead_lettered'
    );
  };
  const applyWebhookAuthRejectionReadback = (row: ResourceRow): void => {
    authRejectionId = asNonEmptyString(row.id);
    authRejectionFailureCode = asNonEmptyString(row.failure_code);
    authRejectionFailureMessage = asNonEmptyString(row.failure_message);
    authRejectionHttpStatus = findNestedNumber(row, ['http_status']);
    authRejectionSourceLabel = asNonEmptyString(row.source_label);
    authRejectionSourceIdentifier = asNonEmptyString(row.source_identifier);
    authRejectionSourceResolved = typeof row.source_resolved === 'boolean' ? row.source_resolved : null;
    authRejectionTokenFingerprint = asNonEmptyString(row.token_fingerprint);
    authRejectionRejectionClass = asNonEmptyString(row.rejection_class);
    ackOutcome = 'auth_rejected';
    responseOutcome = 'auth_rejected';
    ackStatusCode = ackStatusCode ?? authRejectionHttpStatus ?? 401;
    ackReason = ackReason ?? authRejectionFailureMessage ?? authRejectionFailureCode ?? 'auth_rejected';
    errorMessage = errorMessage ?? authRejectionFailureMessage ?? authRejectionFailureCode;
    sourceLabel = sourceLabel ?? authRejectionSourceLabel;
    sourceIdentifier = sourceIdentifier ?? authRejectionSourceIdentifier;
    webhookProcessingStatus = webhookProcessingStatus ?? 'auth_rejected';
    isTerminal = true;
    isActionable = false;
  };
  const responseStatus = findNestedNumber(response, ['status', 'status_code', 'http_status']);
  const edgeRejectedWithoutLineage =
    !workflowRunId &&
    typeof responseStatus === 'number' &&
    responseStatus >= 400 &&
    responseStatus < 500;
  const responseHasAuthSignal =
    Boolean(invokeErrorMessage) ||
    responseStatus === 401 ||
    responseStatus === 403 ||
    /unauthorized|invalid_token|forbidden|auth/i.test(
      [
        findNestedString(response, ['error', 'message', 'code', 'failure_code']),
        invokeErrorMessage,
      ].filter(Boolean).join(' '),
    );
  if (responseHasAuthSignal && !workflowRunId && !edgeRejectedWithoutLineage) {
    const authRejection = await readWebhookReceiverAuthRejectionUntil({
      correlationId,
      idempotencyKey,
      startedAtMs: startedAt,
    });
    if (authRejection) {
      applyWebhookAuthRejectionReadback(authRejection);
    }
  }
  if (edgeRejectedWithoutLineage && !authRejectionId) {
    ackOutcome = ackOutcome ?? 'response_failed';
    responseOutcome = responseOutcome ?? 'response_failed';
    ackStatusCode = ackStatusCode ?? responseStatus;
    ackReason =
      ackReason ??
      findNestedString(response, ['response_reason', 'ack_reason', 'reason', 'message', 'error', 'code', 'failure_code']) ??
      invokeErrorMessage ??
      `webhook-receiver failed with HTTP ${responseStatus}`;
    errorMessage = errorMessage ?? ackReason;
    webhookProcessingStatus = webhookProcessingStatus ?? 'response_failed';
    isTerminal = true;
    isActionable = false;
  }
  if (!workflowRunId) {
    const foundReplayReadback = authRejectionId || edgeRejectedWithoutLineage
      ? false
      : await readWebhookDirectoryUntil(
          [
            webhookId ? { id: webhookId } : null,
            { idempotency_key: idempotencyKey },
            { correlation_id: correlationId },
          ].filter(Boolean) as Array<Record<string, unknown>>,
          WEBHOOK_RECEIVER_READBACK_AFTER_INVOKE_TIMEOUT_MS,
          false,
        );
    const terminalFailureWithoutWorkflow =
      foundReplayReadback &&
      isTerminal === true &&
      isWebhookReceiverTerminalFailure(webhookProcessingStatus);
    const terminalAuthRejectionWithoutWorkflow = Boolean(authRejectionId);
    if (
      (!foundReplayReadback || !workflowRunId) &&
      !terminalFailureWithoutWorkflow &&
      !terminalAuthRejectionWithoutWorkflow &&
      !edgeRejectedWithoutLineage
    ) {
      throw new Error(invokeErrorMessage ?? 'webhook-receiver did not return workflow_run_id evidence');
    }
  }
  try {
    const workflowIds = Array.from(new Set([workflowRunId, followupWorkflowRunId].filter(Boolean)));
    const stepResults = await Promise.all(
      workflowIds.map((id) =>
        ui_list_resource_v1<ResourceRow>('workflow_run_steps', {
          filter: { workflow_run_id: id },
          page_size: 50,
        }),
      ),
    );
    workflowSteps = stepResults.flatMap((result) => result.rows);
    trackingNumber = trackingNumber ?? findNestedString(workflowSteps, ['tracking_number', 'planned_tracking_number']);
  } catch {
    // The receiver evidence is still useful; the UI will show that step/shipment
    // readback is pending rather than treating the edge call as full readiness.
  }
  if (!authRejectionId && workflowRunId) {
    await readWebhookDirectory([
      webhookId ? { id: webhookId } : null,
      { workflow_run_id: workflowRunId },
      { idempotency_key: idempotencyKey },
      { correlation_id: correlationId },
    ].filter(Boolean) as Array<Record<string, unknown>>);
  }
  const webhookPayloadIntent = findNestedString(payload, ['event_type', 'type', 'intent', 'target']);
  const shipmentCreateReadbackRequired = [canonicalIntent, mappingTarget, webhookPayloadIntent]
    .some((value) => isShipmentCreateIntent(value));
  const shouldPollShipmentCreateTerminalReadback = !Object.is(isTerminal, false);
  try {
    const readDirectoryOnce = async (): Promise<boolean> => {
      const readbackFilters = [
        webhookId ? { id: webhookId } : null,
        workflowRunId ? { workflow_run_id: workflowRunId } : null,
        { idempotency_key: idempotencyKey },
        { correlation_id: correlationId },
      ].filter(Boolean) as Array<Record<string, unknown>>;
      const found = await readWebhookDirectory(readbackFilters);
      return found && (isTerminal === true || Boolean(shipmentId));
    };
    if (!authRejectionId && !edgeRejectedWithoutLineage && shipmentCreateReadbackRequired && shouldPollShipmentCreateTerminalReadback) {
      const deadline = performance.now() + WEBHOOK_RECEIVER_TERMINAL_READBACK_TIMEOUT_MS;
      do {
        const complete = await readDirectoryOnce();
        if (complete) break;
        if (performance.now() >= deadline) break;
        await sleep(WEBHOOK_RECEIVER_READBACK_INTERVAL_MS);
      } while (!shipmentId || isTerminal !== true);
    }
  } catch {
    // Keep the receiver result visible; missing directory readback prevents
    // production readiness proof and is surfaced as pending UI evidence.
  }

  const shipmentCreateTerminalFailure = isWebhookReceiverTerminalFailure(webhookProcessingStatus);
  if (shipmentCreateReadbackRequired && shipmentCreateTerminalFailure) {
    shipmentId = null;
    trackingNumber = null;
  }

  if (!shipmentId && isTerminal === true && trackingNumber && !shipmentCreateTerminalFailure) {
    try {
      const readback = await ui_list_resource_v1<ResourceRow>('shipment_directory', {
        filter: { identifier: trackingNumber },
        page_size: 1,
      });
      const row = readback.rows[0];
      shipmentId = asNonEmptyString(row?.id) ?? asNonEmptyString(row?.shipment_id) ?? shipmentId;
    } catch {
      // Tracking-only evidence keeps the receiver result visible, but the
      // shipment action remains disabled until a canonical id can be read.
    }
  }

  if (shipmentId) {
    await requireLiveResourceReadback('shipments', shipmentId, 'webhook-receiver');
    await requireLiveResourceReadback('shipment_directory', shipmentId, 'webhook-receiver');
  }

  if (shipmentCreateReadbackRequired && !authRejectionId && isTerminal === true && !shipmentId && !shipmentCreateTerminalFailure) {
    throw new Error('webhook-receiver completed shipment.create without shipment readback');
  }

  return buildWebhookReceiverTestResult({
    receiverStatus: ackStatusCode ?? 200,
    durationMs: Math.round(performance.now() - startedAt),
    correlationId,
    idempotencyKey,
    ackOutcome,
    responseOutcome,
    ackStatusCode,
    ackReason,
    workflowRunId,
    followupWorkflowRunId,
    webhookId,
    canonicalIntent,
    webhookProcessingStatus,
    sourceLabel,
    sourceIdentifier,
    providerTypeLabel,
    mappingConfigId,
    mappingLabel,
    mappingTarget,
    mappingVersion,
    mappingRulesCount,
    errorMessage,
    isTerminal,
    isActionable,
    shipmentId,
    trackingNumber,
    authRejectionId,
    authRejectionFailureCode,
    authRejectionFailureMessage,
    authRejectionHttpStatus,
    authRejectionSourceLabel,
    authRejectionSourceIdentifier,
    authRejectionSourceResolved,
    authRejectionTokenFingerprint,
    authRejectionRejectionClass,
    response,
    workflowSteps,
  });
}
