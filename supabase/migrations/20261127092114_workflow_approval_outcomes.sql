BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_settings_apply_v1(p_step workflow_run_steps, p_run workflow_runs, p_operation_result jsonb DEFAULT '{}'::jsonb)
 RETURNS workflow_handler_response
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_task_id UUID := COALESCE(
      NULLIF(v_ctx->>'manual_review_task_id', ''),
      NULLIF(p_step.operation_result->>'manual_review_task_id', ''),
      NULLIF(v_ctx#>>'{manual_review,task_id}', ''),
      NULLIF(p_operation_result->>'manual_review_task_id', '')
    )::UUID;

    v_task public.manual_review_tasks%ROWTYPE;
    v_settings_version_id UUID;
    v_sv public.settings_versions%ROWTYPE;

    v_org UUID;
    v_now TIMESTAMPTZ := public.workflow_now();
    v_resp workflow_handler_response;
BEGIN
    IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'settings_apply: manual_review_task_id missing from workflow context (workflow_run_id=%)', p_run.id;
    END IF;

    SELECT * INTO v_task FROM public.manual_review_tasks mrt WHERE mrt.id = v_task_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'settings_apply: manual_review_task_id % not found', v_task_id;
    END IF;

    -- Older runs linked the task directly in context before tasks recorded the run ID.
    IF (v_task.metadata ? 'workflow_run_id' OR NULLIF(v_ctx->>'manual_review_task_id', '') IS NULL)
       AND v_task.metadata->>'workflow_run_id' IS DISTINCT FROM p_run.id::text THEN
        RAISE EXCEPTION 'settings_apply: manual review does not belong to this workflow run'
          USING ERRCODE = '42501';
    END IF;

    IF v_task.status <> 'resolved' OR v_task.resolution_outcome IS DISTINCT FROM 'approved' THEN
        v_resp.status := 'failed';
        v_resp.last_error := 'settings_apply: approval missing or rejected';
        v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'manual_review_task_id', v_task_id,
          'resolution_outcome', v_task.resolution_outcome,
          'resolution_notes', v_task.resolution_notes
        ));
        RETURN v_resp;
    END IF;

    IF v_task.resource_type = 'settings_version' AND v_task.resource_id IS NOT NULL THEN
      v_settings_version_id := v_task.resource_id;
    ELSE
      v_settings_version_id := NULLIF(v_ctx->>'resource_id', '')::UUID;
    END IF;

    IF v_settings_version_id IS NULL THEN
      RAISE EXCEPTION 'settings_apply: settings_version_id missing (manual_review_task_id=%)', v_task_id;
    END IF;

    SELECT *
      INTO v_sv
      FROM public.settings_versions sv
     WHERE sv.id = v_settings_version_id
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings_apply: settings_versions row not found for id=%', v_settings_version_id;
    END IF;

    v_org := COALESCE(v_task.organization_id, NULLIF(v_ctx->'payload'->>'organization_id', '')::UUID, public.current_user_org_id());
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'settings_apply: organization_id missing for decision log (settings_version_id=%)', v_settings_version_id;
    END IF;

    -- Keep append-only history monotonic even when the previous row was future-dated.
    UPDATE public.settings_versions
       SET effective_until = GREATEST(
             v_now,
             effective_from + INTERVAL '1 microsecond'
           )
     WHERE category = v_sv.category
       AND scope_type = v_sv.scope_type
       AND scope_hash = v_sv.scope_hash
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
       AND id <> v_settings_version_id;

    UPDATE public.settings_versions
       SET approved_at = COALESCE(approved_at, v_task.resolved_at, v_now),
           approved_by = COALESCE(approved_by, v_task.resolved_by),
           effective_from = CASE WHEN approved_at IS NULL THEN v_now ELSE effective_from END
     WHERE id = v_settings_version_id
       AND scope_hash = v_sv.scope_hash;

    INSERT INTO public.settings (
      id,
      category,
      scope_type,
      scope_id,
      scope_hash,
      settings_version_id,
      cached_value,
      last_updated
    ) VALUES (
      gen_random_uuid(),
      v_sv.category,
      v_sv.scope_type,
      v_sv.scope_id,
      v_sv.scope_hash,
      v_settings_version_id,
      v_sv.value,
      v_now
    )
    ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
    SET scope_id = EXCLUDED.scope_id,
        settings_version_id = EXCLUDED.settings_version_id,
        cached_value = EXCLUDED.cached_value,
        last_updated = EXCLUDED.last_updated;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'settings',
        p_resource_type := 'settings_version',
        p_resource_id := v_settings_version_id,
        p_decision_point := 'apply',
        p_decision_outcome := 'applied',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'category', v_sv.category,
          'scope_type', v_sv.scope_type,
          'scope_id', v_sv.scope_id,
          'manual_review_task_id', v_task_id,
          'approved_by', v_task.resolved_by
        )),
        p_decision_reason := NULL
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'settings_version_id', v_settings_version_id,
      'category', v_sv.category,
      'scope_type', v_sv.scope_type,
      'scope_id', v_sv.scope_id
    ));
    v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'settings_applied', jsonb_build_object(
        'settings_version_id', v_settings_version_id,
        'category', v_sv.category,
        'scope_type', v_sv.scope_type,
        'scope_id', v_sv.scope_id,
        'applied_at', v_now
      )
    ));
    RETURN v_resp;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_manual_review_wait_v1(p_step workflow_run_steps, p_run workflow_runs, p_operation_result jsonb DEFAULT '{}'::jsonb)
 RETURNS workflow_handler_response
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_task_id_text TEXT := COALESCE(
      p_operation_result->>'manual_review_task_id',
      p_step.operation_result->>'manual_review_task_id',
      v_ctx->>'manual_review_task_id'
    );
    v_task_id UUID;
    v_poll_seconds INT := COALESCE(NULLIF(p_step.metadata->>'poll_interval_seconds', '')::INT, 60);
    v_task public.manual_review_tasks%ROWTYPE;
    v_resp workflow_handler_response;
