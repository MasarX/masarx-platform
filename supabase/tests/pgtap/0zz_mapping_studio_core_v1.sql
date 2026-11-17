BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(18);

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

SELECT * FROM finish();

ROLLBACK;
