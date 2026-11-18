-- JSON RPC cannot resolve TEXT/UUID overloads with the same argument name.
-- Retain the established validating TEXT facade and public SQL compatibility.
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20260909180000_driver_status_api_overload_repair_v1'));
DROP FUNCTION IF EXISTS api.marketplace_application_status_by_token_v1(UUID);
REVOKE ALL ON FUNCTION api.marketplace_application_status_by_token_v1(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.marketplace_application_status_by_token_v1(TEXT)
  TO service_role;
COMMENT ON FUNCTION api.marketplace_application_status_by_token_v1(TEXT) IS
  'Single PostgREST status-token facade; validates TEXT through canonical public implementation; browser access remains Edge-only.';
NOTIFY pgrst, 'reload schema';
COMMIT;
