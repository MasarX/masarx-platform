-- Plan: PLAN-202603-landing-public-tracking-page / Step: S99
-- Migration: tenant signup public intake privilege lockdown v1
-- Purpose:
--   - Keep browser-facing tenant-signup intake behind the dedicated edge facade only.
--   - Revoke accidental anon/authenticated execute access from the public and api wrappers.
--   - Preserve service_role and edge_api_gateway_role least-privilege access.

BEGIN;
SET search_path TO public, extensions, pg_temp;

REVOKE ALL ON FUNCTION public.tenant_signup_policy_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_policy_v1() FROM anon;
REVOKE ALL ON FUNCTION public.tenant_signup_policy_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_signup_policy_v1() TO service_role;

REVOKE ALL ON FUNCTION public.tenant_signup_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) FROM anon;
REVOKE ALL ON FUNCTION public.tenant_signup_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_signup_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) TO service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

REVOKE ALL ON FUNCTION api.tenant_signup_policy_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION api.tenant_signup_policy_v1() FROM anon;
REVOKE ALL ON FUNCTION api.tenant_signup_policy_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION api.tenant_signup_policy_v1() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.tenant_signup_policy_v1() TO edge_api_gateway_role;
  END IF;
END $$;

REVOKE ALL ON FUNCTION api.tenant_signup_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.tenant_signup_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) FROM anon;
REVOKE ALL ON FUNCTION api.tenant_signup_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.tenant_signup_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.tenant_signup_request_create_v1(
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
    ) TO edge_api_gateway_role;
  END IF;
END $$;

COMMIT;
