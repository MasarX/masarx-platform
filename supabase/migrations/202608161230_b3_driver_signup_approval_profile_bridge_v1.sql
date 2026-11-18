BEGIN;

SELECT pg_advisory_lock(hashtext('202605301520_fieldops_mobile_v2_driver_signup_approval_profile_bridge_v1'));

CREATE OR REPLACE FUNCTION public.marketplace_driver_profile_from_participant_request_v1(
  p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_req public.marketplace_participant_requests%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_existing_driver_id UUID := NULL;
  v_existing_status TEXT := NULL;
  v_driver_profile_id UUID := NULL;
  v_driver_code TEXT := NULL;
  v_status TEXT := NULL;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_id_required'));
  END IF;

  SELECT *
    INTO v_req
    FROM public.marketplace_participant_requests
   WHERE id = p_request_id;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.requested_participant_type_key <> 'freelancer_driver' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'skipped', TRUE,
      'reason', 'participant_type_not_driver',
      'marketplace_participant_request_id', v_req.id
    );
  END IF;

  IF v_req.status <> 'approved'
     OR v_req.approved_organization_id IS NULL
     OR v_req.approved_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'driver_profile_approval_state_missing')
    );
  END IF;

  SELECT *
    INTO v_user
    FROM public.users
   WHERE id = v_req.approved_user_id
   LIMIT 1;

  IF v_user.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'approved_user_not_found'));
  END IF;

  IF v_user.organization_id IS DISTINCT FROM v_req.approved_organization_id THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'approved_user_org_mismatch'));
  END IF;

  SELECT dp.id, dp.status
    INTO v_existing_driver_id, v_existing_status
    FROM public.driver_profiles dp
   WHERE dp.organization_id = v_req.approved_organization_id
     AND dp.user_id = v_req.approved_user_id
   LIMIT 1;

  IF v_existing_driver_id IS NOT NULL THEN
    UPDATE public.driver_profiles
       SET metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_strip_nulls(
                  jsonb_build_object(
                    'source', 'marketplace_driver_profile_from_participant_request_v1',
                    'marketplace_participant_request_id', v_req.id,
                    'marketplace_participant_profile_id', v_req.approved_participant_profile_id
                  )
                ),
           updated_at = now()
     WHERE id = v_existing_driver_id;

    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok', TRUE,
        'created', FALSE,
        'driver_profile_id', v_existing_driver_id,
        'driver_user_id', v_req.approved_user_id,
        'organization_id', v_req.approved_organization_id,
        'status', v_existing_status,
        'marketplace_participant_request_id', v_req.id
      )
    );
  END IF;

  SELECT lv.value
    INTO v_status
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'driver_status'
     AND lv.is_default IS TRUE
   ORDER BY lv.sort_order, lv.value
   LIMIT 1;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'driver_status_default_missing'));
  END IF;

  v_driver_code := upper(NULLIF(btrim(COALESCE(
    v_req.marketing->>'employee_or_contractor_id',
    v_req.metadata->>'employee_or_contractor_id',
    ''
  )), ''));

  IF v_driver_code IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.driver_profiles dp
        WHERE dp.organization_id = v_req.approved_organization_id
          AND dp.driver_code = v_driver_code
          AND dp.user_id IS DISTINCT FROM v_req.approved_user_id
     ) THEN
    v_driver_code := NULL;
  END IF;

  INSERT INTO public.driver_profiles (
    organization_id,
    user_id,
    driver_code,
    status,
    hired_at,
    metadata
  )
  VALUES (
    v_req.approved_organization_id,
    v_req.approved_user_id,
    v_driver_code,
    v_status,
    COALESCE(v_req.reviewed_at, now()),
    jsonb_strip_nulls(
      jsonb_build_object(
        'source', 'marketplace_driver_profile_from_participant_request_v1',
        'marketplace_participant_request_id', v_req.id,
        'marketplace_participant_profile_id', v_req.approved_participant_profile_id,
        'created_correlation_id', v_correlation_id
      )
    )
  )
  RETURNING id INTO v_driver_profile_id;

  PERFORM public.enqueue_domain_event(
    v_req.approved_organization_id,
    'fleet.driver_created',
    'driver_profile',
    v_driver_profile_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'driver_user_id', v_req.approved_user_id,
        'driver_code', v_driver_code,
        'status', v_status,
        'marketplace_participant_request_id', v_req.id,
        'marketplace_participant_profile_id', v_req.approved_participant_profile_id
      )
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_req.approved_organization_id,
    'fleet.driver_created',
    'driver_profile',
    v_driver_profile_id,
    'rpc_dispatch',
    'created',
    'marketplace_driver_profile_from_participant_request_v1',
    v_correlation_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'driver_user_id', v_req.approved_user_id,
        'driver_code', v_driver_code,
        'status', v_status,
        'driver_status_source', 'lookup_values.driver_status',
        'marketplace_participant_request_id', v_req.id,
        'marketplace_participant_profile_id', v_req.approved_participant_profile_id
      )
    ),
    NULL
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'created', TRUE,
      'driver_profile_id', v_driver_profile_id,
      'driver_user_id', v_req.approved_user_id,
      'organization_id', v_req.approved_organization_id,
      'driver_code', v_driver_code,
      'status', v_status,
      'marketplace_participant_request_id', v_req.id
    )
  );
