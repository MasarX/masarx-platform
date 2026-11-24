BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(14);

SELECT ok(
  has_function_privilege('service_role', 'api.tenant_signup_review_reverse_v1(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'api.tenant_signup_review_reverse_v1(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'api.tenant_signup_review_reverse_v1(uuid,text)', 'EXECUTE'),
  'signup reversal API accepts only the service role'
);
SET LOCAL request.jwt.claim.role TO 'authenticated';
SET LOCAL request.jwt.claims TO '{"role":"authenticated"}';
SELECT is(
  api.tenant_signup_review_reverse_v1(gen_random_uuid(), 'Synthetic reversal') #>> '{error,code}',
  'service_role_required', 'signup reversal requires the service admission even with an elevated SQL session'
);

CREATE FUNCTION pg_temp.check_signup_approval_reversal()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  linked boolean;
  request_id uuid;
  existing_org_id uuid := gen_random_uuid();
  org_id uuid;
  invited_id uuid;
  email_address text;
  approval jsonb;
  reversal jsonb;
  scenario text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations(id, name, slug)
  VALUES (existing_org_id, 'Synthetic existing tenant', 'existing-tenant-' || existing_org_id);
  PERFORM set_config('app.organization_onboarding_source', '', true);

  FOREACH linked IN ARRAY ARRAY[false, true] LOOP
    invited_id := gen_random_uuid();
    email_address := invited_id || '@example.test';
    scenario := CASE WHEN linked THEN 'linked' ELSE 'created' END;
    request_id := (public.tenant_signup_request_create_v1(
      p_email := email_address,
      p_full_name := 'Synthetic applicant',
      p_organization_name := 'Synthetic signup ' || scenario,
      p_organization_slug := NULL,
      p_website_url := NULL,
      p_phone := NULL,
      p_notes := NULL,
      p_locale := 'en',
      p_page_url := 'https://example.test/signup',
      p_referrer := NULL,
      p_origin := 'https://example.test',
      p_marketing := '{}'::jsonb,
      p_ip_hash := 'signup-test-' || gen_random_uuid(),
      p_turnstile_verified := true
    )->>'id')::uuid;
    IF linked THEN
      INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
      VALUES (invited_id, existing_org_id, email_address, 'Synthetic linked user', 'ops_admin', 'active', 'tenant');
    END IF;
    approval := public.tenant_signup_review_apply_v1(
      p_request_id := request_id,
      p_decision := 'approved',
      p_invited_auth_user_id := invited_id,
      p_decision_metadata := CASE WHEN linked
        THEN jsonb_build_object('approved_existing_organization_id', existing_org_id)
        ELSE '{}'::jsonb END
    );
    org_id := (approval->>'approved_organization_id')::uuid;
    RETURN NEXT ok(org_id IS NOT NULL, scenario || ' signup approval returns an organization');
    RETURN NEXT is((
      SELECT approval_created_organization_id FROM public.tenant_signup_requests WHERE id = request_id
    ), CASE WHEN linked THEN NULL::uuid ELSE org_id END, scenario || ' signup stores only created-organization provenance');

    reversal := api.tenant_signup_review_reverse_v1(request_id, 'Synthetic reversal');
    RETURN NEXT is(reversal->>'status', 'reversed', scenario || ' signup records a reversal');
    RETURN NEXT is((
      SELECT billing_status FROM public.organizations WHERE id = org_id
    ), CASE WHEN linked THEN 'active' ELSE 'suspended' END, scenario || ' signup applies the correct organization suspension');
    RETURN NEXT ok(EXISTS (
      SELECT 1 FROM public.decision_log
      WHERE id = (reversal->>'decision_log_id')::uuid AND organization_id = org_id
        AND resource_id = request_id AND decision_outcome = 'reversed'
    ), scenario || ' signup reversal links its decision evidence');
    RETURN NEXT is(
      api.tenant_signup_review_reverse_v1(request_id, 'Synthetic reversal')->>'decision_log_id',
      reversal->>'decision_log_id', scenario || ' signup reversal retry returns the original evidence'
    );
  END LOOP;
END;
$test$;

SELECT * FROM pg_temp.check_signup_approval_reversal();
SELECT * FROM finish();
ROLLBACK;
