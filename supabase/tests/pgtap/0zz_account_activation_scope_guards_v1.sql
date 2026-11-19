-- pgTAP: account activation guards for scope + access policy resolution

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

DO $$
DECLARE
  v_org_active UUID := gen_random_uuid();
  v_org_suspended UUID := gen_random_uuid();
  v_user_active UUID := gen_random_uuid();
  v_user_suspended UUID := gen_random_uuid();
  v_user_org_suspended UUID := gen_random_uuid();
  v_client_active UUID := gen_random_uuid();
  v_client_suspended UUID := gen_random_uuid();
  v_sender_active UUID := gen_random_uuid();
  v_sender_suspended UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES
    (v_org_active, 'Activation Guard Org Active', 'acct-guard-active-' || left(v_org_active::text, 8), 'active'),
    (v_org_suspended, 'Activation Guard Org Suspended', 'acct-guard-susp-' || left(v_org_suspended::text, 8), 'suspended');

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client_active, v_org_active, 'Activation Guard Active Client', 'acct-guard-active-client-' || left(v_client_active::text, 8), 'active'),
    (v_client_suspended, v_org_suspended, 'Activation Guard Suspended Client', 'acct-guard-susp-client-' || left(v_client_suspended::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES
    (v_sender_active, v_client_active, 'Activation Guard Active Sender', 'Activation Guard Active Sender', TRUE, 'active'),
    (v_sender_suspended, v_client_suspended, 'Activation Guard Suspended Sender', 'Activation Guard Suspended Sender', TRUE, 'active');

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org_active,
    'pgtap:account-activation-scope-guards-active-fixture-bootstrap'
  );

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org_suspended,
    'pgtap:account-activation-scope-guards-suspended-fixture-bootstrap'
  );

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
  VALUES
    (
      v_user_active,
      v_org_active,
      'acct-active-' || left(v_user_active::text, 8) || '@example.com',
      'Activation Active User',
      'ops_admin',
      'active',
      'tenant',
      NULL
    ),
    (
      v_user_suspended,
      v_org_active,
      'acct-suspended-' || left(v_user_suspended::text, 8) || '@example.com',
      'Activation Suspended User',
      'ops_admin',
      'suspended',
      'tenant',
      NULL
    ),
    (
      v_user_org_suspended,
      v_org_suspended,
      'acct-org-suspended-' || left(v_user_org_suspended::text, 8) || '@example.com',
      'Activation Org Suspended User',
      'ops_admin',
      'active',
      'tenant',
      NULL
    );

  PERFORM set_config('request.jwt.claim.sub', v_user_active::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM is(
    public.current_user_org_id()::text,
    v_org_active::text,
    'active user resolves organization scope'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.resolve_access_control_policy_v1(NULL, NULL, FALSE)
    ),
    'active user resolves access_control_policy'
  );
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user_suspended::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM is(
    public.current_user_org_id()::text,
    NULL::text,
    'suspended user resolves NULL organization scope'
  );
  PERFORM ok(
    NOT EXISTS (
      SELECT 1
      FROM public.resolve_access_control_policy_v1(NULL, NULL, FALSE)
    ),
    'suspended user cannot resolve access_control_policy'
  );
  PERFORM ok(
    public.user_can_write() = FALSE,
    'suspended user cannot write via capability gate'
  );
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user_org_suspended::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM is(
    public.current_user_org_id()::text,
    NULL::text,
    'user in suspended organization resolves NULL organization scope'
  );
  PERFORM ok(
    NOT EXISTS (
      SELECT 1
      FROM public.resolve_access_control_policy_v1(NULL, NULL, FALSE)
    ),
    'user in suspended organization cannot resolve access_control_policy'
  );
  PERFORM ok(
    public.user_can_write() = FALSE,
    'user in suspended organization cannot write via capability gate'
  );
  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();

ROLLBACK;
