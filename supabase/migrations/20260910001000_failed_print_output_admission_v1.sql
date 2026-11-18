BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20260910001000_failed_print_output_admission_v1'));
DO $repair$
DECLARE
  target REGPROCEDURE := 'public.ui_get_workflow_run_output_status_v1(uuid,text[])'::regprocedure;
  definition TEXT;
  marker TEXT := '  v_ready_source := v_output_source;';
  guard TEXT := $guard$  -- Definitive failure overrides residual downloadable bytes, not factual persistence.
  IF COALESCE(v_run.workflow_status, '') IN ('failed', 'cancelled') THEN
    v_terminal := TRUE;
    v_phase := 'failed';
    v_output_url := NULL;
    v_output_file_path := NULL;
    v_output_source := NULL;
    v_output_needs_signing := FALSE;
  END IF;
$guard$;
BEGIN
  definition := pg_get_functiondef(target);
  IF position(guard IN definition) > 0 THEN RETURN; END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one final output admission seam in %', target;
  END IF;
  EXECUTE replace(definition,marker,guard || E'\n' || marker);
END;
$repair$;
COMMIT;
