BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(23);

SELECT has_table('public', 'mapping_operation_reports', 'mapping_operation_reports table exists');
SELECT ok(
  COALESCE(
    (SELECT rowsecurity
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'mapping_operation_reports'),
    false
  ),
  'mapping_operation_reports has RLS enabled'
);

SELECT has_function('public', 'ui_upsert_mapping_artifact_v1', ARRAY['jsonb'], 'ui_upsert_mapping_artifact_v1 exists');
SELECT has_function('public', 'ui_upsert_mapping_config_v1', ARRAY['jsonb'], 'ui_upsert_mapping_config_v1 exists');
SELECT has_function('public', 'ui_create_mapping_operation_report_v1', ARRAY['jsonb'], 'ui_create_mapping_operation_report_v1 exists');
SELECT has_function('api', 'ui_upsert_mapping_artifact_v1', ARRAY['jsonb'], 'api.ui_upsert_mapping_artifact_v1 exists');
SELECT ok(
  NOT has_function_privilege('anon', 'public.ui_upsert_mapping_artifact_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute public.ui_upsert_mapping_artifact_v1'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_upsert_mapping_artifact_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute api.ui_upsert_mapping_artifact_v1'
);
SELECT has_function('api', 'ui_create_mapping_operation_report_v1', ARRAY['jsonb'], 'api.ui_create_mapping_operation_report_v1 exists');
SELECT has_function('api', 'assert_capability_v1', ARRAY['text', 'text', 'uuid'], 'api.assert_capability_v1 exists');

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'mapping_configs'
       AND c.column_name = 'mapping_type'
       AND c.lookup_category = 'mapping_type'
  ),
  'mapping_configs.mapping_type is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_type'
       AND lv.value = 'tabular_import'
  ),
  'mapping_type lookup includes tabular_import'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'mapping_operation_reports'
       AND c.column_name = 'artifact_type'
       AND c.lookup_category = 'mapping_operation_report_artifact_type'
  ),
  'mapping_operation_reports.artifact_type is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'mapping_operation_reports'
       AND c.column_name = 'save_mode'
       AND c.lookup_category = 'mapping_operation_report_save_mode'
  ),
  'mapping_operation_reports.save_mode is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'mapping_operation_reports'
       AND c.column_name = 'status'
       AND c.lookup_category = 'mapping_operation_report_status'
  ),
  'mapping_operation_reports.status is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'mapping_operation_reports'
       AND c.column_name = 'operation_kind'
       AND c.lookup_category = 'mapping_operation_report_operation_kind'
  ),
  'mapping_operation_reports.operation_kind is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_operation_report_operation_kind'
       AND lv.value = 'tabular_import_execution'
  ),
  'mapping_operation_report_operation_kind lookup includes tabular_import_execution'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'mapping_operation_reports'
       AND policyname = 'mapping_operation_reports_select'
  ),
  'mapping_operation_reports select policy exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'mapping_operation_reports'
       AND policyname = 'mapping_operation_reports_insert'
  ),
  'mapping_operation_reports insert policy exists'
);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000c501';
  v_foreign_org UUID := '00000000-0000-0000-0000-00000000c502';
  v_ops UUID := '00000000-0000-0000-0000-00000000c511';
  v_global_mapping UUID := '00000000-0000-0000-0000-00000000c521';
  v_foreign_mapping UUID := '00000000-0000-0000-0000-00000000c522';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Mapping Config Scope Org', 'mapping-config-scope-' || left(v_org::text, 8)),
    (v_foreign_org, 'Mapping Config Scope Foreign Org', 'mapping-config-scope-foreign-' || left(v_foreign_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops,
    v_org,
    'mapping-config-scope-' || left(v_ops::text, 8) || '@example.com',
    'Mapping Config Scope Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version)
  VALUES
    (v_global_mapping, NULL, 'webhook_inbound', 'pgtap-global-service-managed', '{}'::jsonb, 1),
    (v_foreign_mapping, v_foreign_org, 'webhook_inbound', 'pgtap-foreign-org-owned', '{}'::jsonb, 1)
  ON CONFLICT (mapping_type, mapping_key) DO NOTHING;

  PERFORM set_config('test.mapping_config_scope_ops', v_ops::text, true);
  PERFORM set_config('test.mapping_config_scope_org', v_org::text, true);
  PERFORM set_config('test.mapping_config_scope_global_id', v_global_mapping::text, true);
  PERFORM set_config('test.mapping_config_scope_foreign_id', v_foreign_mapping::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.mapping_config_scope_ops'), true);
SET LOCAL ROLE authenticated;

SELECT ok(
  (
    SELECT (public.ui_upsert_mapping_config_v1(jsonb_build_object(
      'mapping_type', 'webhook_inbound',
      'mapping_key', 'pgtap-own-org-create',
      'mapping_config', jsonb_build_object('target', 'shipments.create')
    ))->>'ok')::bool
  ),
  'ui_upsert_mapping_config_v1 creates org-scoped mapping config'
);

SELECT throws_ok(
  $$ SELECT public.ui_upsert_mapping_config_v1(jsonb_build_object(
       'mapping_type', 'webhook_inbound',
       'mapping_key', 'pgtap-unknown-target',
       'mapping_config', jsonb_build_object('target', 'pgtap_target')
     )) $$,
  '23503',
  NULL,
  'ui_upsert_mapping_config_v1 rejects mapping_config.target outside mapping_target lookup'
);

SELECT throws_ok(
  $$ SELECT public.ui_upsert_mapping_config_v1(jsonb_build_object(
       'mapping_config_id', current_setting('test.mapping_config_scope_global_id'),
       'mapping_type', 'webhook_inbound',
       'mapping_key', 'pgtap-global-service-managed',
       'mapping_config', jsonb_build_object('target', 'shipments.create')
     )) $$,
  '42501',
  NULL,
  'ui_upsert_mapping_config_v1 refuses global/shared mapping config edits'
);

SELECT throws_ok(
  $$ SELECT public.ui_upsert_mapping_config_v1(jsonb_build_object(
       'mapping_config_id', current_setting('test.mapping_config_scope_foreign_id'),
       'mapping_type', 'webhook_inbound',
       'mapping_key', 'pgtap-foreign-org-owned',
       'mapping_config', jsonb_build_object('target', 'shipments.create')
     )) $$,
  '42501',
  NULL,
  'ui_upsert_mapping_config_v1 refuses cross-tenant mapping config edits'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
