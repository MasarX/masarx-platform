-- Plan: B04 UC054 re-sort shipments after address or route changes / Step: E01
-- Migration: shipment-level re-sort workflow + dedicated UI/API contract
-- Date: 2026-04-06
--
-- Purpose:
--   - Add a truthful shipment-level re-sort mutation for address/route-change follow-up.
--   - Reuse the canonical basket-policy + mis-sort substrate rather than app-side basket rewrites.
--   - Keep Console/Portal execution browser-safe through dedicated public/api RPCs and row-driven command wiring.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061930_b04_uc054_shipment_resort_after_route_change_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

-------------------------------------------------------------------------------
-- 1) Workflow-backed shipment re-sort mutation
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_resort_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_target RECORD;
  v_profile RECORD;
  v_current RECORD;
  v_exception RECORD;
  v_resolved RECORD;
  v_assign_response public.workflow_handler_response;
  v_response public.workflow_handler_response;
  v_now TIMESTAMPTZ := now();
  v_mismatch BOOLEAN := FALSE;
  v_previous_basket_id UUID := NULL;
  v_previous_basket_item_id UUID := NULL;
  v_decision_inputs JSONB := '{}'::jsonb;
BEGIN
  SELECT *
    INTO v_target
    FROM workflow_handlers.resolve_shipment_target_v1(v_ctx)
   LIMIT 1;

  IF v_target.shipment_id IS NULL OR v_target.client_id IS NULL THEN
    v_response.status := 'failed';
    v_response.last_error := 'shipment_not_found';
    v_response.operation_result := jsonb_build_object('status', 'blocked', 'reason', 'shipment_not_found');
    RETURN v_response;
  END IF;

  SELECT *
    INTO v_profile
    FROM public.resolve_shipment_basket_profile_v1(v_target.shipment_id, v_target.client_id)
   LIMIT 1;

  SELECT
    bi.id AS basket_item_id,
    bi.basket_id,
    b.zone_id,
    b.sort_branch_id,
    b.sort_service_key,
    b.sort_route_key,
    b.sort_priority_key
  INTO v_current
  FROM public.basket_items bi
  JOIN public.baskets b ON b.id = bi.basket_id
  WHERE bi.shipment_id = v_target.shipment_id
    AND bi.shipment_client_id = v_target.client_id
    AND bi.removed_at IS NULL
  ORDER BY bi.added_at DESC, bi.id DESC
  LIMIT 1
  FOR UPDATE OF bi;

  v_previous_basket_id := v_current.basket_id;
  v_previous_basket_item_id := v_current.basket_item_id;

  v_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'client_id', v_target.client_id,
    'previous_basket_id', v_previous_basket_id,
    'previous_basket_item_id', v_previous_basket_item_id,
    'expected_zone_id', v_profile.zone_id,
    'expected_sort_branch_id', v_profile.sort_branch_id,
    'expected_sort_service_key', v_profile.sort_service_key,
    'expected_sort_route_key', v_profile.sort_route_key,
    'expected_sort_priority_key', v_profile.sort_priority_key
  ));

  IF v_profile.reason IS NOT NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_target.organization_id,
      p_decision_category := 'settings_resolution',
      p_resource_type := 'shipment',
      p_resource_id := v_target.shipment_id,
      p_decision_point := 'shipment_resort',
      p_decision_outcome := 'blocked',
      p_performed_by_system := 'workflow_engine',
      p_correlation_id := p_run.id,
      p_decision_inputs := v_decision_inputs,
      p_decision_reason := v_profile.reason
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'status', 'blocked',
      'shipment_id', v_target.shipment_id,
      'previous_basket_id', v_previous_basket_id,
      'previous_basket_item_id', v_previous_basket_item_id,
      'reason', v_profile.reason
    ));
    RETURN v_response;
  END IF;

  IF v_current.basket_item_id IS NOT NULL THEN
    v_mismatch :=
      v_current.zone_id IS DISTINCT FROM v_profile.zone_id
      OR v_current.sort_branch_id IS DISTINCT FROM v_profile.sort_branch_id
      OR v_current.sort_service_key IS DISTINCT FROM v_profile.sort_service_key
      OR v_current.sort_route_key IS DISTINCT FROM v_profile.sort_route_key
      OR v_current.sort_priority_key IS DISTINCT FROM v_profile.sort_priority_key;

    IF NOT v_mismatch THEN
      PERFORM public.log_decision(
        p_organization_id := v_target.organization_id,
        p_decision_category := 'settings_resolution',
        p_resource_type := 'shipment',
        p_resource_id := v_target.shipment_id,
        p_decision_point := 'shipment_resort',
        p_decision_outcome := 'already_sorted',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := p_run.id,
        p_decision_inputs := v_decision_inputs,
        p_decision_reason := 'already_sorted'
      );

      v_response.status := 'completed';
      v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'already_sorted',
        'shipment_id', v_target.shipment_id,
        'basket_id', v_current.basket_id,
        'basket_item_id', v_current.basket_item_id,
        'reason', 'already_sorted'
      ));
      RETURN v_response;
    END IF;

    PERFORM public.sync_shipment_mis_sort_exceptions_v1(v_target.shipment_id, v_target.client_id);

    SELECT *
      INTO v_exception
      FROM public.mis_sort_exceptions mse
     WHERE mse.shipment_id = v_target.shipment_id
       AND mse.shipment_client_id = v_target.client_id
     ORDER BY mse.detected_at DESC, mse.updated_at DESC, mse.id DESC
     LIMIT 1;

    IF v_exception.id IS NOT NULL THEN
      SELECT *
        INTO v_resolved
        FROM public.resolve_mis_sort_exception_v1(v_exception.id, '{}'::jsonb)
       LIMIT 1;

      PERFORM public.log_decision(
        p_organization_id := v_target.organization_id,
        p_decision_category := 'settings_resolution',
        p_resource_type := 'shipment',
        p_resource_id := v_target.shipment_id,
        p_decision_point := 'shipment_resort',
        p_decision_outcome := 'resorted',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := p_run.id,
        p_decision_inputs := v_decision_inputs || jsonb_strip_nulls(jsonb_build_object(
          'basket_id', v_resolved.basket_id,
          'basket_item_id', v_resolved.basket_item_id
        )),
        p_decision_reason := COALESCE(v_exception.exception_reason, 'basket_assignment_mismatch')
      );

      v_response.status := 'completed';
      v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'resorted',
        'shipment_id', v_target.shipment_id,
        'previous_basket_id', v_resolved.previous_basket_id,
        'basket_id', v_resolved.basket_id,
        'basket_item_id', v_resolved.basket_item_id,
        'reason', COALESCE(v_exception.exception_reason, 'basket_assignment_mismatch')
      ));
      v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
        'basket', jsonb_build_object(
          'basket_id', v_resolved.basket_id
        )
      ));
      RETURN v_response;
    END IF;

    UPDATE public.basket_items
       SET removed_at = COALESCE(removed_at, v_now)
     WHERE id = v_current.basket_item_id
       AND removed_at IS NULL;
  END IF;

  v_assign_response := workflow_handlers.execute_basket_assign_v1(
    p_step,
    p_run,
    p_operation_result
  );

  IF COALESCE((v_assign_response.operation_result->>'assigned')::BOOLEAN, FALSE) IS TRUE THEN
    PERFORM public.log_decision(
      p_organization_id := v_target.organization_id,
      p_decision_category := 'settings_resolution',
      p_resource_type := 'shipment',
      p_resource_id := v_target.shipment_id,
      p_decision_point := 'shipment_resort',
      p_decision_outcome := CASE
        WHEN COALESCE(v_assign_response.operation_result->>'reason', '') = 'already_assigned'
          THEN 'already_sorted'
        ELSE 'resorted'
      END,
      p_performed_by_system := 'workflow_engine',
      p_correlation_id := p_run.id,
      p_decision_inputs := v_decision_inputs || jsonb_strip_nulls(jsonb_build_object(
        'basket_id', v_assign_response.operation_result->>'basket_id',
        'settings_resolution_id', v_assign_response.operation_result->>'settings_resolution_id'
      )),
      p_decision_reason := COALESCE(v_assign_response.operation_result->>'reason', 'assigned')
    );

    v_assign_response.operation_result := jsonb_strip_nulls(
      COALESCE(v_assign_response.operation_result, '{}'::jsonb)
      || jsonb_build_object(
        'status',
        CASE
          WHEN COALESCE(v_assign_response.operation_result->>'reason', '') = 'already_assigned'
            THEN 'already_sorted'
          ELSE 'resorted'
        END,
        'shipment_id', v_target.shipment_id,
        'previous_basket_id', v_previous_basket_id,
        'previous_basket_item_id', v_previous_basket_item_id
      )
    );
    RETURN v_assign_response;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_target.organization_id,
    p_decision_category := 'settings_resolution',
    p_resource_type := 'shipment',
    p_resource_id := v_target.shipment_id,
    p_decision_point := 'shipment_resort',
    p_decision_outcome := 'blocked',
    p_performed_by_system := 'workflow_engine',
    p_correlation_id := p_run.id,
    p_decision_inputs := v_decision_inputs || COALESCE(v_assign_response.operation_result, '{}'::jsonb),
    p_decision_reason := COALESCE(v_assign_response.operation_result->>'reason', 'basket_assignment_failed')
  );

  v_assign_response.operation_result := jsonb_strip_nulls(
    COALESCE(v_assign_response.operation_result, '{}'::jsonb)
    || jsonb_build_object(
      'status', 'blocked',
      'shipment_id', v_target.shipment_id,
      'previous_basket_id', v_previous_basket_id,
      'previous_basket_item_id', v_previous_basket_item_id
    )
  );
  RETURN v_assign_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_resort_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Workflow-backed shipment re-sort mutation that reuses basket-policy assignment and mis-sort resolution after address/route changes.';

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'shipment_resort',
  'workflow_handlers',
  'execute_shipment_resort_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Re-sort one shipment through canonical basket-policy / mis-sort resolution after address or route changes.',
  'docs/ops/runbooks/branches_coverage_capacity_runbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

