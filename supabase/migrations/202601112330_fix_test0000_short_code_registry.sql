-- Migration: Fix TEST0000 short-code registry entry
-- Purpose: Update SSOT address_code_registry coordinates + address fields for TEST0000 (HERE verified).
-- Alignment: SIMPLE / SCALABLE / DYNAMIC - data fix in SSOT cache, no hardcoding in code paths.

BEGIN;

SET search_path TO public, extensions, pg_temp;

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
  created_at,
  updated_at
)
VALUES (
  'SA',
  'sa_short_code',
  'TEST0000',
  ST_SetSRID(ST_MakePoint(0.0, 0.0), 4326)::geography,
  '1 Example Street, Example District, Example City, 00000',
  'Example Street',
  '1',
  'Example District',
  'Example City',
  'Example City',
  '00000',
  'here_geocoding',
  0.99,
  'house_number',
  jsonb_build_object(
    'source', 'here_geocode',
    'short_code', 'TEST0000',
    'here_id', 'example-place-id',
    'position', jsonb_build_object('lat', 0.0, 'lng', 0.0),
    'address', jsonb_build_object(
      'label', '1 Example Street, Example District, Example City, 00000',
      'district', 'Example District',
      'city', 'Example City',
      'postalCode', '00000',
      'countryCode', 'SAU'
    )
  ),
  now(),
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
  provider_name = EXCLUDED.provider_name,
  confidence_score = EXCLUDED.confidence_score,
  accuracy_type = EXCLUDED.accuracy_type,
  provider_parsed = EXCLUDED.provider_parsed,
  resolved_at = now(),
  updated_at = now();

COMMIT;
