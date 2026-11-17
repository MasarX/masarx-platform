-- Plan: PLAN-202601-masarx-live-e2e-demo / Step: S04
-- Migration: Reduce wait_workflow polling interval for Logestechs geocode-first template
-- Purpose:
--   - Lower demo latency by polling wait steps more frequently.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-12
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
    RAISE NOTICE 'workflow template api_gateway_logestechs_v2_create_geocode_first_v1 not found (active); skipping wait poll interval patch';
    RETURN;
  END IF;

  UPDATE public.workflow_template_steps
  SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{poll_interval_seconds}',
        to_jsonb(1),
        TRUE
      ),
      updated_at = now()
  WHERE workflow_template_id = v_template_id
    AND handler_key IN ('wait_workflow', 'wait_for_shipment')
    AND operation_name IN ('wait_geocoding', 'wait_for_shipment');
END;
$do$;

COMMIT;
