-- Plan: PLAN-202603-marketplace-network-dev-convergence-closeout / Step: S03
-- Migration: Drop duplicate FK-support indexes introduced during dev convergence

BEGIN;
SELECT pg_advisory_lock(hashtext('202603111133_index_redundancy_dev_convergence_cleanup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP INDEX IF EXISTS public.idx_fk_mapping_operation_re_workflow_template_id_4ca1cb65;

DROP INDEX IF EXISTS public.idx_fk_tabular_import_runs_client_id_83f68645;
DROP INDEX IF EXISTS public.idx_fk_tabular_import_runs_created_by_844366cc;
DROP INDEX IF EXISTS public.idx_fk_tabular_import_runs_error_artifact_id_88d28e9b;
DROP INDEX IF EXISTS public.idx_fk_tabular_import_runs_report_id_403a8bbf;
DROP INDEX IF EXISTS public.idx_fk_tabular_import_runs_sender_id_1332f593;
DROP INDEX IF EXISTS public.idx_fk_tabular_import_runs_source_artifact_id_e74b92de;
DROP INDEX IF EXISTS public.idx_fk_tabular_import_runs_task_id_e71cf4f0;
DROP INDEX IF EXISTS public.idx_fk_tabular_import_runs_updated_by_312f9ba9;

SELECT pg_advisory_unlock(hashtext('202603111133_index_redundancy_dev_convergence_cleanup_v1'));
COMMIT;
