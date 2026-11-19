-- pgTAP: Console V2 integration api-schema wrappers required by browser clients.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(30);

CREATE OR REPLACE FUNCTION test_console_v2_integration_api_wrapper_contracts()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rpc TEXT;
  v_signature TEXT;
  v_rpcs TEXT[] := ARRAY[
    'ui_upsert_provider_auth_config_v1',
    'ui_revoke_provider_auth_config_v1',
    'plugin_submit_v1',
    'plugin_approve_v1',
    'plugin_activate_v1',
    'plugin_set_binding_v1'
  ];
BEGIN
  FOREACH v_rpc IN ARRAY v_rpcs LOOP
    v_signature := format('api.%s(jsonb)', v_rpc);

    RETURN NEXT has_function(
      'api',
      v_rpc,
      ARRAY['jsonb'],
      format('%s exists for browser-safe Console V2 live calls', v_signature)
    );

    RETURN NEXT ok(
      has_function_privilege('authenticated', v_signature, 'execute'),
      format('authenticated can execute %s', v_signature)
    );

    RETURN NEXT ok(
      has_function_privilege('service_role', v_signature, 'execute'),
      format('service_role can execute %s', v_signature)
    );

    RETURN NEXT ok(
      NOT has_function_privilege('anon', v_signature, 'execute'),
      format('anon cannot execute %s', v_signature)
    );

    RETURN NEXT ok(
      EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'api'
           AND p.proname = v_rpc
           AND pg_catalog.oidvectortypes(p.proargtypes) = 'jsonb'
           AND p.prosecdef
      ),
      format('%s is SECURITY DEFINER', v_signature)
    );
  END LOOP;
END;
$function$;

SELECT * FROM test_console_v2_integration_api_wrapper_contracts();

ROLLBACK;
