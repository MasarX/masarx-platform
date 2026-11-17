-- Migration: webhook_ack_history view fix
-- Purpose: expose webhook_source_id for idempotency checks

BEGIN;

SET search_path TO public, pg_temp;

DROP VIEW IF EXISTS webhook_ack_history;

CREATE VIEW webhook_ack_history AS
SELECT
    dl.resource_id AS webhook_inbox_id,
    dl.organization_id,
    wi.webhook_source_id,
    COALESCE(dl.decision_inputs->>'mode', 'accepted_async') AS ack_mode,
    NULLIF(dl.decision_inputs->>'status', '')::INT AS ack_status_code,
    COALESCE(dl.decision_inputs->'headers', '{}'::jsonb) AS ack_headers,
    dl.decision_inputs->'body' AS ack_body,
    CASE
        WHEN dl.decision_outcome = 'response_failed' THEN 'ack_failed'
        WHEN dl.decision_outcome = 'response_replayed' THEN 'ack_sent'
        ELSE 'ack_sent'
    END AS ack_outcome,
    dl.decision_reason AS ack_reason,
    COALESCE(dl.decision_inputs->'validation_results', '{}'::jsonb) AS validation_results,
    NULL::UUID AS policy_settings_id,
    NULL::TEXT AS policy_scope_type,
    NULL::UUID AS policy_scope_id,
    NULL::INT AS policy_version,
    NULLIF(dl.decision_inputs->>'idempotency_key', '') AS idempotency_key,
    dl.decision_inputs->>'workflow_run_id' AS workflow_run_ref,
    dl.timestamp AS ack_sent_at
FROM decision_log dl
JOIN webhook_inbox wi ON wi.id = dl.resource_id
WHERE dl.resource_type = 'webhook_inbox'
  AND dl.decision_category = 'http_response_emitted';

COMMENT ON VIEW webhook_ack_history IS 'Compatibility view: exposes http_response_emitted decisions as webhook ack history.';

COMMIT;
