-- pgTAP: Tenant signup approval can link to an existing organization without duplicate org creation.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(23);

CREATE OR REPLACE FUNCTION pg_temp.test_tenant_signup_existing_org_link_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_existing_org UUID := gen_random_uuid();
  v_existing_slug TEXT := 'existing-tenant-signup-link-' || left(replace(v_existing_org::text, '-', ''), 16);
  v_request JSONB;
  v_request_id UUID;
  v_auth_user_id UUID := gen_random_uuid();
  v_approval JSONB;
  v_missing_request JSONB;
  v_missing_request_id UUID;
  v_missing_approval JSONB;
  v_foreign_org UUID := gen_random_uuid();
  v_foreign_slug TEXT := 'foreign-tenant-signup-' || left(replace(v_foreign_org::text, '-', ''), 16);
  v_foreign_user UUID := gen_random_uuid();
  v_foreign_email TEXT := format('foreign-signup-%s@example.com', left(replace(gen_random_uuid()::text, '-', ''), 12));
  v_conflict_request JSONB;
  v_conflict_request_id UUID;
  v_conflict_approval JSONB;
  v_email_conflict_user UUID := gen_random_uuid();
  v_email_conflict_existing TEXT := format('preserved-email-%s@example.com', left(replace(gen_random_uuid()::text, '-', ''), 12));
  v_email_conflict_request JSONB;
  v_email_conflict_request_id UUID;
  v_email_conflict_approval JSONB;
  v_unique_conflict_request JSONB;
  v_unique_conflict_request_id UUID;
  v_unique_conflict_approval JSONB;
  v_unique_conflict_invited_user UUID := gen_random_uuid();
  v_org_count_before INT;
  v_org_count_after INT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_existing_org, 'Existing Tenant Signup Link Org', v_existing_slug),
    (v_foreign_org, 'Foreign Tenant Signup User Org', v_foreign_slug);

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id
  ) VALUES
    (
      v_foreign_user, v_foreign_org, v_foreign_email, 'Example Person',
      'ops_admin', 'active', 'tenant', NULL
    ),
    (
      v_email_conflict_user, v_existing_org, v_email_conflict_existing, 'Example Person',
      'ops_admin', 'active', 'tenant', NULL
    );

  SELECT COUNT(*) INTO v_org_count_before FROM public.organizations;

  v_request := public.tenant_signup_request_create_v1(
    p_email := format('existing-link-%s@example.com', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_full_name := 'Existing Link User',
    p_organization_name := 'Existing Tenant Signup Link Org',
    p_organization_slug := v_existing_slug,
    p_website_url := NULL,
    p_phone := NULL,
    p_notes := 'pgtap existing org link',
    p_locale := 'en',
    p_page_url := 'https://example.com/signup',
    p_referrer := NULL,
    p_origin := 'https://example.com',
    p_marketing := '{}'::jsonb,
    p_ip_hash := format('pgtap-existing-link-%s', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_turnstile_verified := TRUE
  );

  v_request_id := NULLIF(v_request->>'id', '')::uuid;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id
  )
  SELECT
    v_auth_user_id, v_existing_org, email, 'Preserved Existing Identity',
    'ops_admin', 'active', 'tenant', NULL
  FROM public.tenant_signup_requests
  WHERE id = v_request_id;

  v_approval := public.tenant_signup_review_apply_v1(
    p_request_id := v_request_id,
    p_decision := 'approved',
    p_reviewer_user_id := NULL,
    p_decision_reason := 'pgtap existing org link',
    p_invited_auth_user_id := v_auth_user_id,
    p_invite_email_sent := FALSE,
    p_invite_redirect_to := 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
    p_decision_metadata := jsonb_build_object('approved_existing_organization_id', v_existing_org)
  );

  SELECT COUNT(*) INTO v_org_count_after FROM public.organizations;

  RETURN NEXT ok(COALESCE((v_approval->>'ok')::boolean, FALSE), 'existing-org tenant signup approval succeeds');
  RETURN NEXT is(v_approval->>'approved_organization_id', v_existing_org::text, 'approval returns existing organization id');
  RETURN NEXT is(v_approval->>'organization_slug', v_existing_slug, 'approval returns existing organization slug');
  RETURN NEXT ok(COALESCE((v_approval->>'linked_existing_organization')::boolean, FALSE), 'approval reports existing organization link');
  RETURN NEXT is(v_org_count_after, v_org_count_before, 'approval does not create a duplicate organization');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.tenant_signup_requests
      WHERE id = v_request_id
        AND status = 'approved'
        AND review_decision = 'approved'
        AND approved_organization_id = v_existing_org
        AND approved_user_id = v_auth_user_id
        AND approved_auth_user_id = v_auth_user_id
        AND decision_metadata->>'existing_organization_linked' = 'true'
    ),
    'canonical request row stores existing organization approval lineage'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.users
      WHERE id = v_auth_user_id
        AND organization_id = v_existing_org
        AND status = 'active'
        AND access_scope_type = 'tenant'
    ),
    'approval keeps the active tenant user under the existing organization'
  );
  RETURN NEXT is(
    (SELECT full_name FROM public.users WHERE id = v_auth_user_id),
    'Preserved Existing Identity',
    'approval does not rewrite an existing same-org same-email identity'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.rbac_user_role_assignments ura
      JOIN public.rbac_roles r ON r.id = ura.role_id
      WHERE ura.organization_id = v_existing_org
        AND ura.user_id = v_auth_user_id
        AND r.key = 'ops_admin'
        AND ura.revoked_at IS NULL
    ),
    'approval assigns initial RBAC role under existing organization'
  );

  v_conflict_request := public.tenant_signup_request_create_v1(
    p_email := v_foreign_email,
    p_full_name := 'Conflicting Foreign User',
    p_organization_name := 'Existing Tenant Signup Link Org',
    p_organization_slug := v_existing_slug,
    p_website_url := NULL,
    p_phone := NULL,
    p_notes := 'pgtap existing foreign identity conflict',
    p_locale := 'en',
    p_page_url := 'https://example.com/signup',
    p_referrer := NULL,
    p_origin := 'https://example.com',
    p_marketing := '{}'::jsonb,
    p_ip_hash := format('pgtap-foreign-user-%s', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_turnstile_verified := TRUE
  );
  v_conflict_request_id := NULLIF(v_conflict_request->>'id', '')::uuid;
  v_conflict_approval := public.tenant_signup_review_apply_v1(
    p_request_id := v_conflict_request_id,
    p_decision := 'approved',
    p_reviewer_user_id := NULL,
    p_decision_reason := 'pgtap reject foreign user rehome',
    p_invited_auth_user_id := v_foreign_user,
    p_invite_email_sent := FALSE,
    p_invite_redirect_to := 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
    p_decision_metadata := jsonb_build_object('approved_existing_organization_id', v_existing_org)
  );

  RETURN NEXT is(
    v_conflict_approval #>> ARRAY['error','code'],
    'invited_auth_user_conflict',
    'approval fails closed instead of rehoming an existing foreign user'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = v_foreign_user
        AND organization_id = v_foreign_org
        AND email = v_foreign_email
        AND full_name = 'Example Person'
    ),
    'foreign user identity remains unchanged after the rejected approval'
  );
  RETURN NEXT is(
    (SELECT status FROM public.tenant_signup_requests WHERE id = v_conflict_request_id),
    'pending',
    'foreign identity conflict keeps the signup request pending'
  );
  RETURN NEXT is(
    (SELECT last_error_code FROM public.tenant_signup_requests WHERE id = v_conflict_request_id),
    'invited_auth_user_conflict',
    'foreign identity conflict persists the returned error classification'
  );

  v_email_conflict_request := public.tenant_signup_request_create_v1(
    p_email := format('different-email-%s@example.com', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_full_name := 'Conflicting Same-Org Email',
    p_organization_name := 'Existing Tenant Signup Link Org',
    p_organization_slug := v_existing_slug,
    p_website_url := NULL,
    p_phone := NULL,
    p_notes := 'pgtap existing same-org email conflict',
    p_locale := 'en',
    p_page_url := 'https://example.com/signup',
    p_referrer := NULL,
    p_origin := 'https://example.com',
    p_marketing := '{}'::jsonb,
    p_ip_hash := format('pgtap-same-org-email-%s', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_turnstile_verified := TRUE
  );
  v_email_conflict_request_id := NULLIF(v_email_conflict_request->>'id', '')::uuid;
  v_email_conflict_approval := public.tenant_signup_review_apply_v1(
    p_request_id := v_email_conflict_request_id,
    p_decision := 'approved',
    p_reviewer_user_id := NULL,
    p_decision_reason := 'pgtap reject same-org email rewrite',
    p_invited_auth_user_id := v_email_conflict_user,
    p_invite_email_sent := FALSE,
    p_invite_redirect_to := 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
    p_decision_metadata := jsonb_build_object('approved_existing_organization_id', v_existing_org)
  );

  RETURN NEXT is(
    v_email_conflict_approval #>> ARRAY['error','code'],
    'invited_auth_user_conflict',
    'approval fails closed instead of rewriting an existing same-org user email'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = v_email_conflict_user
        AND organization_id = v_existing_org
        AND email = v_email_conflict_existing
        AND full_name = 'Example Person'
    ),
    'same-org user identity remains unchanged after the email conflict'
  );
  RETURN NEXT is(
    (SELECT status FROM public.tenant_signup_requests WHERE id = v_email_conflict_request_id),
    'pending',
    'same-org email conflict keeps the signup request pending'
  );
  RETURN NEXT is(
    (SELECT last_error_code FROM public.tenant_signup_requests WHERE id = v_email_conflict_request_id),
    'invited_auth_user_conflict',
    'same-org email conflict persists the returned error classification'
  );

  v_unique_conflict_request := public.tenant_signup_request_create_v1(
    p_email := v_email_conflict_existing,
    p_full_name := 'Unrelated Unique Email Conflict',
    p_organization_name := 'Existing Tenant Signup Link Org',
    p_organization_slug := v_existing_slug,
    p_website_url := NULL,
    p_phone := NULL,
    p_notes := 'pgtap unrelated user email uniqueness conflict',
    p_locale := 'en',
    p_page_url := 'https://example.com/signup',
    p_referrer := NULL,
    p_origin := 'https://example.com',
    p_marketing := '{}'::jsonb,
    p_ip_hash := format('pgtap-unique-email-%s', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_turnstile_verified := TRUE
  );
  v_unique_conflict_request_id := NULLIF(v_unique_conflict_request->>'id', '')::uuid;
  v_unique_conflict_approval := public.tenant_signup_review_apply_v1(
    p_request_id := v_unique_conflict_request_id,
    p_decision := 'approved',
    p_reviewer_user_id := NULL,
    p_decision_reason := 'pgtap preserve generic uniqueness classification',
    p_invited_auth_user_id := v_unique_conflict_invited_user,
    p_invite_email_sent := FALSE,
    p_invite_redirect_to := 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
    p_decision_metadata := jsonb_build_object('approved_existing_organization_id', v_existing_org)
  );

  RETURN NEXT is(
    v_unique_conflict_approval #>> ARRAY['error','code'],
    'provision_failed',
    'unrelated user email uniqueness failure keeps the generic provision classification'
  );
  RETURN NEXT is(
    (SELECT last_error_code FROM public.tenant_signup_requests WHERE id = v_unique_conflict_request_id),
    'provision_failed',
    'unrelated user email uniqueness failure persists the same generic classification'
  );
  RETURN NEXT is(
    (SELECT status FROM public.tenant_signup_requests WHERE id = v_unique_conflict_request_id),
    'pending',
    'unrelated uniqueness failure keeps the signup request pending'
  );
  RETURN NEXT ok(
    NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_unique_conflict_invited_user),
    'unrelated uniqueness failure does not create the invited user'
  );

  v_missing_request := public.tenant_signup_request_create_v1(
    p_email := format('missing-existing-link-%s@example.com', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_full_name := 'Missing Existing Link User',
    p_organization_name := 'Missing Existing Link Org',
    p_organization_slug := NULL,
    p_website_url := NULL,
    p_phone := NULL,
    p_notes := 'pgtap missing existing org link',
    p_locale := 'en',
    p_page_url := 'https://example.com/signup',
    p_referrer := NULL,
    p_origin := 'https://example.com',
    p_marketing := '{}'::jsonb,
    p_ip_hash := format('pgtap-missing-existing-link-%s', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_turnstile_verified := TRUE
  );

  v_missing_request_id := NULLIF(v_missing_request->>'id', '')::uuid;
  v_missing_approval := public.tenant_signup_review_apply_v1(
    p_request_id := v_missing_request_id,
    p_decision := 'approved',
    p_reviewer_user_id := NULL,
    p_decision_reason := 'pgtap missing existing org link',
    p_invited_auth_user_id := gen_random_uuid(),
    p_invite_email_sent := FALSE,
    p_invite_redirect_to := 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
    p_decision_metadata := jsonb_build_object('approved_existing_organization_id', gen_random_uuid())
  );

  RETURN NEXT is(
    v_missing_approval #>> ARRAY['error','code'],
    'approved_existing_organization_not_found',
    'approval fails closed when requested existing organization is missing'
  );
  RETURN NEXT is(
    (SELECT status FROM public.tenant_signup_requests WHERE id = v_missing_request_id),
    'pending',
    'missing existing organization failure keeps request pending'
  );
END;
$function$;

SELECT * FROM pg_temp.test_tenant_signup_existing_org_link_v1();

SELECT * FROM finish();

ROLLBACK;
