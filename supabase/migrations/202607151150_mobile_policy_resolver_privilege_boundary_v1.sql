-- Restore the authenticated Mobile/FieldOps policy resolver boundary without
-- exposing the generic settings resolver to browser roles.

BEGIN;

SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202607151150_mobile_policy_resolver_privilege_boundary_v1'));

DO $migration$
DECLARE
  v_function_name TEXT;
BEGIN
  FOREACH v_function_name IN ARRAY ARRAY[
    'resolve_location_tracking_policy',
    'resolve_scan_policy',
    'resolve_pod_policy',
    'resolve_mobile_sync_policy'
  ]
  LOOP
    EXECUTE format(
      'ALTER FUNCTION public.%I(JSONB) SECURITY DEFINER',
      v_function_name
    );
    EXECUTE format(
      'ALTER FUNCTION public.%I(JSONB) SET search_path TO public, extensions, pg_temp',
      v_function_name
    );
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.%I(JSONB) FROM PUBLIC',
      v_function_name
    );
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.%I(JSONB) FROM anon',
      v_function_name
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.%I(JSONB) TO authenticated, service_role',
      v_function_name
    );
  END LOOP;
END;
$migration$;

-- Mobile ingest is an internal implementation detail used only from protected
-- definer write paths. Remove its stale browser grant instead of elevating it.
ALTER FUNCTION public.resolve_mobile_ingest_policy(JSONB) SECURITY INVOKER;
ALTER FUNCTION public.resolve_mobile_ingest_policy(JSONB)
  SET search_path TO public, extensions, pg_temp;
REVOKE ALL ON FUNCTION public.resolve_mobile_ingest_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_ingest_policy(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_mobile_ingest_policy(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_ingest_policy(JSONB) TO service_role;
COMMENT ON FUNCTION public.resolve_mobile_ingest_policy(JSONB)
  IS 'Service-role-only internal category wrapper used by protected Mobile ingest write paths.';

-- The canonical generic resolver must remain inaccessible to browser roles.
REVOKE ALL ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  FROM anon;
REVOKE ALL ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  TO service_role;

COMMIT;
