-- Migration: HTTP response projections and helpers
-- Date: 2025-11-20 18:30 UTC

BEGIN;

CREATE OR REPLACE VIEW webhook_response_latest AS
SELECT
    wi.id AS webhook_inbox_id,
    wi.webhook_source_id,
    wi.provider_type,
    resp.http_status_code,
    resp.http_headers,
    resp.http_body,
    resp.response_mode,
    resp.response_outcome,
    resp.response_reason,
    resp.validation_results,
    resp.idempotency_key,
    resp.workflow_run_id,
    resp.workflow_run_step_id,
    resp.created_at AS response_created_at
FROM webhook_inbox wi
LEFT JOIN LATERAL (
    SELECT *
    FROM webhook_response_history wrh
    WHERE wrh.webhook_inbox_id = wi.id
    ORDER BY wrh.created_at DESC
    LIMIT 1
) resp ON TRUE;

COMMENT ON VIEW webhook_response_latest
    IS 'Latest HTTP response snapshot per webhook inbox entry (derived from webhook_response_history).';

COMMIT;

