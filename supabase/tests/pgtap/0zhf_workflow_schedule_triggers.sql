-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04
-- pgTAP: workflow_schedule_triggers are row-driven and gated by workflows.write.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_workflow_template UUID := gen_random_uuid();
  v_user_client_admin UUID := gen_random_uuid();
  v_user_sender UUID := gen_random_uuid();
  v_schedule_trigger_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Schedule Triggers Org', 'schedule-triggers-org-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Schedule Triggers Client', 'schedule-triggers-client-' || left(v_client::text, 8), 'active');

  INSERT INTO senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Schedule Triggers Sender', 'active');

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:workflow-schedule-triggers-fixture-bootstrap'
  );

  INSERT INTO workflow_templates (id, name, description, version, status, scope_type, scope_id, notes)
  VALUES (
    v_workflow_template,
    'schedule_trigger_template_' || left(v_workflow_template::text, 8),
    'Template used for schedule trigger pgTAP coverage.',
    1,
    'active',
    'tenant',
    v_org,
    'pgTAP fixture workflow template'
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user_client_admin,
    v_org,
    'schedule-trigger-client-admin-' || left(v_user_client_admin::text, 8) || '@example.com',
    'Schedule Trigger Client Admin',
    'client_admin',
    'client',
    v_client
  );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user_sender,
    v_org,
    'schedule-trigger-sender-user-' || left(v_user_sender::text, 8) || '@example.com',
    'Schedule Trigger Sender User',
    'sender_user',
    'sender',
    v_sender
  );

  EXECUTE 'RESET ROLE';

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v
        ON v.lookup_definition_id = d.id
      WHERE d.category = 'workflow_schedule_type'
        AND v.value = 'interval'
        AND v.status = 'active'
        AND v.metadata->>'summary_template' = 'every'
        AND (v.metadata #>> '{thresholds,hour_seconds}')::integer = 3600
        AND (v.metadata #>> '{thresholds,minute_seconds}')::integer = 60
    ),
    'workflow_schedule_type lookup rows are seeded for Console authoring'
  );

  PERFORM ok(
    pg_get_functiondef('public.ui_create_workflow_schedule_trigger_v1(uuid,jsonb,jsonb,boolean,text)'::regprocedure)
      LIKE '%assert_capability_v1(''workflows.write''%'
    AND pg_get_functiondef('public.ui_create_workflow_schedule_trigger_v1(uuid,jsonb,jsonb,boolean,text)'::regprocedure)
      NOT LIKE '%assert_capability_v1(''workflow_runs.write''%',
    'schedule create RPC gates on workflows.write only'
  );

  PERFORM ok(
    NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'workflow_schedule_triggers'
        AND policyname IN (
          'workflow_schedule_triggers_authenticated_insert',
          'workflow_schedule_triggers_authenticated_update',
          'workflow_schedule_triggers_authenticated_delete'
        )
        AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%workflow_runs.write%'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'workflow_schedule_triggers'
        AND policyname IN (
          'workflow_schedule_triggers_authenticated_insert',
          'workflow_schedule_triggers_authenticated_update',
          'workflow_schedule_triggers_authenticated_delete'
        )
        AND COALESCE(qual, '') || COALESCE(with_check, '') NOT LIKE '%workflows.write%'
    ),
    'workflow_schedule_triggers write policies align with workflows.write'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource(value)
      WHERE s.category = 'ui_read_registry'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND resource.value->>'key' = 'workflow_schedule_triggers'
        AND resource.value->>'capability_write' = 'workflows.write'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_row(column_value)
          WHERE column_value->>'edit_permission' = 'workflow_runs.write'
        )
    ),
    'workflow_schedule_triggers registry write capability aligns with workflows.write'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user_client_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT (
    public.ui_create_workflow_schedule_trigger_v1(
      v_workflow_template,
      jsonb_build_object('type','interval','interval_seconds',3600),
      '{}'::jsonb,
      TRUE,
      NULL
    )->>'workflow_schedule_trigger_id'
  )::uuid INTO v_schedule_trigger_id;

  PERFORM ok(
    v_schedule_trigger_id IS NOT NULL,
    'client_admin can create workflow schedule trigger'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM ok(
    (SELECT organization_id FROM public.workflow_schedule_triggers WHERE id = v_schedule_trigger_id) = v_org,
    'organization_id resolved from scope'
  );

  PERFORM ok(
    (SELECT scope_type FROM public.workflow_schedule_triggers WHERE id = v_schedule_trigger_id) = 'client',
    'scope_type stored from current_user_scope_type()'
  );

  PERFORM ok(
    (SELECT scope_id FROM public.workflow_schedule_triggers WHERE id = v_schedule_trigger_id) = v_client,
    'scope_id stored from current_user_scope_id()'
  );

  PERFORM ok(
    (SELECT next_run_at IS NOT NULL FROM public.workflow_schedule_triggers WHERE id = v_schedule_trigger_id),
    'next_run_at computed'
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user_sender::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM throws_ok(
    format(
      $sql$ SELECT public.ui_create_workflow_schedule_trigger_v1('%s'::uuid, '{"type":"interval","interval_seconds":3600}'::jsonb, '{}'::jsonb, TRUE, NULL); $sql$,
      v_workflow_template
    ),
    '42501',
    'Capability denied: workflows.write'
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;
