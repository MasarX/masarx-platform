-- Migration: Revoke anon access to UI command executor
BEGIN;
SELECT pg_advisory_lock(hashtext('202601152140_ui_command_execute_privileges'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE EXECUTE ON FUNCTION public.ui_execute_command_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION public.ui_delete_resource_v1(TEXT, TEXT) FROM anon;

SELECT pg_advisory_unlock(hashtext('202601152140_ui_command_execute_privileges'));
COMMIT;
