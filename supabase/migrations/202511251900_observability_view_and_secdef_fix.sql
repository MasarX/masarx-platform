-- Migration: Restore observability view and enforce search_path on securdef functions
-- Date: 2025-11-25 19:00 UTC

BEGIN;

-- Recreate observability_events_v to ensure telemetry coverage.
DROP VIEW IF EXISTS observability_events_v;
CREATE OR REPLACE VIEW observability_events_v AS
SELECT
    dl.id AS event_id,
    dl.organization_id,
    CASE
        WHEN dl.decision_category = 'http_response_emitted' THEN 'webhook_http_response'
        ELSE 'decision_log'
    END AS event_source,
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
FROM decision_log dl;

COMMENT ON VIEW observability_events_v IS
    'Unified observability view exposing decision_log-backed events plus webhook HTTP responses as event_source=webhook_http_response.';

-- Pin search_path for remaining SECURITY DEFINER functions flagged by tests.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'partition_apply_index_templates' AND p.pronargs = 0
  ) THEN
    EXECUTE 'ALTER FUNCTION public.partition_apply_index_templates() SET search_path = public, extensions, pg_temp';
  ELSE
    RAISE NOTICE 'partition_apply_index_templates not present; skipping search_path pin';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'audit' AND p.proname = 'capture_row_change'
  ) THEN
    EXECUTE 'ALTER FUNCTION audit.capture_row_change() SET search_path = public, extensions, pg_temp';
  ELSE
    RAISE NOTICE 'audit.capture_row_change not present; skipping search_path pin';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'run_domain_events_worker' AND p.pronargs = 0
  ) THEN
    EXECUTE 'ALTER FUNCTION public.run_domain_events_worker() SET search_path = public, extensions, pg_temp';
  ELSE
    RAISE NOTICE 'run_domain_events_worker not present; skipping search_path pin';
  END IF;
END $$;

COMMIT;
