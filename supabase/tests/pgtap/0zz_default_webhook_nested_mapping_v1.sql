-- pgTAP: Console default webhook mapping matches the external shipment
-- envelope used by live first-tenant webhook intake.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT '00000000-0000-0000-0000-00000000d0f1'::uuid AS default_mapping_id \gset

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  :'default_mapping_id'::uuid,
  'webhook_inbound',
  'pgtap-default-webhook-nested-mapping-v1',
  public.default_shipment_webhook_intake_mapping_config_v1(),
  1,
  'Deterministic transaction-scoped default webhook mapping pgTAP fixture'
);

SELECT is(
  (SELECT mapping_config#>>'{metadata,payload_shape}'
     FROM public.mapping_configs
    WHERE id = :'default_mapping_id'::uuid),
  'external_shipment_envelope_v1',
  'default shipment webhook mapping declares the external shipment envelope payload shape'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object(
      'event', jsonb_build_object('id', 'external-webhook-pgtap', 'type', 'shipment.created'),
      'shipment', jsonb_build_object(
        'reference', 'FT-WH-PGTAP-1001',
        'service_type', 'delivery',
        'service_level', 'next_day',
        'cod_amount', 137.65,
        'cod_currency', 'SAR',
        'recipient', jsonb_build_object(
          'external_id', 'REC-WH-PGTAP-1001',
          'name', 'Noura External PGTAP',
          'phone', '+12025550123',
          'email', 'noura.pgtap@example.com'
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
    :'default_mapping_id'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{recipient,name}' FROM mapped),
  'Noura External PGTAP',
  'default webhook mapping maps nested Example Entity ntvplorhukthpmnmvgrstqzp'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'cod_amount', 137.65,
      'cod_currency', 'SAR',
      'recipient', jsonb_build_object('phone', '+12025550123'),
      'destination', jsonb_build_object('line1', 'King Fahd Road', 'city', 'Riyadh', 'country', 'SA')
    )),
    :'default_mapping_id'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{recipient,phone}' FROM mapped),
  '+12025550123',
  'default webhook mapping maps nested shipment.recipient.phone'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'cod_amount', 137.65,
      'cod_currency', 'SAR',
      'recipient', jsonb_build_object('name', 'Noura External PGTAP'),
      'destination', jsonb_build_object('line1', 'King Fahd Road', 'city', 'Riyadh', 'country', 'SA')
    )),
    :'default_mapping_id'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,line1}' FROM mapped),
  'King Fahd Road',
  'default webhook mapping maps nested shipment.destination.line1'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'cod_amount', 137.65,
      'cod_currency', 'SAR',
      'recipient', jsonb_build_object('name', 'Noura External PGTAP'),
      'destination', jsonb_build_object('line1', 'King Fahd Road', 'city', 'Riyadh', 'country', 'SA')
    )),
    :'default_mapping_id'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,city}' FROM mapped),
  'Riyadh',
  'default webhook mapping maps nested shipment.destination.city'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'cod_amount', 137.65,
      'cod_currency', 'SAR',
      'recipient', jsonb_build_object('name', 'Noura External PGTAP'),
      'destination', jsonb_build_object('line1', 'King Fahd Road', 'city', 'Riyadh', 'country', 'SA')
    )),
    :'default_mapping_id'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,country_code}' FROM mapped),
  'SA',
  'default webhook mapping maps nested shipment.destination.country'
);

SELECT ok(
  (SELECT mapping_config#>'{transforms,address,sa_short_code}'
     FROM public.mapping_configs
    WHERE id = :'default_mapping_id'::uuid)
    @> '["shipment.destination.short_national_address","address.sa_short_code","shortCode"]'::jsonb,
  'default webhook mapping declares canonical Saudi short national address fallback paths'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'recipient', jsonb_build_object('name', 'Noura External PGTAP'),
      'destination', jsonb_build_object(
        'line1', 'King Fahd Road',
        'city', 'Riyadh',
        'country', 'SA',
        'short_national_address', 'RNQA7082'
      )
    )),
    :'default_mapping_id'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,sa_short_code}' FROM mapped),
  'RNQA7082',
  'default webhook mapping maps nested shipment.destination.short_national_address to canonical address.sa_short_code'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object(
      'shortCode', 'RNQA7082',
      'shipment', jsonb_build_object(
        'reference', 'FT-WH-PGTAP-1001',
        'recipient', jsonb_build_object('name', 'Noura External PGTAP'),
        'destination', jsonb_build_object('line1', 'King Fahd Road', 'city', 'Riyadh', 'country', 'SA')
      )
    ),
    :'default_mapping_id'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,sa_short_code}' FROM mapped),
  'RNQA7082',
  'default webhook mapping maps top-level shortCode fallback to canonical address.sa_short_code'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'service_type', 'delivery',
      'cod_amount', 137.65,
      'cod_currency', 'SAR',
      'recipient', jsonb_build_object('name', 'Noura External PGTAP'),
      'destination', jsonb_build_object('line1', 'King Fahd Road', 'city', 'Riyadh', 'country', 'SA')
    )),
    :'default_mapping_id'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{shipment,currency}' FROM mapped),
  'SAR',
  'default webhook mapping maps nested shipment.cod_currency'
);

SELECT * FROM finish();
ROLLBACK;
