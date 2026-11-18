-- Plan: PLAN-202601-workflow-studio-dnd / Step: S95
-- pgTAP: client_admin has capabilities needed to load the workflow operation library (operation_templates)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(1);

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
  VALUES (v_org, 'Workflow Studio Ops Org', 'workflow-studio-ops-org-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Workflow Studio Ops Client', 'workflow-studio-ops-client-' || left(v_client::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender,
    v_client,
    'Workflow Studio Ops Sender',
    'Workflow Studio Ops Sender',
    TRUE,
    'active'
  );

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:workflow-studio-operation-library-access-fixture-bootstrap'
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'workflow-studio-ops-' || left(v_user::text, 8) || '@example.com',
    'Workflow Studio Client Admin',
    'client_admin',
    'client',
    v_client
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM ok(
    public.user_has_capability_v1('integrations.read', 'client', v_client),
    'client_admin has integrations.read'
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;

