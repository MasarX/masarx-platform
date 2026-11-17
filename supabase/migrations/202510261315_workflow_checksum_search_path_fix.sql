-- Migration: Pin search_path for workflow_refresh_steps_checksum

BEGIN;

ALTER FUNCTION public.workflow_refresh_steps_checksum(UUID, BOOLEAN)
  SET search_path TO public, pg_temp;

COMMIT;

