-- Migration: label compose platform-role compatibility
-- Purpose:
--   - Keep SECURITY DEFINER label compose reads compatible with platform-local
--     pgTAP and maintenance contexts that execute as postgres/supabase_admin.
--   - Preserve the existing tenant guard for non-platform callers while staying
--     aligned with later label completion/reprint role allowances.

BEGIN;

CREATE OR REPLACE FUNCTION public.compose_label_payload(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_job label_jobs%ROWTYPE;
  v_payload JSONB;
  v_target RECORD;
  v_claim_role TEXT := lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''));
BEGIN
  SELECT *
    INTO v_job
    FROM public.label_jobs
   WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Label job % not found', p_job_id;
  END IF;

  IF COALESCE(v_claim_role, lower(current_user)) NOT IN (
    'service_role',
    'edge_label_renderer_role',
    'postgres',
    'supabase_admin'
  ) THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
      RAISE EXCEPTION 'Access denied for label job %', p_job_id;
    END IF;
  END IF;

  IF v_job.shipment_id IS NOT NULL THEN
    SELECT to_jsonb(payload)
      INTO v_payload
      FROM shipment_label_payload_v payload
     WHERE payload.shipment_id = v_job.shipment_id
       AND (
             v_job.shipment_box_id IS NULL
             OR payload.shipment_box_id = v_job.shipment_box_id
           )
     ORDER BY payload.box_number NULLS FIRST
     LIMIT 1;
  ELSE
    SELECT *
      INTO v_target
      FROM public.resolve_label_target_payload(
        v_job.target_type,
        v_job.target_id,
        v_job.target_box_id
      )
     LIMIT 1;
    v_payload := COALESCE(v_target.payload, '{}'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'organization_id', v_job.organization_id,
      'client_id', v_job.client_id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'target_type', v_job.target_type,
      'target_id', v_job.target_id,
      'target_box_id', v_job.target_box_id,
      'target_metadata', COALESCE(v_job.target_metadata, '{}'::jsonb),
      'label_type', v_job.label_type,
      'attempts', v_job.attempts,
      'max_attempts', v_job.max_attempts,
      'template', v_job.template_snapshot,
      'renderer_hint', v_job.renderer_hint,
      'retry_state', v_job.retry_state,
      'workflow_run_step_id', NULL
    ),
    'payload', COALESCE(v_payload, '{}'::jsonb)
  );
END;
$function$;

COMMENT ON FUNCTION public.compose_label_payload(UUID)
  IS 'Return canonical payload + template snapshot for a label job, including target-neutral jobs.';

COMMIT;
