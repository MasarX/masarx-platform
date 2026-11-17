-- Plan: PLAN-202602-mobile-field-ops-native-app-v1 / Step: S04
-- Migration: Mobile UI policy resolvers security definer v1
-- Date: 2026-02-05
--
-- Goal:
--   - Ensure mobile policy resolvers are SECURITY DEFINER (required for RLS-safe resolution).
--   - Fix preview-db drift when earlier iterations applied without SECURITY DEFINER.
--
BEGIN;
SELECT pg_advisory_lock(hashtext('202602050015_mobile_ui_policy_resolvers_security_definer_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER FUNCTION public.resolve_mobile_visibility_policy(JSONB) SECURITY DEFINER;
ALTER FUNCTION public.resolve_mobile_visibility_policy(JSONB) SET search_path TO public, extensions, pg_temp;

ALTER FUNCTION public.resolve_mobile_diagnostics_policy(JSONB) SECURITY DEFINER;
ALTER FUNCTION public.resolve_mobile_diagnostics_policy(JSONB) SET search_path TO public, extensions, pg_temp;

SELECT pg_advisory_unlock(hashtext('202602050015_mobile_ui_policy_resolvers_security_definer_v1'));
COMMIT;

