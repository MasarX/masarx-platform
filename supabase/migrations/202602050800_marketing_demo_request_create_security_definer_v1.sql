-- Plan: PLAN-202602-landing-page-live / Step: S00
-- Migration: Marketing demo intake RPC security definer fix v1
-- Date: 2026-02-05
--
-- Goal:
--   - Ensure marketing_demo_request_create_v1 is SECURITY DEFINER (required for RLS-safe intake).
--   - Fix preview-db drift when earlier iterations applied without SECURITY DEFINER.
--
BEGIN;
SELECT pg_advisory_lock(hashtext('202602050800_marketing_demo_request_create_security_definer_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) SECURITY DEFINER;
ALTER FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) SET search_path TO public, extensions, pg_temp;

REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM anon;
REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN)
      TO edge_api_gateway_role;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202602050800_marketing_demo_request_create_security_definer_v1'));
COMMIT;

