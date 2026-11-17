-- Migration: ui_reorder_resource_v1 revoke anon execute
BEGIN;
SELECT pg_advisory_lock(hashtext('202601201030_ui_reorder_resource_v1_revoke_anon'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.ui_reorder_resource_v1(TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ui_reorder_resource_v1(TEXT, TEXT[]) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601201030_ui_reorder_resource_v1_revoke_anon'));
COMMIT;

