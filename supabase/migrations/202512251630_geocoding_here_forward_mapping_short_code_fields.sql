-- Migration: Extend HERE forward response mapping with canonical address fields
-- Purpose:
--   Expose street/house_number/district/city/province/postal_code/country_code in the
--   provider_response mapping (geocoding::here_forward::v1) so downstream workflow logic
--   can hydrate addresses and upsert SSOT registries without provider-specific parsing.
-- Alignment: Row-driven mappings, ZERO HARD CODING, SSOT-friendly.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, extensions, pg_temp;

UPDATE public.mapping_configs
SET mapping_config = jsonb_set(
        COALESCE(mapping_config, '{}'::jsonb),
        '{field_mappings}',
        COALESCE(mapping_config->'field_mappings', '{}'::jsonb) || jsonb_build_object(
          'street', '$.items[0].address.street',
          'house_number', '$.items[0].address.houseNumber',
          'district', '$.items[0].address.district',
          'city', '$.items[0].address.city',
          'province', '$.items[0].address.state',
          'postal_code', '$.items[0].address.postalCode',
          'country_code', '$.items[0].address.countryCode'
        ),
        TRUE
    ),
    mapping_version = mapping_version + 1,
    updated_at = now()
WHERE mapping_type = 'provider_response'
  AND mapping_key = 'geocoding::here_forward::v1';

COMMIT;

