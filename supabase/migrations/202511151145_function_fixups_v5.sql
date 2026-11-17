-- Migration: Function search_path adjustments (v5)
-- Date: 2025-11-15

BEGIN;

ALTER FUNCTION public.close_workflow_run(uuid, text) SET search_path = public, extensions;
ALTER FUNCTION public.progress_workflow_run(uuid, jsonb) SET search_path = public, extensions;

COMMIT;
