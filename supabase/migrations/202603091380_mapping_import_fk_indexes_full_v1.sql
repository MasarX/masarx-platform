-- Plan: PLAN-202603-shared-mapping-studio / Step: S95
-- Migration: Replace partial FK indexes with full supporting indexes
--
-- Purpose:
--   - FK hygiene requires full, non-partial indexes on referencing columns.
--   - Replace the earlier nullable partial indexes with full indexes so pgTAP
--     and delete/update performance guarantees match the repo contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091380_mapping_import_fk_indexes_full_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP INDEX IF EXISTS public.idx_mapping_operation_reports_workflow_template_id;
CREATE INDEX IF NOT EXISTS idx_mapping_operation_reports_workflow_template_id
  ON public.mapping_operation_reports (workflow_template_id);

DROP INDEX IF EXISTS public.idx_tabular_import_runs_client_id;
CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_client_id
  ON public.tabular_import_runs (client_id);

DROP INDEX IF EXISTS public.idx_tabular_import_runs_created_by;
CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_created_by
  ON public.tabular_import_runs (created_by);

DROP INDEX IF EXISTS public.idx_tabular_import_runs_error_artifact_id;
CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_error_artifact_id
  ON public.tabular_import_runs (error_artifact_id);

DROP INDEX IF EXISTS public.idx_tabular_import_runs_report_id;
CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_report_id
  ON public.tabular_import_runs (report_id);

DROP INDEX IF EXISTS public.idx_tabular_import_runs_sender_id;
CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_sender_id
  ON public.tabular_import_runs (sender_id);

DROP INDEX IF EXISTS public.idx_tabular_import_runs_source_artifact_id;
CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_source_artifact_id
  ON public.tabular_import_runs (source_artifact_id);

DROP INDEX IF EXISTS public.idx_tabular_import_runs_task_id;
CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_task_id
  ON public.tabular_import_runs (task_id);

DROP INDEX IF EXISTS public.idx_tabular_import_runs_updated_by;
CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_updated_by
  ON public.tabular_import_runs (updated_by);

SELECT pg_advisory_unlock(hashtext('202603091380_mapping_import_fk_indexes_full_v1'));
COMMIT;
