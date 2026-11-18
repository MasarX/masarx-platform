-- Driver application status edge function must not call overloaded RPC names.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605301030_driver_application_status_edge_unambiguous_rpc_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.driver_application_status_lookup_v1(
  p_status_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF NULLIF(btrim(COALESCE(p_status_token, '')), '') IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'invalid_status_token')
    );
  END IF;

  RETURN public.marketplace_application_status_by_token_v1(p_status_token::UUID);
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'invalid_status_token')
    );
END;
$function$;

CREATE OR REPLACE FUNCTION api.driver_application_status_lookup_v1(
  p_status_token TEXT
)
RETURNS JSONB
LANGUAGE SQL
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.driver_application_status_lookup_v1(p_status_token);
$function$;

REVOKE ALL ON FUNCTION public.driver_application_status_lookup_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_application_status_lookup_v1(TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_application_status_lookup_v1(TEXT) TO service_role;

REVOKE ALL ON FUNCTION api.driver_application_status_lookup_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.driver_application_status_lookup_v1(TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION api.driver_application_status_lookup_v1(TEXT) TO service_role;

COMMENT ON FUNCTION public.driver_application_status_lookup_v1(TEXT)
  IS 'Unambiguous driver application status wrapper for browser-safe driver-application-status edge function. Delegates to marketplace status SSOT and avoids overloaded PostgREST RPC resolution.';

COMMENT ON FUNCTION api.driver_application_status_lookup_v1(TEXT)
  IS 'API-schema wrapper for driver_application_status_lookup_v1 used by the public driver-application-status edge function.';

SELECT pg_advisory_unlock(hashtext('202605301030_driver_application_status_edge_unambiguous_rpc_v1'));

COMMIT;
