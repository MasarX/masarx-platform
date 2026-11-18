-- Preserve every scope-validated label target when the fresh workflow-scope
-- prepare handler upgrades the legacy prepare result. The legacy handler may
-- classify unresolved rows as timed_out when its wait budget is zero; fresh
-- mode owns asynchronous settlement and must continue those rows as targets.

BEGIN;
SELECT pg_advisory_lock(hashtext('20260920007000_label_print_prepare_timed_out_targets_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $migration$
DECLARE
  v_target regprocedure := 'workflow_handlers.execute_label_print_prepare_v4(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure;
  v_definition text;
  v_old text := $fragment$
                 COALESCE(v_base_response.operation_result->'ready', '[]'::jsonb)
                 || COALESCE(v_base_response.operation_result->'pending', '[]'::jsonb)
               ) WITH ORDINALITY AS t(elem, ordinality)
$fragment$;
  v_new text := $fragment$
                 COALESCE(v_base_response.operation_result->'ready', '[]'::jsonb)
                 || COALESCE(v_base_response.operation_result->'pending', '[]'::jsonb)
                 || COALESCE(v_base_response.operation_result->'timed_out', '[]'::jsonb)
               ) WITH ORDINALITY AS t(elem, ordinality)
$fragment$;
BEGIN
  SELECT pg_get_functiondef(v_target) INTO v_definition;
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'label print prepare timed-out target repair function is missing';
  END IF;

  IF (length(v_definition) - length(replace(v_definition, v_old, '')))
       / NULLIF(length(v_old), 0) <> 1 THEN
    RAISE EXCEPTION 'label print prepare timed-out target anchor drifted';
  END IF;

  v_definition := replace(v_definition, v_old, v_new);
  EXECUTE v_definition;

  SELECT pg_get_functiondef(v_target) INTO v_definition;
  IF position(v_new IN v_definition) = 0 THEN
    RAISE EXCEPTION 'label print prepare timed-out target repair did not persist';
  END IF;
END;
$migration$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_prepare_v4(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) IS 'Prepare labels for bundling with fresh workflow-scope readiness, including scope-validated legacy timeout candidates in asynchronous settlement.';

SELECT pg_advisory_unlock(hashtext('20260920007000_label_print_prepare_timed_out_targets_v1'));
COMMIT;
