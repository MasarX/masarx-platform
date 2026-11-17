-- Migration: HERE reverse mapping config fix
-- Purpose:
--   - Populate mapping for HERE reverse responses so geocoding attempts record
--     coordinates and address components (enables cache_write + decision).
-- Alignment: SIMPLE, SCALABLE, DYNAMIC, row-driven, SSOT.
-- Date: 2026-01-05

BEGIN;

UPDATE public.mapping_configs
SET mapping_config = jsonb_build_object(
        'field_mappings',
        jsonb_build_object(
          'city', '$.items[0].address.city',
          'street', '$.items[0].address.street',
          'district', '$.items[0].address.district',
          'latitude', '$.items[0].position.lat',
          'longitude', '$.items[0].position.lng',
          'province', '$.items[0].address.county',
          'postal_code', '$.items[0].address.postalCode',
          'country_code', '$.items[0].address.countryCode',
          'house_number', '$.items[0].address.houseNumber',
          'confidence_score', '$.items[0].scoring.relevance',
          'formatted_address', '$.items[0].title',
          'address_components', '$.items[0].address',
          'raw_items', '$.items'
        )
    ),
    mapping_version = mapping_version + 1,
    notes = 'HERE reverse mapping: populate coordinates + address components',
    updated_at = now()
WHERE mapping_key = 'here_geocoding::reverse_v1';

COMMIT;
