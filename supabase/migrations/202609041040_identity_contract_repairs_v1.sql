-- Repair shared identity, workflow-path, branch-governance, dispute, and API Gateway readback contracts.
BEGIN;
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202609041040_identity_contract_repairs_v1'));

CREATE OR REPLACE FUNCTION public.dispute_escalate_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_resource_id UUID;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_dispute public.marketplace_disputes%ROWTYPE;
  v_reason TEXT;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_payload JSONB;
  v_existing_count INT := 0;
  v_new_count INT;
  v_new_status TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'dispute_escalate_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_disputes.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'dispute_escalate_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'dispute_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'dispute_escalate_v1 requires dispute_id'
      USING ERRCODE = '23502';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_args->>'escalation_reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'dispute_escalate_v1 requires non-empty escalation_reason'
      USING ERRCODE = '23502';
  END IF;

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  SELECT * INTO v_dispute
    FROM public.marketplace_disputes
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispute_escalate_v1 dispute_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user()
     AND v_dispute.opened_by_organization_id <> v_org_id
     AND v_dispute.counterparty_organization_id <> v_org_id THEN
    RAISE EXCEPTION 'dispute_escalate_v1 cannot escalate disputes outside caller organization'
      USING ERRCODE = '42501';
  END IF;

  -- Disallow escalation on terminal statuses (resolved/rejected).
  IF v_dispute.status IN ('resolved', 'rejected') THEN
    RAISE EXCEPTION 'dispute_escalate_v1 cannot escalate dispute in terminal status=%', v_dispute.status
      USING ERRCODE = '22023';
  END IF;

  -- Track escalation count in metadata.escalation_count (defaults to 0).
  v_existing_count := COALESCE(
    NULLIF(btrim(COALESCE(v_dispute.metadata->>'escalation_count', '')), '')::INT,
    0
  );
  v_new_count := v_existing_count + 1;

  -- Status transitions to under_review on escalation from open; otherwise unchanged.
  v_new_status := CASE WHEN v_dispute.status = 'open' THEN 'under_review' ELSE v_dispute.status END;

  UPDATE public.marketplace_disputes
     SET status = v_new_status,
         metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata
                    || jsonb_build_object(
                         'last_escalated_at', now(),
                         'last_escalated_by_user_id', v_user_id,
                         'last_escalation_reason', v_reason,
                         'escalation_count', v_new_count
                       ),
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'escalation_reason', v_reason,
    'prior_status', v_dispute.status,
    'new_status', v_new_status,
    'escalation_count', v_new_count,
    'metadata', v_metadata,
    'escalated_by_user_id', v_user_id
  ));

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_dispute.opened_by_organization_id, 'dispute.escalate', 'marketplace_dispute', v_resource_id,
    'dispute_escalate_v1', v_new_status,
    v_payload,
    'dispute_escalate_v1', v_correlation_id
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_dispute.opened_by_organization_id, 'dispute.escalated', 'marketplace_dispute', v_resource_id,
    v_payload,
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dispute_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'status', v_new_status,
    'escalation_count', v_new_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  p_request_id uuid,
  p_decision text,
  p_reviewer_user_id uuid DEFAULT NULL::uuid,
  p_decision_reason text DEFAULT NULL::text,
  p_invited_auth_user_id uuid DEFAULT NULL::uuid,
  p_invite_email_sent boolean DEFAULT false,
  p_invite_redirect_to text DEFAULT NULL::text,
  p_decision_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_decision TEXT := lower(btrim(COALESCE(p_decision, '')));

  v_policy JSONB;
  v_req public.tenant_signup_requests%ROWTYPE;

  v_provision_on_approval BOOLEAN := TRUE;
  v_user_type TEXT := 'ops_admin';
  v_role_key TEXT := 'ops_admin';

  v_org_id UUID := NULL;
  v_user_id UUID := NULL;
  v_role_id UUID := NULL;

  v_invite_redirect_to TEXT := NULL;
  v_org_slug TEXT := NULL;
  v_previous_org_onboarding_source TEXT := NULL;
  v_existing_org_text TEXT := NULL;
  v_existing_org_id UUID := NULL;
  v_existing_org_linked BOOLEAN := FALSE;
  v_existing_user public.users%ROWTYPE;
  v_provision_error_code TEXT := 'provision_failed';
