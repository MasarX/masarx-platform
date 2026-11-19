BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '8e02a0e0-0000-4000-8000-000000000021',
  'Plugin Studio OpenAPI Test Org',
  'plugin-studio-openapi-test-org'
)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.integration_plugin_generate_draft_v1(
    p_plugin_name := 'pgtap-openapi-authoring-readback',
    p_plugin_kind := 'api',
    p_source_type := 'openapi',
    p_source_payload := jsonb_build_object(
      'openapi', '3.0.0',
      'info', jsonb_build_object('title', 'PGTAP OpenAPI source', 'version', '1.0.0'),
      'servers', jsonb_build_array(jsonb_build_object('url', 'https://vomhkplympywspxymnstltsw.example.invalid')),
      'paths', jsonb_build_object(
        '/v1/openapi-proof-orders',
        jsonb_build_object('post', jsonb_build_object('summary', 'Create shipment order'))
      )
    ),
    p_inbound_config := jsonb_build_object(
      'route',
      jsonb_build_object(
        'method', 'POST',
        'path_template', '/v1/openapi-proof-orders',
        'upstream_method', 'POST',
        'upstream_path_template', '/v1/openapi-proof-orders',
        'upstream_base_url', 'https://vomhkplympywspxymnstltsw.example.invalid'
      )
    ),
    p_mapping_config := jsonb_build_object('version', 1, 'mode', 'deterministic', 'fields', jsonb_build_array()),
    p_outbound_operations := jsonb_build_array(
      jsonb_build_object(
        'operation_name', 'forward_event',
        'method', 'POST',
        'url_template', 'https://vomhkplympywspxymnstltsw.example.invalid/v1/openapi-proof-orders'
      )
    ),
    p_organization_id := '8e02a0e0-0000-4000-8000-000000000021',
    p_metadata := jsonb_build_object(
      'managed_by', 'integration_plugin_studio_edge',
      'normalized_contract', jsonb_build_object(
        'source_type', 'openapi',
        'plugin_kind', 'api',
        'route', jsonb_build_object(
          'method', 'POST',
          'path_template', '/v1/openapi-proof-orders',
          'upstream_method', 'POST',
          'upstream_path_template', '/v1/openapi-proof-orders'
        ),
        'metadata', jsonb_build_object(
          'server_url', 'https://vomhkplympywspxymnstltsw.example.invalid',
          'document_kind', '3.0.0'
        )
      )
    )
  );

  PERFORM set_config('test.openapi_plugin_id', v_result->>'plugin_id', true);
  PERFORM set_config('test.openapi_version_id', v_result->>'plugin_version_id', true);
END $$;

SELECT is(
  (
    SELECT source_payload->>'openapi'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.openapi_version_id')::uuid
  ),
  '3.0.0',
  'Plugin Studio OpenAPI draft preserves raw source payload'
);

SELECT is(
  (
    SELECT normalized_contract->>'source_type'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.openapi_version_id')::uuid
  ),
  'openapi',
  'Plugin Studio OpenAPI draft persists parsed normalized contract source type'
);

SELECT is(
  (
    SELECT normalized_contract #>> '{route,path_template}'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.openapi_version_id')::uuid
  ),
  '/v1/openapi-proof-orders',
  'Plugin Studio OpenAPI draft persists parsed route path'
);

SELECT is(
  (
    SELECT normalized_contract #>> '{metadata,server_url}'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.openapi_version_id')::uuid
  ),
  'https://vomhkplympywspxymnstltsw.example.invalid',
  'Plugin Studio OpenAPI draft persists provider server URL'
);

SELECT ok(
  NOT (
    SELECT metadata ? 'normalized_contract'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.openapi_version_id')::uuid
  ),
  'Plugin Studio OpenAPI draft does not leak normalized contract transport into version metadata'
);

SELECT finish();

ROLLBACK;
