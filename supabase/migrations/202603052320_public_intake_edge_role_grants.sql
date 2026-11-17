-- Plan: PLAN-202603-stg-go-live-security-review
-- Step: S04
-- Grant least-privilege intake access to edge_api_gateway_role for public browser facades.

BEGIN;
SET search_path TO public, extensions, pg_temp;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.marketing_lead_request_create_v1(
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      JSONB,
      TEXT,
      BOOLEAN
    ) TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.tenant_signup_policy_v1() TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.tenant_signup_request_create_v1(
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      JSONB,
      TEXT,
      BOOLEAN
    ) TO edge_api_gateway_role;
  END IF;
END;
$$;

COMMIT;
