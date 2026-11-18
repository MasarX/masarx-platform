-- Tenant signup review service-claim hardening.
--
-- The original provisioning body included a legacy session_user breakglass
-- branch. Keep that body private and expose a new public entrypoint that only
-- admits service_role through request/role claims only.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031930_tenant_signup_review_service_claim_hardening_v1'));
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
BEGIN
  IF v_role_setting = 'service_role' OR v_role_claim = 'service_role' THEN
    RETURN TRUE;
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION WHEN others THEN
    v_claims := NULL;
  END;

  v_claims_role := lower(NULLIF(btrim(COALESCE(v_claims->>'role', '')), ''));
  RETURN COALESCE(v_claims_role = 'service_role', FALSE);
END;
$function$;

DO $$
BEGIN
  IF to_regprocedure('public.tenant_signup_review_apply_v1_impl_202605031930(uuid,text,uuid,text,uuid,boolean,text,jsonb)') IS NULL THEN
    ALTER FUNCTION public.tenant_signup_review_apply_v1(
      UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
    ) RENAME TO tenant_signup_review_apply_v1_impl_202605031930;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_signup_review_apply_v1(
  p_request_id UUID,
  p_decision TEXT,
  p_reviewer_user_id UUID DEFAULT NULL,
  p_decision_reason TEXT DEFAULT NULL,
  p_invited_auth_user_id UUID DEFAULT NULL,
  p_invite_email_sent BOOLEAN DEFAULT FALSE,
  p_invite_redirect_to TEXT DEFAULT NULL,
  p_decision_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF NOT public.request_role_is_service_claim_v1() THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'service_role_required')
    );
  END IF;

  -- The private implementation still validates legacy service claims. Since
  -- this wrapper has already admitted only service_role requests, seed the
  -- request claim for the private call when an sb_secret key path authenticated
  -- as the service database role without JWT claims.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  RETURN public.tenant_signup_review_apply_v1_impl_202605031930(
    p_request_id,
    p_decision,
    p_reviewer_user_id,
    p_decision_reason,
    p_invited_auth_user_id,
    p_invite_email_sent,
    p_invite_redirect_to,
    COALESCE(p_decision_metadata, '{}'::jsonb)
  );
END;
$function$;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION api.tenant_signup_review_apply_v1(
  p_request_id UUID,
  p_decision TEXT,
  p_reviewer_user_id UUID DEFAULT NULL,
  p_decision_reason TEXT DEFAULT NULL,
  p_invited_auth_user_id UUID DEFAULT NULL,
  p_invite_email_sent BOOLEAN DEFAULT FALSE,
  p_invite_redirect_to TEXT DEFAULT NULL,
  p_decision_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.tenant_signup_review_apply_v1(
    p_request_id,
    p_decision,
    p_reviewer_user_id,
    p_decision_reason,
    p_invited_auth_user_id,
    p_invite_email_sent,
    p_invite_redirect_to,
    p_decision_metadata
  );
$function$;

REVOKE ALL ON FUNCTION public.request_role_is_service_claim_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_role_is_service_claim_v1() FROM anon;
REVOKE ALL ON FUNCTION public.request_role_is_service_claim_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.request_role_is_service_claim_v1() TO service_role;

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM authenticated;
REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM service_role;

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) TO service_role;

REVOKE ALL ON FUNCTION api.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION api.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) TO service_role;

COMMENT ON FUNCTION public.request_role_is_service_claim_v1() IS
  'Service-role detector based on role/JWT request claims only.';
COMMENT ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) IS
  'Service-claim-only tenant signup review entrypoint. Delegates to the private provisioning implementation after rejecting non-service callers.';
COMMENT ON FUNCTION api.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) IS
  'API-schema tenant signup review wrapper for service edge calls only.';

SELECT pg_advisory_unlock(hashtext('202605031930_tenant_signup_review_service_claim_hardening_v1'));

COMMIT;
