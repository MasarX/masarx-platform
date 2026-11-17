-- Plan: B04 UC062 zone override approval / Step: E02
-- Migration: zone_override_requests api contract compat v1
-- Date: 2026-04-06
--
-- Purpose:
--   - Expose the user-facing zone_override_requests ledger through api.zone_override_requests
--     so strict api contract audits stay aligned with the public table contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604062230_zone_override_requests_api_contract_compat_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE SCHEMA IF NOT EXISTS api;

CREATE OR REPLACE VIEW api.zone_override_requests
WITH (security_invoker = true)
AS
SELECT * FROM public.zone_override_requests;

REVOKE ALL ON api.zone_override_requests FROM PUBLIC;
REVOKE ALL ON api.zone_override_requests FROM anon;
REVOKE ALL ON api.zone_override_requests FROM authenticated;
GRANT SELECT ON api.zone_override_requests TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604062230_zone_override_requests_api_contract_compat_v1'));
COMMIT;
