-- Restore Mobile/scan policy wrappers to SECURITY DEFINER.
--
-- The underlying public.resolve_settings_row_from_policy_context_v1 resolver is
-- intentionally service-role locked. These category wrappers are the sanctioned
-- authenticated call surface for FieldOps scan, location, ingest, and POD policy
-- resolution, so they must execute through a pinned definer boundary instead of
-- requiring direct caller access to the locked canonical resolver.

BEGIN;

SET search_path TO public, extensions, pg_temp;

SELECT pg_advisory_lock(hashtext('202606042134_mobile_policy_public_wrappers_definer_v1'));

ALTER FUNCTION public.resolve_mobile_ingest_policy(JSONB)
  SECURITY DEFINER
  SET search_path TO public, extensions, pg_temp;

ALTER FUNCTION public.resolve_location_tracking_policy(JSONB)
  SECURITY DEFINER
  SET search_path TO public, extensions, pg_temp;

ALTER FUNCTION public.resolve_scan_policy(JSONB)
  SECURITY DEFINER
  SET search_path TO public, extensions, pg_temp;

ALTER FUNCTION public.resolve_pod_policy(JSONB)
  SECURITY DEFINER
  SET search_path TO public, extensions, pg_temp;

REVOKE ALL ON FUNCTION public.resolve_mobile_ingest_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_ingest_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_ingest_policy(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.resolve_location_tracking_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_location_tracking_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_location_tracking_policy(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.resolve_scan_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_scan_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_scan_policy(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.resolve_pod_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_pod_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_pod_policy(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_mobile_ingest_policy(JSONB)
  IS 'SECURITY DEFINER wrapper for mobile_ingest_policy over the service-role-locked canonical policy context resolver.';

COMMENT ON FUNCTION public.resolve_location_tracking_policy(JSONB)
  IS 'SECURITY DEFINER wrapper for location_tracking_policy over the service-role-locked canonical policy context resolver.';

COMMENT ON FUNCTION public.resolve_scan_policy(JSONB)
  IS 'SECURITY DEFINER wrapper for scan_policy over the service-role-locked canonical policy context resolver.';

COMMENT ON FUNCTION public.resolve_pod_policy(JSONB)
  IS 'SECURITY DEFINER wrapper for pod_policy over the service-role-locked canonical policy context resolver.';

SELECT pg_advisory_unlock(hashtext('202606042134_mobile_policy_public_wrappers_definer_v1'));

COMMIT;
