-- Migration: UI command executor + delete resource RPC
BEGIN;
SELECT pg_advisory_lock(hashtext('202601152100_ui_command_execute_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_delete_resource_v1(
  p_resource TEXT,
  p_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_id_type TEXT;
  v_capability TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_sql TEXT;
  v_result JSONB;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 requires id';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(NULLIF(v_resource->>'id_column', ''), 'id');
  v_capability := COALESCE(NULLIF(v_resource->>'capability_write', ''), NULLIF(v_resource->>'capability_read', ''));

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 resource missing relation';
  END IF;

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation not found: %', v_relation;
  END IF;

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation missing RLS: %', v_relation;
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_id_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table
     AND a.attname = v_id_column
     AND a.attnum > 0
     AND a.attisdropped = false
   LIMIT 1;

  IF v_id_type IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 id column not found: %', v_id_column;
  END IF;

  v_sql := format(
    'DELETE FROM %I.%I AS t WHERE t.%I = $1::%s RETURNING to_jsonb(t.*)',
    v_schema,
    v_table,
    v_id_column,
    v_id_type
  );

  EXECUTE v_sql INTO v_result USING p_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 could not find resource % for id %', p_resource, p_id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.ui_delete_resource_v1(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_delete_resource_v1(TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_execute_command_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[],
  p_selection_id TEXT,
  p_selection_count INTEGER,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB;
  v_execution JSONB;
  v_capability TEXT;
  v_selection JSONB;
  v_mode TEXT;
  v_min INT;
  v_max INT;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_handler TEXT;
  v_patch JSONB;
  v_payload_key TEXT;
  v_selection_key TEXT;
  v_payload JSONB;
  v_context JSONB;
  v_template_id UUID;
  v_run_id UUID;
  v_results JSONB := '[]'::jsonb;
  v_item JSONB;
BEGIN
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_command_v1 requires action key';
  END IF;

  SELECT value INTO v_command
    FROM jsonb_array_elements(v_registry->'commands') AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_command_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := v_command->'selection';
  v_mode := lower(COALESCE(v_selection->>'mode', ''));
  v_min := COALESCE(NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END);
  v_max := COALESCE(NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END);

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_command_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_command_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_handler := lower(COALESCE(NULLIF(p_params->>'handler', ''), ''));
  v_patch := COALESCE(p_params->'patch', '{}'::jsonb);

  IF COALESCE(v_command->>'workflow_key', '') <> '' OR (v_execution->>'type') = 'workflow' THEN
    IF COALESCE(v_command->>'workflow_key', '') = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow key missing for %', p_action_key;
    END IF;

    SELECT id INTO v_template_id
      FROM public.workflow_templates
     WHERE name = v_command->>'workflow_key'
       AND status = 'active'
     ORDER BY version DESC
     LIMIT 1;

    IF v_template_id IS NULL THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow template not found %', v_command->>'workflow_key';
    END IF;

    v_payload_key := NULLIF(p_params->>'payload_key', '');
    v_selection_key := NULLIF(p_params->>'selection_id_key', '');
    IF v_payload_key IS NULL THEN
      v_payload_key := 'selections';
    END IF;
    IF v_selection_key IS NULL THEN
      v_selection_key := 'id';
    END IF;

    v_payload := jsonb_build_object(
      v_payload_key,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(v_selection_key, value)) FROM unnest(v_ids) AS value),
        '[]'::jsonb
      ),
      'selection_ids', to_jsonb(v_ids),
      'selection_id', v_id,
      'selection_count', v_count,
      'resource_key', p_resource_key,
      'organization_id', public.current_user_org_id()
    );

    v_context := jsonb_build_object(
      'organization_id', public.current_user_org_id(),
      'requested_by', auth.uid(),
      'payload', v_payload,
      'ui_command', jsonb_build_object(
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'params', p_params
      )
    );

    v_run_id := public.start_workflow_run(v_template_id, v_context);

    RETURN jsonb_build_object(
      'status', 'workflow_started',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'workflow_run_id', v_run_id
    );
  END IF;

  IF v_handler = 'resource_update' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;
    IF jsonb_typeof(v_patch) <> 'object' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 patch must be object';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.ui_update_resource_v1(p_resource_key, v_id, v_patch);
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;
    RETURN jsonb_build_object(
      'status', 'updated',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'resource_delete' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.ui_delete_resource_v1(p_resource_key, v_id);
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;
    RETURN jsonb_build_object(
      'status', 'deleted',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  RAISE EXCEPTION 'ui_execute_command_v1 missing handler for %', p_action_key;
END;
$$;

REVOKE ALL ON FUNCTION public.ui_execute_command_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_execute_command_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601152100_ui_command_execute_v1'));
COMMIT;
