-- Migration: Add post-dispatch wait + routing steps to Logestechs geocode-first workflow
-- Purpose:
--   - Wait for shipment creation before zone/basket assignment in geocode-first flow.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-11

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

DO $do$
DECLARE
  v_template_id UUID;
  v_wait_step_id UUID := '99990000-0000-0000-0000-000000790105'::uuid;
  v_zone_step_id UUID := '99990000-0000-0000-0000-000000790106'::uuid;
  v_basket_step_id UUID := '99990000-0000-0000-0000-000000790107'::uuid;
BEGIN
  SELECT id
  INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'api_gateway_logestechs_v2_create_geocode_first_v1'
    AND status = 'active'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'workflow template api_gateway_logestechs_v2_create_geocode_first_v1 not found (active); skipping post-dispatch steps';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'wait_for_shipment'
  ) THEN
    INSERT INTO public.workflow_template_steps (
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
      enabled
    )
    VALUES (
      v_wait_step_id,
      v_template_id,
      5,
      'wait_for_shipment',
      'workflow',
      'always',
      'wait_for_shipment',
      'v1',
      jsonb_build_object(
        'poll_interval_seconds', 5,
        'max_wait_seconds', 600,
        'decision_log_event', 'routing.wait_for_shipment'
      ),
      FALSE,
      TRUE
    );
  ELSE
    UPDATE public.workflow_template_steps
    SET sequence_order = 5,
        operation_settings_category = 'workflow',
        transition_condition = 'always',
        handler_key = 'wait_for_shipment',
        handler_version = 'v1',
        metadata = jsonb_build_object(
          'poll_interval_seconds', 5,
          'max_wait_seconds', 600,
          'decision_log_event', 'routing.wait_for_shipment'
        ),
        manual_action_required = FALSE,
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'wait_for_shipment';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'zone_assign'
  ) THEN
    INSERT INTO public.workflow_template_steps (
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
      enabled
    )
    VALUES (
      v_zone_step_id,
      v_template_id,
      6,
      'zone_assign',
      'routing',
      'always',
      'zone_assign',
      'v1',
      jsonb_build_object('decision_log_event', 'routing.zone_assign'),
      FALSE,
      TRUE
    );
  ELSE
    UPDATE public.workflow_template_steps
    SET sequence_order = 6,
        operation_settings_category = 'routing',
        transition_condition = 'always',
        handler_key = 'zone_assign',
        handler_version = 'v1',
        metadata = jsonb_build_object('decision_log_event', 'routing.zone_assign'),
        manual_action_required = FALSE,
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'zone_assign';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'basket_assign'
  ) THEN
    INSERT INTO public.workflow_template_steps (
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
      enabled
    )
    VALUES (
      v_basket_step_id,
      v_template_id,
      7,
      'basket_assign',
      'routing',
      'always',
      'basket_assign',
      'v1',
      jsonb_build_object('decision_log_event', 'routing.basket_assign'),
      FALSE,
      TRUE
    );
  ELSE
    UPDATE public.workflow_template_steps
    SET sequence_order = 7,
        operation_settings_category = 'routing',
        transition_condition = 'always',
        handler_key = 'basket_assign',
        handler_version = 'v1',
        metadata = jsonb_build_object('decision_log_event', 'routing.basket_assign'),
        manual_action_required = FALSE,
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'basket_assign';
  END IF;

  PERFORM public.workflow_refresh_steps_checksum(v_template_id);
END;
$do$;

COMMIT;
