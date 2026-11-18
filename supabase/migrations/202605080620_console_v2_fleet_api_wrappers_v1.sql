-- Console V2 fleet live wrappers.
-- Browser Supabase clients call the exposed `api` schema, so every Console
-- fleet action must have an api.* wrapper around the canonical public RPC.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605080620_console_v2_fleet_api_wrappers_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION api.complete_maintenance_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.complete_maintenance_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.cancel_maintenance_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.cancel_maintenance_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.record_vehicle_event_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.record_vehicle_event_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION api.complete_maintenance_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.complete_maintenance_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.complete_maintenance_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.cancel_maintenance_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.cancel_maintenance_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.cancel_maintenance_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.record_vehicle_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.record_vehicle_event_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.record_vehicle_event_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION api.complete_maintenance_v1(JSONB) IS
  'Console V2 api-schema wrapper for public.complete_maintenance_v1.';
COMMENT ON FUNCTION api.cancel_maintenance_v1(JSONB) IS
  'Console V2 api-schema wrapper for public.cancel_maintenance_v1.';
COMMENT ON FUNCTION api.record_vehicle_event_v1(JSONB) IS
  'Console V2 api-schema wrapper for public.record_vehicle_event_v1.';

SELECT pg_advisory_unlock(hashtext('202605080620_console_v2_fleet_api_wrappers_v1'));
COMMIT;
