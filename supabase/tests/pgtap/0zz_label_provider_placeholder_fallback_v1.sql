-- pgTAP: label renderer provider resolution ignores tenant bootstrap
-- placeholders only when an activated global provider exists.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

CREATE FUNCTION pg_temp.check_label_provider_placeholder_fallback()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $fixture$
DECLARE
  v_org UUID := 'f95dce10-df04-4bdf-8244-1d999a8e64dd'::uuid;
  v_placeholder JSONB := jsonb_build_object(
    'version', 1,
    'providers', jsonb_build_array(
      jsonb_build_object(
        'mode', 'internal',
        'name', 'internal_renderer',
        'invoke_url', 'https://tenant-renderer.example.test/functions/v1/label-renderer',
        'timeout_ms', 30000,
        'invoke_secret', 'EXAMPLE_PASSWORD'
      )
    )
  );
  v_active JSONB := jsonb_build_object(
    'version', 2,
    'providers', jsonb_build_array(
      jsonb_build_object(
        'mode', 'internal',
        'name', 'internal_renderer',
        'invoke_url', 'https://global-renderer.example.test/functions/v1/label-renderer',
        'timeout_ms', 20000,
        'invoke_secret', 'synthetic-global-renderer-credential'
      )
    )
  );
  v_malformed JSONB := jsonb_build_object(
    'version', 2,
    'providers', jsonb_build_array(
      jsonb_build_object(
        'mode', 'internal',
        'name', 'internal_renderer',
        'timeout_ms', 20000,
        'invoke_secret', 'synthetic-tenant-renderer-credential'
      )
    )
  );
  v_result JSONB;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Label Provider Placeholder Fallback Org', 'label-provider-placeholder-fallback-org')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.upsert_label_provider_settings_v1(
    'global',
    NULL,
    v_active,
    'pgTAP active global label provider'
  );

  PERFORM public.upsert_label_provider_settings_v1(
    'tenant',
    v_org,
    v_placeholder,
    'pgTAP placeholder tenant label provider'
  );

  v_result := public.resolve_label_renderer_invoke_config_v1(v_org);

  RETURN NEXT is(
    v_result->>'invoke_url',
    'https://global-renderer.example.test/functions/v1/label-renderer',
    'Vault-backed placeholder credential falls through to the active global endpoint'
  );

  RETURN NEXT is(
    v_result->>'timeout_ms',
    '20000',
    'active global provider timeout is preserved'
  );

  RETURN NEXT is(
    v_result->>'invoke_secret',
    'synthetic-global-renderer-credential',
    'fallback resolves only the credential paired with the global endpoint'
  );

  PERFORM public.upsert_label_provider_settings_v1(
    'tenant',
    v_org,
    v_malformed,
    'pgTAP malformed non-placeholder tenant label provider'
  );

  RETURN NEXT throws_ok(
    format('SELECT public.resolve_label_renderer_invoke_config_v1(%L::uuid)', v_org),
    'P0001',
    'resolve_label_renderer_invoke_config_v1: invoke_url missing in label_provider configuration',
    'malformed non-placeholder tenant provider fails closed'
  );
END $fixture$;

SELECT * FROM pg_temp.check_label_provider_placeholder_fallback();
SELECT * FROM finish();

ROLLBACK;
