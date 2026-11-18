-- pgTAP: default shipment webhook onboarding contract stays aligned with
-- active baseline plugin versions so first-tenant readiness does not drift.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

CREATE OR REPLACE FUNCTION pg_temp.default_webhook_contract_readiness_sync_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org_id UUID := gen_random_uuid();
  v_default public.onboarding_integration_plugin_defaults%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
  v_readiness JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT *
    INTO v_default
    FROM public.onboarding_integration_plugin_defaults
   WHERE profile_key = 'default'
     AND scope_type = 'tenant'
     AND plugin_key = 'default-shipment-webhook-intake';

  RETURN NEXT ok(
    v_default.plugin_key IS NOT NULL,
    'default shipment webhook onboarding plugin default exists'
  );

  RETURN NEXT is(
    v_default.workflow_binding,
    '{"mode":"attach_existing","intent":"shipment.create","template_name":"webhook_shipment_create_v1"}'::jsonb,
    'default webhook onboarding workflow binding matches the active shipment-create contract'
  );

  RETURN NEXT is(
    v_default.mapping_config#>'{transforms,shipment,tracking_number}',
    '["shipment.tracking_number","tracking_number","awb","waybill","barcode"]'::jsonb,
    'default webhook mapping accepts canonical tracking-number aliases'
  );

  RETURN NEXT is(
    v_default.mapping_config#>>'{metadata,canonical_intent}',
    'shipment.create',
    'default webhook mapping records canonical shipment.create intent'
  );

  INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (
    v_org_id,
    'Default Webhook Contract Readiness Org',
    format('default-webhook-contract-%s', left(replace(v_org_id::text, '-', ''), 8)),
    'Asia/Riyadh',
    'en',
    'active'
  );

  PERFORM public.bootstrap_tenant_onboarding_v1(v_org_id, 'pgtap_default_webhook_contract_readiness');

  SELECT *
    INTO v_plugin
    FROM public.integration_plugins
   WHERE organization_id = v_org_id
     AND plugin_key = 'default-shipment-webhook-intake'
   LIMIT 1;

  SELECT *
    INTO v_version
    FROM public.integration_plugin_versions
   WHERE id = v_plugin.active_version_id
   LIMIT 1;

  RETURN NEXT ok(
    v_plugin.id IS NOT NULL
    AND v_plugin.status = 'active'
    AND v_version.status = 'active',
    'tenant bootstrap activates the default shipment webhook plugin'
  );

  RETURN NEXT ok(
    lower(COALESCE(v_plugin.plugin_kind, '')) = lower(COALESCE(v_default.plugin_kind, ''))
    AND lower(COALESCE(v_version.source_type, '')) = lower(COALESCE(v_default.source_type, ''))
    AND COALESCE(v_version.source_payload, '{}'::jsonb) IS NOT DISTINCT FROM COALESCE(v_default.source_payload, '{}'::jsonb)
    AND COALESCE(v_version.inbound_config, '{}'::jsonb) IS NOT DISTINCT FROM COALESCE(v_default.inbound_config, '{}'::jsonb)
    AND COALESCE(v_version.mapping_config, '{}'::jsonb) IS NOT DISTINCT FROM COALESCE(v_default.mapping_config, '{}'::jsonb)
    AND COALESCE(v_version.workflow_binding, '{}'::jsonb) IS NOT DISTINCT FROM COALESCE(v_default.workflow_binding, '{}'::jsonb)
    AND COALESCE(v_version.outbound_operations, '[]'::jsonb) IS NOT DISTINCT FROM COALESCE(v_default.outbound_operations, '[]'::jsonb),
    'bootstrapped default shipment webhook plugin has no effective-contract drift from onboarding defaults'
  );

  v_readiness := public.onboarding_integration_plugin_readiness_v1('tenant', v_org_id);

  RETURN NEXT is(
    v_readiness->>'ok',
    'true',
    'tenant integration-plugin readiness is healthy after default webhook contract sync'
  );
END;
$function$;

SELECT * FROM pg_temp.default_webhook_contract_readiness_sync_v1();

SELECT * FROM finish();

ROLLBACK;
