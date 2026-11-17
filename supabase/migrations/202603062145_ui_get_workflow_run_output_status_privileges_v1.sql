-- Migration: fail-closed privileges for ui_get_workflow_run_output_status_v1
-- Purpose:
--   - Preserve the authenticated-only UI read contract after the async-reconcile function replacement.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603062145_ui_get_workflow_run_output_status_privileges_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.ui_get_workflow_run_output_status_v1(UUID, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_get_workflow_run_output_status_v1(UUID, TEXT[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_get_workflow_run_output_status_v1(UUID, TEXT[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_get_workflow_run_output_status_v1(UUID, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_get_workflow_run_output_status_v1(UUID, TEXT[]) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_get_workflow_run_output_status_v1(UUID, TEXT[]) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603062145_ui_get_workflow_run_output_status_privileges_v1'));
COMMIT;
