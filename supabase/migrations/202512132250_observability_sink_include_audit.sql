-- Plan: PLAN-202512-logging-trace-headers-audit-sink-v2 / Step: S02
-- Migration: Observability sink includes audit ledger
-- Purpose: Extend observability_sink_v to include audit_table_changes events for end-to-end 2AM debugging.

BEGIN;

CREATE OR REPLACE VIEW public.observability_sink_v AS
-- Base observability union (decision_log, webhook_http_response, api_call_log, outbound_calls)
SELECT
  event_id,
  organization_id,
  event_source,
  event_type,
  resource_type,
  resource_id,
  correlation_id,
  status,
  event_time,
  metadata
FROM public.observability_events_v

UNION ALL

-- Ops alerts (projection anchored to decision_log when available)
SELECT
  oa.id AS event_id,
  oa.organization_id,
  'ops_alerts'::text AS event_source,
  oa.alert_type AS event_type,
  COALESCE(dl.resource_type, 'unknown') AS resource_type,
  dl.resource_id AS resource_id,
  COALESCE(oa.correlation_id, dl.correlation_id) AS correlation_id,
  oa.severity AS status,
  oa.created_at AS event_time,
  jsonb_strip_nulls(jsonb_build_object(
    'message', oa.message,
    'details', oa.details,
    'decision_log_id', oa.decision_log_id,
    'acknowledged_at', oa.acknowledged_at,
    'acknowledged_by', oa.acknowledged_by
  )) AS metadata
FROM public.ops_alerts oa
LEFT JOIN public.decision_log dl ON dl.id = oa.decision_log_id

UNION ALL

-- Provider health signals
SELECT
  ph.id AS event_id,
  ph.organization_id,
  'provider_health_logs'::text AS event_source,
  ph.status AS event_type,
  'provider'::text AS resource_type,
  ph.provider_id AS resource_id,
  ph.correlation_id,
  ph.status AS status,
  ph.created_at AS event_time,
  jsonb_strip_nulls(jsonb_build_object(
    'error_message', ph.error_message,
    'metadata', ph.metadata,
    'decision_log_id', ph.decision_log_id
  )) AS metadata
FROM public.provider_health_logs ph

UNION ALL

-- Durable alert triggers (rule-driven)
SELECT
  at.id AS event_id,
  at.organization_id,
  'alert_triggers'::text AS event_source,
  'alert_triggered'::text AS event_type,
  at.resource_type,
  at.resource_id,
  CASE
    WHEN at.context ? 'correlation_id'
     AND (at.context->>'correlation_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (at.context->>'correlation_id')::uuid
    ELSE NULL
  END AS correlation_id,
  at.severity AS status,
  at."timestamp" AS event_time,
  jsonb_strip_nulls(jsonb_build_object(
    'alert_rule_id', at.alert_rule_id,
    'message', at.message,
    'context', at.context,
    'notified_at', at.notified_at,
    'acknowledged_at', at.acknowledged_at,
    'resolution_notes', at.resolution_notes
  )) AS metadata
FROM public.alert_triggers at

UNION ALL

-- Audit ledger (row/statement changes across all public tables)
SELECT
  ac.id AS event_id,
  ac.organization_id,
  'audit_table_changes'::text AS event_source,
  ac.op AS event_type,
  ac.table_name AS resource_type,
  CASE
    WHEN ac.pk ? 'id'
     AND (ac.pk->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (ac.pk->>'id')::uuid
    ELSE NULL
  END AS resource_id,
  ac.correlation_id,
  ac.op AS status,
  ac.created_at AS event_time,
  jsonb_strip_nulls(jsonb_build_object(
    'schema_name', ac.schema_name,
    'table_name', ac.table_name,
    'pk', ac.pk,
    'changed_by', ac.changed_by,
    'row_old', ac.row_old,
    'row_new', ac.row_new
  )) AS metadata
FROM public.audit_table_changes ac;

COMMENT ON VIEW public.observability_sink_v IS
  'Unified observability sink view (observability_events_v + ops_alerts + provider_health_logs + alert_triggers + audit_table_changes) for cross-system tracing.';

-- service_role-only
REVOKE ALL ON public.observability_sink_v FROM PUBLIC;
REVOKE ALL ON public.observability_sink_v FROM anon;
REVOKE ALL ON public.observability_sink_v FROM authenticated;
GRANT SELECT ON public.observability_sink_v TO service_role;

COMMIT;

