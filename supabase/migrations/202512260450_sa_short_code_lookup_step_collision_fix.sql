-- Migration: Repair short_code_lookup step insertion (avoid step-id collisions)
-- Purpose:
--   - Ensure workflow_geocoding_standard includes the short_code_lookup step before dispatch_provider.
--   - Avoid reliance on fixed workflow_template_steps IDs (prior migrations reused the same ID and caused collisions).
--   - Repair local_lookup metadata if it was accidentally overwritten by the collision.
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - workflow/row-driven - ZERO REDUNDANCY - ZERO HARD CODING - SSOT.
-- Date: 2025-12-26

BEGIN;

SELECT pg_advisory_lock(hashtext('202512260450_sa_short_code_lookup_step_collision_fix'));

SET search_path TO public, workflow_handlers, extensions, pg_temp;

DO $$
DECLARE
  v_template_id UUID;
  v_dispatch_seq INT := NULL;
  v_has_short BOOLEAN := FALSE;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'workflow_geocoding_standard'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'workflow_geocoding_standard not found; skipping short_code_lookup repair';
    RETURN;
  END IF;

  -- Repair local_lookup metadata if a prior ID collision overwrote decision_log_event.
  UPDATE public.workflow_template_steps
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('decision_log_event', 'geocoding.local_lookup'),
      updated_at = now()
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'local_lookup'
    AND COALESCE(metadata->>'decision_log_event', '') IN ('', 'geocoding.short_code_lookup');

  SELECT TRUE INTO v_has_short
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'short_code_lookup'
  LIMIT 1;

  IF NOT COALESCE(v_has_short, FALSE) THEN
    SELECT sequence_order
    INTO v_dispatch_seq
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'dispatch_provider'
    ORDER BY sequence_order
    LIMIT 1;

    v_dispatch_seq := COALESCE(v_dispatch_seq, 999);

    -- Insert before dispatch_provider (shift steps at/after dispatch_provider by +1).
    UPDATE public.workflow_template_steps
    SET sequence_order = sequence_order + 1
    WHERE workflow_template_id = v_template_id
      AND sequence_order >= v_dispatch_seq;

    INSERT INTO public.workflow_template_steps (
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
      v_template_id,
      v_dispatch_seq,
      'short_code_lookup',
      'geocoding',
      'always',
      'geo_short_code_registry',
      'v1',
      jsonb_build_object('decision_log_event', 'geocoding.short_code_lookup'),
      FALSE,
      TRUE
    );
  ELSE
    -- Idempotent repair: ensure handler configuration is correct if the row already exists.
    UPDATE public.workflow_template_steps
    SET operation_settings_category = 'geocoding',
        transition_condition = 'always',
        handler_key = 'geo_short_code_registry',
        handler_version = 'v1',
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('decision_log_event', 'geocoding.short_code_lookup'),
        manual_action_required = FALSE,
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'short_code_lookup';
  END IF;

  -- Recompute steps_checksum for audit parity.
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

SELECT pg_advisory_unlock(hashtext('202512260450_sa_short_code_lookup_step_collision_fix'));

COMMIT;

