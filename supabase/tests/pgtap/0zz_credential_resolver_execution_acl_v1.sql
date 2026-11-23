BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT no_plan();

CREATE TEMP TABLE credential_acl_cases (
  signature TEXT PRIMARY KEY,
  call_sql TEXT NOT NULL,
  runtime_roles TEXT[] NOT NULL
);
INSERT INTO credential_acl_cases VALUES
  ('public.get_provider_auth_credentials(uuid)', 'SELECT public.get_provider_auth_credentials(NULL::uuid)',
    ARRAY['service_role','edge_api_caller_role','edge_api_gateway_role','edge_webhook_role','edge_label_renderer_role']),
  ('public.get_provider_auth_credential(uuid,text)', 'SELECT public.get_provider_auth_credential(NULL::uuid,''api_key'')',
    ARRAY['service_role','edge_api_caller_role','edge_api_gateway_role','edge_webhook_role','edge_label_renderer_role']),
  ('public.resolve_edge_api_caller_jwt_v1()', 'SELECT public.resolve_edge_api_caller_jwt_v1()', ARRAY['service_role']),
  ('public.resolve_ingress_execution_url_v1(uuid)', 'SELECT public.resolve_ingress_execution_url_v1(NULL::uuid)', ARRAY['service_role']),
  ('public.resolve_label_renderer_invoke_request_v1(integer,jsonb)',
    'SELECT public.resolve_label_renderer_invoke_request_v1(1,NULL::jsonb)', ARRAY['service_role','edge_label_renderer_role']),
  ('public.resolve_label_renderer_invoke_config_v1(uuid)',
    'SELECT public.resolve_label_renderer_invoke_config_v1(NULL::uuid)', ARRAY['service_role','edge_label_renderer_role']),
  ('public.resolve_settings(text,text,uuid)',
    'SELECT public.resolve_settings(NULL::text,NULL::text,NULL::uuid)',
    ARRAY['service_role','edge_api_caller_role','edge_api_gateway_role','edge_webhook_role','edge_label_renderer_role','label_renderer_role','geocoding_worker_role','ui_rpc_executor']),
  ('public.resolve_settings_row(text,text,uuid)',
    'SELECT public.resolve_settings_row(NULL::text,NULL::text,NULL::uuid)',
    ARRAY['service_role','edge_api_caller_role','edge_api_gateway_role','edge_webhook_role','edge_label_renderer_role','label_renderer_role','geocoding_worker_role','ui_rpc_executor']),
  ('public.resolve_settings_merged(text,text,uuid)',
    'SELECT public.resolve_settings_merged(NULL::text,NULL::text,NULL::uuid)', ARRAY['service_role','label_renderer_role','edge_label_renderer_role']),
  ('api.resolve_settings_merged(text,text,uuid)',
    'SELECT api.resolve_settings_merged(NULL::text,NULL::text,NULL::uuid)', ARRAY['service_role','label_renderer_role','edge_label_renderer_role']),
  ('public.get_job_call_spec(uuid)', 'SELECT public.get_job_call_spec(NULL::uuid)', ARRAY[]::text[]),
  ('api.get_job_call_spec(uuid)', 'SELECT api.get_job_call_spec(NULL::uuid)', ARRAY[]::text[]),
  ('public.get_claimed_edge_job_call_spec_v1(uuid,uuid)', 'SELECT public.get_claimed_edge_job_call_spec_v1(NULL::uuid,NULL::uuid)',
    ARRAY['service_role','edge_api_caller_role']),
  ('api.get_claimed_edge_job_call_spec_v1(uuid,uuid)', 'SELECT api.get_claimed_edge_job_call_spec_v1(NULL::uuid,NULL::uuid)',
    ARRAY['service_role','edge_api_caller_role']),
  ('public.get_job_call_spec_without_ingress_vault_v1(uuid)',
    'SELECT public.get_job_call_spec_without_ingress_vault_v1(NULL::uuid)', ARRAY[]::text[]),
  ('public.integration_studio_test_material_v1(uuid,uuid,text)',
    'SELECT public.integration_studio_test_material_v1(NULL::uuid,NULL::uuid,''{}'')', ARRAY['service_role']),
  ('api.integration_studio_test_material_v1(uuid,uuid,text)',
    'SELECT api.integration_studio_test_material_v1(NULL::uuid,NULL::uuid,''{}'')', ARRAY['service_role']),
  ('public.integration_connection_oauth_consume_v1(text,uuid,text,uuid,text)',
    'SELECT public.integration_connection_oauth_consume_v1(NULL::text,NULL::uuid,NULL::text,NULL::uuid,NULL::text)', ARRAY['service_role']),
  ('api.integration_connection_oauth_consume_v1(text,uuid,text,uuid,text)',
    'SELECT api.integration_connection_oauth_consume_v1(NULL::text,NULL::uuid,NULL::text,NULL::uuid,NULL::text)', ARRAY['service_role']);

