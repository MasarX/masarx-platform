-- Migration: Pin search_path for workflow handler functions to include public

BEGIN;

ALTER FUNCTION workflow_handlers.execute_outbound_http_v1(
  workflow_run_steps, workflow_runs, JSONB
)
  SET search_path TO public, workflow_handlers, pg_temp;

COMMIT;

