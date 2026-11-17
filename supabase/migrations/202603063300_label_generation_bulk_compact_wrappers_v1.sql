-- Migration: compact bulk label-generation wrappers for print renderer
-- Purpose:
--   - Remove redundant post-insert scans from the step-aware bulk wrapper.
--   - Add compact JSON wrappers so the edge renderer can fetch ordered job ids without row-by-row payload overhead.
--   - Keep workflow-step linkage row-driven through existing session-context triggers and guardrails.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063300_label_generation_bulk_compact_wrappers_v1'));
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

  RETURN QUERY
  SELECT r.job_id, r.shipment_id, r.shipment_box_id, r.inserted, r.shipment_index, r.box_index
  FROM public.request_label_generation_bulk_v1(
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  ) AS r
  ORDER BY r.shipment_index, r.box_index;
END;
$$;

COMMENT ON FUNCTION public.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text)
  IS 'Workflow-step-aware bulk label generation wrapper that sets canonical workflow context before delegating directly to request_label_generation_bulk_v1.';

CREATE OR REPLACE FUNCTION public.request_label_generation_bulk_compact_v1(
  p_shipments jsonb,
  p_label_type text,
  p_requested_by uuid DEFAULT NULL,
  p_requested_source text DEFAULT NULL,
  p_job_purpose text DEFAULT 'primary'
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT jsonb_strip_nulls(
    jsonb_build_object(
      'job_ids', COALESCE(jsonb_agg(to_jsonb(r.job_id) ORDER BY r.shipment_index, r.box_index), '[]'::jsonb),
      'job_count', COUNT(*)::int,
      'inserted_count', COUNT(*) FILTER (WHERE r.inserted)::int,
      'reused_count', COUNT(*) FILTER (WHERE NOT r.inserted)::int,
      'shipment_count', COUNT(DISTINCT r.shipment_id)::int
    )
  )
  FROM public.request_label_generation_bulk_v1(
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  ) AS r;
$$;

COMMENT ON FUNCTION public.request_label_generation_bulk_compact_v1(jsonb, text, uuid, text, text)
  IS 'Compact JSON wrapper around request_label_generation_bulk_v1 returning ordered job ids and aggregate counts for edge call sites.';

CREATE OR REPLACE FUNCTION public.request_label_generation_bulk_compact_for_step_v1(
  p_workflow_run_step_id uuid,
  p_shipments jsonb,
  p_label_type text,
  p_requested_by uuid DEFAULT NULL,
  p_requested_source text DEFAULT NULL,
  p_job_purpose text DEFAULT 'primary'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_workflow_run_id uuid := NULL;
BEGIN
  IF p_workflow_run_step_id IS NULL THEN
    RAISE EXCEPTION 'request_label_generation_bulk_compact_for_step_v1 requires workflow_run_step_id';
  END IF;

  SELECT wrs.workflow_run_id
  INTO v_workflow_run_id
  FROM public.workflow_run_steps wrs
  WHERE wrs.id = p_workflow_run_step_id
  LIMIT 1;

  IF v_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'request_label_generation_bulk_compact_for_step_v1 workflow_run_step not found %', p_workflow_run_step_id;
  END IF;

  PERFORM set_config('app.workflow_run_id', v_workflow_run_id::text, true);
  PERFORM set_config('app.workflow_run_step_id', p_workflow_run_step_id::text, true);
  PERFORM set_config('platform.workflow_run_id', v_workflow_run_id::text, true);
  PERFORM set_config('platform.workflow_run_step_id', p_workflow_run_step_id::text, true);

  RETURN public.request_label_generation_bulk_compact_v1(
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  );
END;
$$;

COMMENT ON FUNCTION public.request_label_generation_bulk_compact_for_step_v1(uuid, jsonb, text, uuid, text, text)
  IS 'Compact workflow-step-aware bulk label generation wrapper returning ordered job ids and counts for edge print execution.';

REVOKE ALL ON FUNCTION public.request_label_generation_bulk_compact_v1(jsonb, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_label_generation_bulk_compact_for_step_v1(uuid, jsonb, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_label_generation_bulk_compact_v1(jsonb, text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_label_generation_bulk_compact_for_step_v1(uuid, jsonb, text, uuid, text, text) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.request_label_generation_bulk_compact_v1(jsonb, text, uuid, text, text) TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION public.request_label_generation_bulk_compact_for_step_v1(uuid, jsonb, text, uuid, text, text) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION api.request_label_generation_bulk_compact_v1(
  p_shipments jsonb,
  p_label_type text,
  p_requested_by uuid DEFAULT NULL,
  p_requested_source text DEFAULT NULL,
  p_job_purpose text DEFAULT 'primary'
)
RETURNS jsonb
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.request_label_generation_bulk_compact_v1(
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  );
$$;

CREATE OR REPLACE FUNCTION api.request_label_generation_bulk_compact_for_step_v1(
  p_workflow_run_step_id uuid,
  p_shipments jsonb,
  p_label_type text,
  p_requested_by uuid DEFAULT NULL,
  p_requested_source text DEFAULT NULL,
  p_job_purpose text DEFAULT 'primary'
)
RETURNS jsonb
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.request_label_generation_bulk_compact_for_step_v1(
    p_workflow_run_step_id,
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  );
$$;

COMMENT ON FUNCTION api.request_label_generation_bulk_compact_v1(jsonb, text, uuid, text, text)
  IS 'API schema wrapper for compact bulk label generation results.';
COMMENT ON FUNCTION api.request_label_generation_bulk_compact_for_step_v1(uuid, jsonb, text, uuid, text, text)
  IS 'API schema wrapper for compact workflow-step-aware bulk label generation results.';

REVOKE ALL ON FUNCTION api.request_label_generation_bulk_compact_v1(jsonb, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_label_generation_bulk_compact_for_step_v1(uuid, jsonb, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_label_generation_bulk_compact_v1(jsonb, text, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION api.request_label_generation_bulk_compact_for_step_v1(uuid, jsonb, text, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION api.request_label_generation_bulk_compact_v1(jsonb, text, uuid, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION api.request_label_generation_bulk_compact_for_step_v1(uuid, jsonb, text, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.request_label_generation_bulk_compact_v1(jsonb, text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION api.request_label_generation_bulk_compact_for_step_v1(uuid, jsonb, text, uuid, text, text) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.request_label_generation_bulk_compact_v1(jsonb, text, uuid, text, text) TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.request_label_generation_bulk_compact_for_step_v1(uuid, jsonb, text, uuid, text, text) TO edge_label_renderer_role;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603063300_label_generation_bulk_compact_wrappers_v1'));
COMMIT;
