-- Console V2 default webhook mapping config for first-tenant onboarding.
--
-- The baseline integration plugin must create a useful shipment-intake mapping,
-- not an empty mapping row that leaves Mapping Studio showing a blank target.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605071135_console_v2_default_webhook_mapping_config_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_default_mapping JSONB := jsonb_build_object(
    'label', 'Default shipment webhook intake',
    'target', 'shipments.create',
    'enabled', TRUE,
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object(
        'external_id', 'shipment.external_id',
        'reference_number', 'shipment.reference_number',
        'service_type', 'shipment.service_type',
        'service_level', 'shipment.service_level',
        'cod_amount', 'shipment.cod_amount',
        'currency', 'shipment.currency'
      ),
      'sender', jsonb_build_object(
        'external_id', 'sender.external_id',
        'name', 'sender.name'
      ),
      'recipient', jsonb_build_object(
        'external_id', 'recipient.external_id',
        'name', 'recipient.name',
        'phone', 'recipient.phone',
        'email', 'recipient.email'
      ),
      'address', jsonb_build_object(
        'line1', 'address.line1',
        'line2', 'address.line2',
        'district', 'address.district',
        'city', 'address.city',
        'province', 'address.province',
        'country_code', 'address.country_code',
        'lat', 'address.lat',
        'lng', 'address.lng'
      )
    ),
    'sample_input', jsonb_build_object(
      'shipment', jsonb_build_object(
        'external_id', 'FT-ORDER-1001',
        'reference_number', 'FT-REF-1001',
        'service_type', 'standard',
        'service_level', 'next_day',
        'cod_amount', 125.50,
        'currency', 'SAR'
      ),
      'sender', jsonb_build_object(
        'external_id', 'FT-SENDER-RUH-01',
        'name', 'Launch Riyadh Storefront'
      ),
      'recipient', jsonb_build_object(
        'external_id', 'REC-LAUNCH-001',
        'name', 'Noura Launch Customer',
        'phone', '+12025550181',
        'email', 'noura.launch@example.com'
      ),
      'address', jsonb_build_object(
        'line1', 'King Fahd Road',
        'line2', 'Building 12',
        'district', 'Al Olaya',
        'city', 'Riyadh',
        'province', 'Riyadh',
        'country_code', 'SA',
        'lat', 24.7136,
        'lng', 46.6753
      )
    ),
    'sample_output', jsonb_build_object(
      'shipment', jsonb_build_object(
        'external_id', 'FT-ORDER-1001',
        'reference_number', 'FT-REF-1001',
        'service_type', 'standard',
        'service_level', 'next_day',
        'cod_amount', 125.50,
        'currency', 'SAR'
      ),
      'sender', jsonb_build_object(
        'external_id', 'FT-SENDER-RUH-01',
        'name', 'Launch Riyadh Storefront'
      ),
      'recipient', jsonb_build_object(
        'external_id', 'REC-LAUNCH-001',
        'name', 'Noura Launch Customer',
        'phone', '+12025550181',
        'email', 'noura.launch@example.com'
      ),
      'address', jsonb_build_object(
        'line1', 'King Fahd Road',
        'line2', 'Building 12',
        'district', 'Al Olaya',
        'city', 'Riyadh',
        'province', 'Riyadh',
        'country_code', 'SA',
        'lat', 24.7136,
        'lng', 46.6753
      )
    ),
    'metadata', jsonb_build_object(
      'managed_by', 'onboarding_default',
      'mapping_profile', 'shipment_webhook_intake_v1'
    )
  );
BEGIN
  UPDATE public.onboarding_integration_plugin_defaults d
     SET mapping_config = public.jsonb_deep_merge(v_default_mapping, COALESCE(d.mapping_config, '{}'::jsonb)),
         updated_at = now()
   WHERE d.profile_key = 'default'
     AND d.scope_type = 'tenant'
     AND d.plugin_key = 'default-shipment-webhook-intake';

  UPDATE public.integration_plugin_versions v
     SET mapping_config = public.jsonb_deep_merge(v_default_mapping, COALESCE(v.mapping_config, '{}'::jsonb)),
         updated_at = now()
    FROM public.integration_plugins p
   WHERE p.id = v.plugin_id
     AND p.plugin_key = 'default-shipment-webhook-intake'
     AND (
       COALESCE(v.mapping_config, '{}'::jsonb) = '{}'::jsonb
       OR NOT COALESCE(v.mapping_config, '{}'::jsonb) ? 'target'
     );

  UPDATE public.mapping_configs mc
     SET mapping_config = public.jsonb_deep_merge(v_default_mapping, COALESCE(mc.mapping_config, '{}'::jsonb)),
         mapping_version = COALESCE(mc.mapping_version, 1) + 1,
         updated_at = now()
    FROM public.integration_plugins p
   WHERE mc.managed_by = 'integration_plugin'
     AND p.plugin_key = 'default-shipment-webhook-intake'
     AND mc.managed_metadata->>'plugin_id' = p.id::text
     AND (
       COALESCE(mc.mapping_config, '{}'::jsonb) = '{}'::jsonb
       OR NOT COALESCE(mc.mapping_config, '{}'::jsonb) ? 'target'
     );
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605071135_console_v2_default_webhook_mapping_config_v1'));

COMMIT;
