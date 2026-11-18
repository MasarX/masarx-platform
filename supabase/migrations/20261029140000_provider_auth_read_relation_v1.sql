BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261029140000_provider_auth_read_relation_v1'));

-- Preserve the executor privilege and rollback contract while separating read routing.
DO $registry$
DECLARE
  v_row RECORD;
  v_value JSONB;
  v_global_seen BOOLEAN := FALSE;
  v_plan_before JSONB;
  v_plan_after JSONB;
  v_plan_added JSONB;
  v_plan_removed JSONB;
  v_plan_added_detail JSONB;
  v_plan_removed_detail JSONB;
  v_saved_grants JSONB;
  v_seal TEXT;
  v_registry_trace JSONB := '[]'::JSONB;
  v_resolved_before JSONB;
  v_resolved_after JSONB;
BEGIN
  LOCK TABLE public.ui_rpc_executor_rollback_state_v1 IN SHARE MODE;
  IF (SELECT relowner FROM pg_class WHERE oid = 'public.ui_rpc_executor_rollback_state_v1'::regclass)
       IS DISTINCT FROM current_user::regrole::oid THEN
    RAISE EXCEPTION 'Provider read routing requires the executor snapshot owner' USING ERRCODE = '42501';
  END IF;
  SELECT obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass, 'pg_class')
    INTO v_seal;
  IF v_seal IS DISTINCT FROM 'ui_rpc_executor_rollback_state_v1:sha256:' || (
      SELECT encode(pg_catalog.sha256(convert_to(
        COALESCE(jsonb_object_agg(key, value ORDER BY key), '{}'::jsonb)::text, 'UTF8')), 'hex')
      FROM public.ui_rpc_executor_rollback_state_v1) THEN
    RAISE EXCEPTION 'Executor snapshot integrity mismatch before provider read routing';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind, object_id, privilege, column_name), '[]'::JSONB)
    INTO v_plan_before FROM public.ui_rpc_executor_privilege_plan_v1() p;
  SELECT value INTO v_saved_grants FROM public.ui_rpc_executor_rollback_state_v1 WHERE key = 'grants';
  IF v_saved_grants IS NULL
     OR jsonb_array_length(v_saved_grants) IS DISTINCT FROM jsonb_array_length(v_plan_before)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_saved_grants) entry
       WHERE NOT v_plan_before @> jsonb_build_array(entry))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan_before) entry
       WHERE NOT v_saved_grants @> jsonb_build_array(entry)) THEN
    RAISE EXCEPTION 'Executor grant snapshot does not match the pre-routing privilege plan';
  END IF;

  FOR v_row IN
    SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_read_registry'
    ORDER BY s.id
    FOR UPDATE OF s, sv
  LOOP
    IF jsonb_typeof(v_row.value->'resources') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'ui_read_registry resources must be an array';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_row.value->'resources') resource
                   WHERE resource->>'key' = 'provider_auth_configs') THEN
      CONTINUE;
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(v_row.value->'resources') resource
         WHERE resource->>'key' = 'provider_auth_configs') <> 1 THEN
      RAISE EXCEPTION 'ui_read_registry has duplicate provider_auth_configs resources';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'relation', resource->>'relation', 'read_relation', resource->>'read_relation')
        ORDER BY resource->>'key'), '[]'::JSONB)
      INTO v_resolved_before
      FROM jsonb_array_elements(COALESCE(
        public.resolve_settings_merged('ui_read_registry', v_row.scope_type, v_row.scope_id)->'resources',
        '[]'::JSONB)) resource
      WHERE resource->>'key' = 'provider_auth_configs';
    IF v_row.scope_type = public.get_root_scope_type_key_v1() AND v_row.scope_id IS NULL THEN
      v_global_seen := TRUE;
    END IF;
    SELECT jsonb_set(v_row.value, '{resources}', jsonb_agg(
      CASE WHEN resource->>'key' = 'provider_auth_configs' THEN
        jsonb_set(resource, '{relation}', '"public.provider_auth_configs_visible_v1"'::JSONB) - 'read_relation'
      ELSE resource END ORDER BY ordinal))
    INTO v_value
    FROM jsonb_array_elements(v_row.value->'resources') WITH ORDINALITY AS entries(resource, ordinal);

    IF v_value IS DISTINCT FROM v_row.value THEN
      PERFORM 1 FROM public.upsert_settings_value_v1(
        'ui_read_registry', v_row.scope_type, v_row.scope_id, v_value, v_row.schema_version,
        'Separate provider credential read projection from canonical mutation relation');
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'relation', resource->>'relation', 'read_relation', resource->>'read_relation')
        ORDER BY resource->>'key'), '[]'::JSONB)
      INTO v_resolved_after
      FROM jsonb_array_elements(COALESCE(
        public.resolve_settings_merged('ui_read_registry', v_row.scope_type, v_row.scope_id)->'resources',
        '[]'::JSONB)) resource
      WHERE resource->>'key' = 'provider_auth_configs';
    v_registry_trace := v_registry_trace || jsonb_build_array(jsonb_build_object(
      'scope_type', v_row.scope_type, 'scope_id', v_row.scope_id,
      'before', v_resolved_before, 'after', v_resolved_after));
  END LOOP;
  IF NOT v_global_seen THEN
    RAISE EXCEPTION 'ui_read_registry has no global provider_auth_configs resource';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind, object_id, privilege, column_name), '[]'::JSONB)
    INTO v_plan_after FROM public.ui_rpc_executor_privilege_plan_v1() p;
  SELECT COALESCE(jsonb_agg(entry), '[]'::JSONB) INTO v_plan_removed
    FROM jsonb_array_elements(v_plan_before) entry
    WHERE NOT v_plan_after @> jsonb_build_array(entry);
  SELECT COALESCE(jsonb_agg(entry), '[]'::JSONB) INTO v_plan_added
    FROM jsonb_array_elements(v_plan_after) entry
    WHERE NOT v_plan_before @> jsonb_build_array(entry);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'object_kind', entry->>'object_kind',
      'object', CASE entry->>'object_kind'
        WHEN 'relation' THEN (entry->>'object_id')::oid::regclass::text
        WHEN 'function' THEN (entry->>'object_id')::oid::regprocedure::text
        WHEN 'schema' THEN (entry->>'object_id')::oid::regnamespace::text
        ELSE entry->>'object_id' END,
      'privilege', entry->>'privilege', 'column', entry->>'column_name')
      ORDER BY entry->>'object_kind', entry->>'object_id', entry->>'privilege', entry->>'column_name'),
    '[]'::JSONB) INTO v_plan_removed_detail
    FROM jsonb_array_elements(v_plan_removed) entry;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'object_kind', entry->>'object_kind',
      'object', CASE entry->>'object_kind'
        WHEN 'relation' THEN (entry->>'object_id')::oid::regclass::text
        WHEN 'function' THEN (entry->>'object_id')::oid::regprocedure::text
        WHEN 'schema' THEN (entry->>'object_id')::oid::regnamespace::text
        ELSE entry->>'object_id' END,
      'privilege', entry->>'privilege', 'column', entry->>'column_name')
      ORDER BY entry->>'object_kind', entry->>'object_id', entry->>'privilege', entry->>'column_name'),
    '[]'::JSONB) INTO v_plan_added_detail
    FROM jsonb_array_elements(v_plan_added) entry;
  IF v_plan_after IS DISTINCT FROM v_plan_before THEN
    RAISE EXCEPTION 'Provider read routing changed the executor privilege plan'
      USING ERRCODE = '42501', HINT = 'Provider registry routing must remain on the visible read view.',
        DETAIL = jsonb_build_object(
          'plan_added', v_plan_added_detail, 'plan_removed', v_plan_removed_detail,
          'plan_before_count', jsonb_array_length(v_plan_before),
          'plan_after_count', jsonb_array_length(v_plan_after),
          'registry', v_registry_trace)::TEXT;
  END IF;
END;
$registry$;

DELETE FROM public.settings_cache
WHERE cache_key LIKE 'ui_read_registry:%'
   OR cache_key LIKE 'ui_list_resource:%provider_auth_configs%'
   OR cache_key LIKE 'ui_get_resource:%provider_auth_configs%'
   OR cache_key LIKE 'ui_resource_metrics:%provider_auth_configs%'
   OR cache_key LIKE 'ui_filter_distinct_values:%provider_auth_configs%';
COMMIT;
