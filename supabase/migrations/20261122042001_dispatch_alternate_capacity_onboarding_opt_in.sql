BEGIN;
SET LOCAL lock_timeout = '30s';

DO $migration$
DECLARE
  v_root_scope_type text := public.get_root_scope_type_key_v1();
  v_policy jsonb;
  v_effective jsonb;
  v_next jsonb;
  v_schema_version integer;
  v_scope_type text;
  v_excluded jsonb;
BEGIN
  SELECT s.cached_value, sv.schema_version
    INTO STRICT v_policy, v_schema_version
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = v_root_scope_type
     AND s.scope_id IS NULL
   FOR UPDATE OF s, sv;

  v_effective := public.resolve_saas_onboarding_policy_v1();
  v_next := v_policy;
  FOREACH v_scope_type IN ARRAY ARRAY['tenant', 'client', 'sender'] LOOP
    v_excluded := v_effective #> ARRAY['materialize_defaults', v_scope_type, 'exclude_categories'];
    IF jsonb_typeof(v_excluded) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid onboarding exclusions for scope %', v_scope_type;
    END IF;

    IF NOT (v_excluded ? 'route_assignment_policy') THEN
      v_next := public.jsonb_deep_merge(v_next, jsonb_build_object(
        'materialize_defaults', jsonb_build_object(v_scope_type, jsonb_build_object(
          'exclude_categories', v_excluded || jsonb_build_array('route_assignment_policy')
        ))
      ));
    END IF;
  END LOOP;

  IF v_next IS DISTINCT FROM v_policy THEN
    PERFORM public.upsert_settings_value_v1(
      'saas_onboarding_policy', v_root_scope_type, NULL, v_next, v_schema_version,
      'Inherit route assignment policy without materializing onboarding defaults'
    );
  END IF;
END;
$migration$;

COMMIT;
