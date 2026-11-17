-- pgTAP: Tenant signup approval queue + onboarding defaults strict coverage

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(34);

CREATE OR REPLACE FUNCTION pg_temp.test_tenant_signup_approval_onboarding_defaults_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_req_id UUID;
  v_create JSONB;
  v_reject JSONB;
  v_second JSONB;
  v_create_no_provision JSONB;
  v_no_provision_req_id UUID;
  v_no_provision_approve JSONB;
  v_no_provision_auth_user_id UUID := gen_random_uuid();
  v_policy_current JSONB;
  v_policy_auto JSONB;
  v_policy_no_provision JSONB;
  v_create_auto JSONB;
  v_scope_check JSONB;
  v_org UUID := gen_random_uuid();
  v_user_platform UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings_category_registry
      WHERE category = 'tenant_signup_policy'
    ),
    'tenant_signup_policy category is registered'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.schema_registry
      WHERE category = 'tenant_signup_policy'
        AND version = 1
        AND is_active = TRUE
    ),
    'tenant_signup_policy schema v1 is active'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings
      WHERE category = 'tenant_signup_policy'
        AND scope_type = 'global'
        AND scope_id IS NULL
    ),
    'tenant_signup_policy global defaults are seeded'
  );

  RETURN NEXT has_table(
    'public',
    'tenant_signup_requests',
    'tenant_signup_requests table exists'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_definitions
      WHERE category = 'tenant_signup_request_status'
    ),
    'tenant_signup_request_status lookup category exists'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_definitions
      WHERE category = 'tenant_signup_review_decision'
    ),
    'tenant_signup_review_decision lookup category exists'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_column_contracts
      WHERE table_schema = 'public'
        AND table_name = 'tenant_signup_requests'
        AND column_name = 'status'
        AND lookup_category = 'tenant_signup_request_status'
    ),
    'tenant_signup_requests.status is enforced via lookup contract'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_column_contracts
      WHERE table_schema = 'public'
        AND table_name = 'tenant_signup_requests'
        AND column_name = 'review_decision'
        AND lookup_category = 'tenant_signup_review_decision'
    ),
    'tenant_signup_requests.review_decision is enforced via lookup contract'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'tenant_signup_requests'
        AND c.relrowsecurity = TRUE
    ),
    'tenant_signup_requests table has RLS enabled'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'tenant_signup_requests'
        AND policyname = 'tenant_signup_requests_service_policy'
    ),
    'tenant_signup_requests service policy exists'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'tenant_signup_requests'
        AND policyname = 'tenant_signup_requests_read_policy'
    ),
    'tenant_signup_requests authenticated read policy exists'
  );

  RETURN NEXT ok(
    to_regprocedure('public.tenant_signup_request_create_v1(text,text,text,text,text,text,text,text,text,text,text,jsonb,text,boolean)') IS NOT NULL,
    'tenant_signup_request_create_v1 exists'
  );

  RETURN NEXT ok(
    to_regprocedure('public.tenant_signup_assert_reviewer_v1()') IS NOT NULL,
    'tenant_signup_assert_reviewer_v1 exists'
  );

  RETURN NEXT ok(
    to_regprocedure('public.tenant_signup_review_apply_v1(uuid,text,uuid,text,uuid,boolean,text,jsonb)') IS NOT NULL,
    'tenant_signup_review_apply_v1 exists'
  );

  RETURN NEXT has_function(
    'api',
    'tenant_signup_request_create_v1',
    ARRAY['text','text','text','text','text','text','text','text','text','text','text','jsonb','text','boolean'],
    'api.tenant_signup_request_create_v1 wrapper exists'
  );

  RETURN NEXT has_function(
    'api',
    'tenant_signup_assert_reviewer_v1',
    ARRAY[]::text[],
    'api.tenant_signup_assert_reviewer_v1 wrapper exists'
  );

  RETURN NEXT has_function(
    'api',
    'tenant_signup_review_apply_v1',
    ARRAY['uuid','text','uuid','text','uuid','boolean','text','jsonb'],
    'api.tenant_signup_review_apply_v1 wrapper exists'
  );

  RETURN NEXT has_function(
    'api',
    'tenant_signup_policy_v1',
    ARRAY[]::text[],
    'api.tenant_signup_policy_v1 wrapper exists'
  );

  RETURN NEXT has_function(
    'api',
    'tenant_signup_request_record_error_v1',
    ARRAY['uuid','text','text','jsonb'],
    'api.tenant_signup_request_record_error_v1 wrapper exists'
  );

  v_create := public.tenant_signup_request_create_v1(
    p_email := format('tenant-signup-%s@example.com', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_full_name := 'Tenant Signup PGTAP User',
    p_organization_name := 'Tenant Signup PGTAP Org',
    p_organization_slug := NULL,
    p_website_url := NULL,
    p_phone := NULL,
    p_notes := 'pgtap lifecycle',
    p_locale := 'en',
    p_page_url := 'https://example.com/signup',
    p_referrer := NULL,
    p_origin := 'https://example.com',
    p_marketing := '{}'::jsonb,
    p_ip_hash := format('pgtap-ip-%s', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_turnstile_verified := TRUE
  );

  v_req_id := NULLIF(v_create->>'id', '')::uuid;

  RETURN NEXT ok(
    COALESCE((v_create->>'ok')::boolean, FALSE),
    'tenant_signup_request_create_v1 returns ok=true'
  );

  RETURN NEXT ok(
    v_req_id IS NOT NULL,
    'tenant_signup_request_create_v1 returns request id'
  );

  RETURN NEXT is(
    (SELECT status FROM public.tenant_signup_requests WHERE id = v_req_id),
    'pending',
    'new tenant signup request is pending'
  );

  v_reject := public.tenant_signup_review_apply_v1(
    p_request_id := v_req_id,
    p_decision := 'rejected',
    p_reviewer_user_id := NULL,
    p_decision_reason := 'pgtap rejection path',
    p_invited_auth_user_id := NULL,
    p_invite_email_sent := FALSE,
    p_invite_redirect_to := NULL,
    p_decision_metadata := '{}'::jsonb
  );

  RETURN NEXT ok(
    COALESCE((v_reject->>'ok')::boolean, FALSE),
    'tenant_signup_review_apply_v1 rejection succeeds'
  );

  v_second := public.tenant_signup_review_apply_v1(
    p_request_id := v_req_id,
    p_decision := 'approved',
    p_reviewer_user_id := NULL,
    p_decision_reason := NULL,
    p_invited_auth_user_id := gen_random_uuid(),
    p_invite_email_sent := FALSE,
    p_invite_redirect_to := NULL,
    p_decision_metadata := '{}'::jsonb
  );

  RETURN NEXT ok(
    COALESCE((v_second->>'already_processed')::boolean, FALSE),
    'tenant_signup_review_apply_v1 is idempotent after first decision'
  );

  RETURN NEXT is(
    (SELECT status FROM public.tenant_signup_requests WHERE id = v_req_id),
    'rejected',
    'tenant signup request status remains rejected after second decision attempt'
  );

  v_policy_current := public.tenant_signup_policy_v1();
  v_policy_auto := jsonb_set(
    COALESCE(v_policy_current, '{}'::jsonb),
    '{approval_mode}',
    '"auto"'::jsonb,
    true
  );

  PERFORM public.upsert_settings_value_v1(
    'tenant_signup_policy',
    'global',
    NULL,
    v_policy_auto,
    1,
    'pgtap: enable auto approval mode'
  );

  v_create_auto := public.tenant_signup_request_create_v1(
    p_email := format('tenant-signup-auto-%s@example.com', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_full_name := 'Tenant Signup Auto Mode User',
    p_organization_name := 'Tenant Signup Auto Mode Org',
    p_organization_slug := NULL,
    p_website_url := NULL,
    p_phone := NULL,
    p_notes := 'pgtap auto mode',
    p_locale := 'en',
    p_page_url := 'https://example.com/signup',
    p_referrer := NULL,
    p_origin := 'https://example.com',
    p_marketing := '{}'::jsonb,
    p_ip_hash := format('pgtap-ip-auto-%s', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_turnstile_verified := TRUE
  );

  RETURN NEXT is(
    COALESCE(v_create_auto->>'approval_mode', ''),
    'auto',
    'tenant_signup_request_create_v1 reflects approval_mode=auto'
  );

  RETURN NEXT ok(
    COALESCE((v_create_auto->>'auto_approve')::boolean, FALSE),
    'tenant_signup_request_create_v1 sets auto_approve=true when policy mode is auto'
  );

  v_policy_no_provision := jsonb_set(
    COALESCE(v_policy_auto, '{}'::jsonb),
    '{onboarding,provision_on_approval}',
    'false'::jsonb,
    true
  );

  PERFORM public.upsert_settings_value_v1(
    'tenant_signup_policy',
    'global',
    NULL,
    v_policy_no_provision,
    1,
    'pgtap: disable provision_on_approval'
  );

  v_create_no_provision := public.tenant_signup_request_create_v1(
    p_email := format('tenant-signup-no-provision-%s@example.com', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_full_name := 'Tenant Signup No Provision User',
    p_organization_name := 'Tenant Signup No Provision Org',
    p_organization_slug := NULL,
    p_website_url := NULL,
    p_phone := NULL,
    p_notes := 'pgtap approve no-provision path',
    p_locale := 'en',
    p_page_url := 'https://example.com/signup',
    p_referrer := NULL,
    p_origin := 'https://example.com',
    p_marketing := '{}'::jsonb,
    p_ip_hash := format('pgtap-ip-no-provision-%s', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_turnstile_verified := TRUE
  );

  v_no_provision_req_id := NULLIF(v_create_no_provision->>'id', '')::uuid;
  v_no_provision_approve := public.tenant_signup_review_apply_v1(
    p_request_id := v_no_provision_req_id,
    p_decision := 'approved',
    p_reviewer_user_id := NULL,
    p_decision_reason := 'pgtap approve no-provision path',
    p_invited_auth_user_id := v_no_provision_auth_user_id,
    p_invite_email_sent := FALSE,
    p_invite_redirect_to := NULL,
    p_decision_metadata := '{}'::jsonb
  );

  RETURN NEXT ok(
    COALESCE((v_no_provision_approve->>'ok')::boolean, FALSE),
    'tenant_signup_review_apply_v1 approves when provision_on_approval=false'
  );

  RETURN NEXT is(
    (SELECT status FROM public.tenant_signup_requests WHERE id = v_no_provision_req_id),
    'approved',
    'tenant signup request is approved when provision_on_approval=false'
  );

  RETURN NEXT ok(
    (SELECT approved_user_id IS NULL
       AND approved_auth_user_id = v_no_provision_auth_user_id
       AND approved_organization_id IS NULL
       FROM public.tenant_signup_requests
      WHERE id = v_no_provision_req_id),
    'no-provision approval keeps approved_user_id/org null and stores approved_auth_user_id'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Tenant Signup Reviewer Org', 'tenant-signup-reviewer-' || left(replace(v_org::text, '-', ''), 16));

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_user_platform,
    v_org,
    format('reviewer-%s@example.com', left(replace(v_user_platform::text, '-', ''), 12)),
    'Tenant Signup Platform Reviewer',
    'ops_admin',
    'active',
    'platform',
    NULL
  );

  PERFORM set_config('request.jwt.claim.sub', v_user_platform::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_user_platform::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_scope_check := public.tenant_signup_assert_reviewer_v1();

  RETURN NEXT ok(
    COALESCE((v_scope_check->>'ok')::boolean, FALSE),
    'tenant_signup_assert_reviewer_v1 allows platform reviewer with capability'
  );

  EXECUTE 'RESET ROLE';

  RETURN NEXT is(
    COALESCE((public.resolve_saas_onboarding_policy_v1() #>> '{materialize_defaults,client,use_registry_required_defaults}')::boolean, FALSE),
    TRUE,
    'saas onboarding policy defaults require client registry defaults'
  );

  RETURN NEXT is(
    COALESCE((public.resolve_saas_onboarding_policy_v1() #>> '{materialize_defaults,sender,use_registry_required_defaults}')::boolean, FALSE),
    TRUE,
    'saas onboarding policy defaults require sender registry defaults'
  );

  RETURN NEXT is(
    COALESCE((public.resolve_saas_onboarding_policy_v1() #>> '{materialize_defaults,tenant,strict_required_coverage}')::boolean, FALSE),
    TRUE,
    'saas onboarding policy defaults enforce strict required coverage'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_tenant_signup_approval_onboarding_defaults_v1();

SELECT * FROM finish();

ROLLBACK;
