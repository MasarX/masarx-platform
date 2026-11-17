-- Spec-Issue: #2377 / Step: E01
-- Migration: Expose ui_create_shipment_v1 through the api schema contract
-- Date: 2026-03-31
--
-- Purpose:
-- - Browser/server UI clients default to db.schema='api'.
-- - public.ui_create_shipment_v1 exists, but hosted Console/Portal call api.ui_create_shipment_v1.
-- - Provide the api wrapper so the browser contract and the workflow-backed public implementation stay aligned.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603311115_api_ui_create_shipment_wrapper_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_create_shipment_v1(
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL,
  p_service_type TEXT DEFAULT NULL,
  p_tracking_number TEXT DEFAULT NULL,
  p_client_reference_number TEXT DEFAULT NULL,
  p_carrier_reference_number TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_create_shipment_v1(
    p_client_id,
    p_sender_id,
    p_service_type,
    p_tracking_number,
    p_client_reference_number,
    p_carrier_reference_number,
    p_status,
    p_metadata
  );
$function$;

REVOKE ALL ON FUNCTION api.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION api.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603311115_api_ui_create_shipment_wrapper_v1'));
COMMIT;
