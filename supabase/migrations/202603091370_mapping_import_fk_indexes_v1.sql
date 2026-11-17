-- Plan: PLAN-202603-shared-mapping-studio / Step: S95
-- Migration: Add supporting FK indexes for mapping/import runtime tables
--
-- Purpose:
--   - Satisfy enterprise FK hygiene for the shared mapping studio and universal
--     import runtime tables.
--   - Ensure every new foreign key added by this feature has a supporting
--     non-partial index on the referencing columns.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091370_mapping_import_fk_indexes_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_mapping_operation_reports_workflow_template_id
  ON public.mapping_operation_reports (workflow_template_id)
  WHERE workflow_template_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_client_id
  ON public.tabular_import_runs (client_id)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_created_by
  ON public.tabular_import_runs (created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_error_artifact_id
  ON public.tabular_import_runs (error_artifact_id)
  WHERE error_artifact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_report_id
  ON public.tabular_import_runs (report_id)
  WHERE report_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_sender_id
  ON public.tabular_import_runs (sender_id)
  WHERE sender_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_source_artifact_id
  ON public.tabular_import_runs (source_artifact_id)
  WHERE source_artifact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_task_id
  ON public.tabular_import_runs (task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_updated_by
  ON public.tabular_import_runs (updated_by)
  WHERE updated_by IS NOT NULL;

SELECT pg_advisory_unlock(hashtext('202603091370_mapping_import_fk_indexes_v1'));
COMMIT;