SELECT diag(signature || ' effective roles: ' || COALESCE((
  SELECT string_agg(rolname, ', ' ORDER BY rolname) FROM pg_roles
  WHERE has_function_privilege(oid, signature, 'EXECUTE')
), '(none)')) FROM credential_acl_cases ORDER BY signature;

SELECT ok(NOT has_function_privilege(role, signature, 'EXECUTE'), role || ' cannot execute ' || signature)
FROM credential_acl_cases CROSS JOIN unnest(ARRAY['public','anon','authenticated']) role
ORDER BY signature, role;

CREATE FUNCTION pg_temp.check_credential_role_calls() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $calls$
DECLARE
  entry RECORD;
  browser_role TEXT;
  refused BOOLEAN;
BEGIN
  FOR entry IN SELECT * FROM credential_acl_cases ORDER BY signature LOOP
    FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      refused := FALSE;
      EXECUTE format('SET LOCAL ROLE %I', browser_role);
      BEGIN
        EXECUTE entry.call_sql;
      EXCEPTION WHEN insufficient_privilege THEN
        refused := TRUE;
      END;
      RESET ROLE;
      RETURN NEXT ok(refused, browser_role || ' call is refused with 42501: ' || entry.signature);
    END LOOP;
  END LOOP;
END;
$calls$;
SELECT * FROM pg_temp.check_credential_role_calls();

SELECT ok(has_function_privilege(runtime_role, signature, 'EXECUTE'), runtime_role || ' retains ' || signature)
FROM credential_acl_cases CROSS JOIN LATERAL unnest(runtime_roles) runtime_role
JOIN pg_roles ON rolname = runtime_role
ORDER BY signature, runtime_role;

SELECT ok(NOT has_function_privilege('service_role',
  'public.get_job_call_spec_without_ingress_vault_v1(uuid)', 'EXECUTE'),
  'the wrapped implementation remains owner-only');

SELECT ok(NOT has_function_privilege(r.oid, c.signature, 'EXECUTE'),
  r.rolname || ' cannot execute the unfenced spec path ' || c.signature)
FROM credential_acl_cases c CROSS JOIN pg_roles r
WHERE c.signature IN ('public.get_job_call_spec(uuid)', 'api.get_job_call_spec(uuid)',
                      'public.get_job_call_spec_without_ingress_vault_v1(uuid)')
  AND (r.rolname LIKE 'edge\_%\_role' OR r.rolname IN (
    'authenticator','service_role','ui_rpc_executor','label_renderer_role','geocoding_worker_role'
  ))
ORDER BY c.signature, r.rolname;

-- Exercise the two raw resolvers under each existing runtime role without secret fixtures.
CREATE FUNCTION pg_temp.check_credential_runtime_calls() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $calls$
DECLARE
  entry RECORD;
  result TEXT;
BEGIN
  FOR entry IN
    SELECT call_sql, signature, runtime_role FROM credential_acl_cases
    CROSS JOIN LATERAL unnest(runtime_roles) runtime_role JOIN pg_roles ON rolname = runtime_role
    WHERE signature IN ('public.get_provider_auth_credentials(uuid)', 'public.get_provider_auth_credential(uuid,text)')
    ORDER BY signature, runtime_role
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', entry.runtime_role);
    EXECUTE entry.call_sql INTO result;
    RESET ROLE;
    RETURN NEXT is(result, NULL::text, entry.runtime_role || ' can call ' || entry.signature);
  END LOOP;
END;
$calls$;
SELECT * FROM pg_temp.check_credential_runtime_calls();

SELECT * FROM finish();
ROLLBACK;