BEGIN
    IF v_task_id_text IS NOT NULL AND btrim(v_task_id_text) <> '' THEN
        v_task_id := v_task_id_text::UUID;
    END IF;
    IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'manual_review_wait: manual_review_task_id missing (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
    END IF;

    SELECT * INTO v_task FROM public.manual_review_tasks mrt WHERE mrt.id = v_task_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'manual_review_wait: manual_review_task_id % not found', v_task_id;
    END IF;

    IF v_task.metadata ? 'workflow_run_id'
       AND NULLIF(v_task.metadata->>'workflow_run_id', '')::UUID IS DISTINCT FROM p_run.id THEN
        RAISE EXCEPTION 'manual_review_wait: task % does not belong to workflow_run_id=%', v_task_id, p_run.id;
    END IF;

    IF v_poll_seconds < 0 THEN
      v_poll_seconds := 60;
    END IF;

    IF v_task.status <> 'resolved' THEN
        v_resp.status := 'pending';
        v_resp.next_run_at := now() + make_interval(secs => v_poll_seconds);
        v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id);
        RETURN v_resp;
    END IF;

    IF v_task.resolution_outcome IS NULL OR v_task.resolution_outcome NOT IN ('approved', 'rejected') THEN
        v_resp.status := 'failed';
        v_resp.last_error := 'manual_review_wait: resolved without supported resolution_outcome';
        v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'manual_review_task_id', v_task_id,
          'resolution_outcome', v_task.resolution_outcome,
          'resolution_notes', v_task.resolution_notes
        ));
        RETURN v_resp;
    END IF;

    IF v_task.resolution_outcome = 'rejected'
       AND NOT COALESCE(p_step.metadata @> '{"complete_on_rejected":true}'::jsonb, false) THEN
        v_resp.status := 'failed';
        v_resp.last_error := COALESCE(v_task.resolution_notes, 'manual_review rejected');
        v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'manual_review_task_id', v_task_id,
          'resolution_outcome', v_task.resolution_outcome,
          'resolution_notes', v_task.resolution_notes,
          'resolved_by', v_task.resolved_by,
          'resolved_at', v_task.resolved_at
        ));
        RETURN v_resp;
    END IF;

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'manual_review_task_id', v_task_id,
      'resolution_outcome', v_task.resolution_outcome,
      'resolution_notes', v_task.resolution_notes,
      'resolved_by', v_task.resolved_by,
      'resolved_at', v_task.resolved_at
    ));
    v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'manual_review', jsonb_build_object(
        'task_id', v_task_id,
        'outcome', v_task.resolution_outcome,
        'resolved_by', v_task.resolved_by,
        'resolved_at', v_task.resolved_at,
        'resolution_notes', v_task.resolution_notes
      )
    ));
    RETURN v_resp;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_zone_override_apply_v1(p_step workflow_run_steps, p_run workflow_runs, p_operation_result jsonb DEFAULT '{}'::jsonb)
 RETURNS workflow_handler_response
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := CASE
    WHEN jsonb_typeof(v_ctx->'payload') = 'object' THEN COALESCE(v_ctx->'payload', '{}'::jsonb)
    ELSE '{}'::jsonb
  END;
  v_request_id UUID := COALESCE(
    NULLIF(p_operation_result->>'zone_override_request_id', '')::UUID,
    NULLIF(v_ctx->>'zone_override_request_id', '')::UUID,
    CASE
      WHEN COALESCE(v_ctx->>'resource_type', '') = 'zone_override_request'
        THEN NULLIF(v_ctx->>'resource_id', '')::UUID
      ELSE NULL
    END,
    CASE
      WHEN COALESCE(v_payload->>'resource_type', '') = 'zone_override_request'
        THEN NULLIF(v_payload->>'resource_id', '')::UUID
      ELSE NULL
    END
  );
  v_request public.zone_override_requests%ROWTYPE;
  v_existing_exception RECORD;
  v_resolved RECORD;
  v_resolved_basket_id UUID := NULL;
  v_resolved_basket_item_id UUID := NULL;
  v_now TIMESTAMPTZ := now();
  v_resp workflow_handler_response;
