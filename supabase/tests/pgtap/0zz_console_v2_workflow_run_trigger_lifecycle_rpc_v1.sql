-- pgTAP: Console V2 workflow run trigger lifecycle RPCs stay gated and row-driven.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT has_function(
  'public',
  'ui_update_workflow_run_trigger_v1',
  ARRAY['uuid','uuid','uuid','text[]','jsonb','boolean','text','uuid'],
  'public workflow run trigger update RPC exists'
);

SELECT has_function(
  'api',
  'ui_update_workflow_run_trigger_v1',
  ARRAY['uuid','uuid','uuid','text[]','jsonb','boolean','text','uuid'],
  'api workflow run trigger update wrapper exists'
);

SELECT has_function(
  'public',
  'ui_delete_workflow_run_trigger_v1',
  ARRAY['uuid','uuid'],
  'public workflow run trigger delete RPC exists'
);

SELECT has_function(
  'api',
  'ui_delete_workflow_run_trigger_v1',
  ARRAY['uuid','uuid'],
  'api workflow run trigger delete wrapper exists'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_source_template UUID := gen_random_uuid();
  v_target_template UUID := gen_random_uuid();
  v_alt_target_template UUID := gen_random_uuid();
  v_foreign_org UUID := gen_random_uuid();
  v_foreign_template UUID := gen_random_uuid();
  v_user_client_admin UUID := gen_random_uuid();
  v_user_sender UUID := gen_random_uuid();
  v_trigger_id UUID;
  v_source_run_id UUID := gen_random_uuid();
  v_fire_id UUID := gen_random_uuid();
  v_update JSONB;
  v_delete JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Workflow Trigger Lifecycle Org', 'workflow-trigger-lifecycle-' || left(v_org::text, 8));

  INSERT INTO organizations (id, name, slug)
  VALUES (
    v_foreign_org,
    'Workflow Trigger Lifecycle Foreign Org',
    'workflow-trigger-lifecycle-foreign-' || left(v_foreign_org::text, 8)
  );

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Workflow Trigger Lifecycle Client', 'workflow-trigger-lifecycle-client-' || left(v_client::text, 8), 'active');

  INSERT INTO workflow_templates (id, name, description, version, status, scope_type, scope_id, notes)
  VALUES
    (
      v_source_template,
      'workflow_trigger_lifecycle_source_' || left(v_source_template::text, 8),
      'Source workflow template used for workflow trigger lifecycle pgTAP coverage.',
      1,
      'active',
      'client',
      v_client,
      'pgTAP fixture source workflow template'
    ),
    (
      v_target_template,
      'workflow_trigger_lifecycle_target_' || left(v_target_template::text, 8),
      'Target workflow template used for workflow trigger lifecycle pgTAP coverage.',
      1,
      'active',
      'client',
      v_client,
      'pgTAP fixture target workflow template'
    ),
    (
      v_alt_target_template,
      'workflow_trigger_lifecycle_alt_target_' || left(v_alt_target_template::text, 8),
      'Alternate target workflow template used for workflow trigger lifecycle pgTAP coverage.',
      1,
      'active',
      'client',
      v_client,
      'pgTAP fixture alternate target workflow template'
    ),
    (
      v_foreign_template,
      'workflow_trigger_lifecycle_foreign_' || left(v_foreign_template::text, 8),
      'Foreign tenant workflow template used for workflow trigger lifecycle scope guards.',
      1,
      'active',
      'tenant',
      v_foreign_org,
      'pgTAP fixture foreign workflow template'
    );

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (
      v_user_client_admin,
      v_org,
      'workflow-trigger-lifecycle-admin-' || left(v_user_client_admin::text, 8) || '@example.com',
      'Workflow Trigger Lifecycle Client Admin',
      'client_admin',
      'client',
      v_client
    ),
    (
      v_user_sender,
      v_org,
      'workflow-trigger-lifecycle-sender-' || left(v_user_sender::text, 8) || '@example.com',
      'Workflow Trigger Lifecycle Sender User',
      'sender_user',
      'sender',
      gen_random_uuid()
    );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_user_client_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM throws_ok(
    format(
      $sql$
        SELECT public.ui_create_workflow_run_trigger_v1(
          '%s'::uuid,
          '%s'::uuid,
          ARRAY['completed']::TEXT[],
          '{}'::jsonb,
          TRUE,
          'foreign trigger should fail'
        );
      $sql$,
      v_source_template,
      v_foreign_template
    ),
    '42501',
    'ui_create_workflow_run_trigger_v1 target workflow template is outside caller scope',
    'create RPC rejects workflow trigger templates outside caller scope'
  );

  SELECT (
    public.ui_create_workflow_run_trigger_v1(
      v_source_template,
      v_target_template,
      ARRAY['completed']::TEXT[],
      '{}'::jsonb,
      TRUE,
      'initial lifecycle trigger'
    )->>'workflow_run_trigger_id'
  )::uuid INTO v_trigger_id;

  v_update := public.ui_update_workflow_run_trigger_v1(
    v_trigger_id,
    v_source_template,
    v_alt_target_template,
    ARRAY['completed']::TEXT[],
    jsonb_build_object('lifecycle', 'updated'),
    FALSE,
    'updated lifecycle trigger'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM ok(
    v_update->>'workflow_run_trigger_id' = v_trigger_id::text,
    'update RPC returns the updated trigger id'
  );

  PERFORM is(
    (SELECT target_workflow_template_id FROM public.workflow_run_triggers WHERE id = v_trigger_id),
    v_alt_target_template,
    'update RPC persists target workflow template changes'
  );

  PERFORM is(
    (SELECT source_statuses FROM public.workflow_run_triggers WHERE id = v_trigger_id),
    ARRAY['succeeded']::TEXT[],
    'update RPC reuses before-write canonical status normalization'
  );

  PERFORM ok(
    (SELECT enabled FROM public.workflow_run_triggers WHERE id = v_trigger_id) = FALSE
      AND (SELECT notes FROM public.workflow_run_triggers WHERE id = v_trigger_id) = 'updated lifecycle trigger',
    'update RPC persists enabled state and notes'
  );

  PERFORM set_config('app.workflow_run_id', v_source_run_id::text, true);

  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context
  )
  VALUES (
    v_source_run_id,
    v_source_template,
    1,
    'test',
    'succeeded',
    '{}'::jsonb
  );

  INSERT INTO public.workflow_trigger_fires (
    id,
    organization_id,
    workflow_run_trigger_id,
    source_workflow_run_id,
    fire_status
  )
  VALUES (
    v_fire_id,
    v_org,
    v_trigger_id,
    v_source_run_id,
    'pending'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user_client_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_delete := public.ui_delete_workflow_run_trigger_v1(v_trigger_id);

  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM ok(
    v_delete->>'workflow_run_trigger_id' = v_trigger_id::text
      AND EXISTS (
        SELECT 1
          FROM public.workflow_run_triggers
         WHERE id = v_trigger_id
           AND enabled = FALSE
           AND deleted_at IS NOT NULL
      )
      AND EXISTS (
        SELECT 1
          FROM public.workflow_trigger_fires
         WHERE id = v_fire_id
           AND workflow_run_trigger_id = v_trigger_id
      )
      AND (v_delete->>'workflow_trigger_fires_count')::INT = 1,
    'delete RPC soft-deletes the trigger and preserves workflow trigger fire lineage'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user_client_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM throws_ok(
    format(
      $sql$
        SELECT public.ui_update_workflow_run_trigger_v1(
          '%s'::uuid,
          '%s'::uuid,
          '%s'::uuid,
          ARRAY['succeeded']::TEXT[],
          '{}'::jsonb,
          TRUE,
          'should not restore deleted trigger'
        );
      $sql$,
      v_trigger_id,
      v_source_template,
      v_target_template
    ),
    '55000',
    'ui_update_workflow_run_trigger_v1 cannot update a deleted workflow run trigger',
    'update RPC fails closed instead of restoring or mutating a soft-deleted trigger'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user_sender::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM throws_ok(
    format(
      $sql$
        SELECT public.ui_delete_workflow_run_trigger_v1('%s'::uuid);
      $sql$,
      gen_random_uuid()
    ),
    '42501',
    'Capability denied: workflows.write'
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT * FROM finish();
ROLLBACK;
