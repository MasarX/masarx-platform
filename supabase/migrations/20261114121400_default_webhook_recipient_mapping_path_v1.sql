BEGIN;
SET LOCAL lock_timeout = '10s';

-- Restore the schema path in the factory as well as existing managed mappings.
DO $factory$
DECLARE
  definition TEXT := pg_get_functiondef('public.default_shipment_webhook_intake_mapping_config_v1()'::regprocedure);
BEGIN
  IF position(quote_literal('Example Entity ntvplorhukthpmnmvgrstqzp') IN definition) > 0 THEN
    EXECUTE replace(definition,
      quote_literal('Example Entity ntvplorhukthpmnmvgrstqzp'),
      quote_literal('shipment.recipient.name'));
  END IF;
  IF public.default_shipment_webhook_intake_mapping_config_v1()
       #>> '{transforms,recipient,name,0}' IS DISTINCT FROM 'shipment.recipient.name' THEN
    RAISE EXCEPTION 'Default webhook recipient mapping path is not canonical';
  END IF;
END;
$factory$;

UPDATE public.mapping_configs
SET mapping_config = jsonb_set(mapping_config, '{transforms,recipient,name,0}', '"shipment.recipient.name"'::jsonb, FALSE),
    mapping_version = COALESCE(mapping_version, 1) + 1,
    updated_at = now()
WHERE mapping_type = 'webhook_inbound'
  AND lower(mapping_config->>'target') IN ('shipment.create', 'shipments.create')
  AND mapping_config #>> '{transforms,recipient,name,0}' = 'Example Entity ntvplorhukthpmnmvgrstqzp';

UPDATE public.onboarding_integration_plugin_defaults
SET mapping_config = jsonb_set(mapping_config, '{transforms,recipient,name,0}', '"shipment.recipient.name"'::jsonb, FALSE),
    updated_at = now()
WHERE plugin_key = 'default-shipment-webhook-intake'
  AND mapping_config #>> '{transforms,recipient,name,0}' = 'Example Entity ntvplorhukthpmnmvgrstqzp';

UPDATE public.integration_plugin_versions v
SET mapping_config = jsonb_set(v.mapping_config, '{transforms,recipient,name,0}', '"shipment.recipient.name"'::jsonb, FALSE),
    updated_at = now()
FROM public.integration_plugins p
WHERE p.id = v.plugin_id
  AND p.plugin_key = 'default-shipment-webhook-intake'
  AND (v.status IN ('active', 'approved') OR p.active_version_id = v.id)
  AND v.mapping_config #>> '{transforms,recipient,name,0}' = 'Example Entity ntvplorhukthpmnmvgrstqzp';

COMMIT;
