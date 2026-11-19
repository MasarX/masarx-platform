import { asNonEmptyString, type ResourceRow } from './shared';

export interface RunWebhookReceiverTestArgs extends Record<string, unknown> {
  auth_token: string;
  payload: unknown;
  idempotency_key?: string;
  signature?: string;
}

export interface RunWebhookReceiverTestResult extends Record<string, unknown> {
  ok: boolean;
  receiver_status?: number | null;
  duration_ms?: number | null;
  correlation_id?: string | null;
  idempotency_key?: string | null;
  ack_outcome?: string | null;
  response_outcome?: string | null;
  ack_status_code?: number | null;
  ack_reason?: string | null;
  workflow_run_id?: string | null;
  followup_workflow_run_id?: string | null;
  webhook_id?: string | null;
  canonical_intent?: string | null;
  webhook_processing_status?: string | null;
  source_label?: string | null;
  source_identifier?: string | null;
  provider_type_label?: string | null;
  mapping_config_id?: string | null;
  mapping_label?: string | null;
  mapping_target?: string | null;
  mapping_version?: number | null;
  mapping_rules_count?: number | null;
  error_message?: string | null;
  is_terminal?: boolean | null;
  is_actionable?: boolean | null;
  shipment_id?: string | null;
  tracking_number?: string | null;
  auth_rejection_id?: string | null;
  auth_rejection_failure_code?: string | null;
  auth_rejection_failure_message?: string | null;
  auth_rejection_http_status?: number | null;
  auth_rejection_source_label?: string | null;
  auth_rejection_source_identifier?: string | null;
  auth_rejection_source_resolved?: boolean | null;
  auth_rejection_token_fingerprint?: string | null;
  auth_rejection_rejection_class?: string | null;
  response: Record<string, unknown>;
  workflow_steps?: ResourceRow[];
}

export interface BuildWebhookReceiverTestResultArgs {
  receiverStatus?: number | null;
  durationMs?: number | null;
  correlationId: string;
  idempotencyKey: string;
  ackOutcome?: string | null;
  responseOutcome?: string | null;
  ackStatusCode?: number | null;
  ackReason?: string | null;
  workflowRunId?: string | null;
  followupWorkflowRunId?: string | null;
  webhookId?: string | null;
  canonicalIntent?: string | null;
  webhookProcessingStatus?: string | null;
  sourceLabel?: string | null;
  sourceIdentifier?: string | null;
  providerTypeLabel?: string | null;
  mappingConfigId?: string | null;
  mappingLabel?: string | null;
  mappingTarget?: string | null;
  mappingVersion?: number | null;
  mappingRulesCount?: number | null;
  errorMessage?: string | null;
  isTerminal?: boolean | null;
  isActionable?: boolean | null;
  shipmentId?: string | null;
  trackingNumber?: string | null;
  authRejectionId?: string | null;
  authRejectionFailureCode?: string | null;
  authRejectionFailureMessage?: string | null;
  authRejectionHttpStatus?: number | null;
  authRejectionSourceLabel?: string | null;
  authRejectionSourceIdentifier?: string | null;
  authRejectionSourceResolved?: boolean | null;
  authRejectionTokenFingerprint?: string | null;
  authRejectionRejectionClass?: string | null;
  response: Record<string, unknown>;
  workflowSteps?: ResourceRow[];
}

export interface RunApiGatewayRequestTestArgs extends Record<string, unknown> {
  auth_token: string;
  source_id?: string | null;
  method?: string;
  path: string;
  query_string?: string | null;
  payload?: Record<string, unknown> | null;
  headers?: Record<string, unknown> | null;
  correlation_id?: string | null;
  idempotency_key?: string | null;
  expect_shipment?: boolean | null;
  replay_of?: string | null;
}

