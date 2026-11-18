-- Restore the browser-safe guard for Console V2 route scan-out reconciliation.
--
-- A later Dispatch registry migration reintroduced the api wrapper as a direct
-- SQL delegate. Browser callers must keep the visibility and routes.read
-- checks before reaching the canonical public helper.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607041320_dispatch_scanout_api_wrapper_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION api.route_run_scan_out_reconciliation_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
BEGIN
  IF p_route_run_id IS NULL THEN
    RAISE EXCEPTION 'route_run_scan_out_reconciliation_v1 requires route_run_id'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_capability_v1(
    'routes.read',
    public.current_user_scope_type(),
    public.current_user_scope_id()
  );

  IF public.ui_get_resource_v1('route_runs', p_route_run_id) IS NULL THEN
    RAISE EXCEPTION 'route_run_scan_out_reconciliation_v1 route_run % is not visible', p_route_run_id
      USING ERRCODE = '42501';
  END IF;

  RETURN public.route_run_scan_out_reconciliation_v1(p_route_run_id);
END;
$function$;

COMMENT ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID)
  IS 'Console V2 browser-safe route scan-out reconciliation wrapper. Requires routes.read and visible route run scope before delegating.';

REVOKE ALL ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.route_run_scan_out_reconciliation_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202607041320_dispatch_scanout_api_wrapper_guard_v1'));

COMMIT;
