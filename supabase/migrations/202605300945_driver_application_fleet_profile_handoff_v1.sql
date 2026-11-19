-- Driver application approval must hand off into canonical fleet eligibility.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605300945_driver_application_fleet_profile_handoff_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.marketplace_provision_freelancer_driver_fleet_profile_v1(
  p_request_id UUID,
  p_actor_user_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_req public.marketplace_participant_requests%ROWTYPE;
  v_status TEXT;
  v_driver_profile_id UUID;
  v_profile_created BOOLEAN := FALSE;
  v_doc RECORD;
  v_doc_type TEXT;
  v_doc_status TEXT;
  v_docs_created INTEGER := 0;
  v_docs_existing INTEGER := 0;
  v_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'marketplace_provision_freelancer_driver_fleet_profile_v1: request_id is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_metadata IS NOT NULL AND jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'marketplace_provision_freelancer_driver_fleet_profile_v1: metadata must be an object'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_req
    FROM public.marketplace_participant_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'marketplace_provision_freelancer_driver_fleet_profile_v1: request % not found', p_request_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_req.requested_participant_type_key <> 'freelancer_driver' THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'not_freelancer_driver');
  END IF;

  IF v_req.status <> 'approved' THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'request_not_approved');
  END IF;

  IF v_req.approved_organization_id IS NULL OR v_req.approved_user_id IS NULL THEN
    RAISE EXCEPTION 'marketplace_provision_freelancer_driver_fleet_profile_v1: approved organization and user are required for request %', v_req.id
      USING ERRCODE = '23514';
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
    RAISE EXCEPTION 'marketplace_provision_freelancer_driver_fleet_profile_v1: no default driver_status lookup row is configured'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.driver_profiles (
    organization_id,
    user_id,
    status,
    hired_at,
    metadata
  )
  VALUES (
    v_req.approved_organization_id,
    v_req.approved_user_id,
    v_status,
    now(),
    jsonb_strip_nulls(
      jsonb_build_object(
        'created_by', 'marketplace_provision_freelancer_driver_fleet_profile_v1',
        'created_correlation_id', v_correlation_id,
        'marketplace_request_id', v_req.id,
        'marketplace_participant_profile_id', v_req.approved_participant_profile_id,
        'application_status_token', v_req.public_status_token,
        'source', 'driver_application_approval',
        'phone', v_req.phone,
        'capabilities_requested', v_req.capabilities_requested
      )
    ) || COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (organization_id, user_id) DO UPDATE
  SET hired_at = COALESCE(public.driver_profiles.hired_at, EXCLUDED.hired_at),
      metadata = COALESCE(public.driver_profiles.metadata, '{}'::jsonb)
        || EXCLUDED.metadata
        || jsonb_build_object('fleet_handoff_refreshed_at', now()),
      updated_at = now()
  RETURNING id, (xmax = 0) INTO v_driver_profile_id, v_profile_created;

  FOR v_doc IN
    SELECT value, ordinality
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(v_req.verification_documents) = 'array' THEN v_req.verification_documents
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS doc(value, ordinality)
  LOOP
    v_doc_type := lower(NULLIF(btrim(COALESCE(v_doc.value->>'document_type_key', v_doc.value->>'type', '')), ''));
    IF v_doc_type IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'driver_document_type'
         AND lv.value = v_doc_type
    ) THEN
      CONTINUE;
    END IF;

    v_doc_status := CASE lower(NULLIF(btrim(COALESCE(v_doc.value->>'status', '')), ''))
      WHEN 'approved' THEN 'verified'
      WHEN 'verified' THEN 'verified'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'expired' THEN 'expired'
      ELSE 'submitted'
    END;

    INSERT INTO public.driver_documents (
      organization_id,
      user_id,
      doc_type,
      status,
      document_ref_hash,
      issued_at,
      expires_at,
      verified_at,
      verified_by_user_id,
      metadata
    )
    SELECT
      v_req.approved_organization_id,
      v_req.approved_user_id,
      v_doc_type,
      v_doc_status,
      NULLIF(btrim(COALESCE(v_doc.value->>'document_ref_hash', '')), ''),
      NULLIF(btrim(COALESCE(v_doc.value->>'issued_at', '')), '')::DATE,
      NULLIF(btrim(COALESCE(v_doc.value->>'expires_at', '')), '')::DATE,
      CASE WHEN v_doc_status = 'verified' THEN now() ELSE NULL END,
      CASE
        WHEN v_doc_status = 'verified'
         AND EXISTS (
           SELECT 1
             FROM public.users verifier
            WHERE verifier.id = p_actor_user_id
              AND verifier.organization_id = v_req.approved_organization_id
         )
          THEN p_actor_user_id
        ELSE NULL
      END,
      jsonb_strip_nulls(
        jsonb_build_object(
          'source', 'driver_application_approval',
          'marketplace_request_id', v_req.id,
          'marketplace_document_index', v_doc.ordinality,
          'marketplace_document_status', v_doc.value->>'status',
          'source_document_ref_present', v_doc.value ? 'document_ref'
        )
      ) || CASE
        WHEN jsonb_typeof(v_doc.value->'metadata') = 'object' THEN v_doc.value->'metadata'
        ELSE '{}'::jsonb
      END
    WHERE NOT EXISTS (
      SELECT 1
        FROM public.driver_documents dd
       WHERE dd.organization_id = v_req.approved_organization_id
         AND dd.user_id = v_req.approved_user_id
         AND dd.doc_type = v_doc_type
         AND dd.metadata->>'marketplace_request_id' = v_req.id::text
         AND dd.metadata->>'marketplace_document_index' = v_doc.ordinality::text
    );

    IF FOUND THEN
      v_docs_created := v_docs_created + 1;
    ELSE
      v_docs_existing := v_docs_existing + 1;
    END IF;
  END LOOP;

  INSERT INTO public.driver_compliance_events (
    id,
    organization_id,
    user_id,
    event_type,
    actor_user_id,
    actor_system,
    payload
  )
  SELECT
    v_event_id,
    v_req.approved_organization_id,
    v_req.approved_user_id,
    'marketplace_driver_approved',
    p_actor_user_id,
    'marketplace_provision_freelancer_driver_fleet_profile_v1',
    jsonb_build_object(
      'driver_profile_id', v_driver_profile_id,
      'marketplace_request_id', v_req.id,
      'marketplace_participant_profile_id', v_req.approved_participant_profile_id,
      'correlation_id', v_correlation_id,
      'documents_created', v_docs_created,
      'documents_existing', v_docs_existing
    )
  WHERE NOT EXISTS (
    SELECT 1
      FROM public.driver_compliance_events dce
     WHERE dce.organization_id = v_req.approved_organization_id
       AND dce.user_id = v_req.approved_user_id
       AND dce.event_type = 'marketplace_driver_approved'
       AND dce.payload->>'marketplace_request_id' = v_req.id::text
  );

  PERFORM public.enqueue_domain_event(
    v_req.approved_organization_id,
    'fleet.driver_onboarding_approved',
    'driver_profile',
    v_driver_profile_id,
    jsonb_build_object(
      'driver_user_id', v_req.approved_user_id,
      'marketplace_request_id', v_req.id,
      'documents_created', v_docs_created
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_req.approved_organization_id,
    'fleet.driver_created',
    'driver_profile',
    v_driver_profile_id,
    'marketplace_participant_request.review',
    CASE WHEN v_profile_created THEN 'created' ELSE 'reconciled' END,
    'marketplace_provision_freelancer_driver_fleet_profile_v1',
    v_correlation_id,
    jsonb_build_object(
      'driver_user_id', v_req.approved_user_id,
      'marketplace_request_id', v_req.id,
      'driver_status_source', 'lookup_values.driver_status',
      'documents_created', v_docs_created,
      'documents_existing', v_docs_existing
    ),
    NULL
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'driver_profile_id', v_driver_profile_id,
    'driver_user_id', v_req.approved_user_id,
    'organization_id', v_req.approved_organization_id,
    'status', v_status,
    'created', v_profile_created,
    'documents_created', v_docs_created,
    'documents_existing', v_docs_existing,
    'correlation_id', v_correlation_id,
    'resolved_from', 'marketplace_participant_request/driver_status'
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
  v_result JSONB := '{}'::jsonb;
  v_fleet_result JSONB := '{}'::jsonb;
  v_review_resolution_id UUID := NULL;
  v_decision_log_id UUID := NULL;
  v_domain_event_id UUID := NULL;
  v_reason TEXT := COALESCE(p_decision_metadata->>'reason', p_decision_metadata->>'note');
  v_effective_metadata JSONB := '{}'::jsonb;
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
      v_decision,
      p_reviewer_user_id,
      p_invited_auth_user_id,
      p_invite_email_sent,
      p_invite_redirect_to,
      p_approved_organization_id,
      p_approved_user_id,
      p_decision_metadata
    );

    SELECT *
      INTO v_req
      FROM public.marketplace_participant_requests
     WHERE id = p_request_id;

    IF COALESCE((v_result->>'ok')::BOOLEAN, FALSE)
       AND COALESCE(v_result->>'status', v_req.status) = 'approved'
       AND v_req.requested_participant_type_key = 'freelancer_driver' THEN
      v_fleet_result := public.marketplace_provision_freelancer_driver_fleet_profile_v1(
        p_request_id,
        p_reviewer_user_id,
        jsonb_build_object('review_result', v_result)
      );

      v_result := v_result
        || jsonb_build_object(
             'driver_profile_id', v_fleet_result->>'driver_profile_id',
             'fleet_driver_profile', v_fleet_result
           );
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

REVOKE ALL ON FUNCTION public.marketplace_provision_freelancer_driver_fleet_profile_v1(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_provision_freelancer_driver_fleet_profile_v1(UUID, UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.marketplace_provision_freelancer_driver_fleet_profile_v1(UUID, UUID, JSONB) TO service_role;

COMMENT ON FUNCTION public.marketplace_provision_freelancer_driver_fleet_profile_v1(UUID, UUID, JSONB)
  IS 'Materializes approved freelancer_driver marketplace applications into canonical fleet driver_profiles, driver_documents, and compliance ledger rows. Row-driven by driver_status and driver_document_type lookups.';

COMMENT ON FUNCTION public.marketplace_participant_request_review_apply_v1(UUID, TEXT, UUID, UUID, BOOLEAN, TEXT, UUID, UUID, JSONB)
  IS 'Reviews marketplace participant requests. approve/reject delegate to marketplace_apply_participant_request_v1, then approved freelancer_driver requests are reconciled into canonical fleet eligibility; request_additional_docs records a pending-state review decision with decision_log and marketplace event lineage.';

SELECT pg_advisory_unlock(hashtext('202605300945_driver_application_fleet_profile_handoff_v1'));

COMMIT;
