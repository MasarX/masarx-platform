-- Plan: PLAN-202603-ci-cd-runtime-reliability-mainline-convergence / Step: S95
-- Migration: Replace mapping studio and tabular import literal enum checks with lookup contracts

BEGIN;
SELECT pg_advisory_lock(hashtext('202603101630_mapping_tabular_lookup_contracts_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Canonical lookup categories + values
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('mapping_operation_report_artifact_type', 'Artifact type recorded by mapping operation reports.', 'engineering', 'tier_1', false),
  ('mapping_operation_report_save_mode', 'Save mode recorded by mapping operation reports.', 'engineering', 'tier_1', false),
  ('mapping_operation_report_status', 'Execution status recorded by mapping operation reports.', 'engineering', 'tier_1', false),
  ('mapping_operation_report_operation_kind', 'Operation kind recorded by mapping operation reports.', 'engineering', 'tier_1', false),
  ('tabular_import_write_mode', 'Write mode for tabular import runs.', 'engineering', 'tier_1', false),
  ('tabular_import_run_status', 'Lifecycle status for tabular import runs.', 'engineering', 'tier_1', false),
  ('tabular_import_row_action', 'Planned action for a staged tabular import row.', 'engineering', 'tier_1', false),
  ('tabular_import_row_execution_status', 'Execution status for a staged tabular import row.', 'engineering', 'tier_1', false)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('mapping_operation_report_artifact_type', 'tabular_import', 'Tabular Import', 10, true),
    ('mapping_operation_report_artifact_type', 'webhook_inbound', 'Webhook Inbound', 20, false),
    ('mapping_operation_report_artifact_type', 'api_outbound', 'API Outbound', 30, false),
    ('mapping_operation_report_artifact_type', 'integration_plugin', 'Integration Plugin', 40, false),

    ('mapping_operation_report_save_mode', 'direct', 'Direct', 10, true),
    ('mapping_operation_report_save_mode', 'draft', 'Draft', 20, false),

    ('mapping_operation_report_status', 'succeeded', 'Succeeded', 10, true),
    ('mapping_operation_report_status', 'failed', 'Failed', 20, false),

    ('mapping_operation_report_operation_kind', 'mapping_save', 'Mapping Save', 10, true),
    ('mapping_operation_report_operation_kind', 'tabular_import_execution', 'Tabular Import Execution', 20, false),

    ('tabular_import_write_mode', 'create', 'Create', 10, true),
    ('tabular_import_write_mode', 'upsert', 'Upsert', 20, false),

    ('tabular_import_run_status', 'prepared', 'Prepared', 10, true),
    ('tabular_import_run_status', 'queued', 'Queued', 20, false),
    ('tabular_import_run_status', 'processing', 'Processing', 30, false),
    ('tabular_import_run_status', 'completed', 'Completed', 40, false),
    ('tabular_import_run_status', 'completed_with_errors', 'Completed With Errors', 50, false),
    ('tabular_import_run_status', 'failed', 'Failed', 60, false),
    ('tabular_import_run_status', 'canceled', 'Canceled', 70, false),

    ('tabular_import_row_action', 'create', 'Create', 10, true),
    ('tabular_import_row_action', 'update', 'Update', 20, false),
    ('tabular_import_row_action', 'skip', 'Skip', 30, false),
    ('tabular_import_row_action', 'block', 'Block', 40, false),
    ('tabular_import_row_action', 'failed', 'Failed', 50, false),

    ('tabular_import_row_execution_status', 'queued', 'Queued', 10, true),
    ('tabular_import_row_execution_status', 'succeeded', 'Succeeded', 20, false),
    ('tabular_import_row_execution_status', 'failed', 'Failed', 30, false),
    ('tabular_import_row_execution_status', 'skipped', 'Skipped', 40, false),
    ('tabular_import_row_execution_status', 'blocked', 'Blocked', 50, false),
    ('tabular_import_row_execution_status', 'canceled', 'Canceled', 60, false)
) AS v(category, value, label, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Row-driven lookup contracts (SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_column_contracts (
  table_schema,
  table_name,
  column_name,
  lookup_category,
  allowed_values
)
VALUES
  ('public', 'mapping_configs', 'mapping_type', 'mapping_type', NULL),
  ('public', 'mapping_operation_reports', 'artifact_type', 'mapping_operation_report_artifact_type', NULL),
  ('public', 'mapping_operation_reports', 'save_mode', 'mapping_operation_report_save_mode', NULL),
  ('public', 'mapping_operation_reports', 'status', 'mapping_operation_report_status', NULL),
  ('public', 'mapping_operation_reports', 'operation_kind', 'mapping_operation_report_operation_kind', NULL),
  ('public', 'tabular_import_runs', 'write_mode', 'tabular_import_write_mode', NULL),
  ('public', 'tabular_import_runs', 'status', 'tabular_import_run_status', NULL),
  ('public', 'tabular_import_run_rows', 'action', 'tabular_import_row_action', NULL),
  ('public', 'tabular_import_run_rows', 'execution_status', 'tabular_import_row_execution_status', NULL)
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique
DO UPDATE SET
  lookup_category = EXCLUDED.lookup_category,
  allowed_values = EXCLUDED.allowed_values;

SELECT public.apply_lookup_column_contracts('public');

-------------------------------------------------------------------------------
-- 3) Drop literal enum CHECK constraints (row-driven enforcement now applies)
-------------------------------------------------------------------------------

ALTER TABLE public.mapping_configs
  DROP CONSTRAINT IF EXISTS mapping_configs_type_check;

ALTER TABLE public.mapping_operation_reports
  DROP CONSTRAINT IF EXISTS mapping_operation_reports_artifact_type_ck,
  DROP CONSTRAINT IF EXISTS mapping_operation_reports_save_mode_ck,
  DROP CONSTRAINT IF EXISTS mapping_operation_reports_status_ck,
  DROP CONSTRAINT IF EXISTS mapping_operation_reports_operation_kind_ck;

ALTER TABLE public.tabular_import_runs
  DROP CONSTRAINT IF EXISTS tabular_import_runs_write_mode_ck,
  DROP CONSTRAINT IF EXISTS tabular_import_runs_status_ck;

ALTER TABLE public.tabular_import_run_rows
  DROP CONSTRAINT IF EXISTS tabular_import_run_rows_action_ck,
  DROP CONSTRAINT IF EXISTS tabular_import_run_rows_execution_status_ck;

SELECT pg_advisory_unlock(hashtext('202603101630_mapping_tabular_lookup_contracts_v1'));
COMMIT;
