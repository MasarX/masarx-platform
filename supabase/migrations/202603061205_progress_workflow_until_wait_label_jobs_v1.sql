-- Migration: progress workflow until wait + label job nudges
-- Purpose:
--  - Add a generic workflow-engine helper that advances synchronous steps until a real wait boundary.
--  - Nudge label-print parent workflows when current-scope jobs become terminal.
--  - Switch ui_execute_command_v1 inline progression to the generic helper.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061205_progress_workflow_until_wait_label_jobs_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.progress_workflow_run_until_wait_v1(
  p_workflow_run_id uuid,
  p_operation_result jsonb DEFAULT '{}'::jsonb,
  p_budget_ms int DEFAULT NULL,
  p_max_steps int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_budget_ms int := LEAST(GREATEST(COALESCE(p_budget_ms, 150), 25), 5000);
  v_max_steps int := LEAST(GREATEST(COALESCE(p_max_steps, 3), 1), 50);
  v_started_at timestamptz := clock_timestamp();
  v_elapsed_ms int := 0;
  v_steps int := 0;
  v_last jsonb := jsonb_build_object('workflow_run_id', p_workflow_run_id, 'status', 'idle');
  v_injected_operation_result jsonb := COALESCE(p_operation_result, '{}'::jsonb);
  v_status text := '';
  v_has_step boolean := false;
BEGIN
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'progress_workflow_run_until_wait_v1 requires workflow_run_id';
  END IF;

  WHILE v_steps < v_max_steps LOOP
    EXIT WHEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::int >= v_budget_ms;

    v_last := public.progress_workflow_run(p_workflow_run_id, v_injected_operation_result);
    v_steps := v_steps + 1;
    v_injected_operation_result := '{}'::jsonb;
    v_status := lower(COALESCE(v_last->>'status', ''));
    v_has_step := NULLIF(v_last->>'step_id', '') IS NOT NULL;

    EXIT WHEN v_status IN ('pending', 'waiting', 'in_progress', 'failed', 'cancelled', 'blocked');
    IF v_status = 'completed' AND NOT v_has_step THEN
      EXIT;
    END IF;
  END LOOP;

  v_elapsed_ms := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::int;

  RETURN jsonb_strip_nulls(
    COALESCE(v_last, '{}'::jsonb)
    || jsonb_build_object(
      'attempts', v_steps,
      'elapsed_ms', v_elapsed_ms,
      'budget_ms', v_budget_ms,
      'max_steps', v_max_steps
    )
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'workflow_run_id', p_workflow_run_id,
      'status', 'failed',
      'error', SQLERRM,
      'attempts', v_steps,
      'elapsed_ms', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000))::int,
      'budget_ms', v_budget_ms,
      'max_steps', v_max_steps
    );
END;
$$;

COMMENT ON FUNCTION public.progress_workflow_run_until_wait_v1(uuid, jsonb, int, int)
  IS 'Advance a workflow run through immediately-available synchronous steps until a real wait boundary, terminal state, or budget limit.';

