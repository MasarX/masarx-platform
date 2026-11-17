-- Migration: HERE forward mapping - province fallback (state -> county)
-- Purpose:
--   Keep HERE provider_response mapping globally correct:
--     - Prefer address.state when present (common outside KSA)
--     - Fall back to address.county when state is null (common in KSA; county represents the region)
--   Implemented via array-valued field_mappings (first match wins) backed by jsonb_extract_fields array support.
-- Alignment: Row-driven mappings, best practice, globally safe.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, extensions, pg_temp;

UPDATE public.mapping_configs
SET mapping_config = jsonb_set(
        COALESCE(mapping_config, '{}'::jsonb),
        '{field_mappings,province}',
        jsonb_build_array('$.items[0].address.state', '$.items[0].address.county'),
        TRUE
    ),
    mapping_version = mapping_version + 1,
    updated_at = now()
WHERE mapping_type = 'provider_response'
  AND mapping_key = 'geocoding::here_forward::v1';

COMMIT;

