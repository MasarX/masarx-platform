-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Mobile policy resolvers v1 (category-specific helpers)
-- Date: 2026-01-25
--
-- Goal:
--   - Provide stable, category-specific resolver helpers that wrap the canonical
--     policy-context ladder resolver (resource > source > sender > client > tenant > global).
--   - Keep call sites consistent and reduce ad-hoc ladder usage.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251045_mobile_policy_resolvers_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_mobile_ingest_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE sql
STABLE
AS $function$
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('mobile_ingest_policy', p_context);
$function$;

COMMENT ON FUNCTION public.resolve_mobile_ingest_policy(JSONB)
  IS 'Resolve mobile_ingest_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_mobile_ingest_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_ingest_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_location_tracking_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE sql
STABLE
AS $function$
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('location_tracking_policy', p_context);
$function$;

COMMENT ON FUNCTION public.resolve_location_tracking_policy(JSONB)
  IS 'Resolve location_tracking_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_location_tracking_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_location_tracking_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_scan_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE sql
STABLE
AS $function$
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('scan_policy', p_context);
$function$;

COMMENT ON FUNCTION public.resolve_scan_policy(JSONB)
  IS 'Resolve scan_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_scan_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_scan_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_pod_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE sql
STABLE
AS $function$
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('pod_policy', p_context);
$function$;

COMMENT ON FUNCTION public.resolve_pod_policy(JSONB)
  IS 'Resolve pod_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_pod_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_pod_policy(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601251045_mobile_policy_resolvers_v1'));
COMMIT;