BEGIN
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
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'service_role_required')
    );
  END IF;

  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_id_required'));
  END IF;

  IF v_decision IN ('approve') THEN
    v_decision := 'approved';
  ELSIF v_decision IN ('reject') THEN
    v_decision := 'rejected';
  END IF;

  IF v_decision NOT IN ('approved', 'rejected') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_decision'));
  END IF;

  SELECT *
    INTO v_req
    FROM public.tenant_signup_requests
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
        'already_processed', TRUE,
        'approved_organization_id', v_req.approved_organization_id,
        'approved_user_id', v_req.approved_user_id
      )
    );
  END IF;

  IF v_decision = 'rejected' THEN
    UPDATE public.tenant_signup_requests
       SET status = 'rejected',
           review_decision = 'rejected',
           reviewed_at = now(),
           reviewed_by = COALESCE(p_reviewer_user_id, reviewed_by),
           review_reason = NULLIF(btrim(COALESCE(p_decision_reason, '')), ''),
           decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
             || COALESCE(p_decision_metadata, '{}'::jsonb)
             || jsonb_build_object('decision', 'rejected', 'review_applied_at', now()),
           updated_at = now()
     WHERE id = v_req.id;

    RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'status', 'rejected');
  END IF;

  IF p_invited_auth_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invited_auth_user_required'));
  END IF;

  v_policy := public.tenant_signup_policy_v1();
  v_provision_on_approval := public.tenant_signup_policy_bool_v1(
    v_policy,
    ARRAY['onboarding', 'provision_on_approval'],
    TRUE
  );

  v_user_type := lower(COALESCE(NULLIF(btrim(v_policy #>> ARRAY['onboarding', 'initial_user_type']), ''), 'ops_admin'));
  v_role_key := lower(COALESCE(NULLIF(btrim(v_policy #>> ARRAY['onboarding', 'initial_role_key']), ''), v_user_type));

  v_invite_redirect_to := COALESCE(
    NULLIF(btrim(COALESCE(p_invite_redirect_to, '')), ''),
    NULLIF(btrim(COALESCE(v_policy #>> ARRAY['onboarding', 'invite_redirect_to'], '')), '')
  );

  v_existing_org_text := NULLIF(btrim(COALESCE(
    p_decision_metadata->>'approved_existing_organization_id',
    p_decision_metadata->>'existing_organization_id',
    ''
  )), '');

  IF v_existing_org_text IS NOT NULL THEN
    BEGIN
      v_existing_org_id := v_existing_org_text::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RETURN jsonb_build_object(
          'ok', FALSE,
          'error', jsonb_build_object('code', 'approved_existing_organization_id_invalid')
        );
    END;

    SELECT o.id, o.slug
      INTO v_org_id, v_org_slug
      FROM public.organizations o
     WHERE o.id = v_existing_org_id;

    IF v_org_id IS NULL THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object('code', 'approved_existing_organization_not_found')
      );
    END IF;

    IF NOT v_provision_on_approval THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object('code', 'approved_existing_organization_requires_provisioning')
      );
    END IF;

    v_existing_org_linked := TRUE;
  END IF;

  BEGIN
    IF v_provision_on_approval THEN
      IF NOT v_existing_org_linked THEN
        v_org_slug := public.tenant_signup_next_org_slug_v1(v_req.organization_slug, v_req.organization_name);

        v_previous_org_onboarding_source := current_setting('app.organization_onboarding_source', true);
        PERFORM set_config('app.organization_onboarding_source', 'tenant_signup_review_apply_v1', true);

        INSERT INTO public.organizations (
          name,
          slug
        ) VALUES (
          v_req.organization_name,
          v_org_slug
        )
        RETURNING id INTO v_org_id;

        PERFORM set_config('app.organization_onboarding_source', COALESCE(v_previous_org_onboarding_source, ''), true);
      END IF;

      INSERT INTO public.users (
        id,
        organization_id,
        email,
        full_name,
        user_type,
        status,
        access_scope_type,
        access_scope_id
      ) VALUES (
        p_invited_auth_user_id,
        v_org_id,
        v_req.email,
        COALESCE(NULLIF(v_req.full_name, ''), v_req.email),
        v_user_type,
        'active',
        'tenant',
        NULL
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id INTO v_user_id;

      IF v_user_id IS NULL THEN
        SELECT *
          INTO v_existing_user
          FROM public.users
         WHERE id = p_invited_auth_user_id
         FOR UPDATE;

        IF v_existing_user.id IS NULL
           OR v_existing_user.organization_id IS DISTINCT FROM v_org_id
           OR lower(btrim(COALESCE(v_existing_user.email, '')))
              IS DISTINCT FROM lower(btrim(COALESCE(v_req.email, ''))) THEN
          v_provision_error_code := 'invited_auth_user_conflict';
          RAISE EXCEPTION 'tenant signup invited auth user conflicts with the approved organization or email'
            USING ERRCODE = '23505';
        END IF;

        v_user_id := v_existing_user.id;
      END IF;

      PERFORM public.provision_rbac_roles_from_templates_v1(
        v_org_id,
        ARRAY[v_role_key],
        NULL
      );

      SELECT r.id
        INTO v_role_id
        FROM public.rbac_roles r
       WHERE r.organization_id = v_org_id
         AND r.key = v_role_key
       LIMIT 1;

      IF v_role_id IS NOT NULL THEN
        INSERT INTO public.rbac_user_role_assignments (
          organization_id,
          user_id,
          role_id,
          assigned_by_user_id,
          metadata
        ) VALUES (
          v_org_id,
          v_user_id,
          v_role_id,
          NULL,
          jsonb_build_object(
            'source', 'tenant_signup_review_apply_v1',
            'request_id', v_req.id
          )
        )
        ON CONFLICT (organization_id, user_id, role_id) WHERE revoked_at IS NULL
        DO UPDATE SET
          metadata = public.rbac_user_role_assignments.metadata || EXCLUDED.metadata,
          updated_at = now();
      END IF;
    END IF;
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('app.organization_onboarding_source', COALESCE(v_previous_org_onboarding_source, ''), true);
      PERFORM public.tenant_signup_request_record_error_v1(
        v_req.id,
        v_provision_error_code,
        SQLERRM,
        jsonb_build_object('sqlstate', SQLSTATE, 'decision', v_decision)
      );
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object(
          'code', v_provision_error_code,
          'message', SQLERRM,
          'sqlstate', SQLSTATE
        )
      );
  END;

  IF v_user_id IS NULL AND p_invited_auth_user_id IS NOT NULL THEN
    SELECT u.id
      INTO v_user_id
      FROM public.users u
     WHERE u.id = p_invited_auth_user_id
     LIMIT 1;
  END IF;

  UPDATE public.tenant_signup_requests
     SET status = 'approved',
         review_decision = 'approved',
         reviewed_at = now(),
         reviewed_by = COALESCE(p_reviewer_user_id, reviewed_by),
         review_reason = NULLIF(btrim(COALESCE(p_decision_reason, '')), ''),
         decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
           || COALESCE(p_decision_metadata, '{}'::jsonb)
           || jsonb_build_object('decision', 'approved', 'review_applied_at', now())
           || CASE
                WHEN v_existing_org_linked THEN jsonb_build_object(
                  'approved_existing_organization_id', v_org_id,
                  'existing_organization_linked', TRUE
                )
                ELSE '{}'::jsonb
              END,
         approved_organization_id = v_org_id,
         approved_user_id = v_user_id,
         approved_auth_user_id = p_invited_auth_user_id,
         invite_email_sent_at = CASE
           WHEN COALESCE(p_invite_email_sent, FALSE) THEN now()
           ELSE invite_email_sent_at
         END,
         invite_redirect_to = v_invite_redirect_to,
         last_error_code = NULL,
         last_error_message = NULL,
         last_error_at = NULL,
         updated_at = now()
   WHERE id = v_req.id;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'id', v_req.id,
      'status', 'approved',
      'organization_id', v_org_id,
      'approved_organization_id', v_org_id,
      'user_id', v_user_id,
      'approved_user_id', v_user_id,
      'approved_auth_user_id', p_invited_auth_user_id,
      'organization_slug', v_org_slug,
      'invite_redirect_to', v_invite_redirect_to,
      'linked_existing_organization', v_existing_org_linked
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.resolve_path_text(p_payload JSONB, p_paths TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_token TEXT;
  v_normalized_token TEXT;
  v_candidate JSONB;
  v_path_list TEXT[];
  v_paths_json JSONB;
BEGIN
  IF p_payload IS NULL OR p_paths IS NULL OR btrim(p_paths) = '' THEN RETURN NULL; END IF;
  IF left(btrim(p_paths), 1) = '[' THEN
    BEGIN
      v_paths_json := p_paths::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'resolve_path_text requires a valid JSON string array' USING ERRCODE = '22023';
    END;
    IF jsonb_typeof(v_paths_json) IS DISTINCT FROM 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_paths_json) AS item(value)
                  WHERE jsonb_typeof(value) IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'resolve_path_text requires a JSON string array' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(array_agg(value ORDER BY ordinal), ARRAY[]::TEXT[]) INTO v_path_list
      FROM jsonb_array_elements_text(v_paths_json) WITH ORDINALITY AS item(value, ordinal);
  ELSE
    v_path_list := string_to_array(p_paths, '|');
  END IF;
  FOREACH v_token IN ARRAY v_path_list LOOP
    v_token := btrim(v_token);
    IF v_token = '' THEN CONTINUE; END IF;
    v_normalized_token := regexp_replace(v_token, '^\$\.?', '');
    IF v_normalized_token = '' THEN v_candidate := p_payload;
    ELSE v_candidate := jsonb_resolve_path(p_payload, v_normalized_token);
    END IF;
    IF v_candidate IS NOT NULL AND v_candidate::TEXT <> 'null' THEN
      IF jsonb_typeof(v_candidate) IN ('string', 'number', 'boolean') THEN RETURN v_candidate #>> '{}'; END IF;
      RETURN v_candidate::TEXT;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.branch_zone_assign_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_branch_id UUID;
  v_zone_id UUID;
  v_priority INT := NULLIF(p_args->>'priority', '')::int;
  v_branch_zone_id UUID;
  v_branch public.branches%ROWTYPE;
  v_already BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'branch_zone_assign_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_branch_id := NULLIF(p_args->>'branch_id', '')::uuid;
  v_zone_id := NULLIF(p_args->>'zone_id', '')::uuid;
  IF v_branch_id IS NULL OR v_zone_id IS NULL THEN
    RAISE EXCEPTION 'branch_zone_assign_v1 requires branch_id and zone_id' USING ERRCODE = '23502';
  END IF;

  -- Authorize before lookup so a missing branch cannot disclose existence.
  PERFORM public.assert_capability_v1('agreements.write');

  SELECT * INTO v_branch FROM public.branches WHERE id = v_branch_id;
  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'branch_zone_assign_v1 branch % not found', v_branch_id USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('agreements.write', 'tenant', v_branch.organization_id);

  IF NOT public.is_platform_user() AND v_branch.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'branch_zone_assign_v1 branch % outside tenant scope', v_branch_id USING ERRCODE = '42501';
  END IF;

  -- Idempotent: branch_zones has unique constraint on zone_id; if already
  -- mapped to this branch, return existing row id.
  SELECT id INTO v_branch_zone_id FROM public.branch_zones
    WHERE zone_id = v_zone_id AND branch_id = v_branch_id;
  IF v_branch_zone_id IS NOT NULL THEN
    v_already := TRUE;
  ELSE
    -- If zone is mapped to a different branch, raise (caller should call
    -- branch_zone_unassign_v1 first to avoid silent reassignment).
    IF EXISTS (SELECT 1 FROM public.branch_zones WHERE zone_id = v_zone_id) THEN
      RAISE EXCEPTION 'branch_zone_assign_v1: zone % already assigned (call branch_zone_unassign_v1 first)', v_zone_id
        USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.branch_zones (branch_id, zone_id, priority)
    VALUES (v_branch_id, v_zone_id, v_priority)
    RETURNING id INTO v_branch_zone_id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_branch.organization_id, 'branch_zone.assigned', 'branch_zone', v_branch_zone_id, v_correlation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'branch_id', v_branch_id,
        'zone_id', v_zone_id,
        'priority', v_priority
      )),
      'pending'
    );
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_branch.organization_id,
    p_decision_category := 'branches.zone_assign',
    p_resource_type := 'branch_zone',
    p_resource_id := v_branch_zone_id,
    p_decision_point := 'branch_zone_assign_v1',
    p_decision_outcome := CASE WHEN v_already THEN 'already_assigned' ELSE 'assigned' END,
    p_performed_by_system := 'branch_zone_assign_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object('branch_id', v_branch_id, 'zone_id', v_zone_id, 'priority', v_priority)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_zone_id', v_branch_zone_id,
    'already_processed', v_already,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.branch_zone_unassign_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_branch_zone_id UUID := NULLIF(p_args->>'branch_zone_id', '')::uuid;
  v_branch_id UUID := NULLIF(p_args->>'branch_id', '')::uuid;
  v_zone_id UUID := NULLIF(p_args->>'zone_id', '')::uuid;
  v_row public.branch_zones%ROWTYPE;
  v_branch_org UUID;
  v_already BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'branch_zone_unassign_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  IF v_branch_zone_id IS NULL AND (v_branch_id IS NULL OR v_zone_id IS NULL) THEN
    RAISE EXCEPTION 'branch_zone_unassign_v1 requires branch_zone_id or (branch_id + zone_id)'
      USING ERRCODE = '23502';
  END IF;

  -- Authorize before lookup so a missing row cannot bypass the write gate.
  PERFORM public.assert_capability_v1('agreements.write');

  IF v_branch_zone_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.branch_zones WHERE id = v_branch_zone_id FOR UPDATE;
  ELSE
    SELECT * INTO v_row FROM public.branch_zones
      WHERE branch_id = v_branch_id AND zone_id = v_zone_id FOR UPDATE;
  END IF;

  IF v_row.id IS NULL THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'ok', TRUE,
      'branch_zone_id', v_branch_zone_id,
      'already_processed', TRUE,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', NULL
    ));
  ELSE
    SELECT organization_id INTO v_branch_org FROM public.branches WHERE id = v_row.branch_id;
    PERFORM public.assert_capability_v1('agreements.write', 'tenant', v_branch_org);
    IF NOT public.is_platform_user() AND v_branch_org <> public.current_user_org_id() THEN
      RAISE EXCEPTION 'branch_zone_unassign_v1 branch_zone % outside tenant scope', v_row.id USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.branch_zones WHERE id = v_row.id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_branch_org, 'branch_zone.unassigned', 'branch_zone', v_row.id, v_correlation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'branch_id', v_row.branch_id,
        'zone_id', v_row.zone_id
      )),
      'pending'
    );
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := COALESCE(v_branch_org, public.current_user_org_id()),
    p_decision_category := 'branches.zone_unassign',
    p_resource_type := 'branch_zone',
    p_resource_id := COALESCE(v_row.id, v_branch_zone_id),
    p_decision_point := 'branch_zone_unassign_v1',
    p_decision_outcome := CASE WHEN v_already THEN 'already_unassigned' ELSE 'unassigned' END,
    p_performed_by_system := 'branch_zone_unassign_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'branch_zone_id', v_branch_zone_id,
      'branch_id', v_branch_id,
      'zone_id', v_zone_id
    ))
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_zone_id', COALESCE(v_row.id, v_branch_zone_id),
    'already_processed', v_already,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.add_branch_member_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_branch_id UUID;
  v_member_user_id UUID;
  v_role_key TEXT := NULLIF(btrim(lower(COALESCE(p_args->>'role_key', ''))), '');
  v_effective_from TIMESTAMPTZ := COALESCE(NULLIF(p_args->>'effective_from', '')::timestamptz, now());
  v_metadata JSONB := COALESCE(p_args->'metadata', NULL);
  v_branch public.branches%ROWTYPE;
  v_membership_id UUID;
  v_already BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'add_branch_member_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_branch_id := NULLIF(p_args->>'branch_id', '')::uuid;
  v_member_user_id := NULLIF(p_args->>'user_id', '')::uuid;
  IF v_branch_id IS NULL OR v_member_user_id IS NULL OR v_role_key IS NULL THEN
    RAISE EXCEPTION 'add_branch_member_v1 requires branch_id, user_id, role_key' USING ERRCODE = '23502';
  END IF;

  -- Authorize before lookup so a missing branch cannot disclose existence.
  PERFORM public.assert_capability_v1('agreements.write');

  SELECT * INTO v_branch FROM public.branches WHERE id = v_branch_id;
  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'add_branch_member_v1 branch % not found', v_branch_id USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('agreements.write', 'tenant', v_branch.organization_id);

  IF NOT public.is_platform_user() AND v_branch.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'add_branch_member_v1 branch % outside tenant scope', v_branch_id USING ERRCODE = '42501';
  END IF;

  -- Idempotent: existing active membership for same (branch, user, role) -> already_processed
  SELECT id INTO v_membership_id
    FROM public.branch_memberships
   WHERE branch_id = v_branch_id
     AND user_id = v_member_user_id
     AND role_key = v_role_key
     AND is_active IS TRUE
   ORDER BY effective_from DESC
   LIMIT 1;

  IF v_membership_id IS NOT NULL THEN
    v_already := TRUE;
  ELSE
    INSERT INTO public.branch_memberships (
      branch_id, user_id, role_key, effective_from, metadata
    ) VALUES (
      v_branch_id, v_member_user_id, v_role_key, v_effective_from, v_metadata
    ) RETURNING id INTO v_membership_id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_branch.organization_id, 'branch_membership.added', 'branch_membership', v_membership_id, v_correlation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'branch_id', v_branch_id,
        'user_id', v_member_user_id,
        'role_key', v_role_key,
        'effective_from', to_jsonb(v_effective_from)
      )),
      'pending'
    );
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_branch.organization_id,
    p_decision_category := 'branches.member_add',
    p_resource_type := 'branch_membership',
    p_resource_id := v_membership_id,
    p_decision_point := 'add_branch_member_v1',
    p_decision_outcome := CASE WHEN v_already THEN 'already_active' ELSE 'added' END,
    p_performed_by_system := 'add_branch_member_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object(
      'branch_id', v_branch_id,
      'user_id', v_member_user_id,
      'role_key', v_role_key
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_membership_id', v_membership_id,
    'already_processed', v_already,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION api.dispute_escalate_v1(p_args JSONB)
