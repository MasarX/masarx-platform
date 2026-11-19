-- Console V2 integration browser RPC wrappers.
--
-- Browser/server Supabase clients are pinned to db.schema='api'. These wrappers
-- expose existing public jsonb RPC contracts through the api schema so live
-- Console V2 integration actions do not depend on public-schema fallbacks.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605081145_console_v2_integration_api_wrappers_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION api.ui_upsert_provider_auth_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_upsert_provider_auth_config_v1(COALESCE(p_args, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.ui_revoke_provider_auth_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_revoke_provider_auth_config_v1(COALESCE(p_args, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.plugin_submit_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.plugin_submit_v1(COALESCE(p_args, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.plugin_approve_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.plugin_approve_v1(COALESCE(p_args, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.plugin_activate_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.plugin_activate_v1(COALESCE(p_args, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.plugin_set_binding_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.plugin_set_binding_v1(COALESCE(p_args, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION api.ui_upsert_provider_auth_config_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_upsert_provider_auth_config_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_upsert_provider_auth_config_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_revoke_provider_auth_config_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_revoke_provider_auth_config_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_revoke_provider_auth_config_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.plugin_submit_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.plugin_submit_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.plugin_submit_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.plugin_approve_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.plugin_approve_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.plugin_approve_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.plugin_activate_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.plugin_activate_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.plugin_activate_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.plugin_set_binding_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.plugin_set_binding_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.plugin_set_binding_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_upsert_provider_auth_config_v1(jsonb)
  IS 'Console V2 api-schema wrapper for provider_auth_configs create/update.';
COMMENT ON FUNCTION api.ui_revoke_provider_auth_config_v1(jsonb)
  IS 'Console V2 api-schema wrapper for provider_auth_configs revoke.';
COMMENT ON FUNCTION api.plugin_submit_v1(jsonb)
  IS 'Console V2 api-schema wrapper for integration plugin submit lifecycle.';
COMMENT ON FUNCTION api.plugin_approve_v1(jsonb)
  IS 'Console V2 api-schema wrapper for integration plugin approve/reject lifecycle.';
COMMENT ON FUNCTION api.plugin_activate_v1(jsonb)
  IS 'Console V2 api-schema wrapper for integration plugin activation lifecycle.';
COMMENT ON FUNCTION api.plugin_set_binding_v1(jsonb)
  IS 'Console V2 api-schema wrapper for integration plugin runtime binding lifecycle.';

SELECT pg_advisory_unlock(hashtext('202605081145_console_v2_integration_api_wrappers_v1'));

COMMIT;
