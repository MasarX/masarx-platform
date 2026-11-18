-- Plan: PLAN-202601-workflow-trigger-plugins-v1 / Step: S95
-- pgTAP: workflow_run_triggers are row-driven and gated by workflow_runs.write.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(16);

CREATE FUNCTION pg_temp.f641_prior_trigger_tests() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $f641_prior$
DECLARE
  v_org UUID := gen_random_uuid();
  v_active_org UUID := gen_random_uuid();
  v_active_client UUID := gen_random_uuid();
  v_active_sender UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_source_template UUID := gen_random_uuid();
  v_target_template UUID := gen_random_uuid();
  v_user_platform UUID := gen_random_uuid();
  v_user_client_admin UUID := gen_random_uuid();
  v_user_sender UUID := gen_random_uuid();
  v_trigger_id UUID;
  v_platform_trigger_id UUID;
  v_platform_active_trigger_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Workflow Run Triggers Org', 'workflow-run-triggers-org-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (
    v_active_org,
    'Workflow Run Triggers Active Tenant',
    'workflow-run-triggers-active-' || left(v_active_org::text, 8)
  );

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Workflow Run Triggers Client', 'workflow-run-triggers-client-' || left(v_client::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Workflow Run Triggers Sender', 'active');

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (
    v_active_client,
    v_active_org,
    'Workflow Run Triggers Active Client',
    'workflow-run-triggers-active-client-' || left(v_active_client::text, 8),
    'active'
  );

  INSERT INTO senders (id, client_id, name, status)
  VALUES (
    v_active_sender,
    v_active_client,
    'Workflow Run Triggers Active Sender',
    'active'
  );

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:workflow-run-triggers-fixture-bootstrap'
  );

  PERFORM bootstrap_tenant_onboarding_v1(
    v_active_org,
    'pgtap:workflow-run-triggers-active-tenant-fixture-bootstrap'
  );

  INSERT INTO workflow_templates (id, name, description, version, status, scope_type, scope_id, notes)
  VALUES (
    v_source_template,
    'workflow_run_trigger_source_' || left(v_source_template::text, 8),
    'Source workflow template used for workflow_run_triggers pgTAP coverage.',
    1,
    'active',
    'client',
    v_client,
    'pgTAP fixture source workflow template'
  );

  INSERT INTO workflow_templates (id, name, description, version, status, scope_type, scope_id, notes)
  VALUES (
    v_target_template,
    'workflow_run_trigger_target_' || left(v_target_template::text, 8),
    'Target workflow template used for workflow_run_triggers pgTAP coverage.',
    1,
    'active',
    'client',
    v_client,
    'pgTAP fixture target workflow template'
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user_platform,
    v_org,
    'workflow-run-trigger-platform-' || left(v_user_platform::text, 8) || '@example.com',
    'Workflow Run Trigger Platform Operator',
    'super_admin',
    'platform',
    NULL
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user_client_admin,
    v_org,
    'workflow-run-trigger-client-admin-' || left(v_user_client_admin::text, 8) || '@example.com',
    'Workflow Run Trigger Client Admin',
    'client_admin',
    'client',
    v_client
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user_sender,
    v_org,
    'workflow-run-trigger-sender-user-' || left(v_user_sender::text, 8) || '@example.com',
    'Workflow Run Trigger Sender User',
    'sender_user',
    'sender',
    v_sender
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user_client_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user_client_admin, 'role', 'authenticated')::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT (
    public.ui_create_workflow_run_trigger_v1(
      v_source_template,
      v_target_template,
      ARRAY['completed']::TEXT[],
      '{}'::jsonb,
      TRUE,
      NULL
    )->>'workflow_run_trigger_id'
  )::uuid INTO v_trigger_id;

  RETURN NEXT ok(
    v_trigger_id IS NOT NULL,
    'client_admin can create workflow run trigger'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    (SELECT organization_id FROM public.workflow_run_triggers WHERE id = v_trigger_id) = v_org,
    'organization_id resolved from scope'
  );

  RETURN NEXT ok(
    (SELECT scope_type FROM public.workflow_run_triggers WHERE id = v_trigger_id) = 'client',
    'scope_type stored from current_user_scope_type()'
  );

  RETURN NEXT ok(
    (SELECT scope_id FROM public.workflow_run_triggers WHERE id = v_trigger_id) = v_client,
    'scope_id stored from current_user_scope_id()'
  );

  RETURN NEXT is(
    (SELECT source_statuses FROM public.workflow_run_triggers WHERE id = v_trigger_id),
    ARRAY['succeeded']::TEXT[],
    'legacy completed trigger status is canonicalized to succeeded'
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user_platform::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user_platform, 'role', 'authenticated')::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT (
    public.ui_create_workflow_run_trigger_v1(
      v_source_template,
      v_target_template,
      ARRAY['completed']::TEXT[],
      jsonb_build_object('marker', 'platform-scope-normalization'),
      TRUE,
      'platform trigger scope normalization regression'
    )->>'workflow_run_trigger_id'
  )::uuid INTO v_platform_trigger_id;

  RETURN NEXT ok(
    v_platform_trigger_id IS NOT NULL,
    'platform operator can create workflow run trigger without unsupported platform scope'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    (SELECT scope_type FROM public.workflow_run_triggers WHERE id = v_platform_trigger_id) = 'tenant',
    'platform operator trigger is normalized to tenant scope_type'
  );

  RETURN NEXT ok(
    (SELECT scope_id FROM public.workflow_run_triggers WHERE id = v_platform_trigger_id) = v_org,
    'platform operator trigger uses caller organization as tenant scope_id'
  );

  RETURN NEXT is(
    (SELECT source_statuses FROM public.workflow_run_triggers WHERE id = v_platform_trigger_id),
    ARRAY['succeeded']::TEXT[],
    'platform trigger stores canonical succeeded source status'
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user_platform::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user_platform, 'role', 'authenticated')::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT (
    public.ui_create_workflow_run_trigger_v1(
      v_source_template,
      v_target_template,
      ARRAY['completed']::TEXT[],
      jsonb_build_object('marker', 'platform-active-tenant-scope'),
      TRUE,
      'platform active tenant trigger scope regression',
      v_active_org
    )->>'workflow_run_trigger_id'
  )::uuid INTO v_platform_active_trigger_id;

  RETURN NEXT ok(
    v_platform_active_trigger_id IS NOT NULL,
    'platform operator can create workflow run trigger for selected active tenant scope'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    (SELECT scope_id FROM public.workflow_run_triggers WHERE id = v_platform_active_trigger_id) = v_active_org,
    'platform operator trigger uses selected active tenant scope_id when provided'
  );

  RETURN NEXT is(
    (SELECT source_statuses FROM public.workflow_run_triggers WHERE id = v_platform_active_trigger_id),
    ARRAY['succeeded']::TEXT[],
    'platform active tenant trigger stores canonical succeeded source status'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
      FROM public.workflow_run_triggers
      WHERE id = v_platform_trigger_id
        AND scope_type = 'platform'
    ),
    'workflow_run_triggers never stores platform scope_type from the Console create RPC'
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user_client_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user_client_admin, 'role', 'authenticated')::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT public.ui_create_workflow_run_trigger_v1(
          '%s'::uuid,
          '%s'::uuid,
          ARRAY['completed']::TEXT[],
          '{}'::jsonb,
          TRUE,
          NULL,
          '%s'::uuid
        );
      $sql$,
      v_source_template,
      v_target_template,
      v_active_org
    ),
    '42501',
    'ui_create_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor'
  );

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT public.ui_create_workflow_run_trigger_v1(
          '%s'::uuid,
          '%s'::uuid,
          ARRAY['completed']::TEXT[],
          '{}'::jsonb,
          TRUE,
          NULL
        );
      $sql$,
      v_source_template,
      v_source_template
    ),
    'P0001',
    'workflow_run_triggers: source and target templates must differ'
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user_sender::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user_sender, 'role', 'authenticated')::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT public.ui_create_workflow_run_trigger_v1(
          '%s'::uuid,
          '%s'::uuid,
          ARRAY['completed']::TEXT[],
          '{}'::jsonb,
          TRUE,
          NULL
        );
      $sql$,
      v_source_template,
      v_target_template
    ),
    '42501',
    'Capability denied: workflow_runs.write'
  );

  EXECUTE 'RESET ROLE';
END;
$f641_prior$;

SELECT * FROM pg_temp.f641_prior_trigger_tests();

SELECT * FROM finish();
ROLLBACK;
