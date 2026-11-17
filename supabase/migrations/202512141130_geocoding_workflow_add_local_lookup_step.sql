-- Migration: Add missing local_lookup step to workflow_geocoding_standard
-- Purpose: Restore the local-first step as a standalone workflow step (row-driven) without relying on conflicting legacy step IDs.
-- Alignment: Workflow-driven, plugin-first (perfect/fuzzy/long_line), no hardcoding in code paths.
-- Date: 2025-12-14

BEGIN;

DO $$
DECLARE
  v_template_id UUID;
  v_step_id UUID := '99990000-0000-0000-0000-000000410011'::uuid;
  v_has_local BOOLEAN := FALSE;
  v_has_slot BOOLEAN := FALSE;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'workflow_geocoding_standard'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'workflow_geocoding_standard not found; skipping local_lookup insert';
    RETURN;
  END IF;

  SELECT TRUE INTO v_has_local
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'local_lookup'
  LIMIT 1;

  IF v_has_local THEN
    -- Ensure handler_key is correct (idempotent repair).
    UPDATE public.workflow_template_steps
    SET handler_key = 'geo_local_lookup',
        handler_version = 'v1',
        operation_settings_category = 'geocoding',
        transition_condition = 'always',
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'local_lookup';
    RETURN;
  END IF;

  SELECT TRUE INTO v_has_slot
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND sequence_order = 4
  LIMIT 1;

  IF v_has_slot THEN
    UPDATE public.workflow_template_steps
    SET sequence_order = sequence_order + 1
    WHERE workflow_template_id = v_template_id
      AND sequence_order >= 4;
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
    v_step_id,
    v_template_id,
    4,
    'local_lookup',
    'geocoding',
    'always',
    'geo_local_lookup',
    'v1',
    jsonb_build_object('decision_log_event', 'geocoding.local_lookup'),
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

  WITH ordered_steps AS (
    SELECT
      sequence_order,
      jsonb_build_object(
        'sequence_order', sequence_order,
        'operation_name', operation_name,
        'handler_key', handler_key,
        'handler_version', handler_version,
        'metadata', COALESCE(metadata, '{}'::jsonb)
      ) AS payload
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id
    ORDER BY sequence_order
  ),
  hashed AS (
    SELECT md5(coalesce(jsonb_agg(payload ORDER BY sequence_order)::text, '')) AS checksum
    FROM ordered_steps
  )
  UPDATE public.workflow_templates wt
  SET steps_checksum = hashed.checksum,
      updated_at = now()
  FROM hashed
  WHERE wt.id = v_template_id;
END
$$;

COMMIT;

