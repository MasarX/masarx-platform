-- Migration: Pin search_path for workflow scheduling helpers

BEGIN;

ALTER FUNCTION public.workflow_schedule_timezone(JSONB)
  SET search_path TO public, pg_temp;

ALTER FUNCTION public.workflow_adjust_for_quiet_hours(TIMESTAMPTZ, JSONB)
  SET search_path TO public, pg_temp;

ALTER FUNCTION public.workflow_compute_run_at(TIMESTAMPTZ, JSONB, JSONB, INTEGER, BOOLEAN)
  SET search_path TO public, pg_temp;

ALTER FUNCTION public.workflow_record_attempt_state(JSONB, JSONB, TIMESTAMPTZ)
  SET search_path TO public, pg_temp;

ALTER FUNCTION public.workflow_should_stop(JSONB, JSONB)
  SET search_path TO public, pg_temp;

COMMIT;

