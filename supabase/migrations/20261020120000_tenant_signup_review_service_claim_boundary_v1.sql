-- Admit tenant provisioning only through a service claim, never session-user breakglass.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261020120000_tenant_signup_review_service_claim_boundary_v1'));

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
DECLARE
  v_role_setting TEXT := lower(btrim(COALESCE(current_setting('role', true), '')));
  v_role_claim TEXT := lower(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')));
  v_claims JSONB;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    v_claims := NULL;
  END;

  IF v_role_setting <> 'service_role'
     AND v_role_claim <> 'service_role'
     AND lower(btrim(COALESCE(v_claims->>'role', ''))) <> 'service_role' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'service_role_required'));
  END IF;

  -- The private legacy body reads JWT JSON; retain other actor/trace claims on secret-key calls.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', jsonb_set(
    CASE WHEN jsonb_typeof(v_claims) = 'object' THEN v_claims ELSE '{}'::jsonb END,
    '{role}', '"service_role"'::jsonb, true
  )::text, true);

  RETURN public.tenant_signup_review_apply_v1_impl_202605031930(
    p_request_id, p_decision, p_reviewer_user_id, p_decision_reason,
    p_invited_auth_user_id, p_invite_email_sent, p_invite_redirect_to,
    COALESCE(p_decision_metadata, '{}'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) TO service_role;

REVOKE ALL ON FUNCTION api.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) TO service_role;

COMMENT ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) IS 'Service-claim-only tenant signup review; the current private provisioning body and reviewer metadata remain unchanged.';

COMMIT;