export interface RunApiGatewayRequestTestResult extends Record<string, unknown> {
  ok: boolean;
  diagnostic_only?: boolean;
  correlation_id: string;
  idempotency_key: string;
  method: string;
  path: string;
  query_string: string | null;
  api_gateway_request_id: string | null;
  workflow_run_id: string | null;
  outbound_call_id: string | null;
  intake_state: string | null;
  error_code: string | null;
  outbound_error_message?: string | null;
  outbound_status: string | null;
  shipment_id: string | null;
  tracking_number: string | null;
  shipment_status: string | null;
  replay_of_request_id?: string | null;
  mutation_intent?: string | null;
  request_mapping_config_id?: string | null;
  request_mapping_key?: string | null;
  request_mapping_type?: string | null;
  request_mapping_target?: string | null;
  request_mapping_applied?: boolean | null;
  materialization_action_id?: string | null;
  materialization_operation?: string | null;
  recipient_id?: string | null;
  recipient_label?: string | null;
  recipient_external_id?: string | null;
  destination_address_id?: string | null;
  destination_city?: string | null;
  destination_validation_status?: string | null;
  response: Record<string, unknown>;
  request_readback: ResourceRow | null;
}

export const WEBHOOK_RECEIVER_TERMINAL_READBACK_TIMEOUT_MS = 120_000;
export const WEBHOOK_RECEIVER_READBACK_INTERVAL_MS = 1_500;
export const WEBHOOK_RECEIVER_EDGE_INVOKE_TIMEOUT_MS = 30_000;
export const WEBHOOK_RECEIVER_READBACK_AFTER_INVOKE_TIMEOUT_MS = 60_000;
export const WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_TIMEOUT_MS = 15_000;
export const WEBHOOK_RECEIVER_AUTH_REJECTION_READBACK_INTERVAL_MS = 750;
export const API_GATEWAY_REQUEST_READBACK_TIMEOUT_MS = 120_000;
export const API_GATEWAY_REQUEST_READBACK_INTERVAL_MS = 1_500;
export const API_GATEWAY_TERMINAL_SETTLE_AFTER_FIRST_READBACK_MS = 4_500;
export const API_GATEWAY_EDGE_INVOKE_TIMEOUT_MS = 30_000;
export const API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_TIMEOUT_MS = 15_000;
export const API_GATEWAY_AUTH_REJECTION_QUICK_READBACK_INTERVAL_MS = 750;
export const API_GATEWAY_REQUEST_READBACK_AFTER_INVOKE_TIMEOUT_MS = 15_000;
export const API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE =
  'api-gateway request timed out before backend response completed';

