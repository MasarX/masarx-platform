-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Purpose:
-- - Normalize workflow-binding dispatches onto valid request_entry_point values
--   before starting workflow runs.
-- - Preserve the original source function in binding context/dispatch rows while
--   keeping workflow_runs.entry_point compliant with the lookup contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603101020_workflow_binding_entry_point_fix_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.workflow_binding_request_entry_point_v1(
  p_binding_key TEXT,
  p_actor_user_id UUID DEFAULT NULL,
  p_requested_entry_point TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_binding_key TEXT := lower(NULLIF(btrim(COALESCE(p_binding_key, '')), ''));
  v_requested_entry_point TEXT := lower(NULLIF(btrim(COALESCE(p_requested_entry_point, '')), ''));
  v_registry_entrypoint_type TEXT := NULL;
BEGIN
  IF v_requested_entry_point IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'request_entry_point'
        AND lv.value = v_requested_entry_point
        AND COALESCE(lv.status, 'active') = 'active'
    ) THEN
      RETURN v_requested_entry_point;
    END IF;
    RAISE EXCEPTION 'invalid request_entry_point for workflow binding dispatch: %', v_requested_entry_point;
  END IF;

  IF p_actor_user_id IS NOT NULL THEN
    RETURN 'manual';
  END IF;

  SELECT lower(NULLIF(btrim(COALESCE(r.entrypoint_type, '')), ''))
    INTO v_registry_entrypoint_type
    FROM public.workflow_binding_registry r
   WHERE r.binding_key = v_binding_key
   LIMIT 1;

  RETURN CASE v_registry_entrypoint_type
    WHEN 'domain_event' THEN 'domain_event'
    WHEN 'workflow_handler' THEN 'worker'
    ELSE 'api'
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.run_workflow_binding_stage_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_binding_key TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'binding_key', '')), ''));
  v_stage_key TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'stage_key', '')), ''));
  v_context JSONB := COALESCE(v_input->'context', '{}'::jsonb);
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');
  v_source_function TEXT := NULLIF(btrim(COALESCE(v_input->>'source_function', '')), '');
  v_requested_entry_point TEXT := NULLIF(btrim(COALESCE(v_input->>'request_entry_point', '')), '');
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_request_entry_point TEXT := NULL;
  v_resolution RECORD;
  v_settings_resolution_id UUID := NULL;
  v_run_context JSONB;
  v_run_id UUID := NULL;
  v_inline_steps INT := 0;
  v_progress JSONB := '{}'::jsonb;
  v_step_result JSONB := NULL;
  v_existing RECORD;
  v_dispatch_id UUID := NULL;
  v_resource_type TEXT := NULLIF(btrim(COALESCE(v_context->>'resource_type', v_input->>'resource_type', '')), '');
  v_resource_id UUID := NULL;
  v_outcome TEXT := 'started';
  v_decision_id UUID := NULL;
  v_loop INT := 0;