RETURNS JSONB LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$ SELECT public.dispute_escalate_v1(COALESCE(p_args, '{}'::jsonb)); $function$;

CREATE OR REPLACE FUNCTION api.branch_zone_assign_v1(p_args JSONB)
RETURNS JSONB LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$ SELECT public.branch_zone_assign_v1(COALESCE(p_args, '{}'::jsonb)); $function$;

CREATE OR REPLACE FUNCTION api.branch_zone_unassign_v1(p_args JSONB)
RETURNS JSONB LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$ SELECT public.branch_zone_unassign_v1(COALESCE(p_args, '{}'::jsonb)); $function$;

CREATE OR REPLACE FUNCTION api.add_branch_member_v1(p_args JSONB)
RETURNS JSONB LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$ SELECT public.add_branch_member_v1(COALESCE(p_args, '{}'::jsonb)); $function$;

REVOKE ALL ON FUNCTION public.dispute_escalate_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispute_escalate_v1(JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.dispute_escalate_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.dispute_escalate_v1(JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.branch_zone_assign_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.branch_zone_assign_v1(JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.branch_zone_assign_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.branch_zone_assign_v1(JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.branch_zone_unassign_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.branch_zone_unassign_v1(JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.branch_zone_unassign_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.branch_zone_unassign_v1(JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.add_branch_member_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_branch_member_v1(JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.add_branch_member_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.add_branch_member_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.dispute_escalate_v1(JSONB) IS 'Canonical marketplace dispute escalation. Uses a UUID correlation id and marketplace_disputes.write capability.';
COMMENT ON FUNCTION workflow_handlers.resolve_path_text(JSONB, TEXT) IS 'Resolves the first non-null value from a scalar path, pipe-delimited paths, or a JSON string-array of paths after optional $ normalization.';
COMMENT ON FUNCTION public.branch_zone_assign_v1(JSONB) IS 'Canonical branch-zone assignment. Capability: agreements.write.';
COMMENT ON FUNCTION public.branch_zone_unassign_v1(JSONB) IS 'Canonical idempotent branch-zone unassignment. Authorizes before lookup and does not emit audit rows for an already-missing mapping. Capability: agreements.write.';
COMMENT ON FUNCTION public.add_branch_member_v1(JSONB) IS 'Canonical idempotent branch member assignment. Capability: agreements.write.';

CREATE OR REPLACE VIEW public.v_api_gateway_request_directory
  WITH (security_invoker = true) AS
SELECT
  agr.id AS id,
  agr.id AS request_id,
  agr.organization_id,
  agr.client_id,
  c.name AS client_label,
  agr.sender_id,
  snd.name AS sender_label,
  agr.source_id,
  ws.name AS source_label,
  ws.organization_id AS source_org_id,
  agr.correlation_id,
  agr.route_id,
  ar.route_name,
  ar.pack_id AS route_pack_id,
  arp.name AS route_pack_name,
  upper(agr.method) AS method,
  agr.path,
  agr.query_string,
  agr.request_headers,
  agr.request_body,
  agr.outbound_call_id,
  oc.status AS outbound_status,
  COALESCE(oc.response_status_code, CASE WHEN rej.id IS NOT NULL THEN 400 END) AS status_code,
  CASE
    WHEN shp.shipment_id IS NOT NULL
      AND NOT (
        COALESCE(oc.status IN ('failed', 'permanently_failed'), FALSE)
        OR COALESCE(oc.response_status_code >= 400, FALSE)
      )
      THEN NULL
    WHEN rej.id IS NOT NULL THEN 'api_gateway_source_missing_sender_client'
    WHEN oc.response_status_code = 401 THEN 'unauthorized'
    WHEN oc.response_status_code = 403 THEN 'forbidden'
    WHEN oc.response_status_code = 404 THEN 'not_found'
    WHEN oc.response_status_code = 422 THEN 'validation_failed'
    WHEN oc.response_status_code = 429 THEN 'rate_limited'
    WHEN oc.response_status_code >= 500 AND oc.response_status_code < 504 THEN 'upstream_error'
    WHEN oc.response_status_code = 504 THEN 'upstream_timeout'
    WHEN oc.response_status_code >= 400 THEN COALESCE(NULLIF(oc.error_message, ''), 'error')
    WHEN oc.status IN ('failed', 'permanently_failed') THEN COALESCE(NULLIF(oc.error_message, ''), oc.status)
    WHEN agr.outbound_call_id IS NULL AND agr.workflow_run_id IS NULL THEN 'not_dispatched'
    ELSE NULL
  END AS error_code,
  CASE
    WHEN shp.shipment_id IS NOT NULL THEN 'shipment_materialized'
    WHEN rej.id IS NOT NULL THEN 'source_binding_rejected'
    WHEN oc.status IN ('failed', 'permanently_failed') OR COALESCE(oc.response_status_code, 0) >= 400 THEN 'provider_failed'
    WHEN agr.workflow_run_id IS NOT NULL THEN 'workflow_queued'
    WHEN agr.outbound_call_id IS NOT NULL THEN COALESCE(oc.status, 'outbound_created')
    ELSE 'not_dispatched'
  END AS intake_state,
  agr.workflow_run_id,
  agr.settings_resolution_id,
  shp.shipment_id,
  shp.tracking_number,
  shp.shipment_status,
  agr.received_at,
  agr.received_at AS occurred_at,
  agr.created_at,
  agr.updated_at,
  COALESCE(NULLIF(oc.error_message, ''), rej.decision_reason) AS outbound_error_message,
  COALESCE(NULLIF(agr.request_headers->>'idempotency-key', ''), NULLIF(agr.request_headers->>'x-idempotency-key', '')) AS idempotency_key,
  NULLIF(agr.request_headers->>'x-masarx-replay-of', '') AS replay_of_request_id,
  public.api_gateway_route_canonical_intent_v1(COALESCE(ar.policy, '{}'::jsonb)) AS mutation_intent,
  COALESCE(NULLIF(req_map.policy->>'mapping_config_id', ''), NULLIF(map_decision.decision_inputs #>> '{mapping,mapping_config_id}', '')) AS request_mapping_config_id,
  COALESCE(NULLIF(req_map.policy->>'mapping_key', ''), NULLIF(map_decision.decision_inputs #>> '{mapping,mapping_key}', '')) AS request_mapping_key,
  COALESCE(NULLIF(req_map.policy->>'mapping_type', ''), NULLIF(map_decision.decision_inputs #>> '{mapping,mapping_type}', '')) AS request_mapping_type,
  COALESCE(NULLIF(req_map.policy->>'target', ''), NULLIF(map_decision.decision_inputs #>> '{mapping,target}', '')) AS request_mapping_target,
  (map_decision.id IS NOT NULL) AS request_mapping_applied,
  mat.action_id AS materialization_action_id,
  mat.operation AS materialization_operation,
  rcp.id AS recipient_id,
  rcp.name AS recipient_label,
  rcp.external_id AS recipient_external_id,
  dest.id AS destination_address_id,
  dest.city AS destination_city,
  dest.validation_status AS destination_validation_status
FROM public.api_gateway_requests agr
LEFT JOIN public.api_routes ar
  ON ar.id = agr.route_id
LEFT JOIN public.api_route_packs arp
  ON arp.id = ar.pack_id
LEFT JOIN public.webhook_sources ws
  ON ws.id = agr.source_id
LEFT JOIN public.clients c
  ON c.id = agr.client_id
LEFT JOIN public.senders snd
  ON snd.id = agr.sender_id
LEFT JOIN public.outbound_calls oc
  ON oc.id = agr.outbound_call_id
LEFT JOIN LATERAL (
  SELECT COALESCE(
    ar.policy->'request_mapping',
    ar.policy #> '{mapping_studio,request_mapping}',
    ar.policy #> '{mapping_studio,request_config,request_mapping}',
    '{}'::jsonb
  ) AS policy
) req_map ON TRUE
LEFT JOIN LATERAL (
  SELECT
    dl.id,
    dl.decision_inputs
  FROM public.decision_log dl
  WHERE dl.resource_type = 'api_gateway_request'
    AND dl.resource_id = agr.id
    AND dl.decision_point = 'api_gateway_request_mapping'
    AND dl.decision_outcome = 'applied'
  ORDER BY dl."timestamp" DESC
  LIMIT 1
) map_decision ON TRUE
LEFT JOIN LATERAL (
  SELECT
    dl.id,
    dl.decision_reason
  FROM public.decision_log dl
  WHERE dl.resource_type = 'api_gateway_request'
    AND dl.resource_id = agr.id
    AND dl.decision_point = 'api_gateway_source_sender_client_checked'
    AND dl.decision_outcome = 'rejected'
  ORDER BY dl."timestamp" DESC
  LIMIT 1
) rej ON TRUE
LEFT JOIN LATERAL (
  SELECT
    s.id AS shipment_id,
    s.client_id,
    s.tracking_number,
    s.status AS shipment_status,
    s.recipient_id,
    s.destination_address_id
  FROM public.shipments s
  WHERE s.organization_id = agr.organization_id
    AND (
      s.metadata #>> '{source,api_gateway_request_id}' = agr.id::text
      OR EXISTS (
        SELECT 1
        FROM public.shipment_actions sa
        WHERE sa.shipment_id = s.id
          AND sa.organization_id = agr.organization_id
          AND sa.action_data->>'api_gateway_request_id' = agr.id::text
          AND (
            sa.action_type = 'api_gateway_materialized'
            OR (
              sa.action_type IN ('address_update', 'status_change')
              AND sa.performed_by_system IN (
                'workflow_handlers.process_api_gateway_shipment_update_v1',
                'workflow_handlers.process_api_gateway_outbound_response_v1'
              )
            )
          )
      )
    )
  ORDER BY
    CASE
      WHEN s.metadata #>> '{source,api_gateway_request_id}' = agr.id::text THEN 0
      ELSE 1
    END,
    s.created_at DESC
  LIMIT 1
) shp ON TRUE
LEFT JOIN LATERAL (
  SELECT
    sa.id AS action_id,
    COALESCE(
      NULLIF(sa.action_data->>'operation', ''),
      CASE
        WHEN sa.action_type = 'address_update' THEN 'updated'
        WHEN sa.action_type = 'status_change' AND lower(COALESCE(sa.canonical_status, '')) IN ('cancelled', 'canceled') THEN 'cancelled'
        WHEN sa.action_type = 'status_change' THEN 'status_changed'
        ELSE NULLIF(sa.action_type, '')
      END
    ) AS operation
  FROM public.shipment_actions sa
  WHERE sa.organization_id = agr.organization_id
    AND sa.action_data->>'api_gateway_request_id' = agr.id::text
    AND (
      sa.action_type = 'api_gateway_materialized'
      OR (
        sa.action_type IN ('address_update', 'status_change')
        AND sa.performed_by_system IN (
          'workflow_handlers.process_api_gateway_shipment_update_v1',
          'workflow_handlers.process_api_gateway_outbound_response_v1'
        )
      )
    )
  ORDER BY
    CASE
      WHEN sa.action_type IN ('address_update', 'status_change') THEN 0
      WHEN sa.action_type = 'api_gateway_materialized' THEN 1
      ELSE 2
    END,
    sa."timestamp" DESC,
    sa.created_at DESC
  LIMIT 1
) mat ON TRUE
LEFT JOIN public.recipients rcp
  ON rcp.id = shp.recipient_id
 AND rcp.client_id = shp.client_id
LEFT JOIN public.addresses dest
  ON dest.id = shp.destination_address_id
 AND dest.client_id = shp.client_id;

COMMENT ON VIEW public.v_api_gateway_request_directory IS
  'Console V2 request-first API gateway intake projection. Starts from api_gateway_requests so failed pre-dispatch intake remains visible; linked canonical shipments project as shipment_materialized while provider failures and source-binding rejections remain visible as diagnostics. Shipment handoff resolves from direct shipment metadata or append-only API Gateway shipment action lineage, including create materialization plus update/delete provider-success actions. Request mapping, idempotency/replay, materialization action, recipient, and destination readback remain visible in the same Console request context.';

REVOKE ALL ON public.v_api_gateway_request_directory FROM PUBLIC;
REVOKE ALL ON public.v_api_gateway_request_directory FROM anon;
REVOKE ALL ON public.v_api_gateway_request_directory FROM authenticated;
GRANT SELECT ON public.v_api_gateway_request_directory TO service_role;

COMMIT;
