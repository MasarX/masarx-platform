-- Console V2 first-tenant webhook tester sample alignment.
--
-- The live default webhook mapping now consumes the external shipment envelope
-- shape under shipment.recipient and shipment.destination. Keep the Console
-- tester backend-owned by updating the lookup sample row to the same shape so
-- Browser-driven receiver proof can materialize a real shipment instead of
-- failing after accepted async intake.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605221220_webhook_tester_default_sample_nested_envelope_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH definition AS (
  INSERT INTO public.lookup_definitions (
    category,
    owner_role,
    approval_policy,
    is_mutable,
    description
  )
  VALUES (
    'webhook_sample_payload',
    'engineering',
    'tier_1',
    FALSE,
    'Canonical sample webhook payloads for Console V2 webhook receiver testing.'
  )
  ON CONFLICT (category) DO UPDATE
     SET owner_role = EXCLUDED.owner_role,
         approval_policy = EXCLUDED.approval_policy,
         is_mutable = EXCLUDED.is_mutable,
         description = EXCLUDED.description,
         updated_at = now()
  RETURNING id
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  definition.id,
  'shipment_created_default',
  'Shipment created - default',
  10,
  TRUE,
  'active',
  jsonb_build_object(
    'payload_shape', 'external_shipment_envelope_v1',
    'payload',
    jsonb_build_object(
      'event', jsonb_build_object(
        'id', '{{event_id}}',
        'type', 'shipment.created',
        'timestamp', '{{timestamp_iso}}'
      ),
      'shipment', jsonb_build_object(
        'reference', '{{shipment_reference_number}}',
        'service_type', 'delivery',
        'service_level', 'next_day',
        'cod_amount', 125.50,
        'cod_currency', 'SAR',
        'recipient', jsonb_build_object(
          'external_id', '{{recipient_external_id}}',
          'name', 'Noura Launch Customer',
          'phone', '{{recipient_phone}}',
          'email', '{{recipient_email}}'
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
    )
  )
FROM definition
ON CONFLICT (lookup_definition_id, value) DO UPDATE
   SET label = EXCLUDED.label,
       sort_order = EXCLUDED.sort_order,
       is_default = EXCLUDED.is_default,
       status = EXCLUDED.status,
       metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       retired_at = NULL,
       archived_at = NULL,
       updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605221220_webhook_tester_default_sample_nested_envelope_v1'));

COMMIT;
