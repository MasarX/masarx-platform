-- Tenant signup approval can explicitly link a reviewed request to an
-- existing organization without creating a duplicate tenant organization.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606110845_tenant_signup_existing_org_link_current_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
BEGIN
  IF NOT public.request_role_is_service_claim_v1() THEN
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
      ON CONFLICT (id) DO UPDATE
      SET
        organization_id = EXCLUDED.organization_id,
        email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        user_type = EXCLUDED.user_type,
        status = EXCLUDED.status,
        access_scope_type = EXCLUDED.access_scope_type,
        access_scope_id = EXCLUDED.access_scope_id
      RETURNING id INTO v_user_id;

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
        'provision_failed',
        SQLERRM,
        jsonb_build_object('sqlstate', SQLSTATE, 'decision', v_decision)
      );
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object('code', 'provision_failed', 'message', SQLERRM, 'sqlstate', SQLSTATE)
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

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  uuid, text, uuid, text, uuid, boolean, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  uuid, text, uuid, text, uuid, boolean, text, jsonb
) IS
  'Tenant signup review implementation. Approval can either defer bootstrap while creating a new organization or explicitly link to an existing organization through validated review metadata without duplicating the tenant.';

SELECT pg_advisory_unlock(hashtext('202606110845_tenant_signup_existing_org_link_current_v1'));

COMMIT;
