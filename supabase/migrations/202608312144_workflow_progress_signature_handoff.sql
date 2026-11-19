BEGIN;
SET LOCAL lock_timeout = '30s';

-- The next migration installs the wrapper with its canonical input name and grants.
DO $handoff$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('api.progress_workflow_run_until_wait_v1(uuid,jsonb,integer,integer)')
      AND proargnames[2] = 'p_input'
  ) THEN
    DROP FUNCTION api.progress_workflow_run_until_wait_v1(uuid, jsonb, integer, integer) RESTRICT;
  END IF;
END;
$handoff$;

COMMIT;
