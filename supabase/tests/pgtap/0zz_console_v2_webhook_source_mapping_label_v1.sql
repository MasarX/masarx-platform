-- pgTAP: Console V2 webhook source directory exposes operator-facing mapping labels.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);

SELECT ok(
  pg_get_viewdef('public.v_webhook_source_directory'::regclass, true)
    LIKE '%mapping_config%label%mc.mapping_key%mapping_label%',
  'v_webhook_source_directory derives mapping_label from mapping_config.label before mapping_key'
);

DO $$
DECLARE
  v_org     UUID := '00000000-0000-0000-0000-00000053a301';
  v_mapping UUID := '00000000-0000-0000-0000-00000053a302';
  v_source  UUID := '00000000-0000-0000-0000-00000053a303';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Webhook Label Test Org', 'webhook-label-test-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config)
  VALUES (
    v_mapping,
    'webhook_inbound',
    'integration_plugin:technical:source:tenant:webhook-label-test-org',
    jsonb_build_object(
      'label', 'Default shipment webhook intake',
      'target', 'shipments.create',
      'enabled', true
    )
  )
  ON CONFLICT (id) DO UPDATE
    SET mapping_config = EXCLUDED.mapping_config,
        mapping_key = EXCLUDED.mapping_key;

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    rate_limit_per_hour,
    enabled
  )
  VALUES (
    v_source,
    v_org,
    'webhook-label-test-source',
    'Webhook label test source',
    'generic',
    'webhook-label-token',
    v_mapping,
    1000,
    TRUE
  )
  ON CONFLICT (id) DO UPDATE
    SET mapping_config_id = EXCLUDED.mapping_config_id,
        enabled = EXCLUDED.enabled;
END;
$$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('role', 'service_role')::text,
  true
);
SET LOCAL ROLE service_role;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;

SELECT is(
  (
    SELECT mapping_label
    FROM public.v_webhook_source_directory
    WHERE id = '00000000-0000-0000-0000-00000053a303'::UUID
  ),
  'Default shipment webhook intake',
  'webhook source directory shows friendly mapping label instead of technical integration_plugin key'
);

SELECT * FROM finish();
ROLLBACK;
