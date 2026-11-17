-- Generic artifact import remains service-only; guarded mobile/KYC APIs are unchanged.
BEGIN;
SET LOCAL lock_timeout = '10s';
REVOKE ALL ON FUNCTION public.register_artifact_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.register_artifact_v1(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_artifact_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION api.register_artifact_v1(JSONB) TO service_role;
COMMIT;
