-- Authorized inverse for the provider read-routing registry migration.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261029140000_provider_auth_read_relation_v1'));
LOCK TABLE public.settings, public.settings_versions IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.ui_rpc_executor_rollback_state_v1 IN SHARE MODE;

DO $rollback$
DECLARE
  v_row RECORD;
  v_prior RECORD;
  v_plan JSONB;
  v_saved_grants JSONB;
BEGIN
  IF obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass, 'pg_class') IS DISTINCT FROM
      'ui_rpc_executor_rollback_state_v1:sha256:' || (SELECT
        encode(pg_catalog.sha256(convert_to(
          COALESCE(jsonb_object_agg(key, value ORDER BY key), '{}'::jsonb)::text, 'UTF8')), 'hex')
        FROM public.ui_rpc_executor_rollback_state_v1) THEN
    RAISE EXCEPTION 'Executor rollback snapshot integrity mismatch';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind, object_id, privilege, column_name), '[]'::jsonb)
    INTO v_plan FROM public.ui_rpc_executor_privilege_plan_v1() p;
  SELECT value INTO v_saved_grants FROM public.ui_rpc_executor_rollback_state_v1 WHERE key = 'grants';
  IF v_saved_grants IS NULL
     OR jsonb_array_length(v_saved_grants) IS DISTINCT FROM jsonb_array_length(v_plan)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_saved_grants) entry
       WHERE NOT v_plan @> jsonb_build_array(entry))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan) entry
       WHERE NOT v_saved_grants @> jsonb_build_array(entry)) THEN
    RAISE EXCEPTION 'Executor plan/grants snapshot consistency check failed';
  END IF;

  FOR v_row IN
    SELECT s.scope_type, s.scope_id, s.settings_version_id, sv.scope_hash, sv.value, sv.schema_version, sv.version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_read_registry'
      AND sv.change_reason = 'Separate provider credential read projection from canonical mutation relation'
      AND sv.effective_until IS NULL
    FOR UPDATE OF s, sv
  LOOP
    SELECT prior.value, prior.schema_version INTO STRICT v_prior
    FROM public.settings_versions prior
    WHERE prior.category = 'ui_read_registry'
      AND prior.scope_type = v_row.scope_type
      AND prior.scope_id IS NOT DISTINCT FROM v_row.scope_id
      AND prior.scope_hash = v_row.scope_hash
      AND prior.version < v_row.version
      AND prior.effective_until IS NOT NULL
    ORDER BY prior.version DESC
    LIMIT 1;
    PERFORM public.upsert_settings_value_v1(
      'ui_read_registry', v_row.scope_type, v_row.scope_id, v_prior.value,
      v_prior.schema_version, 'Restore provider auth registry before read-routing migration');
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind, object_id, privilege, column_name), '[]'::jsonb)
    INTO v_plan FROM public.ui_rpc_executor_privilege_plan_v1() p;
  IF v_saved_grants IS NULL
     OR jsonb_array_length(v_saved_grants) IS DISTINCT FROM jsonb_array_length(v_plan)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_saved_grants) entry
       WHERE NOT v_plan @> jsonb_build_array(entry))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan) entry
       WHERE NOT v_saved_grants @> jsonb_build_array(entry)) THEN
    RAISE EXCEPTION 'Provider read rollback changed the executor plan';
  END IF;
END;
$rollback$;

DELETE FROM public.settings_cache
WHERE cache_key LIKE 'ui_read_registry:%'
   OR cache_key LIKE 'ui_list_resource:%provider_auth_configs%'
   OR cache_key LIKE 'ui_get_resource:%provider_auth_configs%'
   OR cache_key LIKE 'ui_resource_metrics:%provider_auth_configs%'
   OR cache_key LIKE 'ui_filter_distinct_values:%provider_auth_configs%';
COMMIT;
