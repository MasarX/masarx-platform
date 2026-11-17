-- Migration: Pin search_path for record_workflow_decision

BEGIN;

ALTER FUNCTION public.record_workflow_decision(UUID, UUID, JSONB)
  SET search_path TO public, pg_temp;

COMMIT;

