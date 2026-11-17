-- Migration: request_label_generation_bulk_for_step_v1 ambiguity fix
-- Purpose:
--   - Resolve plpgsql OUT-parameter name collisions in the step-aware bulk enqueue wrapper.
--   - Keep workflow context stamping and explicit step linkage while making the function safe for edge RPC execution.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603062640_request_label_generation_bulk_for_step_ambiguity_fix'));
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
  SELECT
    bulk.job_id,
    bulk.shipment_id,
    bulk.shipment_box_id,
    bulk.inserted,
    bulk.shipment_index,
    bulk.box_index
  FROM public.request_label_generation_bulk_v1(
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  ) AS bulk;

  SELECT COUNT(*)
  INTO v_conflict_count
  FROM public.label_jobs lj
  WHERE lj.id IN (SELECT result.job_id FROM _label_generation_bulk_for_step_result result)
    AND lj.workflow_run_step_id IS NOT NULL
    AND lj.workflow_run_step_id IS DISTINCT FROM p_workflow_run_step_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'request_label_generation_bulk_for_step_v1 step linkage conflict for % job(s)', v_conflict_count;
  END IF;

  UPDATE public.label_jobs lj
  SET workflow_run_step_id = p_workflow_run_step_id
  WHERE lj.id IN (SELECT result.job_id FROM _label_generation_bulk_for_step_result result)
    AND lj.workflow_run_step_id IS NULL;

  RETURN QUERY
  SELECT
    result.job_id,
    result.shipment_id,
    result.shipment_box_id,
    result.inserted,
    result.shipment_index,
    result.box_index
  FROM _label_generation_bulk_for_step_result result
  ORDER BY result.shipment_index, result.box_index;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603062640_request_label_generation_bulk_for_step_ambiguity_fix'));
COMMIT;
