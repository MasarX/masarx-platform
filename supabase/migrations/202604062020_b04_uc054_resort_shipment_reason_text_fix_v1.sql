-- Plan: B04 UC054 re-sort shipments after address or route changes / Step: E01
-- Fixup: keep resort_shipment_v1 result shaping text-safe for workflow error fields
-- Date: 2026-04-06

BEGIN;
SELECT pg_advisory_lock(hashtext('202604062020_b04_uc054_resort_shipment_reason_text_fix_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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

SELECT pg_advisory_unlock(hashtext('202604062020_b04_uc054_resort_shipment_reason_text_fix_v1'));
COMMIT;