BEGIN
  IF v_request_id IS NULL THEN
    RAISE EXCEPTION 'execute_zone_override_apply_v1 requires zone_override_request_id';
  END IF;

  SELECT *
    INTO v_request
    FROM public.zone_override_requests zor
   WHERE zor.id = v_request_id
   LIMIT 1
   FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'execute_zone_override_apply_v1 request % not found', v_request_id
      USING ERRCODE = '23503';
  END IF;

  IF v_request.workflow_run_id IS DISTINCT FROM p_run.id THEN
    RAISE EXCEPTION 'zone override request does not belong to this workflow run' USING ERRCODE = '42501';
  END IF;

  IF v_request.resolution_outcome = 'rejected' AND v_request.status = 'rejected' THEN
    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object(
      'zone_override_request_id', v_request.id,
      'resolution_outcome', 'rejected',
      'applied', false
    );
    RETURN v_resp;
  END IF;

  IF v_request.resolution_outcome IS DISTINCT FROM 'approved'
     OR v_request.status NOT IN ('approved', 'applied') THEN
    RAISE EXCEPTION 'execute_zone_override_apply_v1 requires approved manual review for request %', v_request_id;
  END IF;

  UPDATE public.shipments
     SET zone_id = v_request.requested_zone_id,
         updated_at = v_now
   WHERE id = v_request.shipment_id
     AND client_id = v_request.shipment_client_id;

  PERFORM public.sync_shipment_mis_sort_exceptions_v1(v_request.shipment_id, v_request.shipment_client_id);

  SELECT *
    INTO v_existing_exception
    FROM public.mis_sort_exceptions mse
   WHERE mse.shipment_id = v_request.shipment_id
     AND mse.shipment_client_id = v_request.shipment_client_id
   ORDER BY mse.detected_at DESC, mse.updated_at DESC, mse.id DESC
   LIMIT 1;

  IF FOUND AND v_existing_exception.id IS NOT NULL THEN
    SELECT *
      INTO v_resolved
      FROM public.resolve_mis_sort_exception_v1(v_existing_exception.id, '{}'::jsonb)
     LIMIT 1;
    v_resolved_basket_id := v_resolved.basket_id;
    v_resolved_basket_item_id := v_resolved.basket_item_id;
  END IF;

  PERFORM public.sync_shipment_mis_sort_exceptions_v1(v_request.shipment_id, v_request.shipment_client_id);

  UPDATE public.zone_override_requests
     SET status = 'applied',
         applied_at = v_now,
         updated_at = v_now,
         metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'applied_basket_id', v_resolved_basket_id,
           'applied_basket_item_id', v_resolved_basket_item_id
         ))
   WHERE id = v_request.id;

  INSERT INTO public.shipment_actions (
    id,
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    action_data,
    timestamp,
    created_at,
    performed_by_system
  )
  VALUES (
    gen_random_uuid(),
    v_request.shipment_id,
    v_request.organization_id,
    v_request.shipment_client_id,
    'zone_override_applied',
    'operational',
    jsonb_strip_nulls(jsonb_build_object(
      'zone_override_request_id', v_request.id,
      'source_exception_id', v_request.source_exception_id,
      'current_zone_id', v_request.current_zone_id,
      'expected_zone_id', v_request.expected_zone_id,
      'requested_zone_id', v_request.requested_zone_id,
      'basket_id', v_resolved_basket_id,
      'basket_item_id', v_resolved_basket_item_id
    )),
    v_now,
    v_now,
    'workflow_engine'
  );

  PERFORM public.log_decision(
    p_organization_id := v_request.organization_id,
    p_decision_category := 'zone_override',
    p_resource_type := 'zone_override_request',
    p_resource_id := v_request.id,
    p_decision_point := 'apply',
    p_decision_outcome := 'applied',
    p_performed_by_system := 'workflow_engine',
    p_correlation_id := p_run.id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_request.shipment_id,
      'source_exception_id', v_request.source_exception_id,
      'requested_zone_id', v_request.requested_zone_id,
      'resolution_outcome', v_request.resolution_outcome
    )),
    p_decision_reason := v_request.request_reason
  );

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'zone_override_request_id', v_request.id,
    'shipment_id', v_request.shipment_id,
    'requested_zone_id', v_request.requested_zone_id,
    'basket_id', v_resolved_basket_id,
    'basket_item_id', v_resolved_basket_item_id,
    'status', 'applied'
  ));
  v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'zone_override_request_id', v_request.id,
    'zone_override', jsonb_build_object(
      'status', 'applied',
      'requested_zone_id', v_request.requested_zone_id,
      'applied_at', v_now
    )
  ));
  RETURN v_resp;
EXCEPTION
  WHEN OTHERS THEN
    IF v_request_id IS NOT NULL THEN
      UPDATE public.zone_override_requests
         SET status = CASE
               WHEN status = 'applied' THEN status
               ELSE 'failed'
             END,
             updated_at = now(),
             metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'apply_error', SQLERRM
             ))
       WHERE id = v_request_id;
    END IF;
    RAISE;
END;
$function$;

-- Rejection is a completed no-op only for the canonical zone override flow.
UPDATE public.workflow_template_steps AS step
SET metadata = COALESCE(step.metadata, '{}'::jsonb) || '{"complete_on_rejected":true}'::jsonb
FROM public.workflow_templates AS template
WHERE step.workflow_template_id = template.id
  AND template.name = 'zone_override_approval_v1'
  AND template.status = 'active'
  AND template.scope_type = 'global'
  AND template.scope_id IS NULL
  AND step.handler_key = 'manual_review_wait';

COMMIT;
