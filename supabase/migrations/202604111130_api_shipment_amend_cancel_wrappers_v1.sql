-- Spec-Issue: #2078 / Step: E02
-- Migration: expose shipment amend/cancel RPCs through the api schema
-- Date: 2026-04-11
--
-- Purpose:
-- - Hosted Console/Portal server clients are contract-bound to db.schema='api'.
-- - Shipment amend/cancel page loads and submits through shipment_amend_cancel_* RPCs.
-- - Provide api wrappers so the browser/server contract stays aligned with the
--   workflow-engine-backed public implementation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604111130_api_shipment_amend_cancel_wrappers_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.shipment_amend_cancel_options_v1(
  p_shipment_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.shipment_amend_cancel_options_v1(p_shipment_id);
$function$;

CREATE OR REPLACE FUNCTION api.shipment_amend_cancel_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.shipment_amend_cancel_v1(p_input);
$function$;

REVOKE ALL ON FUNCTION api.shipment_amend_cancel_options_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.shipment_amend_cancel_options_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION api.shipment_amend_cancel_options_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.shipment_amend_cancel_options_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.shipment_amend_cancel_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.shipment_amend_cancel_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION api.shipment_amend_cancel_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.shipment_amend_cancel_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604111130_api_shipment_amend_cancel_wrappers_v1'));
COMMIT;
