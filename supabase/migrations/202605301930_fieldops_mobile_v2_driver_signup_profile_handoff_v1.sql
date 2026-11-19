-- FieldOps Mobile V2 driver signup profile handoff readback.
-- Extends the browser-safe status-token resolver with approved profile
-- lineage so the native app can show backend-confirmed handoff readiness
-- after Console approval, without polling raw tables or falling back to V1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605301930_fieldops_mobile_v2_driver_signup_profile_handoff_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.marketplace_application_status_by_token_v1(
  p_status_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_req public.marketplace_participant_requests%ROWTYPE;
  v_state TEXT := 'pending_review';
  v_additional_docs_requested BOOLEAN := FALSE;
  v_handoff_ready BOOLEAN := FALSE;
  v_driver_profile_id UUID := NULL;
  v_fleet_driver_status TEXT := NULL;
  v_fleet_document_count INTEGER := 0;
  v_fleet_compliance_event_count INTEGER := 0;
BEGIN
  SELECT *
    INTO v_req
    FROM public.marketplace_participant_requests r
   WHERE r.public_status_token = p_status_token
   LIMIT 1;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  v_additional_docs_requested :=
    lower(COALESCE(v_req.decision_metadata->>'request_additional_docs', 'false')) IN ('true', 't', '1', 'yes');

  IF v_req.status = 'approved' THEN
    v_state := CASE
      WHEN COALESCE(v_req.last_error_code, '') = 'reverification_required' THEN 'reverification_required'
      ELSE 'approved'
    END;
  ELSIF v_req.status = 'rejected' THEN
    v_state := 'rejected';
  ELSIF v_additional_docs_requested THEN
    v_state := 'additional_documents_requested';
  ELSE
    v_state := 'pending_review';
  END IF;

  v_handoff_ready :=
    v_req.status = 'approved'
    AND v_req.approved_user_id IS NOT NULL
    AND v_req.approved_participant_profile_id IS NOT NULL
    AND v_req.approved_organization_id IS NOT NULL;

  IF v_req.status = 'approved'
     AND v_req.approved_user_id IS NOT NULL
     AND v_req.approved_organization_id IS NOT NULL THEN
    SELECT dp.id, dp.status
      INTO v_driver_profile_id, v_fleet_driver_status
      FROM public.driver_profiles dp
     WHERE dp.organization_id = v_req.approved_organization_id
       AND dp.user_id = v_req.approved_user_id
     LIMIT 1;

    SELECT COUNT(*)::INT
      INTO v_fleet_document_count
      FROM public.driver_documents dd
     WHERE dd.organization_id = v_req.approved_organization_id
       AND dd.user_id = v_req.approved_user_id
       AND dd.metadata->>'marketplace_request_id' = v_req.id::text;

    SELECT COUNT(*)::INT
      INTO v_fleet_compliance_event_count
      FROM public.driver_compliance_events dce
     WHERE dce.organization_id = v_req.approved_organization_id
       AND dce.user_id = v_req.approved_user_id
       AND dce.event_type = 'marketplace_driver_approved'
       AND dce.payload->>'marketplace_request_id' = v_req.id::text;
  END IF;

  v_handoff_ready := v_handoff_ready AND v_driver_profile_id IS NOT NULL;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'status', v_req.status,
      'application_state', v_state,
      'participant_type_key', v_req.requested_participant_type_key,
      'review_decision', v_req.review_decision,
      'reviewed_at', v_req.reviewed_at,
      'invite_email_sent_at', v_req.invite_email_sent_at,
      'invite_redirect_to', v_req.invite_redirect_to,
      'review_reason', v_req.review_reason,
      'requested_documents', v_req.decision_metadata->'requested_documents',
      'profile_handoff', jsonb_build_object(
        'ready', v_handoff_ready,
        'organization_id', v_req.approved_organization_id,
        'user_id', v_req.approved_user_id,
        'participant_profile_id', v_req.approved_participant_profile_id,
        'driver_profile_id', v_driver_profile_id,
        'fleet_driver_status', v_fleet_driver_status,
        'fleet_handoff_ready', v_driver_profile_id IS NOT NULL,
        'fleet_document_count', v_fleet_document_count,
        'fleet_compliance_event_count', v_fleet_compliance_event_count,
        'invite_redirect_to', v_req.invite_redirect_to,
        'invite_email_sent_at', v_req.invite_email_sent_at
      )
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.marketplace_application_status_by_token_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605301930_fieldops_mobile_v2_driver_signup_profile_handoff_v1'));
COMMIT;
