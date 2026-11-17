-- Migration: api wrappers for label generation bulk enqueue helpers
-- Purpose:
--   - Expose the bulk label generation RPCs through the api schema for edge/PostgREST callers.
--   - Keep the step-aware hybrid print path and the generic bulk path on the same API contract surface.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603062630_api_request_label_generation_bulk_wrappers_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.request_label_generation_bulk_v1(
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
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.request_label_generation_bulk_v1(
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  );
$function$;

CREATE OR REPLACE FUNCTION api.request_label_generation_bulk_for_step_v1(
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
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.request_label_generation_bulk_for_step_v1(
    p_workflow_run_step_id,
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  );
$function$;

COMMENT ON FUNCTION api.request_label_generation_bulk_v1(jsonb, text, uuid, text, text)
  IS 'API schema wrapper for the generic bulk label generation enqueue helper.';

COMMENT ON FUNCTION api.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text)
  IS 'API schema wrapper for the workflow-step-aware bulk label generation enqueue helper.';

REVOKE ALL ON FUNCTION api.request_label_generation_bulk_v1(jsonb, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_label_generation_bulk_v1(jsonb, text, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION api.request_label_generation_bulk_v1(jsonb, text, uuid, text, text) FROM authenticated;

REVOKE ALL ON FUNCTION api.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION api.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text) FROM authenticated;

GRANT USAGE ON SCHEMA api TO service_role;
GRANT EXECUTE ON FUNCTION api.request_label_generation_bulk_v1(jsonb, text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION api.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.request_label_generation_bulk_v1(jsonb, text, uuid, text, text)
      TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text)
      TO edge_label_renderer_role;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603062630_api_request_label_generation_bulk_wrappers_v1'));
COMMIT;
