-- Migration: ui_execute_command_v1 optional row-driven inline workflow kick
BEGIN;
SELECT pg_advisory_lock(hashtext('202603051520_ui_execute_command_inline_kick_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_workflow_start JSONB := '{}'::jsonb;
  v_inline_kick_enabled BOOLEAN := FALSE;
  v_inline_kick_max_attempts INT := 0;
  v_inline_kick_budget_ms INT := 0;
  v_inline_kick_poll_ms INT := 0;
  v_inline_attempts INT := 0;
  v_inline_started_at TIMESTAMPTZ := NULL;
  v_inline_elapsed_ms INT := 0;
  v_inline_progress JSONB := '{}'::jsonb;
  v_inline_status TEXT := NULL;
  v_inline_error TEXT := NULL;
  v_inline_next_run_at TIMESTAMPTZ := NULL;
  v_inline_deadline TIMESTAMPTZ := NULL;
  v_inline_enabled_raw TEXT := '';
  v_inline_max_raw TEXT := '';
  v_inline_budget_raw TEXT := '';
  v_inline_poll_raw TEXT := '';
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

  IF COALESCE(v_command->>'workflow_key', '') <> '' OR (v_execution->>'type') = 'workflow' OR (v_execution->>'type') = 'print' THEN
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

    v_workflow_start := COALESCE(p_params->'workflow_start', v_execution->'params'->'workflow_start', '{}'::jsonb);
    IF jsonb_typeof(v_workflow_start) IS DISTINCT FROM 'object' THEN
      v_workflow_start := '{}'::jsonb;
    END IF;

    v_inline_enabled_raw := lower(COALESCE(NULLIF(v_workflow_start->>'inline_kick_enabled', ''), ''));
    v_inline_kick_enabled := v_inline_enabled_raw IN ('1', 't', 'true', 'y', 'yes', 'on');

    IF v_inline_kick_enabled THEN
      v_inline_max_raw := COALESCE(v_workflow_start->>'inline_kick_max_attempts', '');
      v_inline_budget_raw := COALESCE(v_workflow_start->>'inline_kick_budget_ms', '');
      v_inline_poll_raw := COALESCE(v_workflow_start->>'inline_kick_poll_ms', '');

      IF v_inline_max_raw ~ '^\\d+$' THEN
        v_inline_kick_max_attempts := LEAST(GREATEST(v_inline_max_raw::INT, 1), 5);
      ELSE
        v_inline_kick_max_attempts := 1;
      END IF;

      IF v_inline_budget_raw ~ '^\\d+$' THEN
        v_inline_kick_budget_ms := LEAST(GREATEST(v_inline_budget_raw::INT, 25), 2000);
      ELSE
        v_inline_kick_budget_ms := 150;
      END IF;

      IF v_inline_poll_raw ~ '^\\d+$' THEN
        v_inline_kick_poll_ms := LEAST(GREATEST(v_inline_poll_raw::INT, 10), 500);
      ELSE
        v_inline_kick_poll_ms := 40;
      END IF;

      v_inline_started_at := clock_timestamp();
      v_inline_deadline := v_inline_started_at + ((v_inline_kick_budget_ms::TEXT || ' milliseconds')::INTERVAL);

      WHILE v_inline_attempts < v_inline_kick_max_attempts LOOP
        EXIT WHEN clock_timestamp() >= v_inline_deadline;

        BEGIN
          v_inline_progress := public.progress_workflow_run(v_run_id);
          v_inline_attempts := v_inline_attempts + 1;
          v_inline_status := NULLIF(v_inline_progress->>'status', '');

          BEGIN
            v_inline_next_run_at := (v_inline_progress->>'next_run_at')::TIMESTAMPTZ;
          EXCEPTION WHEN OTHERS THEN
            v_inline_next_run_at := NULL;
          END;

          EXIT WHEN v_inline_status IN ('completed', 'failed', 'cancelled', 'blocked');
          EXIT WHEN v_inline_next_run_at IS NOT NULL AND v_inline_next_run_at > now();

          IF v_inline_attempts < v_inline_kick_max_attempts AND clock_timestamp() < v_inline_deadline THEN
            PERFORM pg_sleep((v_inline_kick_poll_ms::NUMERIC) / 1000.0);
          END IF;
        EXCEPTION WHEN OTHERS THEN
          v_inline_error := SQLERRM;
          EXIT;
        END;
      END LOOP;

      v_inline_elapsed_ms := GREATEST(
        0,
        FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_inline_started_at)) * 1000)
      )::INT;
    END IF;

    RETURN jsonb_build_object(
      'status', 'workflow_started',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'workflow_run_id', v_run_id,
      'workflow_inline_kick', jsonb_strip_nulls(jsonb_build_object(
        'enabled', v_inline_kick_enabled,
        'attempts', CASE WHEN v_inline_kick_enabled THEN v_inline_attempts ELSE NULL END,
        'max_attempts', CASE WHEN v_inline_kick_enabled THEN v_inline_kick_max_attempts ELSE NULL END,
        'budget_ms', CASE WHEN v_inline_kick_enabled THEN v_inline_kick_budget_ms ELSE NULL END,
        'poll_ms', CASE WHEN v_inline_kick_enabled THEN v_inline_kick_poll_ms ELSE NULL END,
        'elapsed_ms', CASE WHEN v_inline_kick_enabled THEN v_inline_elapsed_ms ELSE NULL END,
        'status', CASE WHEN v_inline_kick_enabled THEN v_inline_status ELSE NULL END,
        'next_run_at', CASE WHEN v_inline_kick_enabled THEN v_inline_next_run_at ELSE NULL END,
        'error', CASE WHEN v_inline_kick_enabled THEN v_inline_error ELSE NULL END
      ))
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

SELECT pg_advisory_unlock(hashtext('202603051520_ui_execute_command_inline_kick_v1'));
COMMIT;
