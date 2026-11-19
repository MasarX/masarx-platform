import * as api from '@/lib/api';
import type { RunApiGatewayRequestTestResult } from '@/lib/api';

export const API_GATEWAY_TEST_READBACK_POLL_INTERVAL_MS = 4_000;
export const API_GATEWAY_TEST_READBACK_MAX_ATTEMPTS = 90;

export interface ApiGatewayRequestReadback extends Record<string, unknown> {
  request_id?: string | null;
  id?: string | null;
  correlation_id?: string | null;
  workflow_run_id?: string | null;
  outbound_call_id?: string | null;
  intake_state?: string | null;
  outbound_status?: string | null;
  status_code?: number | string | null;
  query_string?: string | null;
  error_code?: string | null;
  outbound_error_message?: string | null;
  shipment_id?: string | null;
  tracking_number?: string | null;
  shipment_status?: string | null;
  idempotency_key?: string | null;
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
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizedValue(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function apiGatewayRequestReadbackIsTerminal(row: ApiGatewayRequestReadback): boolean {
  const intakeState = normalizedValue(row.intake_state);
  const outboundStatus = normalizedValue(row.outbound_status);
  const statusCode = asNumber(row.status_code);
  if (
    [
      'diagnostic_only',
      'not_dispatched',
      'provider_failed',
      'shipment_materialized',
      'timeout',
      'timed_out',
    ].includes(intakeState)
  ) {
    return true;
  }
  if (
    [
      'cancelled',
      'canceled',
      'completed',
      'failed',
      'permanently_failed',
      'timeout',
      'timed_out',
    ].includes(outboundStatus)
  ) {
    return true;
  }
  return statusCode != null && statusCode >= 400;
}

export function requestReadbackFromGatewayTestResult(
  result: RunApiGatewayRequestTestResult | null,
): ApiGatewayRequestReadback | null {
  const row = result?.request_readback;
  if (!row || typeof row !== 'object') return null;
  if (!asString((row as Record<string, unknown>).request_id)) return null;
  return row as ApiGatewayRequestReadback;
}

export function mergeApiGatewayTestResultWithReadback(
  result: RunApiGatewayRequestTestResult,
  row: ApiGatewayRequestReadback,
): RunApiGatewayRequestTestResult {
  const readbackSummary = {
    request_id: asString(row.request_id) ?? asString(row.id) ?? result.api_gateway_request_id,
    intake_state: asString(row.intake_state),
    outbound_status: asString(row.outbound_status),
    status_code: asNumber(row.status_code),
    query_string: asString(row.query_string),
    error_code: asString(row.error_code),
    outbound_error_message: asString(row.outbound_error_message),
    workflow_run_id: asString(row.workflow_run_id),
    outbound_call_id: asString(row.outbound_call_id),
    shipment_id: asString(row.shipment_id),
    tracking_number: asString(row.tracking_number),
    idempotency_key: asString(row.idempotency_key),
    replay_of_request_id: asString(row.replay_of_request_id),
    mutation_intent: asString(row.mutation_intent),
    request_mapping_config_id: asString(row.request_mapping_config_id),
    request_mapping_key: asString(row.request_mapping_key),
    request_mapping_type: asString(row.request_mapping_type),
    request_mapping_target: asString(row.request_mapping_target),
    request_mapping_applied: row.request_mapping_applied === true,
    materialization_action_id: asString(row.materialization_action_id),
    materialization_operation: asString(row.materialization_operation),
    recipient_id: asString(row.recipient_id),
    recipient_label: asString(row.recipient_label),
    recipient_external_id: asString(row.recipient_external_id),
    destination_address_id: asString(row.destination_address_id),
    destination_city: asString(row.destination_city),
    destination_validation_status: asString(row.destination_validation_status),
  };

  return {
    ...result,
    api_gateway_request_id: readbackSummary.request_id,
    workflow_run_id: readbackSummary.workflow_run_id ?? result.workflow_run_id,
    outbound_call_id: readbackSummary.outbound_call_id ?? result.outbound_call_id,
    intake_state: readbackSummary.intake_state ?? result.intake_state,
    error_code: readbackSummary.error_code ?? result.error_code,
    outbound_error_message: readbackSummary.outbound_error_message ?? result.outbound_error_message,
    outbound_status: readbackSummary.outbound_status ?? result.outbound_status,
    query_string: readbackSummary.query_string ?? result.query_string,
    shipment_id: readbackSummary.shipment_id ?? result.shipment_id,
    tracking_number: readbackSummary.tracking_number ?? result.tracking_number,
    shipment_status: asString(row.shipment_status) ?? result.shipment_status,
    response: {
      ...objectRecord(result.response),
      backend_readback: readbackSummary,
    },
    request_readback: row,
  };
}

export async function readApiGatewayTestRequestReadback(
  result: RunApiGatewayRequestTestResult,
): Promise<ApiGatewayRequestReadback | null> {
  const filters: Array<Record<string, unknown>> = [];
  const requestId = asString(result.api_gateway_request_id);
  const correlationId = asString(result.correlation_id);
  if (requestId) {
    const row = await api.ui_get_resource_v1<ApiGatewayRequestReadback>('api_gateway_requests', requestId);
    if (row?.request_id || row?.id) return row;
  }
  if (requestId) filters.push({ request_id: requestId });
  if (correlationId) filters.push({ correlation_id: correlationId });

  for (const filter of filters) {
    const readback = await api.ui_list_resource_v1<ApiGatewayRequestReadback>(
      'api_gateway_requests',
      { filter, page_size: 1 },
    );
    const row = readback.rows[0];
    if (row) return row;
  }

  return null;
}
