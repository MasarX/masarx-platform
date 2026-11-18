-- Console V2 NDR resolution: authenticated operators pass the UI capability
-- gate, then the SECURITY DEFINER wrapper temporarily elevates the inner
-- service-only apply chain so create_task_system_v1 can enqueue canonical
-- follow-up tasks. Original JWT claims are restored on success and failure.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605211640_console_v2_ndr_resolution_service_claim_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_execute_dispatch_exception_resolution_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_mode TEXT := '';
  v_min INTEGER := 0;
  v_max INTEGER := NULL;
  v_ids TEXT[] := COALESCE(
    p_selection_ids,
    CASE
      WHEN p_selection_id IS NULL OR btrim(p_selection_id) = '' THEN ARRAY[]::TEXT[]
      ELSE ARRAY[p_selection_id]
    END
  );
  v_count INTEGER := COALESCE(p_selection_count, COALESCE(array_length(v_ids, 1), 0));
  v_selection_id_text TEXT := NULL;
  v_selection_uuid UUID := NULL;
  v_resolution_action TEXT := NULL;
  v_resolution_notes TEXT := NULL;
  v_visible_task JSONB := NULL;
  v_preview JSONB := '{}'::jsonb;
  v_apply_result JSONB := '{}'::jsonb;
  v_task public.tasks%ROWTYPE;
  v_transition RECORD;
  v_workflow_template_name TEXT := NULL;
  v_template_id UUID := NULL;
  v_workflow_run_id UUID := NULL;
  v_manual_review_task_id UUID := NULL;
  v_results JSONB := '[]'::jsonb;
  v_pending_review_count INTEGER := 0;
  v_scheduled_count INTEGER := 0;
  v_completed_count INTEGER := 0;
  v_blocked_count INTEGER := 0;
  v_apply_status TEXT := NULL;
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_elevated_claims JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(COALESCE(p_params, '{}'::jsonb)) IS DISTINCT FROM 'object' THEN
    p_params := '{}'::jsonb;
  END IF;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 requires action key';
  END IF;

  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 requires resource key';
  END IF;

  v_resolution_action := lower(NULLIF(btrim(COALESCE(
    p_params->>'resolution_action',
    p_params->>'ndr_action',
    ''
  )), ''));
  v_resolution_notes := NULLIF(btrim(COALESCE(p_params->>'resolution_notes', '')), '');

  IF v_resolution_action IS NULL THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 requires resolution_action';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'ndr_action'
       AND lv.value = v_resolution_action
       AND lv.status = 'active'
  ) THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 unsupported resolution_action %', v_resolution_action
      USING ERRCODE = '23514';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 selection above maximum %', v_max;
  END IF;

  v_elevated_claims := jsonb_build_object(
    'role', 'service_role',
    'sub', v_user_id::text,
    'origin', 'ui_execute_dispatch_exception_resolution_v1',
    'origin_scope_type', v_scope_type,
    'origin_scope_id', v_scope_id::text
  );

  FOREACH v_selection_id_text IN ARRAY v_ids LOOP
    BEGIN
      v_selection_uuid := NULLIF(btrim(v_selection_id_text), '')::uuid;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 invalid task id %', v_selection_id_text;
    END;

    IF v_selection_uuid IS NULL THEN
      CONTINUE;
    END IF;

    v_visible_task := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
    IF v_visible_task IS NULL THEN
      RAISE EXCEPTION
        'ui_execute_dispatch_exception_resolution_v1 task % is not visible in resource %',
        v_selection_uuid,
        p_resource_key
        USING ERRCODE = '42501';
    END IF;

    v_preview := public.preview_dispatch_exception_resolution_v1(
      v_selection_uuid,
      v_resolution_action,
      p_params
    );

    IF COALESCE(v_preview->>'decision_status', '') = 'blocked' THEN
      v_blocked_count := v_blocked_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'task_id', v_selection_uuid,
        'status', 'blocked',
        'blocked_reason', v_preview->>'blocked_reason',
        'preview', v_preview
      )));
      CONTINUE;
    END IF;

    SELECT *
      INTO v_task
      FROM public.tasks t
     WHERE t.id = v_selection_uuid
     LIMIT 1;

    SELECT *
      INTO v_transition
      FROM public.transition_task_v1(
        v_selection_uuid,
        'completed',
        NULLIF(v_preview->>'dispatch_exception_reason', ''),
        jsonb_strip_nulls(jsonb_build_object(
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes,
          'decision_status', v_preview->>'decision_status'
        )),
        format('dispatch_exception_review:resolve:%s:%s', v_selection_uuid, v_resolution_action)
      )
     LIMIT 1;

    IF COALESCE(v_preview->>'decision_status', '') = 'manual_review_required' THEN
      v_workflow_template_name := COALESCE(
        NULLIF(v_preview->>'approval_workflow_template_name', ''),
        'dispatch_reattempt_approval_v1'
      );

      SELECT wt.id
        INTO v_template_id
        FROM public.workflow_templates wt
       WHERE wt.name = v_workflow_template_name
         AND wt.status = 'active'
       ORDER BY wt.version DESC, wt.updated_at DESC NULLS LAST
       LIMIT 1;

      IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 workflow template missing %', v_workflow_template_name
          USING ERRCODE = '23503';
      END IF;

      v_workflow_run_id := public.start_workflow_run(
        v_template_id,
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_task.organization_id,
          'client_id', v_task.client_id,
          'sender_id', v_task.sender_id,
          'resource_type', 'task',
          'resource_id', v_selection_uuid,
          'dispatch_exception_review_task_id', v_selection_uuid,
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes,
          'payload', jsonb_strip_nulls(jsonb_build_object(
            'dispatch_exception_review_task_id', v_selection_uuid,
            'resolution_action', v_resolution_action,
            'resolution_notes', v_resolution_notes
          ))
        ))
      );

      PERFORM public.progress_workflow_run(
        v_workflow_run_id,
        jsonb_strip_nulls(jsonb_build_object(
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes
        ))
      );

      SELECT mrt.id
        INTO v_manual_review_task_id
        FROM public.manual_review_tasks mrt
       WHERE mrt.metadata->>'workflow_run_id' = v_workflow_run_id::text
       ORDER BY mrt.created_at DESC, mrt.id DESC
       LIMIT 1;

      IF v_manual_review_task_id IS NULL THEN
        RAISE EXCEPTION 'ui_execute_dispatch_exception_resolution_v1 failed to create manual review task for workflow_run_id %',
          v_workflow_run_id;
      END IF;

      UPDATE public.manual_review_tasks
         SET reason = COALESCE(v_resolution_notes, reason, NULLIF(v_preview->>'dispatch_exception_reason', '')),
             metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'workflow_resume_on_resolve', TRUE,
               'dispatch_exception_review_task_id', v_selection_uuid,
               'resolution_action', v_resolution_action,
               'resolution_notes', v_resolution_notes
             )),
             updated_at = now()
       WHERE id = v_manual_review_task_id;

      PERFORM public.progress_workflow_run(
        v_workflow_run_id,
        jsonb_strip_nulls(jsonb_build_object(
          'manual_review_task_id', v_manual_review_task_id,
          'resolution_action', v_resolution_action,
          'resolution_notes', v_resolution_notes
        ))
      );

      UPDATE public.tasks
         SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'resolution_action', v_resolution_action,
               'resolution_notes', v_resolution_notes,
               'resolution_status', 'pending_review',
               'resolution_workflow_run_id', v_workflow_run_id,
               'resolution_manual_review_task_id', v_manual_review_task_id
             )),
             updated_at = now()
       WHERE id = v_selection_uuid;

      v_pending_review_count := v_pending_review_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'task_id', v_selection_uuid,
        'status', 'pending_review',
        'workflow_run_id', v_workflow_run_id,
        'manual_review_task_id', v_manual_review_task_id,
        'preview', v_preview
      )));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', v_elevated_claims::text, true);
        v_apply_result := public.apply_dispatch_exception_resolution_v1(
          jsonb_strip_nulls(jsonb_build_object(
            'task_id', v_selection_uuid,
            'resolution_action', v_resolution_action,
            'resolution_notes', v_resolution_notes,
            'actor_system', 'ui_execute_dispatch_exception_resolution_v1'
          ))
        );
        PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      EXCEPTION
        WHEN others THEN
          PERFORM set_config('request.jwt.claims', v_prev_claims, true);
          RAISE;
      END;

      v_apply_status := lower(NULLIF(btrim(COALESCE(v_apply_result->>'status', '')), ''));
      IF v_apply_status IN ('scheduled', 'pending', 'queued') THEN
        v_scheduled_count := v_scheduled_count + 1;
      ELSIF v_apply_status = 'blocked' THEN
        v_blocked_count := v_blocked_count + 1;
      ELSIF v_apply_status = 'pending_review' THEN
        v_pending_review_count := v_pending_review_count + 1;
      ELSE
        v_completed_count := v_completed_count + 1;
      END IF;
      v_results := v_results || jsonb_build_array(
        jsonb_strip_nulls(COALESCE(v_apply_result, '{}'::jsonb) || jsonb_build_object('task_id', v_selection_uuid))
      );
    END IF;
  END LOOP;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', CASE
      WHEN v_pending_review_count > 0 AND v_completed_count = 0 AND v_blocked_count = 0 THEN 'pending_review'
      WHEN v_scheduled_count > 0 AND v_pending_review_count = 0 AND v_completed_count = 0 AND v_blocked_count = 0 THEN 'scheduled'
      WHEN v_completed_count > 0 AND v_pending_review_count = 0 AND v_blocked_count = 0 THEN 'completed'
      WHEN v_blocked_count > 0 AND v_pending_review_count = 0 AND v_completed_count = 0 THEN 'blocked'
      ELSE 'mixed'
    END,
    'count', COALESCE(jsonb_array_length(v_results), 0),
    'pending_review_count', v_pending_review_count,
    'scheduled_count', v_scheduled_count,
    'completed_count', v_completed_count,
    'blocked_count', v_blocked_count,
    'items', v_results
  ));
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Resolve visible dispatch exception review tasks through the dedicated row-driven NDR policy path. Capability gate stays authenticated; service-only apply helpers run under temporary service_role JWT claims and restore the operator claims afterwards.';

SELECT pg_advisory_unlock(hashtext('202605211640_console_v2_ndr_resolution_service_claim_v1'));
COMMIT;
