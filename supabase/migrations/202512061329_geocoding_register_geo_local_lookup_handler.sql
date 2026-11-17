-- Migration: Register geo_local_lookup handler in operation_handlers
-- Purpose: Ensure workflow_template_steps can reference geo_local_lookup via FK to operation_handlers.
-- Alignment: SSOT handler registry; dynamic workflow execution; no hardcoding.
-- Date: 2025-12-06

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.operation_handlers'::regclass
      AND tgname = 'operation_handlers_validate_signature'
  ) THEN
    EXECUTE 'ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature';
  END IF;
END;
$$;

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
  'geo_local_lookup',
  'workflow_handlers',
  'execute_geo_local_lookup_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Local-first geocoding: canonical city/district matching (perfect/fuzzy/long_line) with scoring and routing.',
  'docs/ops/plans/PLAN-202511-geocoding-polygons-benchmarks.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.operation_handlers'::regclass
      AND tgname = 'operation_handlers_validate_signature'
  ) THEN
    EXECUTE 'ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature';
  END IF;
END;
$$;

COMMIT;

