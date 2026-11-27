BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, workflow_handlers, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT is((
  SELECT count(*)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'workflow_handlers'
    AND p.prokind = 'f'
    AND (
      p.prosrc ~* $path$\mset_config\s*\(\s*'search_path'\s*,[^;]*,\s*(?:is_local\s*(?:=>|:=)\s*)?false\s*\)$path$
      OR (
        p.prosrc ~* $path$\mPERFORM\s+(?:pg_catalog\.)?set_config\s*\(\s*'search_path'\s*,\s*'public(?:, workflow_handlers)?(?:, extensions)?, pg_temp'\s*,\s*true\s*\)$path$
        AND NOT EXISTS (
          SELECT 1 FROM unnest(p.proconfig) AS settings(setting) WHERE setting LIKE 'search_path=%'
        )
      )
    )
), 0::bigint, 'workflow handlers that change search path all restore it at the function boundary');

CREATE FUNCTION pg_temp.check_dispatch_search_path()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  caller_path text := current_setting('search_path');
  returned_path text;
  run_row public.workflow_runs;
  step_row public.workflow_run_steps;
  response public.workflow_handler_response;
BEGIN
  run_row.context := '{"geocoding":{"successful":true}}'::jsonb;
  step_row.metadata := '{}'::jsonb;

  response := workflow_handlers.execute_provider_dispatch_v1(step_row, run_row);
  returned_path := current_setting('search_path');
  PERFORM set_config('search_path', caller_path, true);
  RETURN NEXT is(response.operation_result->>'reason', 'geocoding_already_resolved',
    'the dispatch wrapper skips a resolved geocode');
  RETURN NEXT is(returned_path, caller_path, 'the dispatch wrapper restores the caller search path');

  response := workflow_handlers.execute_provider_dispatch_v1_base(step_row, run_row, '{}'::jsonb);
  returned_path := current_setting('search_path');
  PERFORM set_config('search_path', caller_path, true);
  RETURN NEXT is(response.operation_result->>'reason', 'geocoding_already_resolved',
    'the base dispatch handler skips a resolved geocode');
  RETURN NEXT is(returned_path, caller_path, 'the base dispatch handler restores the caller search path');
END;
$test$;

SELECT * FROM pg_temp.check_dispatch_search_path();
SELECT * FROM finish();
ROLLBACK;