END;
$function$;

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
  v_effective_metadata JSONB := '{}'::jsonb;
  v_decision_log_id UUID := NULL;
  v_domain_event_id UUID := NULL;
  v_result JSONB := '{}'::jsonb;
  v_driver_profile_readback JSONB := NULL;
BEGIN
  IF v_decision = 'approve' THEN
    v_decision := 'approved';
  ELSIF v_decision = 'reject' THEN
    v_decision := 'rejected';
  ELSIF v_decision IN ('request_docs', 'request-docs', 'additional_docs') THEN
    v_decision := 'request_additional_docs';
  END IF;

  IF v_decision <> 'request_additional_docs' THEN
    v_result := public.marketplace_apply_participant_request_v1(
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

    IF v_decision = 'approved'
       AND lower(COALESCE(v_result->>'ok', 'false')) IN ('true', 't', '1', 'yes') THEN
      v_driver_profile_readback :=
        public.marketplace_driver_profile_from_participant_request_v1(p_request_id);

      IF lower(COALESCE(v_driver_profile_readback->>'ok', 'false')) NOT IN ('true', 't', '1', 'yes') THEN
        RETURN COALESCE(v_result, '{}'::jsonb)
          || jsonb_build_object('ok', FALSE, 'driver_profile_readback', v_driver_profile_readback);
      END IF;

      RETURN COALESCE(v_result, '{}'::jsonb)
        || jsonb_build_object('driver_profile_readback', v_driver_profile_readback);
    END IF;

    RETURN v_result;
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

  v_effective_metadata :=
    COALESCE(p_decision_metadata, '{}'::jsonb)
    || jsonb_build_object(
      'decision', 'request_additional_docs',
      'request_additional_docs', TRUE,
      'review_applied_at', now()
    );

  UPDATE public.marketplace_participant_requests
     SET reviewed_by = COALESCE(p_reviewer_user_id, reviewed_by),
         reviewed_at = now(),
         review_reason = COALESCE(v_reason, review_reason),
         decision_metadata = COALESCE(decision_metadata, '{}'::jsonb) || v_effective_metadata,
         updated_at = now()
   WHERE id = v_req.id;

  SELECT public.log_decision(
    p_organization_id := COALESCE(v_req.requested_organization_id, public.marketplace_system_org_id_v1()),
    p_decision_category := 'marketplace_compliance_policy',
    p_resource_type := 'marketplace_participant_request',
    p_resource_id := v_req.id,
    p_decision_point := 'participant_request.review',
    p_decision_outcome := 'request_additional_docs',
    p_performed_by_system := 'marketplace_participant_request_review_apply_v1',
    p_decision_inputs := v_effective_metadata,
    p_decision_reason := COALESCE(v_reason, 'request_additional_docs'),
    p_settings_resolution_id := v_review_resolution_id
  )
  INTO v_decision_log_id;

  SELECT public.marketplace_append_event_v1(
    COALESCE(v_req.requested_organization_id, public.marketplace_system_org_id_v1()),
    'marketplace_participant_request',
    v_req.id,
    'participant_request.additional_docs_requested',
    v_effective_metadata || jsonb_strip_nulls(
      jsonb_build_object(
        'decision_log_id', v_decision_log_id,
        'settings_resolution_id', v_review_resolution_id
      )
    )
  )
  INTO v_domain_event_id;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'id', v_req.id,
      'marketplace_participant_request_id', v_req.id,
      'status', 'pending',
      'decision', 'request_additional_docs',
      'reviewed_at', now(),
      'decision_log_id', v_decision_log_id,
      'domain_event_id', v_domain_event_id
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.marketplace_driver_profile_from_participant_request_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_driver_profile_from_participant_request_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.marketplace_driver_profile_from_participant_request_v1(UUID) TO service_role;

COMMENT ON FUNCTION public.marketplace_driver_profile_from_participant_request_v1(UUID)
  IS 'Materializes the canonical driver_profiles row for an approved freelancer-driver marketplace participant request. Used by the review workflow so self-signup approvals can proceed to Dispatch and FieldOps Mobile V2 route visibility.';

COMMENT ON FUNCTION public.marketplace_participant_request_review_apply_v1(UUID, TEXT, UUID, UUID, BOOLEAN, TEXT, UUID, UUID, JSONB)
IS 'Reviews marketplace participant requests. approve/reject delegate to marketplace_apply_participant_request_v1; approved freelancer-driver requests also materialize canonical driver_profiles readback; request_additional_docs records a pending-state review decision with drawer/backend readback metadata, decision_log, and marketplace event lineage.';

SELECT pg_advisory_unlock(hashtext('202605301520_fieldops_mobile_v2_driver_signup_approval_profile_bridge_v1'));

COMMIT;
