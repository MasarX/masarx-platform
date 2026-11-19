-- pgTAP: Console V2 workflow run trigger lifecycle RPCs stay gated and row-driven.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(42);

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

CREATE FUNCTION pg_temp.f641_lifecycle_tests() RETURNS SETOF TEXT LANGUAGE plpgsql AS $f641$
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
  v_create JSONB;
  v_update JSONB;
  v_delete JSONB;
  v_repeat JSONB;
  v_first_deleted JSONB;
  v_duplicate_sql TEXT;
  v_foreign_trigger UUID := gen_random_uuid();
  v_platform_user UUID := gen_random_uuid();
  v_tenant_user UUID := gen_random_uuid();
  v_absent_org UUID := gen_random_uuid();
  v_platform_create JSONB;
  v_registry JSONB;
  v_registry_version UUID;
  v_registry_schema INT;
  v_registry_id UUID;
  v_resource JSONB;
  v_stale_registry JSONB;
BEGIN
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id=v_absent_org) THEN
    RAISE EXCEPTION 'F641 absent organization fixture collision';
  END IF;
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

  v_create := api.ui_create_workflow_run_trigger_v1(
    v_source_template,
    v_target_template,
    ARRAY['completed']::TEXT[],
    '{}'::jsonb,
    TRUE,
    'initial lifecycle trigger'
  );

  v_trigger_id := (v_create->>'workflow_run_trigger_id')::uuid;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    NULLIF(v_create->>'decision_log_id', '') IS NOT NULL
      AND NULLIF(v_create->>'domain_event_id', '') IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM public.decision_log dl
         WHERE dl.id = (v_create->>'decision_log_id')::uuid
           AND dl.resource_type = 'workflow_run_trigger'
           AND dl.resource_id = v_trigger_id
           AND dl.decision_point = 'workflow_run_trigger.create'
           AND dl.decision_outcome = 'created'
      )
      AND EXISTS (
        SELECT 1
          FROM public.domain_events de
         WHERE de.id = (v_create->>'domain_event_id')::uuid
           AND de.resource_type = 'workflow_run_trigger'
           AND de.resource_id = v_trigger_id
           AND de.event_type = 'workflow_run_trigger.created'
      ),
    'create RPC returns and writes workflow trigger decision/domain evidence'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user_client_admin::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user_client_admin, 'role', 'authenticated')::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_update := api.ui_update_workflow_run_trigger_v1(
    v_trigger_id,
    v_source_template,
    v_alt_target_template,
    ARRAY[' Completed ', 'completed']::TEXT[],
    jsonb_build_object('lifecycle', 'updated'),
    FALSE,
    'updated lifecycle trigger'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    v_update->>'workflow_run_trigger_id' = v_trigger_id::text,
    'update RPC returns the updated trigger id'
  );

  RETURN NEXT is(
    (SELECT target_workflow_template_id FROM public.workflow_run_triggers WHERE id = v_trigger_id),
    v_alt_target_template,
    'update RPC persists target workflow template changes'
  );

  RETURN NEXT is(
    (SELECT source_statuses FROM public.workflow_run_triggers WHERE id = v_trigger_id),
    ARRAY['completed']::TEXT[],
    'update RPC reuses before-write canonical status normalization'
  );

  RETURN NEXT ok(
    (SELECT enabled FROM public.workflow_run_triggers WHERE id = v_trigger_id) = FALSE
      AND (SELECT notes FROM public.workflow_run_triggers WHERE id = v_trigger_id) = 'updated lifecycle trigger',
    'update RPC persists enabled state and notes'
  );

  RETURN NEXT ok(
    NULLIF(v_update->>'decision_log_id', '') IS NOT NULL
      AND NULLIF(v_update->>'domain_event_id', '') IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM public.decision_log dl
         WHERE dl.id = (v_update->>'decision_log_id')::uuid
           AND dl.resource_type = 'workflow_run_trigger'
           AND dl.resource_id = v_trigger_id
           AND dl.decision_point = 'workflow_run_trigger.update'
           AND dl.decision_outcome = 'disabled'
      )
      AND EXISTS (
        SELECT 1
          FROM public.domain_events de
         WHERE de.id = (v_update->>'domain_event_id')::uuid
           AND de.resource_type = 'workflow_run_trigger'
           AND de.resource_id = v_trigger_id
           AND de.event_type = 'workflow_run_trigger.disabled'
      ),
    'update RPC returns and writes disabled workflow trigger decision/domain evidence'
  );



  RETURN NEXT ok(
    (SELECT bool_and(NOT has_function_privilege(r.role_name,
      'public.workflow_run_trigger_lifecycle_evidence_v1(text,public.workflow_run_triggers)','EXECUTE'))
     FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)),
    'private lifecycle evidence cannot be forged through default role grants');
  RETURN NEXT ok(
    (SELECT bool_and(NOT has_function_privilege(r.role_name,
      'public.ui_assert_generic_mutation_relation_v1(regclass)','EXECUTE'))
     FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)),
    'generic mutation relation guard remains private');
  RETURN NEXT ok(
    (SELECT bool_and(NOT has_function_privilege('anon',f.signature,'EXECUTE'))
     FROM unnest(ARRAY[
       'public.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text)',
       'public.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text,uuid)',
       'api.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text)',
       'api.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text,uuid)',
       'public.ui_update_workflow_run_trigger_v1(uuid,uuid,uuid,text[],jsonb,boolean,text,uuid)',
       'api.ui_update_workflow_run_trigger_v1(uuid,uuid,uuid,text[],jsonb,boolean,text,uuid)',
       'public.ui_delete_workflow_run_trigger_v1(uuid,uuid)',
       'api.ui_delete_workflow_run_trigger_v1(uuid,uuid)'
     ]) f(signature)),
    'anonymous callers cannot execute lifecycle RPCs');

  -- Existing generic writers reject the active view and every stale raw-table alias.
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.ui_update_resource_v1(%L,%L,%L::jsonb)',
    'workflow_run_triggers',v_trigger_id::TEXT,'{"enabled":true}'),
    'P0001','ui_update_resource_v1 relation not allowed: public.workflow_run_triggers_active_v1',
    'generic update cannot mutate the active view');
  RETURN NEXT throws_ok(format('SELECT api.ui_delete_resource_v1(%L,%L)',
    'workflow_run_triggers',v_trigger_id::TEXT),
    'P0001','ui_delete_resource_v1 relation not allowed: public.workflow_run_triggers_active_v1',
    'generic delete cannot mutate the active view');
  RETURN NEXT ok(
    NOT has_table_privilege('authenticated','public.workflow_run_triggers','INSERT')
    AND NOT has_table_privilege('authenticated','public.workflow_run_triggers','UPDATE')
    AND NOT has_table_privilege('authenticated','public.workflow_run_triggers','DELETE'),
    'browser direct base DML cannot bypass lifecycle RPCs');
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT s.id,s.settings_version_id,sv.schema_version,sv.value INTO v_registry_id,v_registry_version,v_registry_schema,v_registry
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='ui_read_registry' AND s.scope_type='global' AND s.scope_id IS NULL;
  SELECT r.value INTO v_resource FROM jsonb_array_elements(v_registry->'resources') r(value)
    WHERE r.value->>'key'='workflow_run_triggers';
  IF v_resource IS NULL THEN RAISE EXCEPTION 'Missing owned test registry source'; END IF;
  v_stale_registry := jsonb_set(v_registry,'{resources}',
    (SELECT jsonb_agg(CASE WHEN r.value->>'key'='workflow_run_triggers'
      THEN r.value || jsonb_build_object('relation','public.workflow_run_triggers') ELSE r.value END ORDER BY r.ordinality)
     FROM jsonb_array_elements(v_registry->'resources') WITH ORDINALITY r(value,ordinality))
    || jsonb_build_array(v_resource || jsonb_build_object('key','f641_trigger_alias','relation','public.workflow_run_triggers')),TRUE);
  PERFORM public.upsert_settings_value_v1('ui_read_registry','client',v_client,
    v_stale_registry,v_registry_schema,'F641 owned stale scoped registry fixture');
  -- Canonical global routing ignores scoped relation overrides and rejects scoped-only aliases.
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.ui_update_resource_v1(%L,%L,%L::jsonb)',
    'workflow_run_triggers',v_trigger_id::TEXT,'{"enabled":true}'),
    'P0001','ui_update_resource_v1 relation not allowed: public.workflow_run_triggers_active_v1',
    'stale raw-table registry cannot bypass lifecycle update');
  RETURN NEXT throws_ok(format('SELECT api.ui_delete_resource_v1(%L,%L)',
    'workflow_run_triggers',v_trigger_id::TEXT),
    'P0001','ui_delete_resource_v1 relation not allowed: public.workflow_run_triggers_active_v1',
    'stale raw-table registry cannot bypass lifecycle delete');
  RETURN NEXT throws_ok(format('SELECT api.ui_update_resource_v1(%L,%L,%L::jsonb)',
    'f641_trigger_alias',v_trigger_id::TEXT,'{"enabled":true}'),
    'P0001','ui_update_resource_v1 unknown resource f641_trigger_alias',
    'raw-table alias cannot bypass lifecycle update');
  RETURN NEXT throws_ok(format('SELECT api.ui_delete_resource_v1(%L,%L)',
    'f641_trigger_alias',v_trigger_id::TEXT),
    'P0001','ui_delete_resource_v1 unknown resource f641_trigger_alias',
    'raw-table alias cannot bypass lifecycle delete');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM public.upsert_settings_value_v1('ui_read_registry','client',v_client,
    v_registry,v_registry_schema,'F641 owned active registry restoration');
  RETURN NEXT lives_ok('SELECT public.ui_assert_generic_mutation_relation_v1(''public.workflow_schedule_triggers''::regclass)',
    'unrelated schedule relation retains generic mutation eligibility');

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
    'completed',
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
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user_client_admin, 'role', 'authenticated')::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_delete := api.ui_delete_workflow_run_trigger_v1(v_trigger_id);

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
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

  RETURN NEXT ok(
    NULLIF(v_delete->>'decision_log_id', '') IS NOT NULL
      AND NULLIF(v_delete->>'domain_event_id', '') IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM public.decision_log dl
         WHERE dl.id = (v_delete->>'decision_log_id')::uuid
           AND dl.resource_type = 'workflow_run_trigger'
           AND dl.resource_id = v_trigger_id
           AND dl.decision_point = 'workflow_run_trigger.delete'
           AND dl.decision_outcome = 'deleted'
      )
      AND EXISTS (
        SELECT 1
          FROM public.domain_events de
         WHERE de.id = (v_delete->>'domain_event_id')::uuid
           AND de.resource_type = 'workflow_run_trigger'
           AND de.resource_id = v_trigger_id
           AND de.event_type = 'workflow_run_trigger.deleted'
      ),
    'delete RPC returns and writes workflow trigger decision/domain evidence'
  );


  -- Repeat deletion preserves its first metadata and existing pending lineage.
  SELECT to_jsonb(t) INTO v_first_deleted FROM public.workflow_run_triggers t WHERE id = v_trigger_id;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_repeat := api.ui_delete_workflow_run_trigger_v1(v_trigger_id);
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    (SELECT deleted_at = (v_first_deleted->>'deleted_at')::TIMESTAMPTZ
       AND deleted_by IS NOT DISTINCT FROM (v_first_deleted->>'deleted_by')::UUID
       AND delete_reason IS NOT DISTINCT FROM v_first_deleted->>'delete_reason'
     FROM public.workflow_run_triggers WHERE id = v_trigger_id),
    'repeat delete preserves the first tombstone metadata'
  );
  RETURN NEXT ok(
    v_repeat->>'decision_log_id' <> v_delete->>'decision_log_id'
    AND v_repeat->>'domain_event_id' <> v_delete->>'domain_event_id'
    AND v_repeat->>'correlation_id' <> v_delete->>'correlation_id',
    'repeat delete emits fresh lifecycle evidence'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.domain_events de JOIN public.decision_log dl
      ON dl.id = (de.payload->>'decision_log_id')::UUID
      WHERE de.id = (v_repeat->>'domain_event_id')::UUID
        AND de.correlation_id = dl.correlation_id
        AND de.correlation_id = (v_repeat->>'correlation_id')::UUID),
    'domain and decision evidence share the returned correlation'
  );
  RETURN NEXT is((SELECT fire_status FROM public.workflow_trigger_fires WHERE id = v_fire_id),
    'pending', 'delete does not cancel pending fires');
  RETURN NEXT ok(EXISTS (SELECT 1 FROM public.workflow_runs WHERE id = v_source_run_id),
    'delete retains already admitted workflow runs');
  v_duplicate_sql := format(
    'INSERT INTO public.workflow_run_triggers(scope_type,scope_id,source_workflow_template_id,target_workflow_template_id,source_statuses) VALUES (%L,%L::uuid,%L::uuid,%L::uuid,ARRAY[%L]::text[])',
    v_first_deleted->>'scope_type', v_first_deleted->>'scope_id',
    v_source_template, v_alt_target_template, 'completed');
  RETURN NEXT lives_ok(v_duplicate_sql, 'a deleted binding can be recreated while its tombstone is retained');
  RETURN NEXT throws_ok(v_duplicate_sql, '23505', NULL, 'a second active binding remains forbidden');
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is((SELECT count(*) FROM public.workflow_run_triggers_active_v1 WHERE id = v_trigger_id),
    0::BIGINT, 'active projection excludes tombstones');
  RETURN NEXT is((SELECT count(*) FROM public.workflow_trigger_fires WHERE id = v_fire_id),
    1::BIGINT, 'scoped fire history remains visible through retained base rows');
  EXECUTE 'SET LOCAL ROLE postgres';

  -- Foreign deleted state must not become an existence/status disclosure.
  INSERT INTO public.workflow_run_triggers(id,scope_type,scope_id,source_workflow_template_id,target_workflow_template_id)
  VALUES (v_foreign_trigger,'tenant',v_foreign_org,v_foreign_template,v_target_template);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.ui_update_workflow_run_trigger_v1(%L::uuid)',v_foreign_trigger),
    '42501','ui_update_workflow_run_trigger_v1 workflow run trigger is outside caller scope',
    'foreign live trigger update is denied');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.workflow_run_triggers SET deleted_at=now(), enabled=FALSE WHERE id=v_foreign_trigger;
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.ui_update_workflow_run_trigger_v1(%L::uuid)',v_foreign_trigger),
    '42501','ui_update_workflow_run_trigger_v1 workflow run trigger is outside caller scope',
    'foreign deleted trigger update has the same scope denial');
  EXECUTE 'SET LOCAL ROLE postgres';

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user_client_admin::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user_client_admin, 'role', 'authenticated')::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT public.ui_update_workflow_run_trigger_v1(
          '%s'::uuid,
          '%s'::uuid,
          '%s'::uuid,
          ARRAY['completed']::TEXT[],
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


  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
  VALUES
    (v_platform_user,v_org,'f641-platform-'||v_platform_user||'@example.com','F641 platform','ops_admin','active','platform',NULL),
    (v_tenant_user,v_org,'f641-tenant-'||v_tenant_user||'@example.com','F641 tenant','ops_admin','active','tenant',NULL);
  PERFORM set_config('request.jwt.claim.sub',v_platform_user::TEXT,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_platform_user,'role','authenticated')::TEXT,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_platform_create := api.ui_create_workflow_run_trigger_v1(
    v_source_template,v_target_template,ARRAY[' Completed ','completed']::TEXT[],'{}'::JSONB,TRUE,NULL,v_org);
  RETURN NEXT ok(v_platform_create->>'scope_type'='tenant' AND v_platform_create->>'scope_id'=v_org::TEXT,
    'explicit platform active-tenant create uses the selected organization');
  RETURN NEXT ok(v_platform_create->'source_statuses'='["completed"]'::JSONB,
    'create readback uses canonical completed normalization');
  RETURN NEXT throws_ok(format(
    'SELECT api.ui_create_workflow_run_trigger_v1(%L::uuid,%L::uuid,NULL,NULL,NULL,NULL,%L::uuid)',
    v_source_template,v_target_template,v_absent_org),
    '22023','ui_create_workflow_run_trigger_v1 active tenant scope_id does not exist',
    'platform cannot create in a nonexistent selected tenant');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',v_tenant_user::TEXT,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_tenant_user,'role','authenticated')::TEXT,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format(
    'SELECT api.ui_create_workflow_run_trigger_v1(%L::uuid,%L::uuid,NULL,NULL,NULL,NULL,%L::uuid)',
    v_source_template,v_target_template,v_foreign_org),
    '42501','ui_create_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor',
    'tenant cannot redirect create to another organization');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub',v_user_client_admin::TEXT,TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_user_client_admin,'role','authenticated')::TEXT,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format(
    'SELECT api.ui_create_workflow_run_trigger_v1(%L::uuid,%L::uuid,NULL,NULL,NULL,NULL,%L::uuid)',
    v_source_template,v_target_template,v_org),
    '42501','ui_create_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor',
    'client cannot supply an active-tenant override');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claims','{}',TRUE);

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user_sender::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user_sender, 'role', 'authenticated')::TEXT, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT public.ui_delete_workflow_run_trigger_v1('%s'::uuid);
      $sql$,
      gen_random_uuid()
    ),
    '42501',
    'Capability denied: workflow_runs.write'
  );

  EXECUTE 'RESET ROLE';
END;
$f641$;

SELECT * FROM pg_temp.f641_lifecycle_tests();
SELECT * FROM finish();
ROLLBACK;
