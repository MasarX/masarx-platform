-- Match export authority before activation can inspect or mutate tenant state.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $activation_guard$
DECLARE
  function_name TEXT;
  definition TEXT;
  capability_check CONSTANT TEXT := '  PERFORM public.assert_capability_v1(''integration_plugins.activate'', ''tenant'', v_plugin.organization_id);';
  actor_guard CONSTANT TEXT := $guard$  IF public.request_role_is_service_v1() IS NOT TRUE
     AND public.is_platform_user() IS NOT TRUE
     AND public.current_user_org_id() IS DISTINCT FROM v_plugin.organization_id THEN
    RAISE EXCEPTION 'Capability denied: integration_plugins.activate' USING ERRCODE = '42501';
  END IF;

$guard$;
  prior TEXT;
  denial CONSTANT TEXT := 'RAISE EXCEPTION ''Capability denied: integration_plugins.activate'' USING ERRCODE = ''42501'';';
  signature REGPROCEDURE;
  grant_row RECORD;
BEGIN
  FOREACH function_name IN ARRAY ARRAY['integration_plugin_activate_v1', 'integration_plugin_activate_core_v1'] LOOP
    signature := format('public.%I(uuid,text,uuid,text)', function_name)::regprocedure;
    definition := pg_get_functiondef(signature);
    IF (length(definition) - length(replace(definition, capability_check, ''))) / length(capability_check) <> 1 THEN
      RAISE EXCEPTION 'Expected one activation capability check in %', signature;
    END IF;
    definition := replace(definition, capability_check, actor_guard || capability_check);
    -- Missing and foreign identifiers expose the same denial class and message.
    FOREACH prior IN ARRAY ARRAY[
      format('RAISE EXCEPTION %L, p_plugin_version_id;', function_name || ' plugin version % not found'),
      format('RAISE EXCEPTION %L, v_version.plugin_id;', function_name || ' plugin % not found')
    ] LOOP
      IF position(prior IN definition) = 0 THEN
        RAISE EXCEPTION 'Expected activation lookup denial in %', signature;
      END IF;
      definition := replace(definition, prior, denial);
    END LOOP;
    -- CREATE OR REPLACE retains owner, comments, ACLs and all existing body repairs.
    EXECUTE definition;
  END LOOP;

  signature := 'public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure;
  FOR grant_row IN
    SELECT DISTINCT acl.grantee
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = signature AND acl.grantee <> p.proowner AND acl.privilege_type = 'EXECUTE'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.integration_plugin_activate_core_v1(UUID,TEXT,UUID,TEXT) FROM %s',
      CASE WHEN grant_row.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grant_row.grantee)) END);
  END LOOP;
END;
$activation_guard$;

REVOKE ALL ON FUNCTION public.integration_plugin_activate_core_v1(UUID,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.integration_plugin_activate_v1(UUID,TEXT,UUID,TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.integration_plugin_activate_v1(UUID,TEXT,UUID,TEXT) FROM PUBLIC, anon;
-- The invoker API wrapper executes the public entrypoint with the browser role.
GRANT EXECUTE ON FUNCTION public.integration_plugin_activate_v1(UUID,TEXT,UUID,TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.integration_plugin_activate_v1(UUID,TEXT,UUID,TEXT) TO authenticated, service_role;
COMMIT;
