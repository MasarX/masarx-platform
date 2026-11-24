-- pgTAP: Console V2 label renderer readiness readback
-- Verifies provider secrets are redacted and the API wrapper is exposed.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

DO $do$
DECLARE
  v_org UUID := '775c6100-254b-4f2d-b9f6-1262f52b06a1'::uuid;
  v_user UUID := '775c6100-254b-4f2d-b9f6-1262f52b06a2'::uuid;
  v_invoke_url TEXT := concat('https', '://', concat_ws('.', 'renderer', 'example', 'test'), '/functions/v1/label-renderer');
  v_legacy_url TEXT := concat(v_invoke_url, '?', 'token', '=', gen_random_uuid());
  v_secret TEXT := gen_random_uuid()::text;
  v_provider JSONB := jsonb_build_object(
    'version', 1,
    'providers', jsonb_build_array(
      jsonb_build_object(
        'mode', 'internal',
        'name', 'pg_tap_label_renderer',
        'invoke_url', v_invoke_url,
        'timeout_ms', 30000,
        'invoke_secret', v_secret
      )
    )
  );
  v_result JSONB;
  v_api_result JSONB;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Label Renderer Readiness Org', 'console-v2-label-renderer-readiness-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name)
  VALUES (v_user, v_org, concat(v_user, chr(64), concat_ws('.', 'example', 'test')), 'Label Renderer Readiness pgTAP')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      email = EXCLUDED.email,
      full_name = EXCLUDED.full_name;

  PERFORM public.upsert_settings_value_v1(
    'label_provider',
    'tenant',
    v_org,
    v_provider,
    1,
    'pgTAP active label renderer provider'
  );

  -- Readback must still redact query parameters stored before URL validation.
  SET CONSTRAINTS ALL IMMEDIATE;
  ALTER TABLE public.settings DISABLE TRIGGER a00_label_provider_seal_cache;
  UPDATE public.settings
  SET cached_value = jsonb_set(cached_value, '{providers,0,invoke_url}', to_jsonb(v_legacy_url))
  WHERE category = 'label_provider' AND scope_type = 'tenant' AND scope_id = v_org;
  ALTER TABLE public.settings ENABLE TRIGGER a00_label_provider_seal_cache;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'service_role', 'aud', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  v_result := public.ui_label_renderer_readiness_v1('tenant', v_org);
  v_api_result := api.ui_label_renderer_readiness_v1('tenant', v_org);

  PERFORM is(v_result->>'ok', 'true', 'public readiness RPC returns ok');
  PERFORM is(v_result#>>'{renderer_provider,status}', 'ready', 'renderer provider resolves ready');
  PERFORM is(v_result#>>'{renderer_provider,invoke_secret}', 'redacted', 'renderer invoke secret is redacted');
  PERFORM is(v_result#>>'{renderer_provider,invoke_url}', v_invoke_url || '?redacted=query', 'renderer invoke URL query is redacted');
  PERFORM ok(position(v_secret in v_result::text) = 0, 'readiness payload never leaks provider secret');
  PERFORM is(v_result#>>'{print_profile,status}', 'ready', 'effective print profile resolves ready');
  PERFORM is(v_result#>>'{printer_certification,status}', 'missing', 'missing printer certification is explicit');
  PERFORM is(v_api_result#>>'{renderer_provider,invoke_secret}', 'redacted', 'api wrapper returns redacted provider payload');
END $do$;

SELECT * FROM finish();

ROLLBACK;
