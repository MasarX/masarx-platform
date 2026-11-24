BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT ok(
  (SELECT 'pgrst.db_pre_request=request_guard.enforce_privileged_session_v1' = ANY(rolconfig)
   FROM pg_roles
   WHERE rolname = 'authenticator'),
  'authenticator runs the assurance hook before Data API requests'
);

CREATE FUNCTION pg_temp.test_privileged_session_assurance()
RETURNS SETOF text
LANGUAGE plpgsql
AS $test$
DECLARE
  v_org uuid := gen_random_uuid();
  v_finance uuid := gen_random_uuid();
  v_viewer uuid := gen_random_uuid();
  v_bank uuid := gen_random_uuid();
  v_claims jsonb;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Session Assurance Test', 'session-assurance-' || v_org);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, status)
  VALUES
    (v_finance, v_org, v_finance || '@example.test', 'Finance User', 'ops_admin', 'tenant', 'active'),
    (v_viewer, v_org, v_viewer || '@example.test', 'Tenant User', 'sender_user', 'tenant', 'active');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['finance'], v_finance);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id)
  SELECT v_org, v_finance, assigned_role.id, v_finance
  FROM public.rbac_roles assigned_role
  WHERE assigned_role.organization_id = v_org AND assigned_role.key = 'finance'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.bank_accounts (id, organization_id, key, name, bank_name, currency, is_active)
  VALUES (v_bank, v_org, 'mfa-test', 'Session Assurance Bank', 'Test Bank', 'sar', true);

  RETURN NEXT is(
    (SELECT count(*)::integer
     FROM pg_policies
     WHERE schemaname = 'public' AND policyname = 'privileged_session_assurance'
       AND permissive = 'RESTRICTIVE' AND roles = ARRAY['authenticated']::name[]),
    3, 'sensitive table policies are restrictive and apply to authenticated sessions'
  );

  SET LOCAL ROLE authenticated;
  v_claims := jsonb_build_object('sub', v_finance, 'role', 'authenticated');
  PERFORM set_config('request.jwt.claim.sub', v_finance::text, true);
  PERFORM set_config('request.jwt.claims', v_claims::text, true);
  RETURN NEXT ok(public.user_has_permission_v1('finance.read'), 'fixture has the finance role');
  RETURN NEXT ok(NOT public.privileged_session_allowed_v1(), 'missing assurance denies privileged access');
  PERFORM set_config('request.jwt.claims', (v_claims || '{"aal":"aal1"}')::text, true);
  RETURN NEXT throws_ok('SELECT request_guard.enforce_privileged_session_v1()', 'PT403', 'mfa_required',
    'aal1 finance session is denied before an RPC');
  RETURN NEXT is((SELECT count(*) FROM public.bank_accounts WHERE id = v_bank), 0::bigint,
    'restrictive policy hides the bank account from an aal1 finance session');

  PERFORM set_config('request.jwt.claims', (v_claims || '{"aal":"aal2"}')::text, true);
  RETURN NEXT lives_ok('SELECT request_guard.enforce_privileged_session_v1()', 'aal2 finance session can reach an RPC');
  RETURN NEXT is((SELECT count(*) FROM public.bank_accounts WHERE id = v_bank), 1::bigint,
    'aal2 preserves finance access to the bank account');

  PERFORM set_config('request.jwt.claim.sub', v_viewer::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_viewer, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  RETURN NEXT lives_ok('SELECT request_guard.enforce_privileged_session_v1()', 'unprivileged aal1 session can reach an RPC');
  RETURN NEXT is((SELECT count(*) FROM public.bank_accounts WHERE id = v_bank), 0::bigint,
    'ordinary row policies still hide the bank account from an unprivileged user');

  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  RETURN NEXT lives_ok('SELECT request_guard.enforce_privileged_session_v1()', 'service requests can run without user MFA');

  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  RETURN NEXT lives_ok('SELECT request_guard.enforce_privileged_session_v1()', 'anonymous requests can run the hook');
  RESET ROLE;
END;
$test$;

SELECT * FROM pg_temp.test_privileged_session_assurance();
SELECT * FROM finish();
ROLLBACK;
