-- Migration 202511021215: Unified observability view
-- Purpose: Provide a single query surface joining decision, webhook, outbound, and API call telemetry.
-- Alignment: SIMPLE · SCALABLE · DYNAMIC operations (Plan.md §5 observability objectives)
-- Dependencies: Base observability tables (decision_log, api_call_log, webhook_ack_history, outbound_calls)

SET search_path = public;

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
    NULL::uuid AS correlation_id,
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
    wah.id AS event_id,
    ws.organization_id,
    'webhook_ack_history'::text AS event_source,
    COALESCE(wah.ack_outcome, 'acknowledged') AS event_type,
    'webhook'::text AS resource_type,
    wah.webhook_inbox_id AS resource_id,
    wi.correlation_id,
    COALESCE(wah.ack_outcome, 'unknown') AS status,
    wah.ack_sent_at AS event_time,
    jsonb_strip_nulls(jsonb_build_object(
        'ack_status_code', wah.ack_status_code,
        'ack_reason', wah.ack_reason,
        'policy_scope_type', wah.policy_scope_type,
        'policy_scope_id', wah.policy_scope_id,
        'policy_version', wah.policy_version,
        'validation_results', wah.validation_results
    )) AS metadata
FROM webhook_ack_history wah
JOIN webhook_inbox wi ON wi.id = wah.webhook_inbox_id
JOIN webhook_sources ws ON ws.id = wah.webhook_source_id

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
'Unified observability view (decision_log, api_call_log, webhook_ack_history, outbound_calls) exposing event_id, scope, status, and metadata for incident triage.';
