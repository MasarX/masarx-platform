-- pgTAP: label renderer provider resolution ignores tenant bootstrap
-- placeholders only when an activated global provider exists.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

DO $do$
DECLARE
  v_org UUID := 'f95dce10-df04-4bdf-8244-1d999a8e64dd'::uuid;
  v_placeholder JSONB := jsonb_build_object(
    'version', 1,
    'providers', jsonb_build_array(
      jsonb_build_object(
        'mode', 'internal',
        'name', 'internal_renderer',
        'invoke_url', 'https://example.supabase.co/functions/v1/label-renderer',
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
        'invoke_url', 'http://127.0.0.1:57429/functions/v1/label-renderer',
        'timeout_ms', 20000,
        'invoke_secret', 'local-label-renderer-secret'
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
        'invoke_secret', 'tenant-real-secret'
      )
    )
  );
  v_result JSONB;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Label Provider Placeholder Fallback Org', 'label-provider-placeholder-fallback-org')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.upsert_settings_value_v1(
    'label_provider',
    'global',
    NULL,
    v_active,
    2,
    'pgTAP active global label provider'
  );

  PERFORM public.upsert_settings_value_v1(
    'label_provider',
    'tenant',
    v_org,
    v_placeholder,
    1,
    'pgTAP placeholder tenant label provider'
  );

  v_result := public.resolve_label_renderer_invoke_config_v1(v_org);

  PERFORM is(
    v_result->>'invoke_url',
    'http://127.0.0.1:57429/functions/v1/label-renderer',
    'placeholder tenant provider falls through to active global provider'
  );

  PERFORM is(
    v_result->>'timeout_ms',
    '20000',
    'active global provider timeout is preserved'
  );

  PERFORM public.upsert_settings_value_v1(
    'label_provider',
    'tenant',
    v_org,
    v_malformed,
    2,
    'pgTAP malformed non-placeholder tenant label provider'
  );

  BEGIN
    PERFORM public.resolve_label_renderer_invoke_config_v1(v_org);
    PERFORM fail('malformed non-placeholder tenant provider must not fall back to global');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pass('malformed non-placeholder tenant provider fails closed');
  END;
END $do$;

SELECT * FROM finish();

ROLLBACK;
