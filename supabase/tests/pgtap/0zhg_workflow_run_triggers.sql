-- Plan: PLAN-202601-workflow-trigger-plugins-v1 / Step: S95
-- pgTAP: workflow_run_triggers are row-driven and gated by workflow_runs.write.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

CREATE FUNCTION pg_temp.f641_prior_trigger_tests() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $f641_prior$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_source_template UUID := gen_random_uuid();
  v_target_template UUID := gen_random_uuid();
  v_user_client_admin UUID := gen_random_uuid();
  v_user_sender UUID := gen_random_uuid();
  v_trigger_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Workflow Run Triggers Org', 'workflow-run-triggers-org-' || left(v_org::text, 8));

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Workflow Run Triggers Client', 'workflow-run-triggers-client-' || left(v_client::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Workflow Run Triggers Sender', 'active');

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
