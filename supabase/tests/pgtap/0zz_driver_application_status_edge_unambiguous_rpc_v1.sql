-- pgTAP: driver-application-status edge function uses an unambiguous API RPC.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

CREATE OR REPLACE FUNCTION pg_temp.test_driver_application_status_edge_unambiguous_rpc_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_request UUID := '00000000-0000-0000-0000-000087100001';
  v_token UUID := '00000000-0000-4000-8000-000087100001';
  v_result JSONB := '{}'::jsonb;
BEGIN
  INSERT INTO public.marketplace_participant_requests (
    id,
    status,
    requested_participant_type_key,
    email,
    full_name,
    organization_name,
    public_status_token,
    turnstile_verified,
    metadata
  )
  VALUES (
    v_request,
    'pending',
    'freelancer_driver',
    'driver-status-edge-pgtap@example.test',
    'Driver Status Edge PgTAP',
    'Driver Status Edge Org',
    v_token,
    TRUE,
    jsonb_build_object('source', 'driver-signup-intake')
  )
  ON CONFLICT (id) DO UPDATE
     SET status = EXCLUDED.status,
         public_status_token = EXCLUDED.public_status_token,
         metadata = EXCLUDED.metadata,
         updated_at = now();

  RETURN NEXT has_function(
    'public',
    'driver_application_status_lookup_v1',
    ARRAY['text'],
    'public.driver_application_status_lookup_v1(text) exists'
  );

  RETURN NEXT has_function(
    'api',
    'driver_application_status_lookup_v1',
    ARRAY['text'],
    'api.driver_application_status_lookup_v1(text) exists'
  );

  RETURN NEXT ok(
    has_function_privilege('service_role', 'api.driver_application_status_lookup_v1(text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'api.driver_application_status_lookup_v1(text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'api.driver_application_status_lookup_v1(text)', 'EXECUTE'),
    'driver status API wrapper is service-role only'
  );

  v_result := api.driver_application_status_lookup_v1(v_token::text);
  RETURN NEXT ok(
    COALESCE((v_result->>'ok')::boolean, FALSE)
    AND v_result->>'status' = 'pending'
    AND v_result->>'participant_type_key' = 'freelancer_driver',
    'api.driver_application_status_lookup_v1 returns pending driver application status'
  );

  RETURN NEXT is(
    public.driver_application_status_lookup_v1('not-a-token')#>>'{error,code}',
    'invalid_status_token',
    'public.driver_application_status_lookup_v1 rejects invalid token text'
  );

  RETURN NEXT is(
    api.driver_application_status_lookup_v1('')#>>'{error,code}',
    'invalid_status_token',
    'api.driver_application_status_lookup_v1 rejects blank token text'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'api'
         AND p.proname = 'driver_application_status_lookup_v1'
         AND pg_get_function_identity_arguments(p.oid) = 'p_status_token text'
    )
    AND (
      SELECT count(*)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'api'
         AND p.proname = 'driver_application_status_lookup_v1'
    ) = 1,
    'driver status edge RPC name has exactly one API overload'
  );
END;
$function$;

SELECT * FROM pg_temp.test_driver_application_status_edge_unambiguous_rpc_v1();

ROLLBACK;
