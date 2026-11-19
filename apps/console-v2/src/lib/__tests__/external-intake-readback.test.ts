import { describe, expect, it } from 'vitest';

import {
  buildApiGatewayRequestResult,
  buildWebhookReceiverTestResult,
  type BuildWebhookReceiverTestResultArgs,
} from '../data-source/external-intake-readback';

describe('external intake readback helpers', () => {
  it('builds a webhook receiver result from backend readback without adapter-local field assembly', () => {
    const args: BuildWebhookReceiverTestResultArgs = {
      receiverStatus: 202,
      durationMs: 412,
      correlationId: 'corr-live-123',
      idempotencyKey: 'idem-live-123',
      ackOutcome: 'ack_sent',
      responseOutcome: 'response_sent',
      ackStatusCode: 202,
      ackReason: 'accepted_async',
      workflowRunId: 'workflow-run-1',
      followupWorkflowRunId: 'workflow-run-2',
      webhookId: 'webhook-inbox-1',
      canonicalIntent: 'shipment.create',
      webhookProcessingStatus: 'succeeded',
      sourceLabel: 'First Tenant API Source',
      sourceIdentifier: 'first-tenant-source',
      providerTypeLabel: 'Webhook',
      mappingConfigId: 'mapping-1',
      mappingLabel: 'Shipment create mapping',
      mappingTarget: 'shipments.create',
      mappingVersion: 4,
      mappingRulesCount: 12,
      errorMessage: null,
      isTerminal: true,
      isActionable: false,
      shipmentId: 'shipment-1',
      trackingNumber: '2600525DJ',
      authRejectionId: null,
      authRejectionFailureCode: null,
      authRejectionFailureMessage: null,
      authRejectionHttpStatus: null,
      authRejectionSourceLabel: null,
      authRejectionSourceIdentifier: null,
      authRejectionSourceResolved: null,
      authRejectionTokenFingerprint: null,
      authRejectionRejectionClass: null,
      response: {
        status: 'accepted_async',
        planned_resource: {
          type: 'shipment',
          tracking_number: '2600525DJ',
        },
      },
      workflowSteps: [{ id: 'step-1', status: 'completed' }],
    };

    expect(buildWebhookReceiverTestResult(args)).toEqual({
      ok: true,
      receiver_status: 202,
      duration_ms: 412,
      correlation_id: 'corr-live-123',
      idempotency_key: 'idem-live-123',
      ack_outcome: 'ack_sent',
      response_outcome: 'response_sent',
      ack_status_code: 202,
      ack_reason: 'accepted_async',
      workflow_run_id: 'workflow-run-1',
      followup_workflow_run_id: 'workflow-run-2',
      webhook_id: 'webhook-inbox-1',
      canonical_intent: 'shipment.create',
      webhook_processing_status: 'succeeded',
      source_label: 'First Tenant API Source',
      source_identifier: 'first-tenant-source',
      provider_type_label: 'Webhook',
      mapping_config_id: 'mapping-1',
      mapping_label: 'Shipment create mapping',
      mapping_target: 'shipments.create',
      mapping_version: 4,
      mapping_rules_count: 12,
      error_message: null,
      is_terminal: true,
      is_actionable: false,
      shipment_id: 'shipment-1',
      tracking_number: '2600525DJ',
      auth_rejection_id: null,
      auth_rejection_failure_code: null,
      auth_rejection_failure_message: null,
      auth_rejection_http_status: null,
      auth_rejection_source_label: null,
      auth_rejection_source_identifier: null,
      auth_rejection_source_resolved: null,
      auth_rejection_token_fingerprint: null,
      auth_rejection_rejection_class: null,
      response: {
        status: 'accepted_async',
        planned_resource: {
          type: 'shipment',
          tracking_number: '2600525DJ',
        },
      },
      workflow_steps: [{ id: 'step-1', status: 'completed' }],
    });
  });

  it('keeps absent optional webhook receiver readback fields explicit and null-safe', () => {
    const result = buildWebhookReceiverTestResult({
      correlationId: 'corr-pending',
      idempotencyKey: 'idem-pending',
      response: { status: 'accepted' },
    });

    expect(result).toMatchObject({
      ok: true,
      receiver_status: 200,
      duration_ms: null,
      correlation_id: 'corr-pending',
      idempotency_key: 'idem-pending',
      ack_outcome: null,
      response_outcome: null,
      workflow_run_id: null,
      shipment_id: null,
      tracking_number: null,
      auth_rejection_id: null,
      auth_rejection_failure_code: null,
      workflow_steps: [],
    });
  });

  it('builds explicit webhook receiver auth-rejection readback evidence', () => {
    const result = buildWebhookReceiverTestResult({
      receiverStatus: 401,
      correlationId: 'corr-auth-rejected',
      idempotencyKey: 'idem-auth-rejected',
      ackOutcome: 'auth_rejected',
      responseOutcome: 'auth_rejected',
      ackStatusCode: 401,
      ackReason: 'retired_webhook_source_token',
      authRejectionId: 'iar-retired-token',
      authRejectionFailureCode: 'retired_webhook_source_token',
      authRejectionFailureMessage: 'Retired webhook source token',
      authRejectionHttpStatus: 401,
      authRejectionSourceLabel: 'API Browser Proof Source',
      authRejectionSourceIdentifier: 'api-browser-proof-source',
      authRejectionSourceResolved: true,
      authRejectionTokenFingerprint: 'sha256:abc123',
      authRejectionRejectionClass: 'unauthorized',
      response: {
        accepted: false,
        error: 'Unauthorized webhook source',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      receiver_status: 401,
      response_outcome: 'auth_rejected',
      webhook_id: null,
      shipment_id: null,
      auth_rejection_id: 'iar-retired-token',
      auth_rejection_failure_code: 'retired_webhook_source_token',
      auth_rejection_http_status: 401,
      auth_rejection_source_label: 'API Browser Proof Source',
      auth_rejection_source_resolved: true,
      auth_rejection_token_fingerprint: 'sha256:abc123',
    });
  });

  it('builds API Gateway shipment proof only from backend request readback', () => {
    const result = buildApiGatewayRequestResult(
      {
        source_id: 'src-live-api',
        auth_token: 'token-must-not-render',
        method: 'POST',
        path: '/api/ship/request/by-email',
        payload: { receiverName: 'API Receiver' },
        idempotency_key: 'idem-api-readback',
      },
      {
        accepted: true,
        shipment_id: 'edge-response-shipment-only',
        tracking_number: 'EDGE-TRACKING-ONLY',
        workflow_run_id: 'wfr-edge-response',
      },
      {
        id: 'req-api-readback',
        request_id: 'req-api-readback',
        correlation_id: 'corr-api-readback',
        workflow_run_id: 'wfr-api-readback',
        intake_state: 'shipment_materialized',
        shipment_id: 'shp-api-readback',
        tracking_number: 'API-READBACK-001',
        shipment_status: 'created',
        replay_of_request_id: 'req-api-original',
        mutation_intent: 'shipment.create',
        request_mapping_config_id: 'map-api-readback',
        request_mapping_key: 'first-tenant-create',
        request_mapping_type: 'api_gateway_inbound',
        request_mapping_target: 'shipments.create',
        request_mapping_applied: 'true',
        materialization_action_id: 'act-api-readback',
        materialization_operation: 'inserted',
        recipient_id: 'rec-api-readback',
        recipient_label: 'API Receiver',
        recipient_external_id: 'receiver-api-001',
        destination_address_id: 'addr-api-readback',
        destination_city: 'Riyadh',
        destination_validation_status: 'valid',
      },
    );

    expect(result).toMatchObject({
      api_gateway_request_id: 'req-api-readback',
      workflow_run_id: 'wfr-api-readback',
      intake_state: 'shipment_materialized',
      shipment_id: 'shp-api-readback',
      tracking_number: 'API-READBACK-001',
      shipment_status: 'created',
      replay_of_request_id: 'req-api-original',
      mutation_intent: 'shipment.create',
      request_mapping_config_id: 'map-api-readback',
      request_mapping_key: 'first-tenant-create',
      request_mapping_type: 'api_gateway_inbound',
      request_mapping_target: 'shipments.create',
      request_mapping_applied: true,
      materialization_action_id: 'act-api-readback',
      materialization_operation: 'inserted',
      recipient_id: 'rec-api-readback',
      recipient_label: 'API Receiver',
      recipient_external_id: 'receiver-api-001',
      destination_address_id: 'addr-api-readback',
      destination_city: 'Riyadh',
      destination_validation_status: 'valid',
    });
    expect(JSON.stringify(result)).not.toContain('token-must-not-render');
  });

  it('does not promote API Gateway response-only shipment fields without backend readback', () => {
    const result = buildApiGatewayRequestResult(
      {
        source_id: 'src-live-api',
        auth_token: 'token-must-not-render',
        method: 'POST',
        path: '/api/ship/request/by-email',
        payload: { receiverName: 'API Receiver' },
        idempotency_key: 'idem-api-response-only',
      },
      {
        accepted: true,
        shipment_id: 'edge-response-shipment-only',
        tracking_number: 'EDGE-TRACKING-ONLY',
        workflow_run_id: 'wfr-edge-response',
      },
      {
        id: 'req-api-response-only',
        request_id: 'req-api-response-only',
        correlation_id: 'corr-api-response-only',
        workflow_run_id: 'wfr-api-response-only',
        intake_state: 'workflow_queued',
        shipment_id: null,
        tracking_number: null,
      },
    );

    expect(result.workflow_run_id).toBe('wfr-api-response-only');
    expect(result.shipment_id).toBeNull();
    expect(result.tracking_number).toBeNull();
    expect(result.response).toMatchObject({
      shipment_id: 'edge-response-shipment-only',
      tracking_number: 'EDGE-TRACKING-ONLY',
    });
  });
});
