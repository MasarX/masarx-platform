-- Migration: complete label jobs with step-scoped nudge serialization
-- Purpose:
--  - Prevent parallel renderer batches from missing the terminal workflow nudge.
--  - Keep completion generic and reusable by serializing nudge evaluation per workflow step.
--  - Preserve the current complete_label_jobs RPC surface while making multi-batch fresh runs deterministic.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061820_complete_label_jobs_step_lock_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.complete_label_jobs(p_results jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_rec record;
  v_step_id uuid;
BEGIN
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' THEN
    RAISE EXCEPTION 'complete_label_jobs requires p_results as JSONB array';
  END IF;

  FOR v_rec IN
    SELECT *
    FROM jsonb_to_recordset(p_results) AS x(
      job_id uuid,
      status text,
      file_url text,
      file_size_bytes integer,
      renderer_metadata jsonb,
      error_reason text
    )
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

  FOR v_step_id IN
    SELECT DISTINCT lj.workflow_run_step_id
    FROM jsonb_to_recordset(p_results) AS x(
      job_id uuid,
      status text,
      file_url text,
      file_size_bytes integer,
      renderer_metadata jsonb,
      error_reason text
    )
    JOIN public.label_jobs lj
      ON lj.id = x.job_id
    WHERE lj.workflow_run_step_id IS NOT NULL
    ORDER BY lj.workflow_run_step_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext('label_jobs_workflow_step_nudge'),
      hashtext(v_step_id::text)
    );
    PERFORM public.nudge_workflow_run_for_label_jobs_v1(v_step_id, 'label_jobs_completed');
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.complete_label_jobs(jsonb)
  IS 'Complete label jobs in batch and serialize parent-workflow nudge evaluation per workflow step to avoid parallel completion races.';

REVOKE ALL ON FUNCTION public.complete_label_jobs(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_label_jobs(jsonb) TO service_role, edge_label_renderer_role;

SELECT pg_advisory_unlock(hashtext('202603061820_complete_label_jobs_step_lock_v1'));
COMMIT;
