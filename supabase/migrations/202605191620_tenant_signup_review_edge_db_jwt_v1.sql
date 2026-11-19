-- Migration: allow trusted edge DB JWT to complete tenant signup review.
-- Purpose:
--   Browser review flows enter through tenant-signup-review, which first checks
--   the operator JWT and then calls the database with the configured edge DB JWT.
--   Keep the guard claim-driven while allowing that trusted edge role.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605191620_tenant_signup_review_edge_db_jwt_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.request_role_is_service_claim_v1()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_role_setting TEXT := lower(NULLIF(btrim(COALESCE(current_setting('role', true), '')), ''));
  v_role_claim TEXT := lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''));
  v_claims JSONB := NULL;
  v_claims_role TEXT := NULL;
  v_trusted_roles TEXT[] := ARRAY['service_role', 'edge_api_gateway_role'];
BEGIN
  IF v_role_setting = ANY(v_trusted_roles) OR v_role_claim = ANY(v_trusted_roles) THEN
    RETURN TRUE;
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION WHEN others THEN
    v_claims := NULL;
  END;

  v_claims_role := lower(NULLIF(btrim(COALESCE(v_claims->>'role', '')), ''));
  RETURN COALESCE(v_claims_role = ANY(v_trusted_roles), FALSE);
END;
$function$;

GRANT EXECUTE ON FUNCTION api.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) TO edge_api_gateway_role;

GRANT EXECUTE ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) TO edge_api_gateway_role;

COMMENT ON FUNCTION public.request_role_is_service_claim_v1() IS
  'Claim-driven trusted edge/service detector for tenant signup review provisioning wrappers.';

SELECT pg_advisory_unlock(hashtext('202605191620_tenant_signup_review_edge_db_jwt_v1'));

COMMIT;
