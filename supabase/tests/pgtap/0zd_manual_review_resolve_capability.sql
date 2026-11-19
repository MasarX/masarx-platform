-- Plan: PLAN-202601-frontend-portal-phase-8-manual-review-queue / Step: S05
-- pgTAP: manual review resolve capability enforcement
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
  v_task UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Manual Review Org', 'manual-review-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Manual Review Client', 'manual-review-client-' || left(v_client::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender,
    v_client,
    'Manual Review Sender',
    'Manual Review Sender',
    TRUE,
    'active'
  );

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:manual-review-resolve-capability-fixture-bootstrap'
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops User', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org, 'client-' || left(v_user_client::text, 8) || '@example.com', 'Client User', 'client_admin', 'client', v_client);

  INSERT INTO manual_review_tasks (
    id,
    organization_id,
    client_id,
    task_type,
    reason,
    status,
    queue_assignment
  ) VALUES (
    v_task,
    v_org,
    v_client,
    'settings_approval',
    'pgTap manual review test',
    'pending',
    'access_policy'
  );

  PERFORM set_config('test.manual_review_task_id', v_task::text, true);
  PERFORM set_config('test.manual_review_user_ops', v_user_ops::text, true);
  PERFORM set_config('test.manual_review_user_client', v_user_client::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.manual_review_user_client'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.resolve_manual_review_task_v1(current_setting('test.manual_review_task_id')::uuid, 'approved', 'test') $$,
  'P0001',
  'resolve_manual_review_task_v1 requires manual_review.resolve capability'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.manual_review_user_ops'), true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.resolve_manual_review_task_v1(current_setting('test.manual_review_task_id')::uuid, 'approved', 'ok')).status,
  'resolved',
  'ops_admin can resolve manual review task'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
