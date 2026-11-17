-- Migration: Pin SECDEF search_path for compute_webhook_ack_v1
-- Purpose:
--   - Ensure workflow_handlers.compute_webhook_ack_v1 satisfies pgTAP guard 027_secdef_search_path.sql.
--   - Prevent search_path injection by pinning a safe, public-first search_path at the function level.
-- Date: 2025-12-17

BEGIN;

DO $do$
BEGIN
  IF to_regprocedure(
    'workflow_handlers.compute_webhook_ack_v1(public.workflow_run_steps, public.workflow_runs, jsonb)'
  ) IS NOT NULL THEN
    EXECUTE
      'ALTER FUNCTION workflow_handlers.compute_webhook_ack_v1(' ||
      'public.workflow_run_steps, public.workflow_runs, jsonb' ||
      ') SET search_path TO public, workflow_handlers, extensions, pg_temp';
  END IF;
END
$do$;

COMMIT;