export type ApiGatewayInvokeMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export function findNestedString(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedString(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const rec = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = asNonEmptyString(rec[key]);
    if (direct) return direct;
  }
  for (const nested of Object.values(rec)) {
    const found = findNestedString(nested, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

export function findNestedNumber(value: unknown, keys: string[], depth = 0): number | null {
  if (depth > 5 || value == null) return null;
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedNumber(item, keys, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  const rec = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = rec[key];
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    if (typeof direct === 'string' && direct.trim()) {
      const parsed = Number(direct);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  for (const nested of Object.values(rec)) {
    const found = findNestedNumber(nested, keys, depth + 1);
    if (found != null) return found;
  }
  return null;
}

export function buildWebhookReceiverSyntheticResult(
  args: RunWebhookReceiverTestArgs,
  nextCorrelationId: () => string,
): RunWebhookReceiverTestResult {
  const idempotency = asNonEmptyString(args.idempotency_key) ?? `console-v2-seed-${Date.now()}`;
  return {
    ok: true,
    receiver_status: 200,
    correlation_id: nextCorrelationId(),
    workflow_run_id: `wfr_receiver_${Date.now()}`,
    followup_workflow_run_id: null,
    webhook_id: `wbk_receiver_${Date.now()}`,
    canonical_intent: 'shipment.create',
    shipment_id: null,
    tracking_number: null,
    response: {
      accepted: true,
      diagnostic_only: true,
      idempotency_key: idempotency,
    },
    workflow_steps: [],
  };
}

export function buildWebhookReceiverTestResult(
  args: BuildWebhookReceiverTestResultArgs,
): RunWebhookReceiverTestResult {
  return {
    ok: true,
    receiver_status: args.receiverStatus ?? args.ackStatusCode ?? 200,
    duration_ms: args.durationMs ?? null,
    correlation_id: args.correlationId,
    idempotency_key: args.idempotencyKey,
    ack_outcome: args.ackOutcome ?? null,
    response_outcome: args.responseOutcome ?? null,
    ack_status_code: args.ackStatusCode ?? null,
    ack_reason: args.ackReason ?? null,
    workflow_run_id: args.workflowRunId ?? null,
    followup_workflow_run_id: args.followupWorkflowRunId ?? null,
    webhook_id: args.webhookId ?? null,
    canonical_intent: args.canonicalIntent ?? null,
    webhook_processing_status: args.webhookProcessingStatus ?? null,
    source_label: args.sourceLabel ?? null,
    source_identifier: args.sourceIdentifier ?? null,
    provider_type_label: args.providerTypeLabel ?? null,
    mapping_config_id: args.mappingConfigId ?? null,
    mapping_label: args.mappingLabel ?? null,
    mapping_target: args.mappingTarget ?? null,
    mapping_version: args.mappingVersion ?? null,
    mapping_rules_count: args.mappingRulesCount ?? null,
    error_message: args.errorMessage ?? null,
    is_terminal: args.isTerminal ?? null,
    is_actionable: args.isActionable ?? null,
    shipment_id: args.shipmentId ?? null,
    tracking_number: args.trackingNumber ?? null,
    auth_rejection_id: args.authRejectionId ?? null,
    auth_rejection_failure_code: args.authRejectionFailureCode ?? null,
    auth_rejection_failure_message: args.authRejectionFailureMessage ?? null,
    auth_rejection_http_status: args.authRejectionHttpStatus ?? null,
    auth_rejection_source_label: args.authRejectionSourceLabel ?? null,
    auth_rejection_source_identifier: args.authRejectionSourceIdentifier ?? null,
    auth_rejection_source_resolved: args.authRejectionSourceResolved ?? null,
    auth_rejection_token_fingerprint: args.authRejectionTokenFingerprint ?? null,
    auth_rejection_rejection_class: args.authRejectionRejectionClass ?? null,
    response: args.response,
    workflow_steps: args.workflowSteps ?? [],
  };
}

export function normalizeApiGatewayMethod(method: unknown): ApiGatewayInvokeMethod {
  const normalized = asNonEmptyString(method)?.toUpperCase() ?? 'POST';
  const methodName = normalized.replace(/[^A-Z]/g, '');
  if (methodName === 'DELETE' || methodName === 'GET' || methodName === 'PATCH' || methodName === 'PUT') {
    return methodName;
  }
  return 'POST';
}

export function splitApiGatewayPath(pathValue: unknown, queryValue: unknown): { path: string; query: string | null } {
  const rawPath = asNonEmptyString(pathValue);
  if (!rawPath) throw new Error('API Gateway route path is required');
  const queryFromArg = asNonEmptyString(queryValue)?.replace(/^\?+/, '') ?? null;
  const [pathPart, pathQuery] = rawPath.split('?', 2);
  const path = `/${String(pathPart ?? '').replace(/^\/+/, '')}`;
  const query = queryFromArg ?? (pathQuery ? pathQuery.replace(/^\?+/, '') : null);
  return { path, query: query && query.trim() ? query.trim() : null };
}

export function apiGatewayReadbackTerminal(row: ResourceRow, expectShipment: boolean): boolean {
  const intakeState = asNonEmptyString(row.intake_state)?.toLowerCase() ?? '';
  const outboundStatus = asNonEmptyString(row.outbound_status)?.toLowerCase() ?? '';
  const statusCode = Number(row.status_code);
  if (asNonEmptyString(row.shipment_id)) return true;
  if (!expectShipment) return true;
  if (intakeState === 'shipment_materialized') return true;
  if (['provider_failed', 'not_dispatched', 'timeout', 'timed_out'].includes(intakeState)) return true;
  if (['failed', 'permanently_failed', 'canceled', 'cancelled', 'timeout', 'timed_out'].includes(outboundStatus)) return true;
  if (Number.isFinite(statusCode) && statusCode >= 400) return true;
  return false;
}

export function buildApiGatewayRequestResult(
  args: RunApiGatewayRequestTestArgs,
  response: Record<string, unknown>,
  readback: ResourceRow | null,
  options: { diagnosticOnly?: boolean; invokeErrorMessage?: string | null } = {},
): RunApiGatewayRequestTestResult {
  const method = normalizeApiGatewayMethod(args.method);
  const { path, query } = splitApiGatewayPath(args.path, args.query_string);
  const requestId =
    asNonEmptyString(readback?.request_id) ??
    asNonEmptyString(readback?.id) ??
    findNestedString(response, ['api_gateway_request_id', 'request_id']);
  const correlationId =
    asNonEmptyString(readback?.correlation_id) ??
    findNestedString(response, ['correlation_id']) ??
    asNonEmptyString(args.correlation_id) ??
    asNonEmptyString(args.idempotency_key) ??
    `console-api-${Date.now()}`;
  const idempotencyKey =
    asNonEmptyString(args.idempotency_key) ??
    asNonEmptyString(response.idempotency_key) ??
    correlationId;
  const errorCode =
    asNonEmptyString(readback?.error_code) ??
    findNestedString(response, ['error_code', 'code']) ??
    (options.invokeErrorMessage ? 'edge_request_failed' : null);
  return {
    ok: !options.invokeErrorMessage,
    diagnostic_only: options.diagnosticOnly || undefined,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    method,
    path,
    query_string: query,
    api_gateway_request_id: requestId,
    workflow_run_id:
      asNonEmptyString(readback?.workflow_run_id) ??
      findNestedString(response, ['workflow_run_id']),
    outbound_call_id:
      asNonEmptyString(readback?.outbound_call_id) ??
      findNestedString(response, ['outbound_call_id']),
    intake_state: asNonEmptyString(readback?.intake_state) ?? null,
    error_code: errorCode,
    outbound_error_message: asNonEmptyString(readback?.outbound_error_message) ?? null,
    outbound_status: asNonEmptyString(readback?.outbound_status) ?? null,
    shipment_id: asNonEmptyString(readback?.shipment_id),
    tracking_number: asNonEmptyString(readback?.tracking_number),
    shipment_status: asNonEmptyString(readback?.shipment_status) ?? null,
    replay_of_request_id: asNonEmptyString(readback?.replay_of_request_id) ?? null,
    mutation_intent: asNonEmptyString(readback?.mutation_intent) ?? null,
    request_mapping_config_id: asNonEmptyString(readback?.request_mapping_config_id) ?? null,
    request_mapping_key: asNonEmptyString(readback?.request_mapping_key) ?? null,
    request_mapping_type: asNonEmptyString(readback?.request_mapping_type) ?? null,
    request_mapping_target: asNonEmptyString(readback?.request_mapping_target) ?? null,
    request_mapping_applied: asNullableBoolean(readback?.request_mapping_applied),
    materialization_action_id: asNonEmptyString(readback?.materialization_action_id) ?? null,
    materialization_operation: asNonEmptyString(readback?.materialization_operation) ?? null,
    recipient_id: asNonEmptyString(readback?.recipient_id) ?? null,
    recipient_label: asNonEmptyString(readback?.recipient_label) ?? null,
    recipient_external_id: asNonEmptyString(readback?.recipient_external_id) ?? null,
    destination_address_id: asNonEmptyString(readback?.destination_address_id) ?? null,
    destination_city: asNonEmptyString(readback?.destination_city) ?? null,
    destination_validation_status: asNonEmptyString(readback?.destination_validation_status) ?? null,
    response: options.invokeErrorMessage
      ? { ...response, error_message: options.invokeErrorMessage }
      : response,
    request_readback: readback,
  };
}

export function buildApiGatewaySyntheticResult(
  args: RunApiGatewayRequestTestArgs,
  nextCorrelationId: () => string,
): RunApiGatewayRequestTestResult {
  const correlationId =
    asNonEmptyString(args.correlation_id) ??
    asNonEmptyString(args.idempotency_key) ??
    nextCorrelationId();
  const requestId = `agr_seed_${Date.now()}`;
  const { path, query } = splitApiGatewayPath(args.path, args.query_string);
  return buildApiGatewayRequestResult(
    {
      ...args,
      correlation_id: correlationId,
      idempotency_key: asNonEmptyString(args.idempotency_key) ?? correlationId,
      path,
      query_string: query,
    },
    {
      accepted: true,
      diagnostic_only: true,
      correlation_id: correlationId,
      api_gateway_request_id: requestId,
    },
    {
      id: requestId,
      request_id: requestId,
      correlation_id: correlationId,
      method: normalizeApiGatewayMethod(args.method),
      path,
      query_string: query,
      intake_state: 'diagnostic_only',
      occurred_at: new Date().toISOString(),
    },
    { diagnosticOnly: true },
  );
}

export function apiGatewayReadbackOccurredAfter(row: ResourceRow, startedAtMs: number): boolean {
  const occurredAt = asNonEmptyString(row.occurred_at) ?? asNonEmptyString(row.created_at);
  if (!occurredAt) return false;
  const parsed = Date.parse(occurredAt);
  return Number.isFinite(parsed) && parsed >= startedAtMs - 10_000;
}

export function apiGatewayAuthRejectionMessage(row: ResourceRow): string {
  const code = asNonEmptyString(row.failure_code) ?? 'unauthorized';
  const message = asNonEmptyString(row.failure_message);
  const status = asNonEmptyString(String(row.http_status ?? ''));
  return [
    'API Gateway auth rejected by backend readback',
    status ? `(${status})` : null,
    code,
    message,
  ].filter(Boolean).join(' - ');
}

export function assertApiGatewaySelectedSourceMatchesReadback(
  args: RunApiGatewayRequestTestArgs,
  row: ResourceRow | null | undefined,
): void {
  const selectedSourceId = asNonEmptyString(args.source_id);
  if (!selectedSourceId || !row) return;
  const authenticatedSourceId =
    asNonEmptyString(row.source_id) ??
    asNonEmptyString(row.webhook_source_id);
  if (!authenticatedSourceId || authenticatedSourceId === selectedSourceId) return;
  throw new Error(
    `API Gateway source mismatch: selected source ${selectedSourceId} does not match authenticated token source ${authenticatedSourceId}`,
  );
}

export function apiGatewayEdgeAuthErrorMessage(
  response: Record<string, unknown>,
  invokeErrorMessage: string | null,
): string | null {
  const responseStatus = findNestedNumber(response, ['status', 'status_code', 'http_status']);
  const code =
    findNestedString(response, ['failure_code', 'error', 'code', 'message']) ??
    asNonEmptyString(invokeErrorMessage);
  const normalized = `${code ?? ''} ${invokeErrorMessage ?? ''}`.toLowerCase();
  const isAuthStatus = responseStatus === 401 || responseStatus === 403;
  const isAuthCode = normalized.includes('invalid_token') || normalized.includes('unauthorized');
  if (!isAuthStatus && !isAuthCode) return null;
  return [
    'API Gateway auth rejected by edge response',
    responseStatus != null ? `(${responseStatus})` : null,
    code,
  ].filter(Boolean).join(' - ');
}

function asNullableBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

export async function withApiGatewayInvokeTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const guarded = promise.catch((error) => {
    if (timedOut) return new Promise<T>(() => {});
    throw error;
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(API_GATEWAY_EDGE_INVOKE_TIMEOUT_MESSAGE));
    }, API_GATEWAY_EDGE_INVOKE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