REVOKE ALL ON FUNCTION public.progress_workflow_run_until_wait_v1(uuid, jsonb, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.progress_workflow_run_until_wait_v1(uuid, jsonb, int, int) TO service_role, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.progress_workflow_run_until_wait_v1(uuid, jsonb, int, int) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.nudge_workflow_run_for_label_jobs_v1(
  p_workflow_run_step_id uuid,
  p_reason text DEFAULT 'label_jobs_terminal'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_run_id uuid := NULL;
  v_org_id uuid := NULL;
  v_policy jsonb := '{}'::jsonb;
  v_enabled boolean := true;
  v_budget_ms int := 750;
  v_max_steps int := 6;
  v_remaining_count int := 0;
  v_org_raw text := '';
BEGIN
  IF p_workflow_run_step_id IS NULL THEN
    RAISE EXCEPTION 'nudge_workflow_run_for_label_jobs_v1 requires workflow_run_step_id';
  END IF;

  SELECT wrs.workflow_run_id,
         COALESCE(wr.context->>'organization_id', '')
  INTO v_run_id, v_org_raw
  FROM public.workflow_run_steps wrs
  JOIN public.workflow_runs wr ON wr.id = wrs.workflow_run_id
  WHERE wrs.id = p_workflow_run_step_id
  LIMIT 1;

  IF v_run_id IS NULL THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_org_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_org_id := v_org_raw::uuid;
  END IF;

  SELECT COUNT(*)
  INTO v_remaining_count
  FROM public.label_jobs lj
  WHERE lj.workflow_run_step_id = p_workflow_run_step_id
    AND (
      lj.status NOT IN ('succeeded', 'failed')
      OR (lj.status = 'succeeded' AND lj.output_file_url IS NULL)
    );

  IF v_remaining_count > 0 THEN
    RETURN jsonb_build_object(
      'status', 'pending',
      'workflow_run_step_id', p_workflow_run_step_id,
      'remaining_count', v_remaining_count
    );
  END IF;

  v_policy := COALESCE(
    CASE
      WHEN v_org_id IS NOT NULL THEN public.resolve_settings('label_print_policy', 'tenant', v_org_id)
      ELSE NULL
    END,
    public.resolve_settings('label_print_policy', 'global', NULL),
    '{}'::jsonb
  );

  v_enabled := COALESCE((v_policy->>'prepare_inline_progress_enabled')::boolean, true);
  IF COALESCE(v_policy->>'prepare_inline_progress_budget_ms', '') ~ '^\d+$' THEN
    v_budget_ms := LEAST(GREATEST((v_policy->>'prepare_inline_progress_budget_ms')::int, 25), 5000);
  END IF;
  IF COALESCE(v_policy->>'prepare_inline_progress_max_steps', '') ~ '^\d+$' THEN
    v_max_steps := LEAST(GREATEST((v_policy->>'prepare_inline_progress_max_steps')::int, 1), 50);
  END IF;

  IF NOT v_enabled THEN
    RETURN jsonb_build_object(
      'status', 'disabled',
      'workflow_run_step_id', p_workflow_run_step_id,
      'workflow_run_id', v_run_id
    );
  END IF;

  RETURN public.progress_workflow_run_until_wait_v1(
    v_run_id,
    jsonb_build_object(
      'source', COALESCE(NULLIF(p_reason, ''), 'label_jobs_terminal'),
      'workflow_run_step_id', p_workflow_run_step_id
    ),
    v_budget_ms,
    v_max_steps
  );
END;
$$;

COMMENT ON FUNCTION public.nudge_workflow_run_for_label_jobs_v1(uuid, text)
  IS 'Advance a parent workflow when all fresh label jobs for the current step are terminal.';

REVOKE ALL ON FUNCTION public.nudge_workflow_run_for_label_jobs_v1(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nudge_workflow_run_for_label_jobs_v1(uuid, text) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.nudge_workflow_run_for_label_jobs_v1(uuid, text) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_label_jobs(p_results jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_rec record;
  v_step_id uuid;
  v_step_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' THEN
    RAISE EXCEPTION 'complete_label_jobs requires p_results as JSONB array';
  END IF;

  FOR v_rec IN
    SELECT *
    FROM jsonb_to_recordset(p_results) AS x(
      job_id uuid,
      status text,
      file_url text,
      file_size_bytes integer,
      renderer_metadata jsonb,
      error_reason text
    )
  LOOP
    SELECT workflow_run_step_id
    INTO v_step_id
    FROM public.label_jobs
    WHERE id = v_rec.job_id;

    IF v_step_id IS NOT NULL AND array_position(v_step_ids, v_step_id) IS NULL THEN
      v_step_ids := array_append(v_step_ids, v_step_id);
    END IF;

    PERFORM public.complete_label_job(
      p_job_id := v_rec.job_id,
      p_status := v_rec.status,
      p_file_url := v_rec.file_url,
      p_file_size_bytes := v_rec.file_size_bytes,
      p_renderer_metadata := COALESCE(v_rec.renderer_metadata, '{}'::jsonb),
      p_error_reason := v_rec.error_reason
    );
  END LOOP;

  FOREACH v_step_id IN ARRAY v_step_ids LOOP
    BEGIN
      PERFORM public.nudge_workflow_run_for_label_jobs_v1(v_step_id, 'label_jobs_completed');
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;
  END LOOP;
END;
$function$;

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
  v_inline_elapsed_ms INT := 0;
  v_inline_progress JSONB := '{}'::jsonb;
  v_inline_status TEXT := NULL;
  v_inline_error TEXT := NULL;
  v_inline_next_run_at TIMESTAMPTZ := NULL;
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

      IF v_inline_max_raw ~ '^\d+$' THEN
        v_inline_kick_max_attempts := LEAST(GREATEST(v_inline_max_raw::INT, 1), 20);
      ELSE
        v_inline_kick_max_attempts := 1;
      END IF;

      IF v_inline_budget_raw ~ '^\d+$' THEN
        v_inline_kick_budget_ms := LEAST(GREATEST(v_inline_budget_raw::INT, 25), 5000);
      ELSE
        v_inline_kick_budget_ms := 150;
      END IF;

      IF v_inline_poll_raw ~ '^\d+$' THEN
        v_inline_kick_poll_ms := LEAST(GREATEST(v_inline_poll_raw::INT, 10), 500);
      ELSE
        v_inline_kick_poll_ms := 40;
      END IF;

      BEGIN
        v_inline_progress := public.progress_workflow_run_until_wait_v1(
          v_run_id,
          jsonb_build_object(
            'source', 'ui_execute_command_inline',
            'action_key', p_action_key
          ),
          v_inline_kick_budget_ms,
          v_inline_kick_max_attempts
        );
        v_inline_attempts := COALESCE(NULLIF(v_inline_progress->>'attempts', '')::INT, 0);
        v_inline_elapsed_ms := COALESCE(NULLIF(v_inline_progress->>'elapsed_ms', '')::INT, 0);
        v_inline_status := NULLIF(v_inline_progress->>'status', '');

        BEGIN
          v_inline_next_run_at := NULLIF(v_inline_progress->>'next_run_at', '')::TIMESTAMPTZ;
        EXCEPTION WHEN OTHERS THEN
          v_inline_next_run_at := NULL;
        END;
      EXCEPTION WHEN OTHERS THEN
        v_inline_error := SQLERRM;
      END;
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

SELECT pg_advisory_unlock(hashtext('202603061205_progress_workflow_until_wait_label_jobs_v1'));
COMMIT;
