-- Plan: Console V2 phaseC6 RPC api-schema wrapper closure
-- Step: expose the remaining browser-called phaseC6Rpc names through api.
--
-- Console V2 calls phaseC6Rpc through client.schema('api'), always using the
-- single-argument `{ p_args: jsonb }` RPC contract. The canonical public RPCs
-- below already exist; this migration adds only the missing api-schema facade
-- layer so PostgREST schema-cache lookups cannot miss them in shared/prod.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041430_console_v2_phasec6_api_wrappers_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

DO $$
DECLARE
  v_name TEXT;
  v_jsonb_wrapper_names TEXT[] := ARRAY[
    'bulk_transition_tasks_v1',
    'mapping_config_promote_v1',
    'register_workflow_binding_v1',
    'request_capability_grant_v1',
    'restore_zone_v1',
    'simulate_binding_dispatch_v1',
    'suspend_zone_v1',
    'ui_set_workflow_template_status_v1'
  ];
BEGIN
  FOREACH v_name IN ARRAY v_jsonb_wrapper_names
  LOOP
    IF to_regprocedure(format('public.%I(jsonb)', v_name)) IS NULL THEN
      RAISE EXCEPTION 'Console V2 phaseC6 api wrapper closure: public.%(jsonb) is missing', v_name
        USING ERRCODE = '42883';
    END IF;

    EXECUTE format(
      $sql$
      CREATE OR REPLACE FUNCTION api.%1$I(p_args jsonb)
      RETURNS jsonb
      LANGUAGE sql
      VOLATILE
      SECURITY DEFINER
      SET search_path TO public, extensions, pg_temp
      AS $wrapper$
        SELECT public.%1$I(p_args);
      $wrapper$;
      $sql$,
      v_name
    );

    EXECUTE format('REVOKE ALL ON FUNCTION api.%I(jsonb) FROM PUBLIC', v_name);
    EXECUTE format('REVOKE ALL ON FUNCTION api.%I(jsonb) FROM anon', v_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION api.%I(jsonb) TO authenticated, service_role', v_name);
    EXECUTE format(
      'COMMENT ON FUNCTION api.%I(jsonb) IS %L',
      v_name,
      format('Console V2 api-schema wrapper delegating to canonical public.%s(jsonb).', v_name)
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION api.provision_rbac_roles_from_templates_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_actor_user_id uuid := auth.uid();
  v_actor_org_id uuid := public.current_user_org_id();
  v_target_org_id uuid;
  v_template_keys text[];
  v_granted_by_user_id uuid;
  v_roles jsonb := '[]'::jsonb;
  v_first_role_id uuid;
BEGIN
  IF v_actor_user_id IS NULL AND NOT public.request_role_is_service_v1() THEN
    RAISE EXCEPTION 'provision_rbac_roles_from_templates_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('access_policy.approve');

  v_target_org_id := COALESCE(NULLIF(v_args->>'organization_id', '')::uuid, v_actor_org_id);
  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'provision_rbac_roles_from_templates_v1 cannot resolve target organization'
      USING ERRCODE = '23502';
  END IF;

  IF v_actor_org_id IS NOT NULL
     AND v_target_org_id <> v_actor_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'provision_rbac_roles_from_templates_v1 organization_id outside tenant scope'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_args->'template_keys') = 'array' THEN
    SELECT array_agg(template_key ORDER BY template_key)
      INTO v_template_keys
      FROM (
        SELECT DISTINCT NULLIF(btrim(value), '') AS template_key
          FROM jsonb_array_elements_text(v_args->'template_keys') AS t(value)
      ) s
     WHERE template_key IS NOT NULL;
  ELSIF NULLIF(btrim(COALESCE(v_args->>'template_key', '')), '') IS NOT NULL THEN
    v_template_keys := ARRAY[NULLIF(btrim(v_args->>'template_key'), '')];
  ELSE
    v_template_keys := NULL;
  END IF;

  v_granted_by_user_id := COALESCE(
    NULLIF(v_args->>'granted_by_user_id', '')::uuid,
    NULLIF(v_args->>'actor_user_id', '')::uuid,
    v_actor_user_id
  );

  WITH provisioned AS (
    SELECT p.template_key, p.role_id, p.created
      FROM public.provision_rbac_roles_from_templates_v1(
        v_target_org_id,
        v_template_keys,
        v_granted_by_user_id
      ) AS p
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'template_key', p.template_key,
          'role_id', p.role_id,
          'created', p.created
        )
        ORDER BY p.template_key
      ),
      '[]'::jsonb
    ),
    (
      SELECT p_first.role_id
        FROM provisioned p_first
       ORDER BY p_first.template_key
       LIMIT 1
    )
    INTO v_roles, v_first_role_id
    FROM provisioned p;

  RETURN jsonb_build_object(
    'ok', true,
    'rbac_role_id', v_first_role_id,
    'rbac_roles', v_roles,
    'organization_id', v_target_org_id,
    'template_keys', COALESCE(to_jsonb(v_template_keys), 'null'::jsonb),
    'correlation_id', gen_random_uuid()
  );
END;
$function$;

REVOKE ALL ON FUNCTION api.provision_rbac_roles_from_templates_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.provision_rbac_roles_from_templates_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.provision_rbac_roles_from_templates_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.provision_rbac_roles_from_templates_v1(jsonb)
  IS 'Console V2 api-schema jsonb wrapper for public.provision_rbac_roles_from_templates_v1(uuid, text[], uuid).';

CREATE OR REPLACE FUNCTION api.request_zone_override_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_exception_id uuid;
  v_params jsonb;
  v_result jsonb;
  v_request_reason text;
BEGIN
  v_exception_id := COALESCE(
    NULLIF(v_args->>'exception_id', '')::uuid,
    NULLIF(v_args->>'mis_sort_exception_id', '')::uuid,
    NULLIF(v_args->>'source_exception_id', '')::uuid
  );

  IF v_exception_id IS NULL THEN
    RAISE EXCEPTION 'request_zone_override_v1 requires exception_id'
      USING ERRCODE = '23502';
  END IF;

  v_params := v_args - 'exception_id' - 'mis_sort_exception_id' - 'source_exception_id';
  v_request_reason := NULLIF(btrim(COALESCE(v_args->>'request_reason', '')), '');

  IF v_request_reason IS NOT NULL AND NULLIF(btrim(COALESCE(v_params->>'override_reason', '')), '') IS NULL THEN
    v_params := jsonb_set(v_params, '{override_reason}', to_jsonb(v_request_reason), true);
  END IF;

  SELECT jsonb_build_object(
      'ok', true,
      'zone_override_request_id', r.request_id,
      'request_id', r.request_id,
      'workflow_run_id', r.workflow_run_id,
      'manual_review_task_id', r.manual_review_task_id,
      'status', r.status,
      'correlation_id', r.workflow_run_id
    )
    INTO v_result
    FROM public.request_zone_override_v1(v_exception_id, v_params) AS r
   LIMIT 1;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'request_zone_override_v1 returned no result'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION api.request_zone_override_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_zone_override_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.request_zone_override_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.request_zone_override_v1(jsonb)
  IS 'Console V2 api-schema jsonb wrapper for public.request_zone_override_v1(uuid, jsonb).';

SELECT pg_advisory_unlock(hashtext('202605041430_console_v2_phasec6_api_wrappers_v1'));

COMMIT;
