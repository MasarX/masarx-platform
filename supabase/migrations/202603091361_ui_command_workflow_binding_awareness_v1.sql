-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S04
-- Migration: Make ui_execute_command_v1 workflow-binding aware
-- Date: 2026-03-09

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091361_ui_command_workflow_binding_awareness_v1'));
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
AS $function$
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
  v_static_params JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_patch JSONB;
  v_payload_key TEXT;
  v_selection_key TEXT;
  v_payload JSONB;
  v_context JSONB;
  v_template_id UUID;
  v_run_id UUID;
  v_results JSONB := '[]'::jsonb;
  v_item JSONB;

  v_binding_key TEXT := NULL;
  v_stage_key TEXT := NULL;
  v_binding_result JSONB := '{}'::jsonb;
  v_binding_resource_id UUID := NULL;
  v_binding_idempotency_key TEXT := NULL;

  -- task_transition handler fields
  v_to_status TEXT;
  v_status_reason TEXT;
  v_idempotency_key TEXT;
  v_transition_payload JSONB;
  v_transition_row RECORD;
  v_task RECORD;
  v_policy_row RECORD;
  v_exception_reason TEXT;
  v_reason_required BOOLEAN;
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
  v_static_params := COALESCE(v_execution->'params', '{}'::jsonb);
  v_params := v_static_params || COALESCE(p_params, '{}'::jsonb);
  v_handler := lower(COALESCE(NULLIF(v_static_params->>'handler', ''), NULLIF(v_params->>'handler', ''), ''));
  v_patch := COALESCE(v_params->'patch', '{}'::jsonb);

  v_payload_key := NULLIF(v_params->>'payload_key', '');
  v_selection_key := NULLIF(v_params->>'selection_id_key', '');
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

  v_context := jsonb_strip_nulls(
    jsonb_build_object(
      'organization_id', public.current_user_org_id(),
      'requested_by', auth.uid(),
      'payload', v_payload,
      'binding_payload', COALESCE(v_params->'binding_payload', v_payload),
      'ui_command', jsonb_build_object(
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'params', p_params
      )
    )
  );

  v_binding_key := lower(COALESCE(
    NULLIF(btrim(COALESCE(v_command->>'binding_key', '')), ''),
    NULLIF(btrim(COALESCE(v_execution->>'binding_key', '')), ''),
    NULLIF(btrim(COALESCE(v_params->>'binding_key', '')), '')
  ));
  v_stage_key := lower(COALESCE(
    NULLIF(btrim(COALESCE(v_command->>'stage_key', '')), ''),
    NULLIF(btrim(COALESCE(v_execution->>'stage_key', '')), ''),
    NULLIF(btrim(COALESCE(v_params->>'stage_key', '')), '')
  ));

  IF v_binding_key IS NOT NULL OR (v_execution->>'type') = 'workflow_binding' THEN
    IF v_binding_key IS NULL OR v_stage_key IS NULL THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow binding requires binding_key and stage_key for %', p_action_key;
    END IF;

    BEGIN
      IF v_count = 1 AND v_id IS NOT NULL THEN
        v_binding_resource_id := v_id::UUID;
      END IF;
    EXCEPTION
      WHEN others THEN
        v_binding_resource_id := NULL;
    END;

    v_binding_idempotency_key := NULLIF(btrim(COALESCE(v_params->>'idempotency_key', '')), '');
    IF v_binding_idempotency_key IS NULL THEN
      v_binding_idempotency_key := format(
        'ui_command:%s:%s',
        p_action_key,
        encode(digest(v_payload::TEXT, 'sha256'), 'hex')
      );
    END IF;

    v_binding_result := public.run_workflow_binding_stage_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'binding_key', v_binding_key,
          'stage_key', v_stage_key,
          'organization_id', public.current_user_org_id(),
          'resource_type', NULLIF(btrim(COALESCE(p_resource_key, '')), ''),
          'resource_id', v_binding_resource_id,
          'actor_user_id', auth.uid(),
          'source_function', 'ui_execute_command_v1',
          'idempotency_key', v_binding_idempotency_key,
          'context', v_context
        )
      )
    );

    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'status', 'workflow_binding_started',
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'binding_key', v_binding_key,
        'stage_key', v_stage_key,
        'dispatch_id', NULLIF(v_binding_result->>'dispatch_id', '')::UUID,
        'workflow_run_id', NULLIF(v_binding_result->>'workflow_run_id', '')::UUID,
        'outcome', NULLIF(v_binding_result->>'outcome', '')
      )
    );
  END IF;

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

  IF v_handler = 'task_transition' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;

    v_to_status := lower(COALESCE(NULLIF(v_static_params->>'to_status', ''), NULLIF(v_params->>'to_status', ''), ''));
    IF v_to_status = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 task_transition requires to_status';
    END IF;

    v_status_reason := NULLIF(COALESCE(v_static_params->>'status_reason', v_params->>'status_reason', ''), '');
    v_transition_payload := COALESCE(v_params->'payload', '{}'::jsonb);

    FOREACH v_id IN ARRAY v_ids LOOP
      IF v_to_status = 'exception' THEN
        SELECT t.id, t.organization_id, t.client_id, t.sender_id, t.resource_type, t.resource_id
          INTO v_task
          FROM public.tasks t
         WHERE t.id = v_id::uuid
         LIMIT 1;

        IF v_task.id IS NULL THEN
          RAISE EXCEPTION 'ui_execute_command_v1 task_transition task not found: %', v_id USING ERRCODE = '23503';
        END IF;

        SELECT *
          INTO v_policy_row
          FROM public.resolve_pod_policy(
            jsonb_strip_nulls(
              jsonb_build_object(
                'organization_id', v_task.organization_id,
                'client_id', v_task.client_id,
                'sender_id', v_task.sender_id,
                'resource_type', v_task.resource_type,
                'resource_id', v_task.resource_id
              )
            )
          )
        LIMIT 1;

        v_reason_required := COALESCE(
          (v_policy_row.value->'requirements'->'exception'->>'exception_reason_required')::boolean,
          TRUE
        );

        v_exception_reason := lower(NULLIF(btrim(COALESCE(v_transition_payload->>'exception_reason', '')), ''));

        IF v_reason_required AND v_exception_reason IS NULL THEN
          RAISE EXCEPTION 'ui_execute_command_v1 exception transition requires payload.exception_reason' USING ERRCODE = '23514';
        END IF;

        IF v_exception_reason IS NOT NULL
           AND public.is_active_lookup_value_v1('dispatch_exception_reason', v_exception_reason, TRUE) IS FALSE THEN
          RAISE EXCEPTION 'ui_execute_command_v1 invalid exception_reason: %', v_exception_reason USING ERRCODE = '23514';
        END IF;

        IF v_exception_reason IS NOT NULL THEN
          v_transition_payload := jsonb_set(v_transition_payload, '{exception_reason}', to_jsonb(v_exception_reason), TRUE);
        END IF;
      END IF;

      v_idempotency_key := encode(
        digest(
          format('%s|%s|%s|%s', p_action_key, v_to_status, v_id, v_transition_payload::text),
          'sha256'
        ),
        'hex'
      );

      SELECT * INTO v_transition_row
      FROM public.transition_task_v1(
        p_task_id := v_id::uuid,
        p_to_status := v_to_status,
        p_status_reason := v_status_reason,
        p_payload := v_transition_payload,
        p_idempotency_key := v_idempotency_key
      )
      LIMIT 1;

      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'task_id', v_transition_row.task_id,
          'task_event_id', v_transition_row.task_event_id
        )
      );
    END LOOP;

    RETURN jsonb_build_object(
      'status', 'task_transitioned',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'to_status', v_to_status,
      'count', v_count,
      'items', v_results
    );
  END IF;

  RAISE EXCEPTION 'ui_execute_command_v1 missing handler for %', p_action_key;
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202603091361_ui_command_workflow_binding_awareness_v1'));
COMMIT;
