-- Migration: request_label_generation_bulk_for_step_v1 workflow context fix
-- Purpose:
--   - Ensure fresh print-sync enqueue stamps label_jobs with the current workflow step at insert time.
--   - Reuse the canonical label job context pattern by setting app/platform workflow run + step config
--     inside the step-aware bulk enqueue wrapper before delegating to request_label_generation_bulk_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603062620_request_label_generation_bulk_for_step_context_v2'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.request_label_generation_bulk_for_step_v1(
  p_workflow_run_step_id uuid,
  p_shipments jsonb,
  p_label_type text,
  p_requested_by uuid DEFAULT NULL,
  p_requested_source text DEFAULT NULL,
  p_job_purpose text DEFAULT 'primary'
)
RETURNS TABLE (
  job_id uuid,
  shipment_id uuid,
  shipment_box_id uuid,
  inserted boolean,
  shipment_index int,
  box_index int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_conflict_count int := 0;
  v_workflow_run_id uuid := NULL;
BEGIN
  IF p_workflow_run_step_id IS NULL THEN
    RAISE EXCEPTION 'request_label_generation_bulk_for_step_v1 requires workflow_run_step_id';
  END IF;

  SELECT wrs.workflow_run_id
  INTO v_workflow_run_id
  FROM public.workflow_run_steps wrs
  WHERE wrs.id = p_workflow_run_step_id
  LIMIT 1;

  IF v_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'request_label_generation_bulk_for_step_v1 workflow_run_step not found %', p_workflow_run_step_id;
  END IF;

  PERFORM set_config('app.workflow_run_id', v_workflow_run_id::text, true);
  PERFORM set_config('app.workflow_run_step_id', p_workflow_run_step_id::text, true);
  PERFORM set_config('platform.workflow_run_id', v_workflow_run_id::text, true);
  PERFORM set_config('platform.workflow_run_step_id', p_workflow_run_step_id::text, true);

  CREATE TEMP TABLE IF NOT EXISTS _label_generation_bulk_for_step_result (
    job_id uuid,
    shipment_id uuid,
    shipment_box_id uuid,
    inserted boolean,
    shipment_index int,
    box_index int
  ) ON COMMIT DROP;
  TRUNCATE TABLE _label_generation_bulk_for_step_result;

  INSERT INTO _label_generation_bulk_for_step_result (job_id, shipment_id, shipment_box_id, inserted, shipment_index, box_index)
  SELECT job_id, shipment_id, shipment_box_id, inserted, shipment_index, box_index
  FROM public.request_label_generation_bulk_v1(
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  );

  SELECT COUNT(*)
  INTO v_conflict_count
  FROM public.label_jobs lj
  WHERE lj.id IN (SELECT r.job_id FROM _label_generation_bulk_for_step_result r)
    AND lj.workflow_run_step_id IS NOT NULL
    AND lj.workflow_run_step_id IS DISTINCT FROM p_workflow_run_step_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'request_label_generation_bulk_for_step_v1 step linkage conflict for % job(s)', v_conflict_count;
  END IF;

  UPDATE public.label_jobs lj
  SET workflow_run_step_id = p_workflow_run_step_id
  WHERE lj.id IN (SELECT r.job_id FROM _label_generation_bulk_for_step_result r)
    AND lj.workflow_run_step_id IS NULL;

  RETURN QUERY
  SELECT r.job_id, r.shipment_id, r.shipment_box_id, r.inserted, r.shipment_index, r.box_index
  FROM _label_generation_bulk_for_step_result r
  ORDER BY r.shipment_index, r.box_index;
END;
$$;

COMMENT ON FUNCTION public.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text)
  IS 'Workflow-step-aware bulk label-job enqueue helper that sets canonical workflow context before delegating to request_label_generation_bulk_v1.';

SELECT pg_advisory_unlock(hashtext('202603062620_request_label_generation_bulk_for_step_context_v2'));
COMMIT;
