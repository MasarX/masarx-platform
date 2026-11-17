-- Plan: PLAN-202601-workflow-logestechs-address-sync / Step: S02
-- Migration: Increase wait_geocoding max_wait_seconds for Logestechs geocode-first workflow
-- Date: 2026-01-10

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
  INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'api_gateway_logestechs_v2_create_geocode_first_v1'
    AND status = 'active'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'workflow template api_gateway_logestechs_v2_create_geocode_first_v1 not found (active); skipping wait window patch';
    RETURN;
  END IF;

  UPDATE public.workflow_template_steps
  SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{max_wait_seconds}',
        to_jsonb(900),
        TRUE
      ),
      updated_at = now()
  WHERE workflow_template_id = v_template_id
    AND handler_key = 'wait_workflow'
    AND operation_name = 'wait_geocoding';
END;
$do$;

COMMIT;
