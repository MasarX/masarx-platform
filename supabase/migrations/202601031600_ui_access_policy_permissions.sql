-- Migration: Fix ui_access_policy_v1 grants
BEGIN;
SELECT pg_advisory_lock(hashtext('202601031600_ui_access_policy_permissions'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.ui_access_policy_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_access_policy_v1(TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_access_policy_v1(TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601031600_ui_access_policy_permissions'));
COMMIT;
