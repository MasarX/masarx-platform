-- Console V2 first-tenant webhook remediation: default shipment webhook
-- mapping must match the external shipment envelope used by receiver/API tests.
--
-- The prior default profile mapped top-level recipient/address fields, while
-- live third-party payloads arrive under shipment.recipient and
-- shipment.destination. This keeps the mapping row-driven and updates the
-- onboarding/plugin defaults plus already-provisioned managed tenant mappings.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605151905_console_v2_default_webhook_nested_payload_mapping_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_patch JSONB := jsonb_build_object(
    'label', 'Default shipment webhook intake',
    'target', 'shipments.create',
    'enabled', TRUE,
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object(
        'external_id', 'shipment.reference',
        'reference_number', 'shipment.reference',
        'service_type', 'shipment.service_type',
        'service_level', 'shipment.service_level',
        'cod_amount', 'shipment.cod_amount',
        'currency', 'shipment.cod_currency'
      ),
      'sender', jsonb_build_object(
        'external_id', 'sender.external_id',
        'name', 'sender.name'
      ),
      'recipient', jsonb_build_object(
        'external_id', 'shipment.recipient.external_id',
        'name', 'Example Entity ntvplorhukthpmnmvgrstqzp',
        'phone', 'shipment.recipient.phone',
        'email', 'shipment.recipient.email'
      ),
      'address', jsonb_build_object(
        'line1', 'shipment.destination.line1',
        'line2', 'shipment.destination.line2',
        'district', 'shipment.destination.district',
        'city', 'shipment.destination.city',
        'province', 'shipment.destination.province',
        'country_code', 'shipment.destination.country',
        'lat', 'shipment.destination.lat',
        'lng', 'shipment.destination.lng'
      )
    ),
    'sample_input', jsonb_build_object(
      'event', jsonb_build_object(
        'id', 'external-webhook-sample-1001',
        'type', 'shipment.created',
        'timestamp', '2026-05-15T12:00:00Z'
      ),
      'shipment', jsonb_build_object(
        'reference', 'FT-WH-EXT-1001',
        'service_type', 'delivery',
        'service_level', 'next_day',
        'cod_amount', 125.50,
        'cod_currency', 'SAR',
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
      'payload_shape', 'external_shipment_envelope_v1'
    )
  );
BEGIN
  UPDATE public.onboarding_integration_plugin_defaults d
     SET mapping_config = public.jsonb_deep_merge(COALESCE(d.mapping_config, '{}'::jsonb), v_patch),
         updated_at = now()
   WHERE d.profile_key = 'default'
     AND d.scope_type = 'tenant'
     AND d.plugin_key = 'default-shipment-webhook-intake'
     AND COALESCE(d.mapping_config#>>'{metadata,payload_shape}', '') IS DISTINCT FROM 'external_shipment_envelope_v1';

  UPDATE public.integration_plugin_versions v
     SET mapping_config = public.jsonb_deep_merge(COALESCE(v.mapping_config, '{}'::jsonb), v_patch),
         updated_at = now()
    FROM public.integration_plugins p
   WHERE p.id = v.plugin_id
     AND p.plugin_key = 'default-shipment-webhook-intake'
     AND COALESCE(v.mapping_config#>>'{metadata,payload_shape}', '') IS DISTINCT FROM 'external_shipment_envelope_v1';

  UPDATE public.mapping_configs mc
     SET mapping_config = public.jsonb_deep_merge(COALESCE(mc.mapping_config, '{}'::jsonb), v_patch),
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
     AND COALESCE(mc.mapping_config#>>'{metadata,payload_shape}', '') IS DISTINCT FROM 'external_shipment_envelope_v1';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605151905_console_v2_default_webhook_nested_payload_mapping_v1'));

COMMIT;
