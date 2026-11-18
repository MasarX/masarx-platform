BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(19);

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '8e02a0e0-0000-4000-8000-000000000052',
  'Plugin Studio Secret Redaction Test Org',
  'plugin-studio-secret-redaction-test-org'
)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_result jsonb;
  v_report_id uuid;
  v_correlation_id uuid := '8e02a0e0-0000-4000-8000-000000000153';
BEGIN
  v_result := public.integration_plugin_generate_draft_v1(
    p_plugin_name := 'pgtap-plugin-studio-secret-redaction',
    p_plugin_kind := 'api',
    p_source_type := 'curl',
    p_source_payload := jsonb_build_object(
      'curl',
      'curl -X POST "https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders?api_key=query-secret&safe=1" -H "Authorization: Bearer raw-bearer-secret" -H "x-api-key: raw-api-key-secret" -d ''{"order_id":"1","password":"raw-password","nested":{"clientSecret":"raw-client-secret"}}'''
    ),
    p_inbound_config := jsonb_build_object(
      'route',
      jsonb_build_object(
        'method', 'POST',
        'path_template', '/v1/orders',
        'upstream_method', 'POST',
        'upstream_path_template', '/v1/orders',
        'headers', jsonb_build_object('Authorization', 'Bearer raw-inbound-secret')
      )
    ),
    p_mapping_config := jsonb_build_object(
      'version', 1,
      'metadata', jsonb_build_object(
        'clientSecret', 'raw-mapping-secret',
        'note', 'token=raw-mapping-token'
      ),
      'fields', jsonb_build_array()
    ),
    p_outbound_operations := jsonb_build_array(
      jsonb_build_object(
        'operation_name', 'forward_event',
        'method', 'POST',
        'url_template', 'https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders?token=raw-outbound-token',
        'headers_template', jsonb_build_object('x-api-key', 'raw-outbound-api-key')
      )
    ),
    p_organization_id := '8e02a0e0-0000-4000-8000-000000000052',
    p_metadata := jsonb_build_object(
      'managed_by', 'integration_plugin_studio_edge',
      'correlation_id', v_correlation_id,
      'vendor_secret', 'raw-plugin-metadata-secret',
      'normalized_contract', jsonb_build_object(
        'source_type', 'curl',
        'plugin_kind', 'api',
        'route', jsonb_build_object(
          'method', 'POST',
          'path_template', '/v1/orders',
          'upstream_method', 'POST',
          'upstream_path_template', '/v1/orders',
          'headers', jsonb_build_object('Authorization', 'Bearer raw-contract-secret')
        ),
        'metadata', jsonb_build_object(
          'source_url', 'https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid',
          'query_string', 'api_key=raw-contract-query-secret'
        )
      )
    )
  );

  PERFORM set_config('test.plugin_studio_secret_plugin_id', v_result->>'plugin_id', true);
  PERFORM set_config(
    'test.plugin_studio_secret_version_id',
    COALESCE(v_result->>'plugin_version_id', v_result->>'version_id'),
    true
  );
  PERFORM set_config('test.plugin_studio_secret_correlation_id', v_correlation_id::text, true);

  INSERT INTO public.mapping_operation_reports (
    organization_id,
    artifact_type,
    operation_kind,
    save_mode,
    status,
    primary_resource_type,
    primary_resource_id,
    correlation_id,
    request_summary,
    conversion_summary,
    diagnostics_summary,
    result_payload,
    decision_refs,
    next_steps
  )
  VALUES (
    '8e02a0e0-0000-4000-8000-000000000052',
    'integration_plugin',
    'mapping_save',
    'draft',
    'succeeded',
    'integration_plugin_version',
    COALESCE(v_result->>'plugin_version_id', v_result->>'version_id')::uuid,
    v_correlation_id::text,
    jsonb_build_object('authorization', 'Bearer raw-report-request-secret'),
    jsonb_build_object('message', 'api_key=raw-report-conversion-secret'),
    jsonb_build_object('diagnostics', jsonb_build_array(jsonb_build_object('message', 'token=raw-diagnostic-secret'))),
    jsonb_build_object('provider_response', jsonb_build_object('refresh_token', 'raw-report-token')),
    jsonb_build_object('trace', 'secret=raw-decision-secret'),
    jsonb_build_array('Rotate token=raw-next-step-secret')
  )
  RETURNING id INTO v_report_id;

  PERFORM set_config('test.plugin_studio_secret_report_id', v_report_id::text, true);
END $$;

SELECT is(
  public.redact_sensitive_text_v1('Authorization: Bearer raw-text-secret'),
  'Authorization: REDACTED',
  'redact_sensitive_text_v1 redacts scalar authorization values'
);

SELECT is(
  public.redact_sensitive_json(to_jsonb('https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders?api_key=query-secret&safe=1'::text)) #>> '{}',
  'https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders?api_key=REDACTED&safe=1',
  'redact_sensitive_json redacts secret query parameters inside scalar text'
);

SELECT ok(
  NOT (
    SELECT source_payload::text LIKE '%raw-bearer-secret%'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.plugin_studio_secret_version_id')::uuid
  ),
  'Plugin Studio version source_payload does not retain bearer secret'
);

