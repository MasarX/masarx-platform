BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER FUNCTION api.ui_unbind_provider_account_credential_v1(jsonb)
  SET search_path TO public, extensions, pg_temp;
ALTER FUNCTION public.apply_api_gateway_outbound_timeout_context_v1()
  SET search_path TO public, extensions, pg_temp;
ALTER FUNCTION public.integration_plugin_rotate_credentials_v1(uuid, text, jsonb, timestamptz, text)
  SET search_path TO public, extensions, pg_temp;
ALTER FUNCTION public.resolve_organization_id_strict(text, uuid)
  SET search_path TO public, extensions, pg_temp;
ALTER FUNCTION public.submit_fieldops_proof_v1(uuid, text, jsonb, uuid)
  SET search_path TO public, extensions, pg_temp;
ALTER FUNCTION public.tenant_signup_find_auth_user_id_by_email_v1(text)
  SET search_path TO public, extensions, pg_temp;
ALTER FUNCTION public.ui_bind_provider_account_credential_v1(jsonb)
  SET search_path TO public, extensions, pg_temp;
ALTER FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb)
  SET search_path TO public, extensions, pg_temp;

ALTER FUNCTION workflow_handlers.execute_geocode_cache_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMIT;
