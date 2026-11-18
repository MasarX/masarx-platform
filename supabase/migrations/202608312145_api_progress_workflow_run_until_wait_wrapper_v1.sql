-- Expose bounded workflow progression to browser/server clients pinned to api.
BEGIN;
SELECT pg_advisory_lock(hashtext('202608312145_api_progress_workflow_run_until_wait_wrapper_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION api.progress_workflow_run_until_wait_v1(
  p_workflow_run_id UUID,
  p_operation_result JSONB DEFAULT '{}'::JSONB,
  p_budget_ms INTEGER DEFAULT NULL,
  p_max_steps INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE SQL
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.progress_workflow_run_until_wait_v1(
    p_workflow_run_id,
    p_operation_result,
    p_budget_ms,
    p_max_steps
  );
$function$;

COMMENT ON FUNCTION api.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER)
  IS 'Browser-safe api schema wrapper for bounded canonical workflow progression.';

REVOKE ALL ON FUNCTION api.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION api.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.progress_workflow_run_until_wait_v1(UUID, JSONB, INTEGER, INTEGER)
  TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202608312145_api_progress_workflow_run_until_wait_wrapper_v1'));
COMMIT;