SELECT ok(
  NOT (
    SELECT source_payload::text LIKE '%raw-api-key-secret%'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.plugin_studio_secret_version_id')::uuid
  ),
  'Plugin Studio version source_payload does not retain api key secret'
);

SELECT ok(
  NOT (
    SELECT source_payload::text LIKE '%raw-password%'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.plugin_studio_secret_version_id')::uuid
  ),
  'Plugin Studio version source_payload does not retain JSON password value'
);

SELECT ok(
  (
    SELECT source_payload->>'curl'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.plugin_studio_secret_version_id')::uuid
  ) LIKE '%api_key=REDACTED%',
  'Plugin Studio source curl readback keeps query shape but redacts query credential'
);

SELECT is(
  (
    SELECT normalized_contract #>> '{route,headers,Authorization}'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.plugin_studio_secret_version_id')::uuid
  ),
  'REDACTED',
  'Plugin Studio normalized contract redacts authorization header value'
);

SELECT is(
  (
    SELECT mapping_config #>> '{metadata,clientSecret}'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.plugin_studio_secret_version_id')::uuid
  ),
  'REDACTED',
  'Plugin Studio mapping_config redacts nested secret keys'
);

SELECT is(
  (
    SELECT outbound_operations #>> '{0,headers_template,x-api-key}'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.plugin_studio_secret_version_id')::uuid
  ),
  'REDACTED',
  'Plugin Studio outbound operation header templates redact API keys'
);

SELECT ok(
  NOT (
    SELECT outbound_operations::text LIKE '%raw-outbound-token%'
    FROM public.integration_plugin_versions
    WHERE id = current_setting('test.plugin_studio_secret_version_id')::uuid
  ),
  'Plugin Studio outbound operation URLs do not retain query tokens'
);

SELECT ok(
  NOT (
    SELECT p.metadata::text LIKE '%raw-plugin-metadata-secret%'
    FROM public.integration_plugins p
    WHERE p.id = current_setting('test.plugin_studio_secret_plugin_id')::uuid
  ),
  'Integration plugin metadata trigger redacts metadata secrets'
);

SELECT is(
  (
    SELECT result_payload #>> '{provider_response,refresh_token}'
    FROM public.mapping_operation_reports
    WHERE id = current_setting('test.plugin_studio_secret_report_id')::uuid
  ),
  'REDACTED',
  'Plugin Studio operation report result payload redacts token keys'
);

SELECT ok(
  NOT (
    SELECT diagnostics_summary::text LIKE '%raw-diagnostic-secret%'
    FROM public.mapping_operation_reports
    WHERE id = current_setting('test.plugin_studio_secret_report_id')::uuid
  ),
  'Plugin Studio operation report diagnostics redact scalar token text'
);

SELECT ok(
  NOT (
    SELECT next_steps::text LIKE '%raw-next-step-secret%'
    FROM public.mapping_operation_reports
    WHERE id = current_setting('test.plugin_studio_secret_report_id')::uuid
  ),
  'Plugin Studio operation report next steps redact scalar token text'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.decision_log
    WHERE resource_type = 'integration_plugin_version'
      AND resource_id = current_setting('test.plugin_studio_secret_version_id')::uuid
      AND decision_point = 'plugin_studio.draft_saved'
      AND decision_outcome = 'draft_saved'
      AND correlation_id = current_setting('test.plugin_studio_secret_correlation_id')::uuid
  ),
  1,
  'Plugin Studio draft save writes canonical decision_log lineage with the request correlation id'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.domain_events
    WHERE resource_type = 'integration_plugin_version'
      AND resource_id = current_setting('test.plugin_studio_secret_version_id')::uuid
      AND event_type = 'integration_plugin_version_draft_saved'
      AND correlation_id = current_setting('test.plugin_studio_secret_correlation_id')::uuid
  ),
  1,
  'Plugin Studio draft save writes domain event lineage with the request correlation id'
);

SELECT ok(
  NOT (
    SELECT decision_inputs::text LIKE '%raw-contract-secret%'
    FROM public.decision_log
    WHERE resource_type = 'integration_plugin_version'
      AND resource_id = current_setting('test.plugin_studio_secret_version_id')::uuid
      AND decision_point = 'plugin_studio.draft_saved'
  ),
  'Plugin Studio decision_log lineage does not leak redacted contract secrets'
);

SELECT ok(
  NOT (
    SELECT payload::text LIKE '%raw-contract-secret%'
    FROM public.domain_events
    WHERE resource_type = 'integration_plugin_version'
      AND resource_id = current_setting('test.plugin_studio_secret_version_id')::uuid
      AND event_type = 'integration_plugin_version_draft_saved'
  ),
  'Plugin Studio domain event lineage does not leak redacted contract secrets'
);

SELECT is(
  (
    SELECT payload->>'mapping_operation_report_id'
    FROM public.domain_events
    WHERE resource_type = 'integration_plugin_version'
      AND resource_id = current_setting('test.plugin_studio_secret_version_id')::uuid
      AND event_type = 'integration_plugin_version_draft_saved'
    LIMIT 1
  ),
  current_setting('test.plugin_studio_secret_report_id'),
  'Plugin Studio domain event lineage is linked back to the operation report readback'
);

SELECT finish();

ROLLBACK;
