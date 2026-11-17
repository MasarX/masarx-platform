-- Migration: http_response_views_fix
-- Purpose: Ensure webhook_response_events and webhook_response_latest views
--          are present and aligned with the decision_log-backed event model.
-- Context:
--   Parent (mhln) history shows 202511201935_http_response_event_model applied,
--   but webhook_response_latest is missing (likely from historical drift).
--   This migration recreates the projection views idempotently.

BEGIN;

-- Projection view backed by decision_log
CREATE OR REPLACE VIEW webhook_response_events AS
SELECT
    dl.id AS decision_log_id,
    dl.resource_id AS webhook_inbox_id,
    dl.organization_id,
    dl.decision_outcome AS response_outcome,
    dl.decision_reason AS response_reason,
    COALESCE(dl.decision_inputs->>'mode', 'accepted_async') AS response_mode,
    NULLIF(dl.decision_inputs->>'status', '')::INT AS http_status_code,
    dl.decision_inputs->'headers' AS http_headers,
    dl.decision_inputs->'body' AS http_body,
    COALESCE(dl.decision_inputs->'validation_results', '{}'::jsonb) AS validation_results,
    NULLIF(dl.decision_inputs->>'idempotency_key', '') AS idempotency_key,
    NULLIF(dl.decision_inputs->>'workflow_run_id', '')::UUID AS workflow_run_id,
    NULLIF(dl.decision_inputs->>'workflow_run_step_id', '')::UUID AS workflow_run_step_id,
    NULLIF(dl.decision_inputs->>'followup_workflow_run_id', '')::UUID AS followup_workflow_run_id,
    dl.timestamp AS response_created_at
FROM decision_log dl
WHERE dl.resource_type = 'webhook_inbox'
  AND dl.decision_category = 'http_response_emitted';

COMMENT ON VIEW webhook_response_events
    IS 'Event stream of webhook HTTP responses sourced from decision_log (single source of truth).';

-- Latest-per-inbox view for tests and observability
CREATE OR REPLACE VIEW webhook_response_latest AS
SELECT
    e.decision_log_id,
    e.webhook_inbox_id,
    e.organization_id,
    e.response_outcome,
    e.response_reason,
    e.response_mode,
    e.http_status_code,
    e.http_headers,
    e.http_body,
    e.validation_results,
    e.idempotency_key,
    e.workflow_run_id,
    e.workflow_run_step_id,
    e.followup_workflow_run_id,
    e.response_created_at
FROM (
    SELECT
        we.*,
        ROW_NUMBER() OVER (
            PARTITION BY we.webhook_inbox_id
            ORDER BY we.response_created_at DESC, we.decision_log_id DESC
        ) AS row_rank
    FROM webhook_response_events we
) e
WHERE e.row_rank = 1;

COMMENT ON VIEW webhook_response_latest
    IS 'Latest webhook HTTP response per inbox row (decision_log projection).';

COMMIT;
