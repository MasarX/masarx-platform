BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261124065515_complete_label_jobs_step_lock_order'));

CREATE OR REPLACE FUNCTION public.complete_label_jobs(p_results jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_rec record;
  v_step_id uuid;
  v_job_ids uuid[];
  v_step_ids uuid[];
BEGIN
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' THEN
    RAISE EXCEPTION 'complete_label_jobs requires p_results as JSONB array';
  END IF;

  SELECT array_agg(x.job_id)
    INTO v_job_ids
    FROM jsonb_to_recordset(p_results) AS x(job_id uuid);

  SELECT COALESCE(array_agg(DISTINCT lj.workflow_run_step_id ORDER BY lj.workflow_run_step_id), '{}'::uuid[])
    INTO v_step_ids
    FROM public.label_jobs lj
    WHERE lj.id = ANY(v_job_ids)
      AND lj.workflow_run_step_id IS NOT NULL;

  -- Cleanup also takes step locks before it locks or deletes job rows.
  FOREACH v_step_id IN ARRAY v_step_ids LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext('label_jobs_workflow_step_nudge'),
      hashtext(v_step_id::text)
    );
  END LOOP;

  FOR v_rec IN
    SELECT x.*
    FROM ROWS FROM (
      jsonb_to_recordset(p_results) AS (
        job_id uuid,
        status text,
        file_url text,
        file_size_bytes integer,
        renderer_metadata jsonb,
        error_reason text
      )
    ) WITH ORDINALITY AS x(job_id, status, file_url, file_size_bytes, renderer_metadata, error_reason, input_order)
    ORDER BY x.job_id, x.input_order
  LOOP
    PERFORM public.complete_label_job(
      p_job_id := v_rec.job_id,
      p_status := v_rec.status,
      p_file_url := v_rec.file_url,
      p_file_size_bytes := v_rec.file_size_bytes,
      p_renderer_metadata := COALESCE(v_rec.renderer_metadata, '{}'::jsonb),
      p_error_reason := v_rec.error_reason
    );
  END LOOP;

  -- A formerly unlinked job can acquire a step while completion is taking locks.
  -- Roll back rather than waiting for a new step lock while holding job rows.
  IF EXISTS (
    SELECT 1
    FROM public.label_jobs lj
    WHERE lj.id = ANY(v_job_ids)
      AND lj.workflow_run_step_id IS NOT NULL
      AND NOT (lj.workflow_run_step_id = ANY(v_step_ids))
  ) THEN
    RAISE EXCEPTION 'Label job joined a workflow step during batch completion'
      USING ERRCODE = 'serialization_failure';
  END IF;

  FOREACH v_step_id IN ARRAY v_step_ids LOOP
    PERFORM public.nudge_workflow_run_for_label_jobs_v1(v_step_id, 'label_jobs_completed');
  END LOOP;
END;
$function$;

COMMIT;
