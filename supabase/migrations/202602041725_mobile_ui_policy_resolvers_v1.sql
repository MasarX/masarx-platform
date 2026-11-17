-- Plan: PLAN-202602-mobile-field-ops-native-app-v1 / Step: S04
-- Migration: Mobile UI policy resolvers v1 (category-specific helpers)
-- Date: 2026-02-04
--
-- Goal:
--   - Provide stable, category-specific resolver helpers that wrap the canonical
--     policy-context ladder resolver (resource > source > sender > client > tenant > global).
--
BEGIN;
SELECT pg_advisory_lock(hashtext('202602041725_mobile_ui_policy_resolvers_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_mobile_visibility_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('mobile_visibility_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_mobile_visibility_policy(JSONB)
  IS 'Resolve mobile_visibility_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
ALTER FUNCTION public.resolve_mobile_visibility_policy(JSONB) SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.resolve_mobile_visibility_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_visibility_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_visibility_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_mobile_diagnostics_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('mobile_diagnostics_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_mobile_diagnostics_policy(JSONB)
  IS 'Resolve mobile_diagnostics_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
ALTER FUNCTION public.resolve_mobile_diagnostics_policy(JSONB) SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.resolve_mobile_diagnostics_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_diagnostics_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_diagnostics_policy(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602041725_mobile_ui_policy_resolvers_v1'));
COMMIT;
