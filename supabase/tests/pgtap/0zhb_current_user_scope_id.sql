-- pgTAP: current_user_scope_id tenant fallback (SSOT)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Scope Org', 'scope-org-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Scope Client', 'scope-client-' || left(v_client::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender,
    v_client,
    'Scope Sender',
    'Scope Sender',
    TRUE,
    'active'
  );

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:current-user-scope-id-fixture-bootstrap'
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'scope-ops-' || left(v_user_ops::text, 8) || '@example.com', 'Scope Ops', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'scope-client-' || left(v_user_client::text, 8) || '@example.com', 'Scope Client Admin', 'client_admin', 'client', v_client);

  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';

  -- tenant scope id derives from organization_id when access_scope_id is NULL
  PERFORM set_config('request.jwt.claim.sub', v_user_ops::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM is(public.current_user_scope_id(), v_org, 'tenant scope id derives from organization_id');
  EXECUTE 'RESET ROLE';

  -- client scope id remains access_scope_id
  PERFORM set_config('request.jwt.claim.sub', v_user_client::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM is(public.current_user_scope_id(), v_client, 'client scope id remains access_scope_id');
  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;

