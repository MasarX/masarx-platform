-- Plan: PLAN-202602-fieldops-mobile-store-ga-v2 / Step: S04
-- Migration: enforce least-privilege grants on resolve_location_tracking_policy
-- Date: 2026-02-05
--
-- Goal:
--   - Ensure location policy resolver is not executable by anon/public.
--   - Keep resolver callable by authenticated and service_role only.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602052235_resolve_location_tracking_policy_grants'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.resolve_location_tracking_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_location_tracking_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_location_tracking_policy(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602052235_resolve_location_tracking_policy_grants'));
COMMIT;
