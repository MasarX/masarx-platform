-- Plan: PLAN-202607-fieldops-mobile-web-proof-fix-v1 / Step: S01
-- Migration: keep mobile sync policy authenticated-only while allowing the wrapper
-- to resolve row-driven settings through the canonical policy-context resolver.

BEGIN;
SELECT pg_advisory_lock(hashtext('202607030720_fieldops_mobile_sync_policy_security_definer_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER FUNCTION public.resolve_mobile_sync_policy(JSONB) SECURITY DEFINER;
ALTER FUNCTION public.resolve_mobile_sync_policy(JSONB) SET search_path TO public, extensions, pg_temp;

REVOKE ALL ON FUNCTION public.resolve_mobile_sync_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_sync_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_sync_policy(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202607030720_fieldops_mobile_sync_policy_security_definer_v1'));
COMMIT;
