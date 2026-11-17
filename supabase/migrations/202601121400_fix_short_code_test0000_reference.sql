-- Migration: Canonical short-code reference for TEST0000
-- Purpose:
--   - Restore authoritative reference mapping for demo short code.
--   - Ensure cache writes do not override reference rows.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-12
BEGIN;
SET search_path TO public, workflow_handlers, extensions, pg_temp;

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

COMMIT;
