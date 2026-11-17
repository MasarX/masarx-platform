-- Migration: Fix TEST0000 short code reference data
-- Purpose:
--   - Align TEST0000 registry entry with HERE reference address/coordinates.
--   - Ensure short-code reverse geocoding yields correct district + zone mapping.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-12
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
  'here_reference',
  1.0,
  'rooftop',
  jsonb_strip_nulls(jsonb_build_object(
    'formatted_address', '1 Example Street, Example District, Example City, 00000',
    'district', 'Example District',
    'city', 'Example City',
    'province', 'Example City',
    'country_code', 'SA',
    'postal_code', '00000',
    'latitude', 0.0,
    'longitude', 0.0,
    'source', 'here_reference'
  )),
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
