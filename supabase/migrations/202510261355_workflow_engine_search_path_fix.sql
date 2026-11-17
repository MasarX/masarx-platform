-- Migration: Pin search_path for workflow engine core functions

BEGIN;

ALTER FUNCTION public.start_workflow_run(UUID, JSONB)
  SET search_path TO public, pg_temp;

ALTER FUNCTION public.progress_workflow_run(UUID, JSONB)
  SET search_path TO public, pg_temp;

COMMIT;

