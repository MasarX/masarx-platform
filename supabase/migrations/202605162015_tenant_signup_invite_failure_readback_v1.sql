-- Plan: PLAN-202605-first-tenant-readiness / Step: tenant signup invite-failure readback
-- Migration: Preserve approved-signup invite email failures in canonical request/readback fields.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605162015_tenant_signup_invite_failure_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_metadata JSONB := COALESCE(p_decision_metadata, '{}'::jsonb);
  v_result JSONB;
  v_invite_error TEXT;
  v_invite_requested BOOLEAN := FALSE;
  v_invite_sent BOOLEAN := COALESCE(p_invite_email_sent, FALSE);
  v_error_at TIMESTAMPTZ;
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

  v_result := public.tenant_signup_review_apply_v1_impl_202605031930(
    p_request_id,
    p_decision,
    p_reviewer_user_id,
    p_decision_reason,
    p_invited_auth_user_id,
    p_invite_email_sent,
    p_invite_redirect_to,
    v_metadata
  );

  v_invite_error := NULLIF(btrim(COALESCE(v_metadata->>'invite_error', '')), '');
  v_invite_requested := lower(COALESCE(v_metadata->>'invite_email_requested', 'false'))
    IN ('true', 't', '1', 'yes', 'on');
  v_invite_sent := v_invite_sent
    OR lower(COALESCE(v_metadata->>'invite_email_sent', 'false')) IN ('true', 't', '1', 'yes', 'on');

  IF COALESCE(v_result->>'ok', 'false') = 'true'
     AND lower(COALESCE(v_result->>'status', v_result->>'decision', '')) = 'approved'
     AND v_invite_requested
     AND NOT v_invite_sent
     AND v_invite_error IS NOT NULL THEN
    UPDATE public.tenant_signup_requests
       SET last_error_code = 'invite_email_failed',
           last_error_message = left(v_invite_error, 800),
           last_error_at = COALESCE(last_error_at, now()),
           updated_at = now()
     WHERE id = p_request_id
       AND status = 'approved'
     RETURNING last_error_at INTO v_error_at;

    IF FOUND THEN
      v_result := COALESCE(v_result, '{}'::jsonb)
        || jsonb_build_object(
          'last_error_code', 'invite_email_failed',
          'last_error_message', left(v_invite_error, 800),
          'last_error_at', v_error_at
        );
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

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

COMMENT ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID, TEXT, UUID, TEXT, UUID, BOOLEAN, TEXT, JSONB
) IS
  'Service-claim-only tenant signup review entrypoint. Delegates to the private provisioning implementation and preserves approved-signup invite email failures in canonical readback fields.';

SELECT pg_advisory_unlock(hashtext('202605162015_tenant_signup_invite_failure_readback_v1'));
COMMIT;
