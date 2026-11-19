-- pgTAP: Console V2 default webhook mapping matches the external shipment
-- envelope used by live first-tenant webhook intake.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

-- Exercise the current shipment factory independently of general intake defaults.
CREATE TEMP TABLE example_webhook_mapping AS
WITH org AS (
  INSERT INTO public.organizations (name, slug)
  VALUES ('Example Mapping Tenant', 'example-mapping-' || gen_random_uuid()::text)
  RETURNING id
), fixture AS (
  INSERT INTO public.mapping_configs (organization_id, mapping_type, mapping_key, mapping_config, mapping_version)
  SELECT id, 'webhook_inbound', 'example-shipment-mapping',
         public.default_shipment_webhook_intake_mapping_config_v1(), 1
    FROM org
  RETURNING id, mapping_config
)
SELECT id, mapping_config FROM fixture;

WITH default_mapping AS (
  SELECT mc.mapping_config
    FROM example_webhook_mapping mc
)
SELECT is(
  (SELECT mapping_config#>>'{metadata,payload_shape}' FROM default_mapping),
  'external_shipment_envelope_v1',
  'default shipment webhook mapping declares the external shipment envelope payload shape'
);

WITH default_mapping AS (
  SELECT mc.id
    FROM example_webhook_mapping mc
),
mapped AS (
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
          'name', 'Example Recipient',
          'phone', '+12025550123',
          'email', 'noura.pgtap@example.com'
        ),
        'destination', jsonb_build_object(
          'line1', 'Example Street',
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
    (SELECT id FROM default_mapping)
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{recipient,name}' FROM mapped),
  'Example Recipient',
  'default webhook mapping maps nested shipment.recipient.name'
);

WITH default_mapping AS (
  SELECT mc.id
    FROM example_webhook_mapping mc
),
mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'cod_amount', 137.65,
      'cod_currency', 'SAR',
      'recipient', jsonb_build_object('phone', '+12025550123'),
      'destination', jsonb_build_object('line1', 'Example Street', 'city', 'Riyadh', 'country', 'SA')
    )),
    (SELECT id FROM default_mapping)
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{recipient,phone}' FROM mapped),
  '+12025550123',
  'default webhook mapping maps nested shipment.recipient.phone'
);

WITH default_mapping AS (
  SELECT mc.id
    FROM example_webhook_mapping mc
),
mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'cod_amount', 137.65,
      'cod_currency', 'SAR',
      'recipient', jsonb_build_object('name', 'Example Recipient'),
      'destination', jsonb_build_object('line1', 'Example Street', 'city', 'Riyadh', 'country', 'SA')
    )),
    (SELECT id FROM default_mapping)
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,line1}' FROM mapped),
  'Example Street',
  'default webhook mapping maps nested shipment.destination.line1'
);

WITH default_mapping AS (
  SELECT mc.id
    FROM example_webhook_mapping mc
),
mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'cod_amount', 137.65,
      'cod_currency', 'SAR',
      'recipient', jsonb_build_object('name', 'Example Recipient'),
      'destination', jsonb_build_object('line1', 'Example Street', 'city', 'Riyadh', 'country', 'SA')
    )),
    (SELECT id FROM default_mapping)
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,city}' FROM mapped),
  'Riyadh',
  'default webhook mapping maps nested shipment.destination.city'
);

WITH default_mapping AS (
  SELECT mc.id
    FROM example_webhook_mapping mc
),
mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'cod_amount', 137.65,
      'cod_currency', 'SAR',
      'recipient', jsonb_build_object('name', 'Example Recipient'),
      'destination', jsonb_build_object('line1', 'Example Street', 'city', 'Riyadh', 'country', 'SA')
    )),
    (SELECT id FROM default_mapping)
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,country_code}' FROM mapped),
  'SA',
  'default webhook mapping maps nested shipment.destination.country'
);

WITH default_mapping AS (
  SELECT mc.id
    FROM example_webhook_mapping mc
),
mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object('shipment', jsonb_build_object(
      'reference', 'FT-WH-PGTAP-1001',
      'service_type', 'delivery',
      'cod_amount', 137.65,
      'cod_currency', 'SAR',
      'recipient', jsonb_build_object('name', 'Example Recipient'),
      'destination', jsonb_build_object('line1', 'Example Street', 'city', 'Riyadh', 'country', 'SA')
    )),
    (SELECT id FROM default_mapping)
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{shipment,currency}' FROM mapped),
  'SAR',
  'default webhook mapping maps nested shipment.cod_currency'
);

SELECT * FROM finish();
ROLLBACK;
