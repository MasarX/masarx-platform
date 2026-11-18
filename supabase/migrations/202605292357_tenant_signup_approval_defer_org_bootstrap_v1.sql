BEGIN;

SELECT pg_advisory_lock(hashtext('202605292357_tenant_signup_approval_defer_org_bootstrap_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

CREATE OR REPLACE FUNCTION public.trigger_bootstrap_tenant_onboarding_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_source TEXT := NULLIF(btrim(COALESCE(current_setting('app.organization_onboarding_source', true), '')), '');
  v_defer_sources JSONB := COALESCE(v_policy #> ARRAY['organization_insert_trigger', 'defer_sources'], '[]'::jsonb);
BEGIN
  IF v_source IS NOT NULL
     AND jsonb_typeof(v_defer_sources) = 'array'
     AND EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(v_defer_sources) AS source(value)
       WHERE source.value = v_source
     ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.bootstrap_tenant_onboarding_v1(NEW.id, 'trigger:organizations.insert');
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trigger_bootstrap_tenant_onboarding_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trigger_bootstrap_tenant_onboarding_v1() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_bootstrap_tenant_onboarding_v1() TO service_role;

COMMENT ON FUNCTION public.trigger_bootstrap_tenant_onboarding_v1() IS
  'Organizations insert bootstrap trigger. Sources listed in saas_onboarding_policy.organization_insert_trigger.defer_sources are deferred to the explicit onboarding readiness bootstrap path.';

DO $onboarding_policy$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_defer_sources JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'saas_onboarding_policy global settings missing';
  END IF;

  v_defer_sources := COALESCE(v_current #> ARRAY['organization_insert_trigger', 'defer_sources'], '[]'::jsonb);
  IF jsonb_typeof(v_defer_sources) <> 'array' THEN
    v_defer_sources := '[]'::jsonb;
  END IF;

  IF NOT (v_defer_sources ? 'tenant_signup_review_apply_v1') THEN
    v_defer_sources := v_defer_sources || jsonb_build_array('tenant_signup_review_apply_v1');
  END IF;

  v_next := v_current;
  v_next := jsonb_set(v_next, ARRAY['organization_insert_trigger'], COALESCE(v_next->'organization_insert_trigger', '{}'::jsonb), true);
  v_next := jsonb_set(v_next, ARRAY['organization_insert_trigger', 'defer_sources'], v_defer_sources, true);
  v_next := jsonb_set(
    v_next,
    ARRAY['organization_insert_trigger', 'deferred_bootstrap_entrypoint'],
    to_jsonb('ui_execute_onboarding_bootstrap_v1'::text),
    true
  );

  WITH current AS (
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'saas_onboarding_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_next,
           version = current.version + 1,
           change_reason = 'Defer tenant signup approval organization insert bootstrap to readiness repair',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_next IS DISTINCT FROM current.value
    RETURNING sv.id, sv.scope_hash, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.settings_version_id = applied.id
     AND s.scope_hash = applied.scope_hash;
END;
$onboarding_policy$;

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

  BEGIN
    IF v_provision_on_approval THEN
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
           || jsonb_build_object('decision', 'approved', 'review_applied_at', now()),
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
      'user_id', v_user_id,
      'organization_slug', v_org_slug,
      'invite_redirect_to', v_invite_redirect_to
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  uuid, text, uuid, text, uuid, boolean, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  uuid, text, uuid, text, uuid, boolean, text, jsonb
) TO service_role;

COMMENT ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  uuid, text, uuid, text, uuid, boolean, text, jsonb
) IS
  'Tenant signup review implementation. Signup approval marks organization insert bootstrap as deferred through row-driven saas_onboarding_policy so approval returns quickly; full tenant readiness setup remains available through ui_execute_onboarding_bootstrap_v1.';

SELECT pg_advisory_unlock(hashtext('202605292357_tenant_signup_approval_defer_org_bootstrap_v1'));

COMMIT;
