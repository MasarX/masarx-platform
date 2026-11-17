-- Migration: tighten ui_settings_preview_v1 execution grants
BEGIN;
SELECT pg_advisory_lock(hashtext('202601061140_ui_settings_preview_privileges'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.ui_settings_preview_v1(TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_settings_preview_v1(TEXT, TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_settings_preview_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601061140_ui_settings_preview_privileges'));
COMMIT;
