BEGIN;
SET LOCAL lock_timeout = '10s';

-- Supabase's explicit browser-role defaults survive a PUBLIC-only revoke.
REVOKE EXECUTE ON FUNCTION
  public.get_provider_auth_credentials(UUID),
  public.get_provider_auth_credential(UUID, TEXT),
  public.resolve_edge_api_caller_jwt_v1(),
  public.resolve_ingress_execution_url_v1(UUID),
  public.resolve_label_renderer_invoke_request_v1(INTEGER, JSONB),
  public.resolve_label_renderer_invoke_config_v1(UUID),
  public.resolve_settings_merged(TEXT, TEXT, UUID),
  api.resolve_settings_merged(TEXT, TEXT, UUID),
  public.get_job_call_spec(UUID),
  api.get_job_call_spec(UUID),
  public.get_job_call_spec_without_ingress_vault_v1(UUID),
  public.integration_studio_test_material_v1(UUID, UUID, TEXT),
  api.integration_studio_test_material_v1(UUID, UUID, TEXT),
  public.integration_connection_oauth_consume_v1(TEXT, UUID, TEXT, UUID, TEXT),
  api.integration_connection_oauth_consume_v1(TEXT, UUID, TEXT, UUID, TEXT)
FROM PUBLIC, anon, authenticated;

-- Preserve runtime access; the renamed implementation stays owner-only.
GRANT EXECUTE ON FUNCTION
  public.get_provider_auth_credentials(UUID),
  public.get_provider_auth_credential(UUID, TEXT),
  public.resolve_edge_api_caller_jwt_v1(),
  public.resolve_ingress_execution_url_v1(UUID),
  public.resolve_label_renderer_invoke_request_v1(INTEGER, JSONB),
  public.resolve_label_renderer_invoke_config_v1(UUID),
  public.resolve_settings_merged(TEXT, TEXT, UUID),
  api.resolve_settings_merged(TEXT, TEXT, UUID),
  public.get_job_call_spec(UUID),
  api.get_job_call_spec(UUID),
  public.integration_studio_test_material_v1(UUID, UUID, TEXT),
  api.integration_studio_test_material_v1(UUID, UUID, TEXT),
  public.integration_connection_oauth_consume_v1(TEXT, UUID, TEXT, UUID, TEXT),
  api.integration_connection_oauth_consume_v1(TEXT, UUID, TEXT, UUID, TEXT)
TO service_role;

DO $roles$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'edge_api_caller_role', 'edge_api_gateway_role',
    'edge_webhook_role', 'edge_label_renderer_role'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.get_provider_auth_credentials(UUID), public.get_provider_auth_credential(UUID, TEXT) TO %I', runtime_role);
    END IF;
  END LOOP;
END;
$roles$;

GRANT EXECUTE ON FUNCTION public.get_job_call_spec(UUID), api.get_job_call_spec(UUID)
TO edge_api_caller_role;
GRANT EXECUTE ON FUNCTION public.resolve_label_renderer_invoke_request_v1(INTEGER, JSONB),
  public.resolve_label_renderer_invoke_config_v1(UUID)
TO edge_label_renderer_role;
GRANT EXECUTE ON FUNCTION public.resolve_settings_merged(TEXT, TEXT, UUID),
  api.resolve_settings_merged(TEXT, TEXT, UUID)
TO label_renderer_role, edge_label_renderer_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
