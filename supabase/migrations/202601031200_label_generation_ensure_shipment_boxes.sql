-- Migration: Ensure default shipment_boxes exist for label generation
-- Purpose:
--   - Label generation relies on shipment_boxes; shipments created via some ingestion paths may not create boxes.
--   - Provide a single SSOT helper to ensure box rows exist (1..shipments.box_count) and update label job RPCs to call it.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-03

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- Helper: ensure_shipment_boxes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_shipment_boxes(
  p_shipment_id UUID,
  p_box_count INT DEFAULT NULL
)
RETURNS TABLE (
  shipment_box_id UUID,
  box_number INT,
  inserted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_shipment RECORD;
  v_expected_count INT;
BEGIN
  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.tracking_number,
    s.box_count
  INTO v_shipment
  FROM public.shipments s
  WHERE s.id = p_shipment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shipment % not found', p_shipment_id;
  END IF;

  v_expected_count := COALESCE(NULLIF(p_box_count, 0), v_shipment.box_count, 1);
  IF v_expected_count < 1 THEN
    v_expected_count := 1;
  END IF;

  RETURN QUERY
  WITH desired AS (
    SELECT
      gs::int AS box_number,
      format('%s:%s', v_shipment.tracking_number, gs::int) AS barcode
    FROM generate_series(1, v_expected_count) gs
  ),
  inserted_rows AS (
    INSERT INTO public.shipment_boxes (
      shipment_id,
      organization_id,
      client_id,
      box_number,
      barcode,
      status,
      created_at
    )
    SELECT
      v_shipment.id,
      v_shipment.organization_id,
      v_shipment.client_id,
      d.box_number,
      d.barcode,
      'pending',
      now()
    FROM desired d
    ON CONFLICT (shipment_id, box_number) DO NOTHING
    RETURNING
      id AS shipment_box_id,
      box_number
  ),
  resolved AS (
    SELECT
      sb.id AS shipment_box_id,
      d.box_number,
      (ir.shipment_box_id IS NOT NULL) AS inserted
    FROM desired d
    LEFT JOIN inserted_rows ir
      ON ir.box_number = d.box_number
    LEFT JOIN public.shipment_boxes sb
      ON sb.shipment_id = v_shipment.id
     AND sb.box_number = d.box_number
    WHERE sb.id IS NOT NULL
  )
  SELECT
    r.shipment_box_id,
    r.box_number,
    r.inserted
  FROM resolved r
  ORDER BY r.box_number;
END;
$function$;

COMMENT ON FUNCTION public.ensure_shipment_boxes(UUID, INT)
  IS 'Ensure shipment_boxes exist for shipment_id (creates box rows 1..box_count when missing); returns resolved box ids + inserted flag.';

GRANT EXECUTE ON FUNCTION public.ensure_shipment_boxes(UUID, INT) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.ensure_shipment_boxes(UUID, INT) TO edge_label_renderer_role;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Patch: request_label_generation_batch calls ensure_shipment_boxes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_label_generation_batch(
  p_shipment_id UUID,
  p_label_type TEXT,
  p_requested_by UUID DEFAULT NULL,
  p_requested_source TEXT DEFAULT NULL,
  p_shipment_box_ids UUID[] DEFAULT NULL,
  p_job_purpose TEXT DEFAULT 'primary'
)
RETURNS TABLE (
  job_id UUID,
  shipment_box_id UUID,
  inserted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_shipment RECORD;
  v_template RECORD;
  v_job_purpose TEXT := COALESCE(NULLIF(p_job_purpose, ''), 'primary');
BEGIN
  IF p_label_type IS NULL OR btrim(p_label_type) = '' THEN
    RAISE EXCEPTION 'Label type is required.';
  END IF;

  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.sender_id
  INTO v_shipment
  FROM public.shipments s
  WHERE s.id = p_shipment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shipment % not found', p_shipment_id;
  END IF;

  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    IF public.current_user_org_id() IS NULL OR public.current_user_org_id() <> v_shipment.organization_id THEN
      RAISE EXCEPTION 'Access denied for shipment %', p_shipment_id;
    END IF;
  END IF;

  -- Ensure label jobs have at least one shipment_box to target.
  PERFORM 1 FROM public.ensure_shipment_boxes(p_shipment_id);

  SELECT *
  INTO v_template
  FROM public.resolve_label_template(
    v_shipment.organization_id,
    v_shipment.client_id,
    v_shipment.sender_id,
    lower(p_label_type)
  )
  LIMIT 1;

  IF v_template.template_id IS NULL THEN
    RAISE EXCEPTION 'Unable to resolve label template for shipment % label_type %', p_shipment_id, p_label_type;
  END IF;

  RETURN QUERY
  WITH requested_boxes AS (
    SELECT u.box_id, u.ordinality::int AS input_index
    FROM unnest(p_shipment_box_ids) WITH ORDINALITY AS u(box_id, ordinality)
  ),
  input_boxes AS (
    SELECT
      sb.id AS shipment_box_id,
      COALESCE(rb.input_index, sb.box_number, 0) AS sort_index
    FROM public.shipment_boxes sb
    LEFT JOIN requested_boxes rb
      ON rb.box_id = sb.id
    WHERE sb.shipment_id = p_shipment_id
      AND (
        p_shipment_box_ids IS NULL
        OR array_length(p_shipment_box_ids, 1) IS NULL
        OR sb.id = ANY (p_shipment_box_ids)
      )
    ORDER BY
      COALESCE(rb.input_index, sb.box_number, 0),
      sb.box_number,
      sb.id
  ),
  job_inputs AS (
    SELECT
      v_shipment.organization_id AS organization_id,
      v_shipment.client_id AS client_id,
      p_shipment_id AS shipment_id,
      ib.shipment_box_id AS shipment_box_id,
      lower(p_label_type) AS label_type,
      v_template.template_id AS template_id,
      v_template.template_version AS template_version,
      v_template.template_snapshot AS template_snapshot,
      COALESCE(v_template.max_attempts, 5) AS max_attempts,
      now() AS scheduled_at,
      v_job_purpose AS job_purpose,
      format(
        '%s:%s:%s:%s:%s:%s',
        v_shipment.organization_id,
        p_shipment_id,
        ib.shipment_box_id,
        lower(p_label_type),
        v_template.template_id,
        v_job_purpose
      ) AS idempotency_key,
      p_requested_by AS requested_by,
      p_requested_source AS requested_source,
      v_template.template_snapshot -> 'label_config' ->> 'provider_hint' AS renderer_hint,
      COALESCE(v_template.retry_backoff, '[]'::jsonb) AS retry_state,
      ib.sort_index AS sort_index
    FROM input_boxes ib
  ),
  inserted_jobs AS (
    INSERT INTO public.label_jobs AS lj (
      organization_id,
      client_id,
      shipment_id,
      shipment_box_id,
      label_type,
      template_id,
      template_version,
      template_snapshot,
      status,
      attempts,
      max_attempts,
      scheduled_at,
      job_purpose,
      idempotency_key,
      requested_by,
      requested_source,
      renderer_hint,
      retry_state
    )
    SELECT
      ji.organization_id,
      ji.client_id,
      ji.shipment_id,
      ji.shipment_box_id,
      ji.label_type,
      ji.template_id,
      ji.template_version,
      ji.template_snapshot,
      'pending',
      0,
      ji.max_attempts,
      ji.scheduled_at,
      ji.job_purpose,
      ji.idempotency_key,
      ji.requested_by,
      ji.requested_source,
      ji.renderer_hint,
      ji.retry_state
    FROM job_inputs ji
    ON CONFLICT ON CONSTRAINT label_jobs_unique_request DO NOTHING
    RETURNING
      lj.id AS job_id,
      lj.shipment_box_id AS shipment_box_id,
      lj.idempotency_key AS idempotency_key
  ),
  resolved AS (
    SELECT
      ji.shipment_box_id,
      COALESCE(ins.job_id, lj.id) AS job_id,
      (ins.job_id IS NOT NULL) AS inserted,
      ji.sort_index
    FROM job_inputs ji
    LEFT JOIN inserted_jobs ins
      ON ins.idempotency_key = ji.idempotency_key
    LEFT JOIN public.label_jobs lj
      ON lj.organization_id = ji.organization_id
     AND lj.idempotency_key = ji.idempotency_key
    WHERE COALESCE(ins.job_id, lj.id) IS NOT NULL
  ),
  decision_rows AS (
    INSERT INTO public.decision_log (
      organization_id,
      decision_category,
      resource_type,
      resource_id,
      decision_point,
      decision_outcome,
      decision_inputs,
      decision_reason,
      performed_by_system,
      correlation_id,
      settings_resolution_id,
      timestamp
    )
    SELECT
      v_shipment.organization_id,
      'label_job',
      'label_job',
      r.job_id,
      'request_label_generation',
      CASE WHEN r.inserted THEN 'enqueued' ELSE 'reused' END,
      jsonb_build_object(
        'shipment_id', p_shipment_id,
        'shipment_box_id', r.shipment_box_id,
        'label_type', lower(p_label_type),
        'template_id', v_template.template_id,
        'template_version', v_template.template_version,
        'job_purpose', v_job_purpose,
        'batch', TRUE
      ),
      CASE WHEN r.inserted THEN NULL ELSE 'idempotent_reuse' END,
      'workflow_engine',
      NULL,
      NULL,
      now()
    FROM resolved r
    RETURNING 1
  )
  SELECT r.job_id, r.shipment_box_id, r.inserted
  FROM resolved r
  ORDER BY r.sort_index;
END;
$function$;

COMMENT ON FUNCTION public.request_label_generation_batch(UUID, TEXT, UUID, TEXT, UUID[], TEXT)
  IS 'Batch enqueue label jobs for a shipment (idempotent per box/type/template/purpose); ensures shipment_boxes exist; returns job ids + inserted flag (ordered).';

GRANT EXECUTE ON FUNCTION public.request_label_generation_batch(UUID, TEXT, UUID, TEXT, UUID[], TEXT) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.request_label_generation_batch(UUID, TEXT, UUID, TEXT, UUID[], TEXT) TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;

