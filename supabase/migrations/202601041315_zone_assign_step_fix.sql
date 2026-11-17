-- Migration: Ensure zone_assign step is wired into workflow_geocoding_standard
-- Purpose:
--   - Insert zone_assign before basket_assign/finalize_outcome when missing.
--   - Keep workflow step wiring row-driven and idempotent.
-- Date: 2026-01-04

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_template_id UUID;
  v_insert_at INT;
  v_zone_step_id UUID := '99990000-0000-0000-0000-000000410020'::uuid;
  v_has_zone BOOLEAN := FALSE;
BEGIN
  SELECT id
  INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'workflow_geocoding_standard'
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'workflow_geocoding_standard not found; skipping zone_assign insert';
    RETURN;
  END IF;

  SELECT TRUE
  INTO v_has_zone
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'zone_assign'
  LIMIT 1;

  IF v_has_zone THEN
    UPDATE public.workflow_template_steps
    SET handler_key = 'zone_assign',
        handler_version = 'v1',
        operation_settings_category = COALESCE(operation_settings_category, 'routing'),
        transition_condition = 'always',
        metadata = jsonb_build_object('decision_log_event', 'routing.zone_assign'),
        manual_action_required = FALSE,
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'zone_assign';

    PERFORM public.workflow_refresh_steps_checksum(v_template_id);
    RETURN;
  END IF;

  SELECT sequence_order
  INTO v_insert_at
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'basket_assign'
  ORDER BY sequence_order
  LIMIT 1;

  IF v_insert_at IS NULL THEN
    SELECT sequence_order
    INTO v_insert_at
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'finalize_outcome'
    ORDER BY sequence_order
    LIMIT 1;
  END IF;

  IF v_insert_at IS NULL THEN
    SELECT COALESCE(MAX(sequence_order), 0) + 1
    INTO v_insert_at
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id;
  END IF;

  UPDATE public.workflow_template_steps
  SET sequence_order = sequence_order + 1
  WHERE workflow_template_id = v_template_id
    AND sequence_order >= v_insert_at;

  IF EXISTS (
    SELECT 1
    FROM public.workflow_template_steps
    WHERE id = v_zone_step_id
  ) THEN
    v_zone_step_id := gen_random_uuid();
  END IF;

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
  );

  PERFORM public.workflow_refresh_steps_checksum(v_template_id);
END
$$;

COMMIT;