INSERT INTO public.workflow_templates AS wt (
  id,
  name,
  description,
  version,
  status,
  scope_type,
  scope_id,
  created_at,
  updated_at,
  published_at,
  notes,
  metadata
)
VALUES (
  'c4a8f9a9-95de-4fa2-97c2-27b1f77b5400',
  'shipment_resort_v1',
  'Workflow-backed shipment re-sort closeout for corrected address or route metadata.',
  1,
  'active',
  'global',
  NULL,
  now(),
  now(),
  now(),
  'Seeded for B04 UC054 shipment resort command.',
  jsonb_build_object(
    'source', 'b04_uc054',
    'resource', 'shipments'
  )
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  version = EXCLUDED.version,
  status = EXCLUDED.status,
  scope_type = EXCLUDED.scope_type,
  scope_id = EXCLUDED.scope_id,
  updated_at = now(),
  published_at = EXCLUDED.published_at,
  notes = EXCLUDED.notes,
  metadata = EXCLUDED.metadata;

INSERT INTO public.workflow_template_steps AS wts (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  operation_settings_category,
  transition_condition,
  handler_key,
  handler_version,
  metadata,
  manual_action_required,
  enabled,
  created_at,
  updated_at
)
VALUES (
  'c4a8f9a9-95de-4fa2-97c2-27b1f77b5401',
  'c4a8f9a9-95de-4fa2-97c2-27b1f77b5400',
  10,
  'shipment_resort',
  'workflow',
  'always',
  'shipment_resort',
  'v1',
  jsonb_build_object('decision_log_event', 'routing.shipment_resort'),
  FALSE,
  TRUE,
  now(),
  now()
)
ON CONFLICT (id) DO UPDATE
SET
  workflow_template_id = EXCLUDED.workflow_template_id,
  sequence_order = EXCLUDED.sequence_order,
  operation_name = EXCLUDED.operation_name,
  operation_settings_category = EXCLUDED.operation_settings_category,
  transition_condition = EXCLUDED.transition_condition,
  handler_key = EXCLUDED.handler_key,
  handler_version = EXCLUDED.handler_version,
  metadata = EXCLUDED.metadata,
  manual_action_required = EXCLUDED.manual_action_required,
  enabled = EXCLUDED.enabled,
  updated_at = now();

WITH recalculated AS (
  SELECT
    wts.workflow_template_id,
    md5(
      string_agg(
        concat_ws(
          '|',
          wts.sequence_order,
          COALESCE(wts.operation_name, ''),
          COALESCE(wts.operation_settings_category, ''),
          COALESCE(wts.transition_condition, ''),
          COALESCE(wts.handler_key, ''),
          COALESCE(wts.handler_version, ''),
          COALESCE(wts.metadata::TEXT, '')
        ),
        '||' ORDER BY wts.sequence_order
      )
    ) AS checksum
  FROM public.workflow_template_steps wts
  WHERE wts.workflow_template_id = 'c4a8f9a9-95de-4fa2-97c2-27b1f77b5400'::UUID
  GROUP BY wts.workflow_template_id
)
UPDATE public.workflow_templates wt
   SET steps_checksum = recalculated.checksum,
       updated_at = now()
  FROM recalculated
 WHERE wt.id = recalculated.workflow_template_id;

CREATE OR REPLACE FUNCTION public.resort_shipment_v1(
  p_input JSONB
)
RETURNS TABLE (
  shipment_id UUID,
  status TEXT,
  workflow_run_id UUID,
  previous_basket_id UUID,
  basket_id UUID,
  basket_item_id UUID,
  reason TEXT,
  settings_resolution_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID := NULL;
  v_client_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'shipment_resort');
  v_template_name TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'workflow_template_name', '')), ''), 'shipment_resort_v1');
  v_template_id UUID := NULL;
  v_shipment RECORD;
  v_run_id UUID := NULL;
  v_progress JSONB := '{}'::jsonb;
  v_workflow_status TEXT := NULL;
  v_step_status TEXT := NULL;
  v_inline_attempts INT := 0;
  v_inline_max_attempts INT := 6;
  v_inline_next_run_at TIMESTAMPTZ := NULL;
  v_inline_explicit_input JSONB := '{}'::jsonb;
  v_preflight_profile RECORD;
  v_preflight_current RECORD;
  v_step RECORD;
