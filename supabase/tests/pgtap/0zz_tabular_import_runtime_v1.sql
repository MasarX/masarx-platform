BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(24);

SELECT has_table('public', 'tabular_import_runs', 'tabular_import_runs table exists');
SELECT has_table('public', 'tabular_import_run_rows', 'tabular_import_run_rows table exists');

SELECT ok(
  COALESCE(
    (SELECT rowsecurity
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'tabular_import_runs'),
    false
  ),
  'tabular_import_runs has RLS enabled'
);

SELECT ok(
  COALESCE(
    (SELECT rowsecurity
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'tabular_import_run_rows'),
    false
  ),
  'tabular_import_run_rows has RLS enabled'
);

SELECT ok(
  EXISTS(
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.tabular_import_run_rows'::regclass
      AND conname = 'tabular_import_run_rows_unique_row'
      AND contype = 'u'
  ),
  'tabular_import_run_rows keeps canonical unique row constraint'
);

SELECT ok(
  NOT EXISTS(
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'tabular_import_run_rows'
      AND indexname = 'idx_tabular_import_run_rows_run_row'
  ),
  'tabular_import_run_rows does not keep redundant run_id/row_number index'
);

SELECT has_column('public', 'mapping_operation_reports', 'operation_kind', 'mapping_operation_reports.operation_kind exists');

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'tabular_import_runs'
       AND c.column_name = 'write_mode'
       AND c.lookup_category = 'tabular_import_write_mode'
  ),
  'tabular_import_runs.write_mode is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'tabular_import_runs'
       AND c.column_name = 'status'
       AND c.lookup_category = 'tabular_import_run_status'
  ),
  'tabular_import_runs.status is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'tabular_import_run_rows'
       AND c.column_name = 'action'
       AND c.lookup_category = 'tabular_import_row_action'
  ),
  'tabular_import_run_rows.action is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'tabular_import_run_rows'
       AND c.column_name = 'execution_status'
       AND c.lookup_category = 'tabular_import_row_execution_status'
  ),
  'tabular_import_run_rows.execution_status is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'tabular_import_run_status'
       AND lv.value = 'completed_with_errors'
  ),
  'tabular_import_run_status lookup includes completed_with_errors'
);

SELECT has_function('public', 'tabular_import_prepare_v1', ARRAY['jsonb'], 'public.tabular_import_prepare_v1 exists');
SELECT has_function('public', 'ui_tabular_import_profiles_v1', ARRAY['text'], 'public.ui_tabular_import_profiles_v1 exists');
SELECT has_function('public', 'ui_get_tabular_import_run_v1', ARRAY['uuid'], 'public.ui_get_tabular_import_run_v1 exists');
SELECT has_function('public', 'ui_cancel_tabular_import_run_v1', ARRAY['uuid'], 'public.ui_cancel_tabular_import_run_v1 exists');
SELECT has_function('public', 'ui_start_tabular_import_run_v1', ARRAY['uuid', 'jsonb'], 'public.ui_start_tabular_import_run_v1 exists');
SELECT has_function('public', 'claim_next_tabular_import_task_v1', ARRAY['text'], 'public.claim_next_tabular_import_task_v1 exists');
SELECT has_function('public', 'process_tabular_import_run_v1', ARRAY['uuid', 'integer'], 'public.process_tabular_import_run_v1 exists');

SELECT has_function('api', 'tabular_import_prepare_v1', ARRAY['jsonb'], 'api.tabular_import_prepare_v1 exists');
SELECT has_function('api', 'ui_tabular_import_profiles_v1', ARRAY['text'], 'api.ui_tabular_import_profiles_v1 exists');
SELECT has_function('api', 'ui_get_tabular_import_run_v1', ARRAY['uuid'], 'api.ui_get_tabular_import_run_v1 exists');
SELECT has_function('api', 'ui_cancel_tabular_import_run_v1', ARRAY['uuid'], 'api.ui_cancel_tabular_import_run_v1 exists');
SELECT has_function('api', 'ui_start_tabular_import_run_v1', ARRAY['uuid', 'jsonb'], 'api.ui_start_tabular_import_run_v1 exists');

SELECT * FROM finish();

ROLLBACK;