BEGIN
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::UUID; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  BEGIN v_resource_id := NULLIF(COALESCE(v_context->>'resource_id', v_input->>'resource_id', ''), '')::UUID; EXCEPTION WHEN others THEN v_resource_id := NULL; END;

  IF v_binding_key IS NULL OR v_stage_key IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'binding_key_stage_key_required'));
  END IF;

  v_request_entry_point := public.workflow_binding_request_entry_point_v1(
    v_binding_key,
    v_actor_user_id,
    v_requested_entry_point
  );

  IF v_idempotency_key IS NOT NULL THEN
    SELECT *
      INTO v_existing
      FROM public.workflow_binding_dispatches d
     WHERE d.binding_key = v_binding_key
       AND d.stage_key = v_stage_key
       AND d.idempotency_key = v_idempotency_key
     LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_strip_nulls(
        jsonb_build_object(
          'ok', TRUE,
          'binding_key', v_binding_key,
          'stage_key', v_stage_key,
          'dispatch_id', v_existing.id,
          'workflow_run_id', v_existing.workflow_run_id,
          'workflow_template_id', v_existing.workflow_template_id,
          'outcome', v_existing.outcome,
          'step_operation_result', v_existing.step_operation_result,
          'settings_resolution_id', v_existing.settings_resolution_id,
          'idempotent', TRUE
        )
      );
    END IF;
  END IF;

  SELECT *
    INTO v_resolution
    FROM public.resolve_workflow_binding_v1(v_binding_key, v_stage_key, v_context)
   LIMIT 1;

  IF v_resolution.binding_key IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'binding_not_found'));
  END IF;

  IF COALESCE(v_resolution.enabled, FALSE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'binding_disabled'));
  END IF;

  IF v_resolution.workflow_template_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'workflow_template_missing'));
  END IF;

  IF v_resolution.organization_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_resolution.organization_id,
      p_category := 'workflow_binding_policy',
      p_winning_scope_type := v_resolution.resolved_scope_type,
      p_winning_scope_id := v_resolution.resolved_scope_id,
      p_winning_settings_id := v_resolution.settings_id,
      p_winning_settings_version_id := v_resolution.settings_version_id,
      p_winning_version := v_resolution.version,
      p_scope_path := v_resolution.scope_path,
      p_inputs := jsonb_strip_nulls(
        jsonb_build_object(
          'binding_key', v_binding_key,
          'stage_key', v_stage_key,
          'requested_scope_type', v_resolution.requested_scope_type,
          'requested_scope_id', v_resolution.requested_scope_id,
          'context', v_context
        )
      ),
      p_merge_notes := NULL
    );
  END IF;

  v_inline_steps := GREATEST(COALESCE(v_resolution.inline_progress_steps, 0), 0);

  v_run_context := public.jsonb_deep_merge(
    COALESCE(v_context, '{}'::jsonb),
    jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_resolution.organization_id,
        'client_id', v_resolution.client_id,
        'sender_id', v_resolution.sender_id,
        'idempotency_key', v_idempotency_key,
        'binding', jsonb_strip_nulls(
          jsonb_build_object(
            'binding_key', v_binding_key,
            'stage_key', v_stage_key,
            'requested_scope_type', v_resolution.requested_scope_type,
            'requested_scope_id', v_resolution.requested_scope_id,
            'resolved_scope_type', v_resolution.resolved_scope_type,
            'resolved_scope_id', v_resolution.resolved_scope_id,
            'settings_id', v_resolution.settings_id,
            'settings_version_id', v_resolution.settings_version_id,
            'settings_resolution_id', v_settings_resolution_id,
            'stage_config', COALESCE(v_resolution.stage_value, '{}'::jsonb),
            'source_function', v_source_function,
            'request_entry_point', v_request_entry_point
          )
        ),
        'trigger_source', v_request_entry_point,
        'actor', jsonb_strip_nulls(
          jsonb_build_object(
            'user_id', v_actor_user_id,
            'system', v_actor_system
          )
        )
      )
    )
  );

  v_run_id := public.start_workflow_run(v_resolution.workflow_template_id, v_run_context);

  IF v_inline_steps > 0 THEN
    v_loop := 0;
    WHILE v_loop < v_inline_steps LOOP
      v_loop := v_loop + 1;
      v_progress := public.progress_workflow_run(v_run_id);
      EXIT WHEN COALESCE(v_progress->>'status', '') IN ('waiting', 'failed', 'completed');
    END LOOP;

    SELECT wrs.operation_result
      INTO v_step_result
      FROM public.workflow_run_steps wrs
     WHERE wrs.workflow_run_id = v_run_id
     ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
     LIMIT 1;

    IF COALESCE(v_progress->>'status', '') IN ('waiting', 'failed', 'completed', 'in_progress') THEN
      v_outcome := COALESCE(v_progress->>'status', v_outcome, 'started');
    END IF;
  END IF;

  INSERT INTO public.workflow_binding_dispatches (
    binding_key,
    stage_key,
    organization_id,
    client_id,
    sender_id,
    resolved_scope_type,
    resolved_scope_id,
    resolved_scope_hash,
    settings_id,
    settings_version_id,
    settings_resolution_id,
    workflow_template_id,
    workflow_run_id,
    resource_type,
    resource_id,
    actor_user_id,
    actor_system,
    source_function,
    idempotency_key,
    outcome,
    context,
    inline_progress_result,
    step_operation_result
  )
  VALUES (
    v_binding_key,
    v_stage_key,
    v_resolution.organization_id,
    v_resolution.client_id,
    v_resolution.sender_id,
    v_resolution.resolved_scope_type,
    v_resolution.resolved_scope_id,
    COALESCE(v_resolution.resolved_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    v_resolution.settings_id,
    v_resolution.settings_version_id,
    v_settings_resolution_id,
    v_resolution.workflow_template_id,
    v_run_id,
    v_resource_type,
    v_resource_id,
    v_actor_user_id,
    v_actor_system,
    v_source_function,
    v_idempotency_key,
    COALESCE(v_outcome, 'started'),
    v_run_context,
    NULLIF(v_progress, '{}'::jsonb),
    v_step_result
  )
  ON CONFLICT (binding_key, stage_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL
  DO UPDATE
  SET
    updated_at = now(),
    workflow_run_id = EXCLUDED.workflow_run_id,
    workflow_template_id = EXCLUDED.workflow_template_id,
    outcome = EXCLUDED.outcome,
    inline_progress_result = EXCLUDED.inline_progress_result,
    step_operation_result = EXCLUDED.step_operation_result
  RETURNING id INTO v_dispatch_id;

  IF v_resolution.organization_id IS NOT NULL THEN
    v_decision_id := public.log_decision(
      p_organization_id := v_resolution.organization_id,
      p_decision_category := 'workflow_binding',
      p_resource_type := COALESCE(v_resource_type, 'workflow_binding_dispatch'),
      p_resource_id := COALESCE(v_resource_id, v_dispatch_id),
      p_decision_point := 'run_workflow_binding_stage_v1',
      p_decision_outcome := COALESCE(v_outcome, 'started'),
      p_performed_by_system := COALESCE(v_actor_system, 'workflow_binding'),
      p_correlation_id := NULL,
      p_decision_inputs := jsonb_strip_nulls(
        jsonb_build_object(
          'binding_key', v_binding_key,
          'stage_key', v_stage_key,
          'dispatch_id', v_dispatch_id,
          'workflow_run_id', v_run_id,
          'workflow_template_id', v_resolution.workflow_template_id,
          'request_entry_point', v_request_entry_point
        )
      ),
      p_decision_reason := NULL,
      p_settings_resolution_id := v_settings_resolution_id
    );
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'binding_key', v_binding_key,
      'stage_key', v_stage_key,
      'dispatch_id', v_dispatch_id,
      'workflow_run_id', v_run_id,
      'workflow_template_id', v_resolution.workflow_template_id,
      'settings_resolution_id', v_settings_resolution_id,
      'decision_id', v_decision_id,
      'outcome', COALESCE(v_outcome, 'started'),
      'request_entry_point', v_request_entry_point,
      'inline_progress_result', NULLIF(v_progress, '{}'::jsonb),
      'step_operation_result', v_step_result
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.workflow_binding_request_entry_point_v1(TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workflow_binding_request_entry_point_v1(TEXT, UUID, TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603101020_workflow_binding_entry_point_fix_v1'));
COMMIT;
