-- Migration: Zones + Baskets workflow step insertion fixup (re-apply after migration version collisions)
-- Purpose:
--   - Repair workflow_geocoding_standard step insertion for zone_assign + basket_assign.
--   - Prior migration used SELECT INTO on boolean flags which can yield NULL and skip inserts.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

DO $$
DECLARE
  v_template_id UUID;
  v_insert_at INT;
  v_shift INT := 0;
  v_has_zone BOOLEAN := FALSE;
  v_has_basket BOOLEAN := FALSE;
  v_zone_step_id UUID := '99990000-0000-0000-0000-000000410020'::uuid;
  v_basket_step_id UUID := '99990000-0000-0000-0000-000000410021'::uuid;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'workflow_geocoding_standard'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'workflow_geocoding_standard not found; skipping zone/basket step insertion';
    RETURN;
  END IF;

  SELECT EXISTS(
    SELECT 1
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'zone_assign'
  )
  INTO v_has_zone;

  SELECT EXISTS(
    SELECT 1
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'basket_assign'
  )
  INTO v_has_basket;

  -- Idempotent repair: ensure handler metadata is correct when steps already exist.
  IF v_has_zone THEN
    UPDATE public.workflow_template_steps
    SET handler_key = 'zone_assign',
        handler_version = 'v1',
        operation_settings_category = COALESCE(operation_settings_category, 'routing'),
        transition_condition = COALESCE(transition_condition, 'always'),
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'zone_assign';
  END IF;

  IF v_has_basket THEN
    UPDATE public.workflow_template_steps
    SET handler_key = 'basket_assign',
        handler_version = 'v1',
        operation_settings_category = COALESCE(operation_settings_category, 'routing'),
        transition_condition = COALESCE(transition_condition, 'always'),
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'basket_assign';
  END IF;

  IF v_has_zone AND v_has_basket THEN
    PERFORM public.workflow_refresh_steps_checksum(v_template_id);
    RETURN;
  END IF;

  SELECT sequence_order
  INTO v_insert_at
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'finalize_outcome'
  ORDER BY sequence_order
  LIMIT 1;

  IF v_insert_at IS NULL THEN
    SELECT COALESCE(MAX(sequence_order), 0) + 1
    INTO v_insert_at
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id;
  END IF;

  v_shift := (CASE WHEN NOT v_has_zone THEN 1 ELSE 0 END)
           + (CASE WHEN NOT v_has_basket THEN 1 ELSE 0 END);

  IF v_shift > 0 THEN
    UPDATE public.workflow_template_steps
    SET sequence_order = sequence_order + v_shift
    WHERE workflow_template_id = v_template_id
      AND sequence_order >= v_insert_at;
  END IF;

  IF NOT v_has_zone THEN
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
      v_insert_at,
      'zone_assign',
      'routing',
      'always',
      'zone_assign',
      'v1',
      jsonb_build_object('decision_log_event', 'routing.zone_assign'),
      FALSE,
      TRUE
    )
    ON CONFLICT (id) DO UPDATE
    SET workflow_template_id = EXCLUDED.workflow_template_id,
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

    v_insert_at := v_insert_at + 1;
  END IF;

  IF NOT v_has_basket THEN
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
      v_insert_at,
      'basket_assign',
      'routing',
      'always',
      'basket_assign',
      'v1',
      jsonb_build_object('decision_log_event', 'routing.basket_assign'),
      FALSE,
      TRUE
    )
    ON CONFLICT (id) DO UPDATE
    SET workflow_template_id = EXCLUDED.workflow_template_id,
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
  END IF;

  PERFORM public.workflow_refresh_steps_checksum(v_template_id);
END
$$;

COMMIT;

