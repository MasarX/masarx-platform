-- Keep the canonical settings resolver service-role only; browser callers must
-- use the api schema wrapper.

BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  FROM anon;
REVOKE ALL ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  TO authenticated, service_role;

COMMIT;
