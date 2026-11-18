-- Migration: expose only the whitelisted public tracking facade to anon.
BEGIN;
SELECT pg_advisory_lock(hashtext('202609011000_b5_public_tracking_privilege_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

GRANT USAGE ON SCHEMA api TO anon;

CREATE OR REPLACE FUNCTION api.public_tracking_config_v1()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
  SELECT public.public_tracking_config_v1();
$function$;

REVOKE ALL ON FUNCTION public.public_tracking_config_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.public_tracking_config_v1() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_tracking_registry_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_tracking_registry_v1() TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_tracking_registry_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.ui_tracking_registry_v1() TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.public_tracking_config_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.public_tracking_config_v1() TO anon, authenticated, service_role;

COMMENT ON FUNCTION api.public_tracking_config_v1() IS
  'Browser-safe security-definer wrapper for the whitelisted public tracking UI configuration.';

SELECT pg_advisory_unlock(hashtext('202609011000_b5_public_tracking_privilege_repair_v1'));
COMMIT;
