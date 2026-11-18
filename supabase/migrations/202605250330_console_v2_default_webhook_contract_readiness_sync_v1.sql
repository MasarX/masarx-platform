-- Console V2 first-tenant readiness: keep the default shipment webhook
-- intake onboarding contract aligned with the active baseline plugin contract.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605250330_console_v2_default_webhook_contract_readiness_sync_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_mapping JSONB := jsonb_build_object(
    'label', 'Default shipment webhook intake',
    'target', 'shipments.create',
    'enabled', TRUE,
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object(
        'external_id', jsonb_build_array(
          'shipment.external_id',
          'shipment.reference',
          'external_id',
          'id',
          'reference'
        ),
        'reference_number', jsonb_build_array(
          'shipment.reference_number',
          'shipment.reference',
          'reference_number',
          'reference'
        ),
        'tracking_number', jsonb_build_array(
          'shipment.tracking_number',
          'tracking_number',
          'awb',
          'waybill',
          'barcode'
        ),
        'service_type', jsonb_build_array(
          'shipment.service_type',
          'service_type'
        ),
        'service_level', jsonb_build_array(
          'shipment.service_level',
          'service_level'
        ),
        'cod_amount', jsonb_build_array(
          'shipment.cod_amount',
          'cod_amount',
          'cash_on_delivery_amount'
        ),
        'currency', jsonb_build_array(
          'shipment.cod_currency',
          'currency'
        )
      ),
      'sender', jsonb_build_object(
        'external_id', 'sender.external_id',
        'name', 'sender.name'
      ),
      'recipient', jsonb_build_object(
        'external_id', jsonb_build_array(
          'shipment.recipient.external_id',
          'recipient.external_id',
          'customer.external_id'
        ),
        'name', jsonb_build_array(
          'Example Entity ntvplorhukthpmnmvgrstqzp',
          'recipient.name',
          'customer.name',
          'customer_name'
        ),
        'phone', jsonb_build_array(
          'shipment.recipient.phone',
          'recipient.phone',
          'customer.phone',
          'phone',
          'mobile'
        ),
        'email', jsonb_build_array(
          'shipment.recipient.email',
          'recipient.email',
          'customer.email',
          'email'
        )
      ),
      'address', jsonb_build_object(
        'line1', jsonb_build_array(
          'shipment.destination.line1',
          'destination.line1',
          'address.line1',
          'line1',
          'address_line_1'
        ),
        'line2', jsonb_build_array(
          'shipment.destination.line2',
          'destination.line2',
          'address.line2',
          'line2',
          'address_line_2'
        ),
        'district', jsonb_build_array(
          'shipment.destination.district',
          'destination.district',
          'address.district',
          'district'
        ),
        'city', jsonb_build_array(
          'shipment.destination.city',
          'destination.city',
          'address.city',
          'city'
        ),
        'province', jsonb_build_array(
          'shipment.destination.province',
          'destination.province',
          'address.province',
          'province',
          'region'
        ),
        'country_code', jsonb_build_array(
          'shipment.destination.country',
          'destination.country',
          'address.country',
          'country_code',
          'country'
        ),
        'lat', jsonb_build_array(
          'shipment.destination.lat',
          'destination.lat',
          'address.lat',
          'latitude',
          'lat'
        ),
        'lng', jsonb_build_array(
          'shipment.destination.lng',
          'destination.lng',
          'address.lng',
          'longitude',
          'lng'
        )
      )
    ),
    'sample_input', jsonb_build_object(
      'event', jsonb_build_object(
        'id', 'external-webhook-sample-1001',
        'type', 'shipment.created',
        'timestamp', '2026-05-15T12:00:00Z'
      ),
      'sender', jsonb_build_object(
        'external_id', 'FT-SENDER-RUH-01',
        'name', 'Launch Riyadh Storefront'
      ),
      'shipment', jsonb_build_object(
        'external_id', 'FT-ORDER-1001',
        'reference', 'FT-WH-EXT-1001',
        'reference_number', 'FT-REF-1001',
        'service_type', 'delivery',
        'service_level', 'next_day',
        'cod_amount', 125.50,
        'cod_currency', 'SAR',
        'currency', 'SAR',
        'recipient', jsonb_build_object(
          'external_id', 'REC-WH-EXT-1001',
          'name', 'Noura External Customer',
          'phone', '+12025550181',
          'email', 'noura.external@example.com'
        ),
        'destination', jsonb_build_object(
          'line1', 'King Fahd Road',
          'line2', 'Building 12',
          'district', 'Al Olaya',
          'city', 'Riyadh',
          'province', 'Riyadh',
          'country', 'SA',
          'lat', 24.7136,
          'lng', 46.6753
        )
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
        'external_id', 'FT-WH-EXT-1001',
        'reference_number', 'FT-WH-EXT-1001',
        'service_type', 'delivery',
        'service_level', 'next_day',
        'cod_amount', 125.50,
        'currency', 'SAR'
      ),
      'sender', jsonb_build_object(
        'external_id', NULL,
        'name', NULL
      ),
      'recipient', jsonb_build_object(
        'external_id', 'REC-WH-EXT-1001',
        'name', 'Noura External Customer',
        'phone', '+12025550181',
        'email', 'noura.external@example.com'
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
      'mapping_profile', 'shipment_webhook_intake_v1',
      'payload_shape', 'external_shipment_envelope_v1',
      'canonical_intent', 'shipment.create'
    )
  );
BEGIN
  UPDATE public.onboarding_integration_plugin_defaults d
     SET mapping_config = v_mapping,
         updated_at = now()
   WHERE d.profile_key = 'default'
     AND d.scope_type = 'tenant'
     AND d.plugin_key = 'default-shipment-webhook-intake'
     AND COALESCE(d.mapping_config, '{}'::jsonb) IS DISTINCT FROM v_mapping;

  UPDATE public.integration_plugin_versions v
     SET mapping_config = v_mapping,
         updated_at = now()
    FROM public.integration_plugins p
   WHERE p.id = v.plugin_id
     AND p.plugin_key = 'default-shipment-webhook-intake'
     AND COALESCE(v.mapping_config, '{}'::jsonb) IS DISTINCT FROM v_mapping;

  UPDATE public.mapping_configs mc
     SET mapping_config = v_mapping,
         mapping_version = COALESCE(mc.mapping_version, 1) + 1,
         updated_at = now()
   WHERE mc.mapping_type = 'webhook_inbound'
     AND (
       mc.mapping_config#>>'{metadata,mapping_profile}' = 'shipment_webhook_intake_v1'
       OR mc.mapping_config->>'label' = 'Default shipment webhook intake'
     )
     AND (
       mc.managed_by = 'integration_plugin'
       OR mc.mapping_config#>>'{metadata,managed_by}' = 'onboarding_default'
     )
     AND COALESCE(mc.mapping_config, '{}'::jsonb) IS DISTINCT FROM v_mapping;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605250330_console_v2_default_webhook_contract_readiness_sync_v1'));

COMMIT;
