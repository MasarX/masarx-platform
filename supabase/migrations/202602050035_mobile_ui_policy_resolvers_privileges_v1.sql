-- Plan: PLAN-202602-mobile-field-ops-native-app-v1 / Step: S04
-- Migration: Mobile UI policy resolvers privileges v1
-- Date: 2026-02-05
--
-- Goal:
--   - Ensure anon cannot execute the policy resolvers.
--   - Fix preview-db drift when earlier iterations were applied with PUBLIC execute.
--
BEGIN;
SELECT pg_advisory_lock(hashtext('202602050035_mobile_ui_policy_resolvers_privileges_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.resolve_mobile_visibility_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_visibility_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_visibility_policy(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.resolve_mobile_diagnostics_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_diagnostics_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_diagnostics_policy(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602050035_mobile_ui_policy_resolvers_privileges_v1'));
COMMIT;

