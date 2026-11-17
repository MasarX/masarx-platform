-- Migration: Re-enforce least-privilege grants on tenant signup API wrappers
-- Purpose:
--   - Repair grant drift in long-lived environments where authenticated regained access
--     to tenant-signup API wrappers.
--   - Preserve the public-intake contract: browser traffic must go through the edge facade.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603131200_api_tenant_signup_wrapper_least_privilege_rerun_v1'));

SET search_path TO public, extensions, pg_temp;

DO $$
BEGIN
  IF to_regprocedure('api.tenant_signup_policy_v1()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION api.tenant_signup_policy_v1() FROM PUBLIC;
    REVOKE ALL ON FUNCTION api.tenant_signup_policy_v1() FROM anon;
    REVOKE ALL ON FUNCTION api.tenant_signup_policy_v1() FROM authenticated;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      GRANT EXECUTE ON FUNCTION api.tenant_signup_policy_v1() TO service_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
      GRANT EXECUTE ON FUNCTION api.tenant_signup_policy_v1() TO edge_api_gateway_role;
    END IF;
  END IF;

  IF to_regprocedure(
    'api.tenant_signup_request_create_v1(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,boolean)'
  ) IS NOT NULL THEN
    REVOKE ALL ON FUNCTION api.tenant_signup_request_create_v1(
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
    ) FROM PUBLIC;
    REVOKE ALL ON FUNCTION api.tenant_signup_request_create_v1(
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
    ) FROM anon;
    REVOKE ALL ON FUNCTION api.tenant_signup_request_create_v1(
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
    ) FROM authenticated;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
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
      ) TO service_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
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
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603131200_api_tenant_signup_wrapper_least_privilege_rerun_v1'));
COMMIT;
