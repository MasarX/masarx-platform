-- pgTAP: first-tenant onboarding ships a useful default webhook mapping config.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.onboarding_integration_plugin_defaults d
    WHERE d.profile_key = 'default'
      AND d.scope_type = 'tenant'
      AND d.plugin_key = 'default-shipment-webhook-intake'
      AND d.mapping_config->>'target' = 'shipments.create'
  ),
  'default onboarding plugin carries shipments.create mapping target'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'dcff5e42-25d1-4219-bc49-48b841f97e07'::uuid,
  'Console Default Mapping Org',
  'console-default-mapping-org'
)
ON CONFLICT (id) DO NOTHING;

SELECT ok(
  (public.bootstrap_tenant_onboarding_v1(
    'dcff5e42-25d1-4219-bc49-48b841f97e07'::uuid,
    'pgtap_default_mapping'
  )->>'ok')::boolean,
  'tenant onboarding bootstrap completes with default mapping config'
);

SELECT is(
  (
    SELECT v.mapping_config->>'target'
    FROM public.integration_plugins p
    JOIN public.integration_plugin_versions v
      ON v.id = p.active_version_id
    WHERE p.organization_id = 'dcff5e42-25d1-4219-bc49-48b841f97e07'::uuid
      AND p.plugin_key = 'default-shipment-webhook-intake'
    LIMIT 1
  ),
  'shipments.create',
  'active default plugin version carries the shipment intake target'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.mapping_configs mc
    JOIN public.webhook_sources ws
      ON ws.mapping_config_id = mc.id
    WHERE ws.organization_id = 'dcff5e42-25d1-4219-bc49-48b841f97e07'::uuid
      AND mc.mapping_type = 'webhook_inbound'
      AND mc.mapping_config->>'target' = 'shipments.create'
  ),
  'activated webhook source points at a non-empty shipment intake mapping'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.mapping_configs mc
    JOIN public.webhook_sources ws
      ON ws.mapping_config_id = mc.id
    WHERE ws.organization_id = 'dcff5e42-25d1-4219-bc49-48b841f97e07'::uuid
      AND mc.mapping_config #> '{transforms,shipment}' IS NOT NULL
      AND mc.mapping_config #> '{transforms,recipient}' IS NOT NULL
      AND mc.mapping_config #> '{transforms,address}' IS NOT NULL
  ),
  'default mapping includes shipment, recipient, and address transforms'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.mapping_configs mc
    JOIN public.webhook_sources ws
      ON ws.mapping_config_id = mc.id
    WHERE ws.organization_id = 'dcff5e42-25d1-4219-bc49-48b841f97e07'::uuid
      AND mc.mapping_config #> '{transforms,address,sa_short_code}' IS NOT NULL
      AND mc.mapping_config #> '{transforms,address,sa_short_code}'
          @> '["shipment.destination.short_national_address","address.sa_short_code","shortCode"]'::jsonb
  ),
  'default mapping includes canonical Saudi short national address extraction paths'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.mapping_configs mc
    JOIN public.webhook_sources ws
      ON ws.mapping_config_id = mc.id
    WHERE ws.organization_id = 'dcff5e42-25d1-4219-bc49-48b841f97e07'::uuid
      AND mc.mapping_config ? 'sample_input'
      AND mc.mapping_config ? 'sample_output'
  ),
  'default mapping carries sample input and output for Mapping Studio testing'
);

SELECT * FROM finish();

ROLLBACK;
