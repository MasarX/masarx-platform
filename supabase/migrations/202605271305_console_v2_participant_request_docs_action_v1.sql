-- Console V2 Network participant applications: expose the existing
-- request-additional-documents review action through canonical lookup rows and
-- strengthen backend readback lineage for the pending-state review decision.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605271305_console_v2_participant_request_docs_action_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  scope_type,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'marketplace_participant_application_doc_kind',
  'Non-driver marketplace participant application document kind taxonomy consumed by Console V2 Network participant applications request-docs review.',
  'global',
  'operations',
  'tier_1',
  false
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  scope_type = EXCLUDED.scope_type,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

WITH lookup_rows AS (
  SELECT *
  FROM (
    VALUES
      ('commercial_registration', 'Commercial registration', 'Commercial registration document required for marketplace participant onboarding.', 10, true, jsonb_build_object('tone', 'info')),
      ('vat_certificate', 'VAT certificate', 'VAT certificate required for tax-backed participant onboarding.', 20, false, jsonb_build_object('tone', 'info')),
      ('operating_license', 'Operating license', 'Operating license required for regulated carrier or fleet onboarding.', 30, false, jsonb_build_object('tone', 'info')),
      ('insurance_certificate', 'Insurance certificate', 'Insurance certificate required before active partner operations.', 40, false, jsonb_build_object('tone', 'info')),
      ('bank_account_letter', 'Bank account letter', 'Bank account letter required for payout settlement readiness.', 50, false, jsonb_build_object('tone', 'neutral'))
  ) AS v(value, label, description, sort_order, is_default, metadata)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  r.value,
  r.label,
  r.description,
  r.sort_order,
  r.is_default,
  'active',
  r.metadata
FROM public.lookup_definitions d
JOIN lookup_rows r ON d.category = 'marketplace_participant_application_doc_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  effective_until = NULL,
  retired_at = NULL,
  metadata = EXCLUDED.metadata,
  updated_at = now();

UPDATE public.lookup_values v
SET
  metadata = COALESCE(v.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'tone', COALESCE(v.metadata->>'tone', 'warn'),
      'allowed_actions', jsonb_build_array('approve', 'reject', 'request_additional_docs')
    ),
  updated_at = now()
FROM public.lookup_definitions d
WHERE d.id = v.lookup_definition_id
  AND d.category = 'marketplace_participant_request_status'
  AND v.value = 'pending';

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

COMMENT ON FUNCTION public.marketplace_participant_request_review_apply_v1(UUID, TEXT, UUID, UUID, BOOLEAN, TEXT, UUID, UUID, JSONB)
IS 'Reviews marketplace participant requests. approve/reject delegate to marketplace_apply_participant_request_v1; request_additional_docs records a pending-state review decision with drawer/backend readback metadata, decision_log, and marketplace event lineage.';

SELECT pg_advisory_unlock(hashtext('202605271305_console_v2_participant_request_docs_action_v1'));

COMMIT;
