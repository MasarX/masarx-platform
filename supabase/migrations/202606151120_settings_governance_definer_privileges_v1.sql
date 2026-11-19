-- Migration: Settings governance definer privilege lockdown
-- Purpose:
--   Keep internal settings governance trigger/helper functions off public RPC
--   surfaces while preserving service-role maintenance access.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202606151120_settings_governance_definer_privileges_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.settings_version_resolved_organization_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settings_version_resolved_organization_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.settings_version_resolved_organization_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settings_version_resolved_organization_v1(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.settings_approval_review_task_defaults_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settings_approval_review_task_defaults_v1() FROM anon;
REVOKE ALL ON FUNCTION public.settings_approval_review_task_defaults_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settings_approval_review_task_defaults_v1() TO service_role;

REVOKE ALL ON FUNCTION public.settings_approval_review_queue_task_sync_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settings_approval_review_queue_task_sync_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.settings_approval_review_queue_task_sync_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settings_approval_review_queue_task_sync_v1(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.settings_approval_operator_task_resolve_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settings_approval_operator_task_resolve_v1() FROM anon;
REVOKE ALL ON FUNCTION public.settings_approval_operator_task_resolve_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settings_approval_operator_task_resolve_v1() TO service_role;

REVOKE ALL ON FUNCTION public.settings_change_requested_inline_approval_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settings_change_requested_inline_approval_v1() FROM anon;
REVOKE ALL ON FUNCTION public.settings_change_requested_inline_approval_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settings_change_requested_inline_approval_v1() TO service_role;

COMMIT;
