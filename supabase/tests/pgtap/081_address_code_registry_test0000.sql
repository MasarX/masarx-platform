BEGIN;
SELECT plan(6);

INSERT INTO public.address_code_registry (
  country_code,
  code_type,
  code_value,
  coordinates,
  formatted_address,
  street,
  house_number,
  district,
  city,
  province,
  postal_code,
  provider_name,
  confidence_score,
  accuracy_type,
  provider_parsed,
  resolved_at,
  expires_at,
  created_at,
  updated_at
)
VALUES (
  'SA',
  'sa_short_code',
  'TEST0000',
  ST_SetSRID(ST_MakePoint(0.0, 0.0), 4326)::geography,
  '1 Example Street, Example District, 00000 Example City, Saudi Arabia',
  'Example Street',
  '1',
  'Example District',
  'Example City',
  'Example City',
  '00000',
  'here_reference',
  1.0,
  'rooftop',
  jsonb_build_object(
    'street', 'Example Street',
    'house_number', '1',
    'district', 'Example District',
    'city', 'Example City',
    'province', 'Example City',
    'postal_code', '00000',
    'country_code', 'SA',
    'latitude', 0.0,
    'longitude', 0.0,
    'source', 'here_reference'
  ),
  now(),
  NULL,
  now(),
  now()
)
ON CONFLICT (country_code, code_type, code_value) DO UPDATE
SET
  coordinates = EXCLUDED.coordinates,
  formatted_address = EXCLUDED.formatted_address,
  street = EXCLUDED.street,
  house_number = EXCLUDED.house_number,
  district = EXCLUDED.district,
  city = EXCLUDED.city,
  province = EXCLUDED.province,
  postal_code = EXCLUDED.postal_code,
  provider_name = 'here_reference',
  confidence_score = EXCLUDED.confidence_score,
  accuracy_type = EXCLUDED.accuracy_type,
  provider_parsed = EXCLUDED.provider_parsed,
  resolved_at = now(),
  expires_at = NULL,
  updated_at = now();

SELECT ok(
  EXISTS(
    SELECT 1
    FROM public.address_code_registry
    WHERE country_code = 'SA'
      AND code_type = 'sa_short_code'
      AND code_value = 'TEST0000'
  ),
  'TEST0000 short code is present in address_code_registry'
);

SELECT is(
  (
    SELECT formatted_address
    FROM public.address_code_registry
    WHERE country_code = 'SA'
      AND code_type = 'sa_short_code'
      AND code_value = 'TEST0000'
    LIMIT 1
  ),
  '1 Example Street, Example District, 00000 Example City, Saudi Arabia',
  'TEST0000 formatted address matches normalized reference'
);

SELECT is(
  (
    SELECT provider_name
    FROM public.address_code_registry
    WHERE country_code = 'SA'
      AND code_type = 'sa_short_code'
      AND code_value = 'TEST0000'
    LIMIT 1
  ),
  'here_reference',
  'TEST0000 provider is canonical reference'
);

SELECT is(
  (
    SELECT district
    FROM public.address_code_registry
    WHERE country_code = 'SA'
      AND code_type = 'sa_short_code'
      AND code_value = 'TEST0000'
    LIMIT 1
  ),
  'Example District',
  'TEST0000 district matches HERE reference'
);

SELECT ok(
  (
    SELECT ST_DWithin(
      coordinates,
      ST_SetSRID(ST_MakePoint(0.0, 0.0), 4326)::geography,
      10
    )
    FROM public.address_code_registry
    WHERE country_code = 'SA'
      AND code_type = 'sa_short_code'
      AND code_value = 'TEST0000'
    LIMIT 1
  ),
  'TEST0000 coordinates align with HERE reference (within 10m)'
);

SELECT is(
  (
    SELECT country_code
    FROM public.address_code_registry
    WHERE country_code = 'SA'
      AND code_type = 'sa_short_code'
      AND code_value = 'TEST0000'
    LIMIT 1
  ),
  'SA',
  'TEST0000 uses ISO2 country code'
);

SELECT * FROM finish();
ROLLBACK;
