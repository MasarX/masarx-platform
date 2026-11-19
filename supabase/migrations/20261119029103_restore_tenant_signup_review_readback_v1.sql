-- Keep the service-only approval boundary and persist safe review outcomes.
BEGIN;
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
  v_role_setting TEXT := lower(btrim(COALESCE(current_setting('role', true), '')));
  v_role_claim TEXT := lower(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')));
  v_claims JSONB;
  v_result JSONB;
  v_metadata JSONB := COALESCE(p_decision_metadata, '{}'::jsonb);
  v_error_at TIMESTAMPTZ;
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

  v_result := public.tenant_signup_review_apply_v1_impl_202605031930(
    p_request_id, p_decision, p_reviewer_user_id, p_decision_reason,
    p_invited_auth_user_id, p_invite_email_sent, p_invite_redirect_to,
    v_metadata
  );

  IF v_result->>'ok' = 'true'
     AND COALESCE(v_result->>'already_processed', 'false') = 'false'
     AND v_result->>'status' IN ('approved', 'rejected') THEN
    v_result := v_result || jsonb_build_object(
      'task_closeout', public.tenant_signup_review_closeout_tasks_v1(
        p_request_id, v_result->>'status', p_reviewer_user_id,
        jsonb_strip_nulls(jsonb_build_object(
          'source', 'tenant_signup_review_apply_v1',
          'decision_reason', p_decision_reason
        ))
      )
    );
  END IF;

  IF v_result->>'ok' = 'true'
     AND v_result->>'status' = 'approved'
     AND lower(COALESCE(v_metadata->>'invite_email_requested', 'false')) IN ('true', 't', '1', 'yes', 'on')
     AND NOT COALESCE(p_invite_email_sent, FALSE)
     AND lower(COALESCE(v_metadata->>'invite_email_sent', 'false')) NOT IN ('true', 't', '1', 'yes', 'on')
     AND NULLIF(btrim(v_metadata->>'invite_error'), '') IS NOT NULL THEN
    UPDATE public.tenant_signup_requests
       SET last_error_code = 'invite_email_failed',
           last_error_message = 'Invite email could not be sent',
           last_error_at = COALESCE(last_error_at, now()),
           updated_at = now()
     WHERE id = p_request_id AND status = 'approved'
     RETURNING last_error_at INTO v_error_at;
    IF FOUND THEN
      v_result := v_result || jsonb_build_object(
        'last_error_code', 'invite_email_failed',
        'last_error_message', 'Invite email could not be sent',
        'last_error_at', v_error_at
      );
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

COMMIT;
