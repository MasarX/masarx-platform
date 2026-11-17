-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Harden marketplace application status grants to keep browser access on the edge facade

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091151_marketplace_application_status_grants_hardening_v1'));
SET search_path TO public, extensions, pg_temp;

REVOKE ALL ON FUNCTION public.marketplace_application_status_by_token_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_application_status_by_token_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.marketplace_application_status_by_token_v1(TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.marketplace_application_status_by_token_v1(TEXT) FROM service_role;

GRANT EXECUTE ON FUNCTION public.marketplace_application_status_by_token_v1(TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.marketplace_application_status_by_token_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.marketplace_application_status_by_token_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION api.marketplace_application_status_by_token_v1(TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION api.marketplace_application_status_by_token_v1(TEXT) FROM service_role;

GRANT EXECUTE ON FUNCTION api.marketplace_application_status_by_token_v1(TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603091151_marketplace_application_status_grants_hardening_v1'));
COMMIT;
