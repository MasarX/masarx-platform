-- Migration: observability view alignment for webhook http responses
-- Purpose: Ensure observability_events_v surfaces http_response_emitted decisions with expected resource_type and event_type for compatibility queries/tests.

BEGIN;

DROP VIEW IF EXISTS observability_events_v;

CREATE OR REPLACE VIEW observability_events_v AS
WITH outbound_org AS (
    SELECT
        oc.id,
        COALESCE(
            s.organization_id,
            NULLIF(oc.context ->> 'organization_id', '')::uuid
        ) AS organization_id
    FROM outbound_calls oc
    LEFT JOIN shipments s ON s.id = oc.shipment_id
)
SELECT
    dl.id AS event_id,
    dl.organization_id,
    'decision_log'::text AS event_source,
    dl.decision_category AS event_type,
    dl.resource_type,
    dl.resource_id,
    dl.correlation_id,
    dl.decision_outcome AS status,
    dl.timestamp AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'decision_point', dl.decision_point,
        'decision_reason', dl.decision_reason,
        'performed_by', dl.performed_by_system,
        'settings_resolution_id', dl.settings_resolution_id,
        'decision_inputs', dl.decision_inputs
    )) AS metadata
FROM decision_log dl

UNION ALL

SELECT
    acl.id AS event_id,
    acl.organization_id,
    'api_call_log'::text AS event_source,
    acl.operation AS event_type,
    'api_call'::text AS resource_type,
    acl.provider_id AS resource_id,
    acl.correlation_id,
    CASE
        WHEN acl.response_status BETWEEN 200 AND 299 THEN 'succeeded'
        WHEN acl.response_status IS NULL THEN 'unknown'
        ELSE 'failed'
    END AS status,
    acl.timestamp AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'method', acl.method,
        'url', acl.url,
        'response_status', acl.response_status,
        'duration_ms', acl.duration_ms,
        'error_message', acl.error_message,
        'circuit_breaker_state', acl.circuit_breaker_state
    )) AS metadata
FROM api_call_log acl

UNION ALL

SELECT
    we.decision_log_id AS event_id,
    COALESCE(we.organization_id, dl.organization_id) AS organization_id,
    'webhook_http_response'::text AS event_source,
    'http_response_emitted'::text AS event_type,
    'webhook_inbox'::text AS resource_type,
    we.webhook_inbox_id AS resource_id,
    dl.correlation_id,
    COALESCE(we.response_outcome, 'unknown') AS status,
    we.response_created_at AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'http_status_code', we.http_status_code,
        'response_mode', we.response_mode,
        'response_reason', we.response_reason,
        'workflow_run_id', we.workflow_run_id,
        'workflow_run_step_id', we.workflow_run_step_id,
        'followup_workflow_run_id', we.followup_workflow_run_id,
        'validation_results', we.validation_results,
        'idempotency_key', we.idempotency_key
    )) AS metadata
FROM webhook_response_events we
JOIN decision_log dl ON dl.id = we.decision_log_id

UNION ALL

SELECT
    oc.id AS event_id,
    outbound_org.organization_id,
    'outbound_calls'::text AS event_source,
    oc.call_type AS event_type,
    oc.target_type AS resource_type,
    oc.target_id AS resource_id,
    oc.correlation_id,
    oc.status,
    COALESCE(oc.completed_at, oc.created_at) AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'method', oc.method,
        'url', oc.url,
        'response_status_code', oc.response_status_code,
        'error_message', oc.error_message,
        'latency_ms', oc.latency_ms,
        'priority', oc.priority,
        'workflow_run_step_id', oc.workflow_run_step_id
    )) AS metadata
FROM outbound_calls oc
LEFT JOIN outbound_org ON outbound_org.id = oc.id;

COMMENT ON VIEW observability_events_v IS
    'Unified observability view (decision_log, webhook_http_response, api_call_log, outbound_calls) with correlation_id for end-to-end tracing.';

COMMIT;
