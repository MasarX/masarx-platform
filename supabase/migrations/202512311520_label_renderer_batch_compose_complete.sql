-- Migration: Add batch RPCs for label renderer compose + complete
-- Purpose: Reduce Edge subrequest overhead for synchronous print+bundle flows.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.compose_label_payloads(p_job_ids uuid[])
RETURNS TABLE (job_id uuid, composed jsonb, compose_ms numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job_id uuid;
  v_started_at timestamptz;
  v_finished_at timestamptz;
BEGIN
  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  FOREACH v_job_id IN ARRAY p_job_ids LOOP
    v_started_at := clock_timestamp();
    job_id := v_job_id;
    composed := public.compose_label_payload(v_job_id);
    v_finished_at := clock_timestamp();
    compose_ms := EXTRACT(EPOCH FROM (v_finished_at - v_started_at)) * 1000;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.compose_label_payloads(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compose_label_payloads(uuid[]) TO service_role, edge_label_renderer_role;

CREATE OR REPLACE FUNCTION public.complete_label_jobs(p_results jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_rec record;
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
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_label_jobs(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_label_jobs(jsonb) TO service_role, edge_label_renderer_role;

COMMIT;

