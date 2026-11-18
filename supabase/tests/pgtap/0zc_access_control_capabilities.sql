-- Plan: PLAN-202601-access-control-capabilities-v2 / Step: S95
-- pgTAP: Access control capability evaluation
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();
  v_user_client UUID := gen_random_uuid();
  v_policy_client JSONB := jsonb_build_object(
    'denies', jsonb_build_array(
      jsonb_build_object('capability_key','shipments.read','scope_type','client','scope_id', v_client::text,'reason','client deny override')
    )
  );
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Access Org', 'access-org-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Access Client', 'access-client-' || left(v_client::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender,
    v_client,
    'Access Sender',
    'Access Sender',
    TRUE,
    'active'
  );

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:access-control-capabilities-fixture-bootstrap'
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops User', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'client-' || left(v_user_client::text, 8) || '@example.com', 'Client User', 'client_admin', 'client', v_client);

  -- ops_admin can read shipments by default
  PERFORM set_config('request.jwt.claim.sub', v_user_ops::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM ok(public.user_has_capability_v1('shipments.read', 'tenant', v_org), 'ops_admin has shipments.read');
  PERFORM ok(public.user_has_capability_v1('workflow_runs.write', 'tenant', v_org), 'ops_admin has workflow_runs.write');
  PERFORM ok(public.user_has_capability_v1('pickups.read', 'tenant', v_org), 'ops_admin has pickups.read');
  PERFORM ok(public.user_has_capability_v1('warehouse.scan', 'tenant', v_org), 'ops_admin has warehouse.scan');
  PERFORM ok(public.user_has_capability_v1('labels.reprint', 'tenant', v_org), 'ops_admin has labels.reprint');
  EXECUTE 'RESET ROLE';

  -- client_admin can read shipments by default
  PERFORM set_config('request.jwt.claim.sub', v_user_client::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM ok(public.user_has_capability_v1('shipments.read', 'client', v_client), 'client_admin has shipments.read');
  PERFORM ok(NOT public.user_has_capability_v1('manual_review.read', 'client', v_client), 'client_admin lacks manual_review.read');
  PERFORM ok(NOT public.user_has_capability_v1('warehouse.scan', 'client', v_client), 'client_admin lacks warehouse.scan');
  PERFORM ok(NOT public.user_has_capability_v1('labels.reprint', 'client', v_client), 'client_admin lacks labels.reprint');
  PERFORM ok(public.user_has_capability_v1('workflow_runs.write', 'client', v_client), 'client_admin has workflow_runs.write');
  EXECUTE 'RESET ROLE';

  -- insert client-level deny override
  PERFORM 1
  FROM public.upsert_settings_value_v1(
    'access_control_policy',
    'client',
    v_client,
    v_policy_client,
    1,
    'test client deny override'
  );

  DELETE FROM public.settings_cache
  WHERE cache_key LIKE 'access_control_policy:%';

  -- client deny should block shipments.read
  PERFORM set_config('request.jwt.claim.sub', v_user_client::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM ok(NOT public.user_has_capability_v1('shipments.read', 'client', v_client), 'client deny override blocks shipments.read');
  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;
