-- Plan: PLAN-202601-workflow-studio-dnd / Step: S95
-- pgTAP: client_admin has capabilities needed to view workflow triggers
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Workflow Studio Org', 'workflow-studio-org-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Workflow Studio Client', 'workflow-studio-client-' || left(v_client::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender,
    v_client,
    'Workflow Studio Sender',
    'Workflow Studio Sender',
    TRUE,
    'active'
  );

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:workflow-studio-triggers-access-fixture-bootstrap'
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'workflow-studio-client-' || left(v_user::text, 8) || '@example.com',
    'Workflow Studio Client Admin',
    'client_admin',
    'client',
    v_client
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM ok(
    public.user_has_capability_v1('settings.read', 'client', v_client),
    'client_admin has settings.read'
  );

  PERFORM ok(
    public.user_has_capability_v1('webhooks.read', 'client', v_client),
    'client_admin has webhooks.read'
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;
