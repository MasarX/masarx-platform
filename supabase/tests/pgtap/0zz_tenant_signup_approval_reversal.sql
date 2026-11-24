BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(42);

SELECT ok(
  has_function_privilege('service_role', 'api.tenant_signup_review_reverse_v1(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'api.tenant_signup_review_reverse_v1(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'api.tenant_signup_review_reverse_v1(uuid,text)', 'EXECUTE'),
  'signup reversal API accepts only the service role'
);
SELECT ok(
  NOT has_function_privilege('edge_api_gateway_role', 'public.tenant_signup_review_reverse_v1(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('edge_api_gateway_role', 'api.tenant_signup_review_reverse_v1(uuid,text)', 'EXECUTE'),
  'the gateway role has no direct or API reversal execute access'
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
  has_existing_user boolean;
  has_existing_role boolean;
  request_id uuid;
  existing_org_id uuid := gen_random_uuid();
  org_id uuid;
  invited_id uuid;
  email_address text;
  approval jsonb;
  reversal jsonb;
  scenario text;
  pending_request uuid := gen_random_uuid();
  rejected_request uuid := gen_random_uuid();
  historical_request uuid := gen_random_uuid();
  unprovisioned_request uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
  INSERT INTO public.organizations(id, name, slug)
  VALUES (existing_org_id, 'Synthetic existing tenant', 'existing-tenant-' || existing_org_id);
  PERFORM set_config('app.organization_onboarding_source', '', true);

  RETURN NEXT is(api.tenant_signup_review_reverse_v1(gen_random_uuid(), 'Synthetic reversal') #>> '{error,code}',
    'signup_request_not_found', 'signup reversal returns a missing request error');
  FOREACH scenario IN ARRAY ARRAY['created', 'linked new user', 'linked existing user', 'linked existing role'] LOOP
    linked := scenario <> 'created';
    has_existing_user := scenario IN ('linked existing user', 'linked existing role');
    has_existing_role := scenario = 'linked existing role';
    invited_id := gen_random_uuid();
    email_address := invited_id || '@example.test';
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
    IF has_existing_user THEN
      INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
      VALUES (invited_id, existing_org_id, email_address, 'Synthetic linked user', 'ops_admin', 'active', 'tenant');
    END IF;
    IF has_existing_role THEN
      PERFORM public.provision_rbac_roles_from_templates_v1(existing_org_id, ARRAY['ops_admin'], NULL);
      INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
      SELECT existing_org_id, invited_id, id
      FROM public.rbac_roles WHERE organization_id = existing_org_id AND key = 'ops_admin';
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

    IF NOT linked THEN
      RETURN NEXT is(api.tenant_signup_review_reverse_v1(request_id, ' ') #>> '{error,code}',
        'reversal_reason_required', 'an approved signup still requires a reversal reason');
    END IF;
    reversal := api.tenant_signup_review_reverse_v1(request_id, 'Synthetic reversal');
    RETURN NEXT is(reversal->>'status', 'reversed', scenario || ' signup records a reversal');
    RETURN NEXT is((
      SELECT billing_status FROM public.organizations WHERE id = org_id
    ), CASE WHEN linked THEN 'active' ELSE 'suspended' END, scenario || ' signup applies the correct organization suspension');
    RETURN NEXT is((SELECT status FROM public.users WHERE id = invited_id),
      CASE WHEN has_existing_user THEN 'active' ELSE 'inactive' END,
      scenario || ' signup deactivates only the user created by approval');
    RETURN NEXT is((
      SELECT assignment.revoked_at IS NOT NULL FROM public.rbac_user_role_assignments assignment
      JOIN public.rbac_roles role ON role.id = assignment.role_id
      WHERE assignment.organization_id = org_id AND assignment.user_id = invited_id
        AND role.key = 'ops_admin'
    ), NOT has_existing_role,
      scenario || ' signup revokes only the role assignment created by approval');
    RETURN NEXT ok(EXISTS (
      SELECT 1 FROM public.decision_log
      WHERE id = (reversal->>'decision_log_id')::uuid AND organization_id = org_id
        AND resource_id = request_id AND decision_outcome = 'reversed'
        AND decision_inputs->>'reason' = 'Synthetic reversal'
        AND decision_inputs->>'organization_provenance' = CASE WHEN linked THEN 'linked' ELSE 'created' END
    ), scenario || ' signup reversal links its decision evidence');
    RETURN NEXT is(
      api.tenant_signup_review_reverse_v1(request_id, 'Synthetic reversal')->>'decision_log_id',
      reversal->>'decision_log_id', scenario || ' signup reversal retry returns the original evidence'
    );
  END LOOP;

  INSERT INTO public.tenant_signup_requests
    (id, email, full_name, organization_name, status, approved_organization_id, approval_provisioning_recorded)
  VALUES
    (pending_request, pending_request || '@example.test', 'Synthetic pending', 'Synthetic tenant', 'pending', NULL, false),
    (rejected_request, rejected_request || '@example.test', 'Synthetic rejected', 'Synthetic tenant', 'rejected', NULL, false),
    (historical_request, historical_request || '@example.test', 'Synthetic historical', 'Synthetic tenant', 'approved', existing_org_id, false),
    (unprovisioned_request, unprovisioned_request || '@example.test', 'Synthetic approved', 'Synthetic tenant', 'approved', NULL, true);
  RETURN NEXT is(api.tenant_signup_review_reverse_v1(pending_request, 'Synthetic reversal') #>> '{error,code}',
    'signup_request_not_approved', 'pending signup is refused for reversal');
  RETURN NEXT is(api.tenant_signup_review_reverse_v1(rejected_request, 'Synthetic reversal') #>> '{error,code}',
    'signup_request_not_approved', 'rejected signup is refused for reversal');
  RETURN NEXT is(api.tenant_signup_review_reverse_v1(historical_request, 'Synthetic reversal') #>> '{error,code}',
    'reversal_provenance_unavailable', 'approval without provenance is refused for reversal');
  reversal := api.tenant_signup_review_reverse_v1(unprovisioned_request, 'Synthetic reversal');
  RETURN NEXT is(reversal->>'status', 'reversed', 'recorded approval without provisioning can be reversed');
  RETURN NEXT ok(EXISTS (
    SELECT 1 FROM public.decision_log
    WHERE id = (reversal->>'decision_log_id')::uuid AND organization_id = public.marketplace_system_org_id_v1()
      AND resource_id = unprovisioned_request AND decision_inputs->>'reason' = 'Synthetic reversal'
      AND decision_inputs->>'organization_provenance' = 'unprovisioned'
  ), 'reversal without a provisioned organization has platform decision evidence');
END;
$test$;

SELECT * FROM pg_temp.check_signup_approval_reversal();
SELECT * FROM finish();
ROLLBACK;