BEGIN
  BEGIN
    v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  BEGIN
    v_client_id := NULLIF(v_input->>'client_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_client_id := NULL;
  END;

  BEGIN
    v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_actor_user_id := NULL;
  END;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'resort_shipment_v1 requires shipment_id';
  END IF;

  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.sender_id
  INTO v_shipment
  FROM public.shipments s
  WHERE s.id = v_shipment_id
    AND (v_client_id IS NULL OR s.client_id = v_client_id)
  LIMIT 1
  FOR UPDATE;

  IF v_shipment.id IS NULL THEN
    RAISE EXCEPTION 'resort_shipment_v1 shipment % not found', v_shipment_id
      USING ERRCODE = '23503';
  END IF;

  SELECT *
    INTO v_preflight_profile
    FROM public.resolve_shipment_basket_profile_v1(v_shipment.id, v_shipment.client_id)
   LIMIT 1;

  SELECT
    bi.id AS basket_item_id,
    bi.basket_id,
    b.zone_id,
    b.sort_branch_id,
    b.sort_service_key,
    b.sort_route_key,
    b.sort_priority_key
  INTO v_preflight_current
  FROM public.basket_items bi
  JOIN public.baskets b ON b.id = bi.basket_id
  WHERE bi.shipment_id = v_shipment.id
    AND bi.shipment_client_id = v_shipment.client_id
    AND bi.removed_at IS NULL
  ORDER BY bi.added_at DESC, bi.id DESC
  LIMIT 1;

  IF v_preflight_profile.reason IS NULL
     AND v_preflight_current.basket_item_id IS NOT NULL
     AND v_preflight_current.zone_id IS NOT DISTINCT FROM v_preflight_profile.zone_id
     AND v_preflight_current.sort_branch_id IS NOT DISTINCT FROM v_preflight_profile.sort_branch_id
     AND v_preflight_current.sort_service_key IS NOT DISTINCT FROM v_preflight_profile.sort_service_key
     AND v_preflight_current.sort_route_key IS NOT DISTINCT FROM v_preflight_profile.sort_route_key
     AND v_preflight_current.sort_priority_key IS NOT DISTINCT FROM v_preflight_profile.sort_priority_key THEN
    shipment_id := v_shipment.id;
    status := 'already_sorted';
    workflow_run_id := NULL;
    previous_basket_id := v_preflight_current.basket_id;
    basket_id := v_preflight_current.basket_id;
    basket_item_id := v_preflight_current.basket_item_id;
    reason := 'already_sorted';
    settings_resolution_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT wt.id
    INTO v_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = v_template_name
     AND wt.status = 'active'
   ORDER BY wt.version DESC, wt.updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'resort_shipment_v1 workflow template not found %', v_template_name
      USING ERRCODE = '23503';
  END IF;

  v_run_id := public.start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_shipment.organization_id,
        'client_id', v_shipment.client_id,
        'sender_id', v_shipment.sender_id,
        'shipment_id', v_shipment.id,
        'actor_user_id', v_actor_user_id,
        'actor_system', v_actor_system,
        'payload', v_input
      )
    )
  );

  v_inline_explicit_input := jsonb_strip_nulls(
    jsonb_build_object(
      'shipment_id', v_shipment.id,
      'client_id', v_shipment.client_id,
      'actor_user_id', v_actor_user_id,
      'actor_system', v_actor_system
    )
  );

  WHILE v_inline_attempts < v_inline_max_attempts LOOP
    IF v_inline_attempts = 0 THEN
      v_progress := public.progress_workflow_run(v_run_id, v_inline_explicit_input);
    ELSE
      v_progress := public.progress_workflow_run(v_run_id);
    END IF;

    v_inline_attempts := v_inline_attempts + 1;
    v_step_status := lower(NULLIF(v_progress->>'status', ''));

    BEGIN
      v_inline_next_run_at := NULLIF(v_progress->>'next_run_at', '')::TIMESTAMPTZ;
    EXCEPTION
      WHEN others THEN
        v_inline_next_run_at := NULL;
    END;

    SELECT wr.workflow_status
      INTO v_workflow_status
      FROM public.workflow_runs wr
     WHERE wr.id = v_run_id;

    EXIT WHEN v_workflow_status IN ('completed', 'failed', 'cancelled', 'blocked', 'waiting');
    EXIT WHEN v_step_status IN ('failed', 'cancelled', 'blocked', 'waiting');
    EXIT WHEN v_inline_next_run_at IS NOT NULL AND v_inline_next_run_at > now();
  END LOOP;

  SELECT
    wr.workflow_status,
    wr.last_error,
    wts.operation_result,
    wts.last_error AS step_last_error
  INTO v_step
  FROM public.workflow_runs wr
  LEFT JOIN public.workflow_run_steps wts
    ON wts.workflow_run_id = wr.id
  WHERE wr.id = v_run_id
  ORDER BY wts.sequence_order DESC NULLS LAST
  LIMIT 1;

  shipment_id := v_shipment.id;
  status := COALESCE(v_step.operation_result->>'status', v_step.workflow_status, v_progress->>'status', 'workflow_started');
  workflow_run_id := v_run_id;

  BEGIN
    previous_basket_id := NULLIF(v_step.operation_result->>'previous_basket_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      previous_basket_id := NULL;
  END;

  BEGIN
    basket_id := NULLIF(v_step.operation_result->>'basket_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      basket_id := NULL;
  END;

  BEGIN
    basket_item_id := NULLIF(v_step.operation_result->>'basket_item_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      basket_item_id := NULL;
  END;

  reason := COALESCE(
    NULLIF(v_step.operation_result->>'reason', ''),
    NULLIF(v_step.step_last_error::TEXT, ''),
    NULLIF(v_step.last_error::TEXT, '')
  );

  BEGIN
    settings_resolution_id := NULLIF(v_step.operation_result->>'settings_resolution_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      settings_resolution_id := NULL;
  END;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.resort_shipment_v1(JSONB) IS
  'Start and progress the canonical shipment_resort_v1 workflow for one shipment, returning the inline mutation result.';

REVOKE ALL ON FUNCTION public.resort_shipment_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resort_shipment_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.resort_shipment_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resort_shipment_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 2) Browser-safe UI/API wrappers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_resort_shipment_v1(
  p_input JSONB
)
RETURNS TABLE (
  shipment_id UUID,
  status TEXT,
  workflow_run_id UUID,
  previous_basket_id UUID,
  basket_id UUID,
  basket_item_id UUID,
  reason TEXT,
  settings_resolution_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID := NULL;
  v_visible RECORD;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ui_resort_shipment_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'ui_resort_shipment_v1 requires shipment_id';
  END IF;

  SELECT *
    INTO v_visible
    FROM public.ui_shipment_mutation_access_v1(v_shipment_id)
   LIMIT 1;

  RETURN QUERY
  SELECT *
  FROM public.resort_shipment_v1(
    jsonb_strip_nulls(
      (v_input - 'organization_id' - 'client_id' - 'actor_user_id' - 'actor_system')
      || jsonb_build_object(
        'shipment_id', v_visible.shipment_id,
        'client_id', v_visible.client_id,
        'actor_user_id', auth.uid(),
        'actor_system', 'shipment_resort_ui'
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_resort_shipment_v1(JSONB) IS
  'Authenticated UI write-path for shipment re-sort after address or route changes with server-derived actor context.';

REVOKE ALL ON FUNCTION public.ui_resort_shipment_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_resort_shipment_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_resort_shipment_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_resort_shipment_v1(
  p_input JSONB
)
RETURNS TABLE (
  shipment_id UUID,
  status TEXT,
  workflow_run_id UUID,
  previous_basket_id UUID,
  basket_id UUID,
  basket_item_id UUID,
  reason TEXT,
  settings_resolution_id UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.ui_resort_shipment_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_resort_shipment_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_resort_shipment_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_resort_shipment_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_execute_shipment_resort_v1(
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
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_execution JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_selection_id_text TEXT := NULL;
  v_selection_uuid UUID := NULL;
  v_visible_shipment JSONB := NULL;
  v_result RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_resort_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_shipment_resort_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_shipment_resort_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_resort_v1 unknown command %', p_action_key;
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
    RAISE EXCEPTION 'ui_execute_shipment_resort_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_shipment_resort_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);

  v_selection_id_text := COALESCE(
    NULLIF(v_id, ''),
    CASE WHEN array_length(v_ids, 1) IS NOT NULL THEN v_ids[1] ELSE NULL END
  );

  BEGIN
    v_selection_uuid := NULLIF(btrim(COALESCE(v_selection_id_text, '')), '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_selection_uuid := NULL;
  END;

  IF v_selection_uuid IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_resort_v1 invalid shipment id %', v_selection_id_text;
  END IF;

  v_visible_shipment := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
  IF v_visible_shipment IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_resort_v1 shipment % is not visible in resource %', v_selection_uuid, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_result
    FROM public.ui_resort_shipment_v1(
      jsonb_strip_nulls(
        COALESCE(v_params, '{}'::jsonb)
        || jsonb_build_object('shipment_id', v_selection_uuid)
      )
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', COALESCE(v_result.status, 'workflow_started'),
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', 1,
    'workflow_run_id', v_result.workflow_run_id,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'shipment_id', v_result.shipment_id,
          'status', v_result.status,
          'workflow_run_id', v_result.workflow_run_id,
          'previous_basket_id', v_result.previous_basket_id,
          'basket_id', v_result.basket_id,
          'basket_item_id', v_result.basket_item_id,
          'reason', v_result.reason,
          'settings_resolution_id', v_result.settings_resolution_id
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_shipment_resort_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Re-sort visible shipments from Console/Portal without widening ui_execute_command_v1.';

REVOKE ALL ON FUNCTION public.ui_execute_shipment_resort_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_shipment_resort_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_shipment_resort_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_shipment_resort_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_execute_shipment_resort_v1($1, $2, $3, $4, $5, $6);
$fn$;

REVOKE ALL ON FUNCTION api.ui_execute_shipment_resort_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_shipment_resort_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_shipment_resort_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 3) ui_command_registry: shipments.resort
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_canonical_commands JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['shipments.resort'],
    jsonb_build_object(
      'key', 'shipments.resort',
      'label', 'Re-sort shipment',
      'description', 'Re-run the selected shipment through canonical basket-policy sorting after address or route changes.',
      'capability', 'shipments.write',
      'schema_category', 'resource:shipments',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_shipment_resort_v1',
        'params', jsonb_build_object(
          'workflow_template_name', 'shipment_resort_v1'
        ),
        'confirm', jsonb_build_object(
          'title', 'Re-sort shipment?',
          'description', 'This moves the selected shipment back through the canonical basket-policy assignment using its latest address and routing metadata.',
          'confirm_label', 'Re-sort shipment',
          'cancel_label', 'Cancel',
          'tone', 'default'
        )
      )
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

    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS item(value)
    LOOP
      v_command_key := COALESCE(v_command->>'key', '');
      IF v_command_key = 'shipments.resort' THEN
        CONTINUE;
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->'shipments.resort');
    v_next := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose shipments.resort through ui_command_registry.',
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

SELECT pg_advisory_unlock(hashtext('202604061930_b04_uc054_shipment_resort_after_route_change_v1'));
COMMIT;
