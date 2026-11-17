-- Migration: Geocoding observability views
-- Purpose: Provide dynamic monitoring surfaces for queue depth, cache metrics, and provider usage.
-- Alignment: SIMPLE / SCALABLE / DYNAMIC - views driven entirely by runtime data (no hard coding).

BEGIN;

CREATE OR REPLACE VIEW public.geocoding_queue_status_v AS
WITH geocoding_runs AS (
    SELECT
        wr.id AS workflow_run_id,
        ctx.organization_id,
        ctx.client_id,
        wt.name AS workflow_template_name
    FROM workflow_runs wr
    JOIN workflow_templates wt ON wt.id = wr.workflow_template_id
    LEFT JOIN LATERAL geocoding_extract_context(wr) ctx ON TRUE
    WHERE wt.name LIKE 'workflow_geocoding%'
)
SELECT
    gr.organization_id,
    gr.client_id,
    COUNT(*) FILTER (WHERE wrs.step_status = 'pending') AS pending_steps,
    COUNT(*) FILTER (WHERE wrs.step_status = 'in_progress') AS in_progress_steps,
    COUNT(*) FILTER (WHERE wrs.step_status = 'failed') AS failed_steps,
    COUNT(*) FILTER (
        WHERE wrs.step_status = 'pending'
          AND wrs.run_at IS NOT NULL
          AND wrs.run_at < now()
    ) AS overdue_steps,
    MAX(wrs.operation_started_at) AS last_started_at,
    MAX(wrs.updated_at) AS last_step_update
FROM geocoding_runs gr
JOIN workflow_run_steps wrs ON wrs.workflow_run_id = gr.workflow_run_id
WHERE wrs.operation_name IN ('dispatch_provider', 'fallback_provider')
GROUP BY gr.organization_id, gr.client_id;

COMMENT ON VIEW public.geocoding_queue_status_v
    IS 'Queue depth for geocoding workflows (pending/in_progress/failed/overdue per organization/client).';

CREATE OR REPLACE VIEW public.geocoding_cache_metrics_v AS
WITH attempt_rollup AS (
    SELECT
        organization_id,
        client_id,
        COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded_attempts,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_attempts,
        COUNT(*) AS total_attempts,
        COUNT(DISTINCT CASE WHEN status = 'succeeded' THEN address_id END) AS addresses_geocoded,
        MAX(created_at) AS last_attempt_at
    FROM geocoding_attempts
    GROUP BY organization_id, client_id
),
cache_rollup AS (
    SELECT
        organization_id,
        client_id,
        COUNT(*) FILTER (WHERE is_primary) AS primary_cache_entries,
        COUNT(DISTINCT address_id) AS cached_addresses
    FROM geocodes
    GROUP BY organization_id, client_id
)
SELECT
    ar.organization_id,
    ar.client_id,
    ar.succeeded_attempts,
    ar.failed_attempts,
    ar.total_attempts,
    CASE
        WHEN ar.total_attempts = 0 THEN NULL
        ELSE ROUND(ar.succeeded_attempts::NUMERIC / ar.total_attempts, 4)
    END AS success_rate,
    ar.addresses_geocoded,
    COALESCE(cr.cached_addresses, 0) AS cached_addresses,
    COALESCE(cr.primary_cache_entries, 0) AS primary_cache_entries,
    ar.last_attempt_at
FROM attempt_rollup ar
LEFT JOIN cache_rollup cr
  ON cr.organization_id = ar.organization_id
 AND cr.client_id = ar.client_id;

COMMENT ON VIEW public.geocoding_cache_metrics_v
    IS 'Cache and success ratios for geocoding attempts per organization/client.';

CREATE OR REPLACE VIEW public.geocoding_provider_spend_v AS
SELECT
    organization_id,
    client_id,
    provider_name,
    COUNT(*) AS total_attempts,
    COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded_attempts,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_attempts,
    ROUND(AVG(confidence_score), 4) AS avg_confidence,
    AVG(duration_ms) AS avg_duration_ms,
    SUM(duration_ms) AS total_duration_ms,
    MAX(created_at) AS last_attempt_at
FROM geocoding_attempts
GROUP BY organization_id, client_id, provider_name;

COMMENT ON VIEW public.geocoding_provider_spend_v
    IS 'Per-provider attempt counts, confidence and latency metrics (proxy for spend monitoring).';

COMMIT;
