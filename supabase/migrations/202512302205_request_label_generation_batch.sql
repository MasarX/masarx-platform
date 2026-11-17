-- Migration: Batch enqueue label jobs
-- Purpose:
--  - Provide a set-based API to enqueue many label_jobs for a shipment in one call.
--  - Avoid per-box loops in workflow handlers (faster, still idempotent).
--  - Preserve SSOT decision logging (one row per job; inserted via a single set-based INSERT).

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION request_label_generation_batch(
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
AS $$
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
  FROM shipments s
  WHERE s.id = p_shipment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shipment % not found', p_shipment_id;
  END IF;

  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_shipment.organization_id THEN
      RAISE EXCEPTION 'Access denied for shipment %', p_shipment_id;
    END IF;
  END IF;

  SELECT *
  INTO v_template
  FROM resolve_label_template(
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
  WITH input_boxes AS (
    SELECT DISTINCT sb.id AS shipment_box_id
    FROM shipment_boxes sb
    WHERE sb.shipment_id = p_shipment_id
      AND (
        p_shipment_box_ids IS NULL
        OR array_length(p_shipment_box_ids, 1) IS NULL
        OR sb.id = ANY (p_shipment_box_ids)
      )
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
      COALESCE(v_template.retry_backoff, '[]'::jsonb) AS retry_state
    FROM input_boxes ib
  ),
  inserted_jobs AS (
    INSERT INTO label_jobs (
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
    RETURNING id AS job_id, shipment_box_id, idempotency_key
  ),
  resolved AS (
    SELECT
      ji.shipment_box_id,
      lj.id AS job_id,
      (ins.job_id IS NOT NULL) AS inserted
    FROM job_inputs ji
    JOIN label_jobs lj
      ON lj.organization_id = ji.organization_id
     AND lj.idempotency_key = ji.idempotency_key
    LEFT JOIN inserted_jobs ins
      ON ins.idempotency_key = ji.idempotency_key
  ),
  decision_rows AS (
    INSERT INTO decision_log (
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
  FROM resolved r;
END;
$$;

COMMENT ON FUNCTION request_label_generation_batch(UUID, TEXT, UUID, TEXT, UUID[], TEXT)
  IS 'Batch enqueue label jobs for a shipment (idempotent per box/type/template/purpose); returns job ids + inserted flag.';

GRANT EXECUTE ON FUNCTION request_label_generation_batch(UUID, TEXT, UUID, TEXT, UUID[], TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION request_label_generation_batch(UUID, TEXT, UUID, TEXT, UUID[], TEXT) TO edge_label_renderer_role;

COMMIT;

