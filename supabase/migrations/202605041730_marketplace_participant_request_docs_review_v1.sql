-- Console V2 driver application review: request additional documents without
-- rejecting the pending participant request.

BEGIN;
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.marketplace_participant_request_review_apply_v1(
  p_request_id UUID,
  p_decision TEXT,
  p_reviewer_user_id UUID DEFAULT NULL,
  p_invited_auth_user_id UUID DEFAULT NULL,
  p_invite_email_sent BOOLEAN DEFAULT FALSE,
  p_invite_redirect_to TEXT DEFAULT NULL,
  p_approved_organization_id UUID DEFAULT NULL,
  p_approved_user_id UUID DEFAULT NULL,
  p_decision_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_decision TEXT := lower(btrim(COALESCE(p_decision, '')));
  v_req public.marketplace_participant_requests%ROWTYPE;
  v_review_resolution_id UUID := NULL;
  v_reason TEXT := COALESCE(p_decision_metadata->>'reason', p_decision_metadata->>'note');
BEGIN
  IF v_decision = 'approve' THEN
    v_decision := 'approved';
  ELSIF v_decision = 'reject' THEN
    v_decision := 'rejected';
  ELSIF v_decision IN ('request_docs', 'request-docs', 'additional_docs') THEN
    v_decision := 'request_additional_docs';
  END IF;

  IF v_decision <> 'request_additional_docs' THEN
    RETURN public.marketplace_apply_participant_request_v1(
      p_request_id,
      p_decision,
      p_reviewer_user_id,
      p_invited_auth_user_id,
      p_invite_email_sent,
      p_invite_redirect_to,
      p_approved_organization_id,
      p_approved_user_id,
      p_decision_metadata
    );
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');
  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'service_role_required'));
  END IF;

  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_id_required'));
  END IF;

  SELECT *
    INTO v_req
    FROM public.marketplace_participant_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.status <> 'pending' THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok', TRUE,
        'id', v_req.id,
        'status', v_req.status,
        'already_processed', TRUE
      )
    );
  END IF;

  SELECT settings_resolution_id
    INTO v_review_resolution_id
    FROM public.marketplace_resolve_policy_row_v1(
      'marketplace_compliance_policy',
      jsonb_build_object(
        'organization_id', v_req.requested_organization_id,
        'participant_type_key', v_req.requested_participant_type_key
      )
    )
   LIMIT 1;

  UPDATE public.marketplace_participant_requests
     SET reviewed_by = COALESCE(p_reviewer_user_id, reviewed_by),
         review_reason = COALESCE(v_reason, review_reason),
         decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
           || COALESCE(p_decision_metadata, '{}'::jsonb)
           || jsonb_build_object(
             'decision', 'request_additional_docs',
             'request_additional_docs', TRUE,
             'review_applied_at', now()
           ),
         updated_at = now()
   WHERE id = v_req.id;

  PERFORM public.log_decision(
    p_organization_id := COALESCE(v_req.requested_organization_id, public.marketplace_system_org_id_v1()),
    p_decision_category := 'marketplace_compliance_policy',
    p_resource_type := 'marketplace_participant_request',
    p_resource_id := v_req.id,
    p_decision_point := 'participant_request.review',
    p_decision_outcome := 'request_additional_docs',
    p_performed_by_system := 'marketplace_participant_request_review_apply_v1',
    p_decision_inputs := COALESCE(p_decision_metadata, '{}'::jsonb),
    p_decision_reason := COALESCE(v_reason, 'request_additional_docs'),
    p_settings_resolution_id := v_review_resolution_id
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_req.id,
    'status', 'pending',
    'decision', 'request_additional_docs'
  );
END;
$function$;

COMMENT ON FUNCTION public.marketplace_participant_request_review_apply_v1(UUID, TEXT, UUID, UUID, BOOLEAN, TEXT, UUID, UUID, JSONB)
IS 'Reviews marketplace participant requests. approve/reject delegate to marketplace_apply_participant_request_v1; request_additional_docs records a pending-state review decision and decision_log entry without materializing or rejecting the request.';

COMMIT;
