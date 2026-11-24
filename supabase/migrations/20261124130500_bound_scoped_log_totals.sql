BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '10s';

DO $migration$
DECLARE
  migration_role name := current_user;
  entrypoint constant regprocedure := 'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure;
  definition text := pg_get_functiondef(
    entrypoint
  );
  old_strategies constant text := $sql$v_total_strategy NOT IN ('exact', 'estimate')$sql$;
  old_count constant text := $sql$  IF v_total_strategy = 'estimate' THEN
    v_sql := format(
      'EXPLAIN (FORMAT JSON)$sql$;
  new_count constant text := $sql$  IF v_total_strategy = 'capped' THEN
    EXECUTE format(
      'SELECT COUNT(*) FROM (SELECT 1 FROM %I.%I WHERE %s LIMIT $1) visible_rows',
      v_schema, v_table, v_where
    ) INTO v_total USING v_max_page_size + 1;
    v_total_is_estimate := v_total > v_max_page_size;
    v_total_strategy := CASE WHEN v_total_is_estimate THEN 'estimate' ELSE 'exact' END;
  ELSIF v_total_strategy = 'estimate' THEN
    v_sql := format(
      'EXPLAIN (FORMAT JSON)$sql$;
BEGIN
  IF (SELECT proowner FROM pg_proc WHERE oid = entrypoint) <> 'ui_rpc_executor'::regrole
     OR cardinality(string_to_array(definition, old_strategies)) <> 2
     OR cardinality(string_to_array(definition, old_count)) <> 2 THEN
    RAISE EXCEPTION 'Unexpected ui_list_resource_v1 definition while bounding log totals';
  END IF;
  definition := replace(definition, old_strategies,
    $sql$v_total_strategy NOT IN ('exact', 'estimate', 'capped')$sql$);

  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT ui_rpc_executor TO %I WITH INHERIT FALSE, SET TRUE', migration_role);
  ELSE
    EXECUTE format('GRANT ui_rpc_executor TO %I', migration_role);
  END IF;
  GRANT CREATE ON SCHEMA public TO ui_rpc_executor;
  SET LOCAL ROLE ui_rpc_executor;
  EXECUTE replace(definition, old_count, new_count);
  EXECUTE format('SET LOCAL ROLE %I', migration_role);
  REVOKE CREATE ON SCHEMA public FROM ui_rpc_executor;
  EXECUTE format('REVOKE ui_rpc_executor FROM %I', migration_role);

  IF has_schema_privilege('ui_rpc_executor', 'public', 'CREATE') OR EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid = 'ui_rpc_executor'::regrole
      AND (COALESCE((to_jsonb(pg_auth_members)->>'inherit_option')::boolean, true)
        OR COALESCE((to_jsonb(pg_auth_members)->>'set_option')::boolean, true))
  ) THEN
    RAISE EXCEPTION 'Temporary executor replacement authority was not revoked';
  END IF;
END;
$migration$;

DO $registry$
DECLARE
  current_registry record;
  next_value jsonb;
BEGIN
  SELECT s.scope_type, sv.value, sv.schema_version INTO STRICT current_registry
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
  WHERE s.category = 'ui_read_registry' AND s.scope_type = public.get_root_scope_type_key_v1()
    AND s.scope_id IS NULL
  FOR UPDATE OF s;

  SELECT jsonb_set(current_registry.value, '{resources}', jsonb_agg(
    CASE WHEN entry.value->>'key' IN ('decision_log', 'settings_resolution_log', 'webhook_inbox')
      THEN entry.value || '{"total_strategy":"capped"}'::jsonb
      ELSE entry.value END ORDER BY entry.ordinal
  )) INTO next_value
  FROM jsonb_array_elements(current_registry.value->'resources') WITH ORDINALITY AS entry(value, ordinal);

  IF next_value IS DISTINCT FROM current_registry.value THEN
    PERFORM public.upsert_settings_value_v1('ui_read_registry', current_registry.scope_type,
      NULL, next_value, current_registry.schema_version, 'Bound scoped log totals to the configured page size');
  END IF;
END;
$registry$;

DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
COMMIT;
