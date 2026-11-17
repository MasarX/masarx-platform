-- Plan: PLAN-202512-logging-enterprise-grade-v2 / Step: S03
-- Migration: Observability dashboard views (ACK metrics, provider health, circuit breaker)
-- Purpose: Provide canonical, queryable sources for ops dashboards without external log sinks.

BEGIN;

-------------------------------------------------------------------------------
-- Webhook ACK metrics (5m window)
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.webhook_ack_metrics_5m_v AS
SELECT
  ws.organization_id,
  wi.webhook_source_id,
  ws.source_identifier,
  COUNT(*) AS total_responses,
  COUNT(*) FILTER (WHERE we.http_status_code BETWEEN 200 AND 299) AS ok_responses,
  COUNT(*) FILTER (WHERE we.http_status_code IS NULL) AS unknown_responses,
  COUNT(*) FILTER (WHERE we.http_status_code < 200 OR we.http_status_code >= 300) AS failed_responses,
  (COUNT(*) FILTER (WHERE we.http_status_code < 200 OR we.http_status_code >= 300))::NUMERIC
    / NULLIF(COUNT(*), 0) AS failure_rate,
  AVG(
    CASE
      WHEN dl.decision_inputs ? 'processing_ms'
       AND (dl.decision_inputs->>'processing_ms') ~ '^[0-9]+$'
      THEN (dl.decision_inputs->>'processing_ms')::INT
      ELSE NULL
    END
  ) AS avg_processing_ms,
  MAX(
    CASE
      WHEN dl.decision_inputs ? 'processing_ms'
       AND (dl.decision_inputs->>'processing_ms') ~ '^[0-9]+$'
      THEN (dl.decision_inputs->>'processing_ms')::INT
      ELSE NULL
    END
  ) AS max_processing_ms,
  MAX(we.response_created_at) AS last_response_at
FROM public.webhook_response_events we
JOIN public.webhook_inbox wi ON wi.id = we.webhook_inbox_id
JOIN public.webhook_sources ws ON ws.id = wi.webhook_source_id
JOIN public.decision_log dl ON dl.id = we.decision_log_id
WHERE we.response_created_at > now() - interval '5 minutes'
GROUP BY ws.organization_id, wi.webhook_source_id, ws.source_identifier;

COMMENT ON VIEW public.webhook_ack_metrics_5m_v IS
  'Webhook ACK KPIs for last 5 minutes (status + failure_rate + processing_ms) sourced from decision_log projections.';

-------------------------------------------------------------------------------
-- Provider health (latest per provider)
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.provider_health_latest_v AS
SELECT
  p.organization_id,
  ph.provider_id,
  p.name AS provider_name,
  ph.status,
  ph.error_message,
  ph.metadata,
  ph.decision_log_id,
  ph.correlation_id,
  ph.created_at
FROM (
  SELECT
    phl.*,
    ROW_NUMBER() OVER (
      PARTITION BY phl.provider_id
      ORDER BY phl.created_at DESC, phl.id DESC
    ) AS row_rank
  FROM public.provider_health_logs phl
) ph
JOIN public.providers p ON p.id = ph.provider_id
WHERE ph.row_rank = 1;

COMMENT ON VIEW public.provider_health_latest_v IS
  'Latest provider health signal per provider_id sourced from provider_health_logs.';

-------------------------------------------------------------------------------
-- Circuit breaker dashboard summary (current state + last health signal)
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.circuit_breaker_dashboard_v AS
SELECT
  p.organization_id,
  cbs.provider_id,
  p.name AS provider_name,
  cbs.operation_name,
  cbs.state,
  cbs.failure_count,
  cbs.success_count,
  cbs.reopen_count,
  cbs.manual_intervention_required,
  cbs.last_failure_at,
  cbs.last_success_at,
  cbs.opened_at,
  cbs.half_open_test_at,
  cbs.last_recovery_attempt_at,
  cbs.updated_at,
  ph.status AS last_health_status,
  ph.error_message AS last_health_error,
  ph.created_at AS last_health_at
FROM public.circuit_breaker_state cbs
JOIN public.providers p ON p.id = cbs.provider_id
LEFT JOIN LATERAL (
  SELECT status, error_message, created_at
  FROM public.provider_health_logs phl
  WHERE phl.provider_id = cbs.provider_id
  ORDER BY phl.created_at DESC, phl.id DESC
  LIMIT 1
) ph ON TRUE;

COMMENT ON VIEW public.circuit_breaker_dashboard_v IS
  'Current circuit breaker state per provider operation with latest provider_health_logs signal.';

-------------------------------------------------------------------------------
-- Grants (service_role-only)
-------------------------------------------------------------------------------

DO $$
BEGIN
  -- webhook_ack_metrics_5m_v
  EXECUTE 'REVOKE ALL ON public.webhook_ack_metrics_5m_v FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.webhook_ack_metrics_5m_v TO service_role';

  -- provider_health_latest_v
  EXECUTE 'REVOKE ALL ON public.provider_health_latest_v FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.provider_health_latest_v TO service_role';

  -- circuit_breaker_dashboard_v
  EXECUTE 'REVOKE ALL ON public.circuit_breaker_dashboard_v FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.circuit_breaker_dashboard_v TO service_role';
END $$;

COMMIT;
