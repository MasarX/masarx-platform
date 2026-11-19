-- Return the same response for an absent row and a row outside the caller's scope.
BEGIN;
SET LOCAL lock_timeout = '30s';

DO $denial$
DECLARE
  v_actor NAME := current_user;
  v_signature REGPROCEDURE := 'public.ui_update_resource_v1(text,text,jsonb)'::regprocedure;
  v_definition TEXT := pg_get_functiondef(v_signature);
  v_old TEXT := $old$RAISE EXCEPTION 'ui_update_resource_v1 could not find resource % for id %', p_resource, p_id;$old$;
  v_new TEXT := $new$RAISE EXCEPTION 'ui_update_resource_v1 resource not available' USING ERRCODE = '42501';$new$;
BEGIN
  IF (SELECT proowner FROM pg_proc WHERE oid = v_signature) <> 'ui_rpc_executor'::regrole
     OR (length(v_definition) - length(replace(v_definition, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'Generic update denial requires the current executor and missing-row branch';
  END IF;

  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT ui_rpc_executor TO %I WITH INHERIT FALSE, SET TRUE', v_actor);
  ELSE
    EXECUTE format('GRANT ui_rpc_executor TO %I', v_actor);
  END IF;
  GRANT CREATE ON SCHEMA public TO ui_rpc_executor;
  SET LOCAL ROLE ui_rpc_executor;
  EXECUTE replace(v_definition, v_old, v_new);
  EXECUTE format('SET LOCAL ROLE %I', v_actor);
  REVOKE CREATE ON SCHEMA public FROM ui_rpc_executor;
  EXECUTE format('REVOKE ui_rpc_executor FROM %I', v_actor);

  IF has_schema_privilege('ui_rpc_executor', 'public', 'CREATE')
     OR EXISTS (
       SELECT 1 FROM pg_auth_members m
        WHERE roleid = 'ui_rpc_executor'::regrole
          AND (COALESCE((to_jsonb(m)->>'inherit_option')::boolean, TRUE)
               OR COALESCE((to_jsonb(m)->>'set_option')::boolean, TRUE))
     ) THEN
    RAISE EXCEPTION 'Temporary executor replacement authority was not revoked';
  END IF;
END;
$denial$;

COMMIT;
