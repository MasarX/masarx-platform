-- Console V2 command palette route targets + workflow template create p_args wrapper.
BEGIN;
SELECT pg_advisory_lock(hashtext('202605041850_console_v2_command_routes_workflow_create_args_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ui_create_workflow_template_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_name text := NULLIF(btrim(COALESCE(v_args->>'name', v_args->>'template_name', '')), '');
  v_description text := NULLIF(btrim(COALESCE(v_args->>'description', v_args->>'template_description', '')), '');
  v_clone_from uuid := NULLIF(COALESCE(v_args->>'clone_from', v_args->>'clone_from_template_id', v_args->>'source_template_id'), '')::uuid;
  v_trigger_event text := NULLIF(btrim(COALESCE(v_args->>'trigger', v_args->>'trigger_event', '')), '');
  v_scope_type text := public.current_user_scope_type();
  v_scope_id uuid := public.current_user_scope_id();
  v_template_id uuid;
  v_metadata jsonb := '{}'::jsonb;
  v_clone_metadata jsonb;
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_v1 requires name'
      USING ERRCODE = '23502';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  IF v_clone_from IS NOT NULL THEN
    SELECT COALESCE(wt.metadata, '{}'::jsonb)
      INTO v_clone_metadata
      FROM public.workflow_templates wt
     WHERE wt.id = v_clone_from
     LIMIT 1;

    IF v_clone_metadata IS NULL THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 clone template not found'
        USING ERRCODE = '23503';
    END IF;

    v_metadata := v_clone_metadata || jsonb_build_object('source_template_id', v_clone_from::text);
  END IF;

  IF v_trigger_event IS NOT NULL THEN
    v_metadata := v_metadata || jsonb_build_object('trigger_event', v_trigger_event);
  END IF;

  INSERT INTO public.workflow_templates (
    name,
    description,
    status,
    version,
    scope_type,
    scope_id,
    created_by,
    metadata
  )
  VALUES (
    v_name,
    v_description,
    'draft',
    1,
    v_scope_type,
    v_scope_id,
    auth.uid(),
    v_metadata
  )
  RETURNING id INTO v_template_id;

  IF v_clone_from IS NOT NULL THEN
    INSERT INTO public.workflow_template_steps (
      workflow_template_id,
      sequence_order,
      operation_name,
      operation_settings_category,
      transition_condition,
      condition_jsonlogic,
      next_operation_name,
      next_operation_priority,
      next_operation_delay_seconds,
      manual_action_required,
      metadata,
      enabled
    )
    SELECT
      v_template_id,
      step.sequence_order,
      step.operation_name,
      step.operation_settings_category,
      step.transition_condition,
      step.condition_jsonlogic,
      step.next_operation_name,
      step.next_operation_priority,
      step.next_operation_delay_seconds,
      step.manual_action_required,
      step.metadata,
      step.enabled
    FROM public.workflow_template_steps step
    WHERE step.workflow_template_id = v_clone_from
    ORDER BY step.sequence_order ASC;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'workflow_template_id', v_template_id::text
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_create_workflow_template_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_create_workflow_template_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.ui_create_workflow_template_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_create_workflow_template_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_create_workflow_template_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_create_workflow_template_v1(jsonb) TO authenticated, service_role;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_create_workflow_template_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_create_workflow_template_v1(jsonb)
  IS 'Console V2 browser-safe p_args wrapper for canonical workflow template creation.';
COMMENT ON FUNCTION api.ui_create_workflow_template_v1(jsonb)
  IS 'API-schema wrapper for Console V2 workflow template creation using the frontend p_args contract.';

DO $do$
DECLARE
  v_canonical_commands jsonb := '{}'::jsonb;
  v_row record;
  v_current jsonb := NULL;
  v_next jsonb := NULL;
  v_commands jsonb := '[]'::jsonb;
  v_next_commands jsonb := '[]'::jsonb;
  v_command jsonb := NULL;
  v_canonical_command jsonb := NULL;
  v_command_key text := NULL;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['route_runs.assign'],
    jsonb_build_object(
      'key', 'route_runs.assign',
      'label', 'Assign run',
      'description', 'Open the dispatch workbench to assign the selected route run.',
      'capability', 'routes.write',
      'schema_category', 'resource:route_runs',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object('type', 'rpc', 'rpc', 'ui_execute_route_run_assign_v1'),
      'route_targets', jsonb_build_object('console', jsonb_build_object('path', '/operate/dispatch'))
    ),
    TRUE
  );
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['route_runs.confirm_departure'],
    jsonb_build_object(
      'key', 'route_runs.confirm_departure',
      'label', 'Confirm departure',
      'description', 'Open the dispatch workbench to reconcile scan-out and confirm route departure.',
      'capability', 'routes.write',
      'schema_category', 'resource:route_runs',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object('type', 'rpc', 'rpc', 'ui_confirm_route_run_departure_v1'),
      'route_targets', jsonb_build_object('console', jsonb_build_object('path', '/operate/dispatch'))
    ),
    TRUE
  );
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['route_stops.reassign'],
    jsonb_build_object(
      'key', 'route_stops.reassign',
      'label', 'Reassign stops',
      'description', 'Open the dispatch workbench to reassign selected stops.',
      'capability', 'routes.write',
      'schema_category', 'resource:route_stops',
      'selection', jsonb_build_object('mode', 'any', 'min_count', 1),
      'execution', jsonb_build_object('type', 'rpc', 'rpc', 'ui_execute_route_stop_reassign_v1'),
      'route_targets', jsonb_build_object('console', jsonb_build_object('path', '/operate/dispatch'))
    ),
    TRUE
  );
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['tasks.transition'],
    jsonb_build_object(
      'key', 'tasks.transition',
      'label', 'Transition task',
      'description', 'Open the review queue to transition the selected task through its allowed workflow action.',
      'capability', 'tasks.write',
      'schema_category', 'resource:tasks',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object('type', 'rpc', 'rpc', 'transition_task_v1'),
      'route_targets', jsonb_build_object('console', jsonb_build_object('path', '/workflows/review-queue'))
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN SELECT value FROM jsonb_array_elements(v_commands) AS value LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_canonical_commands ? v_command_key THEN
        v_command := public.deep_merge_jsonb(v_command, v_canonical_commands->v_command_key);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    FOR v_command_key, v_canonical_command IN
      SELECT key, value
      FROM jsonb_each(v_canonical_commands)
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_next_commands) AS item(value)
        WHERE item.value->>'key' = v_command_key
      ) THEN
        v_next_commands := v_next_commands || jsonb_build_array(v_canonical_command);
      END IF;
    END LOOP;

    v_next := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);
    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = COALESCE(v_row.version, 1) + 1,
             change_reason = 'Expose Console V2 command route targets for dispatch and task workbenches.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605041850_console_v2_command_routes_workflow_create_args_v1'));
COMMIT;
