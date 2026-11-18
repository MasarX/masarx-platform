-- Plan: PLAN-202605-first-tenant-readiness / Step: tenant signup partial invite/Auth recovery
-- Migration: Provide a trusted edge/service auth-user lookup for approval fallback recovery.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605292045_tenant_signup_auth_user_lookup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;

CREATE OR REPLACE FUNCTION public.tenant_signup_find_auth_user_id_by_email_v1(
  p_email TEXT
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, auth, extensions, pg_temp
AS $function$
DECLARE
  v_email TEXT := lower(NULLIF(btrim(COALESCE(p_email, '')), ''));
  v_auth_user_id UUID;
BEGIN
  IF NOT public.request_role_is_service_claim_v1() THEN
    RAISE EXCEPTION 'tenant_signup_find_auth_user_id_by_email_v1 requires trusted edge/service role'
      USING ERRCODE = '42501';
  END IF;

  IF v_email IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT u.id
    INTO v_auth_user_id
    FROM auth.users u
   WHERE lower(u.email) = v_email
   ORDER BY u.created_at DESC, u.id DESC
   LIMIT 1;

  RETURN v_auth_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION api.tenant_signup_find_auth_user_id_by_email_v1(
  p_email TEXT
)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp
AS $function$
  SELECT public.tenant_signup_find_auth_user_id_by_email_v1(p_email);
$function$;

REVOKE ALL ON FUNCTION public.tenant_signup_find_auth_user_id_by_email_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_find_auth_user_id_by_email_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.tenant_signup_find_auth_user_id_by_email_v1(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_signup_find_auth_user_id_by_email_v1(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_signup_find_auth_user_id_by_email_v1(TEXT) TO edge_api_gateway_role;

REVOKE ALL ON FUNCTION api.tenant_signup_find_auth_user_id_by_email_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.tenant_signup_find_auth_user_id_by_email_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION api.tenant_signup_find_auth_user_id_by_email_v1(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.tenant_signup_find_auth_user_id_by_email_v1(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION api.tenant_signup_find_auth_user_id_by_email_v1(TEXT) TO edge_api_gateway_role;

COMMENT ON FUNCTION public.tenant_signup_find_auth_user_id_by_email_v1(TEXT) IS
  'Trusted edge/service lookup used by tenant signup approval recovery when Auth admin listUsers is unavailable but createUser reports an existing Auth user.';

COMMENT ON FUNCTION api.tenant_signup_find_auth_user_id_by_email_v1(TEXT) IS
  'API-schema wrapper for trusted tenant signup approval Auth user lookup.';

SELECT pg_advisory_unlock(hashtext('202605292045_tenant_signup_auth_user_lookup_v1'));
COMMIT;
