-- Migration: HERE forward mapping - province derived from county (Saudi)
-- Purpose:
--   HERE Geocoding & Search API returns Saudi administrative region under address.county (state is often null).
--   Ensure provider_response mapping (geocoding::here_forward::v1) populates `province` for Saudi addresses so
--   downstream workflow hydration + SSOT registry upserts can store province consistently.
-- Alignment: Row-driven mappings, SSOT-friendly, best-effort normalization.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, extensions, pg_temp;

UPDATE public.mapping_configs
SET mapping_config = jsonb_set(
        COALESCE(mapping_config, '{}'::jsonb),
        '{field_mappings,province}',
        to_jsonb('$.items[0].address.county'::text),
        TRUE
    ),
    mapping_version = mapping_version + 1,
    updated_at = now()
WHERE mapping_type = 'provider_response'
  AND mapping_key = 'geocoding::here_forward::v1'
  AND COALESCE(mapping_config->'field_mappings'->>'province', '') <> '$.items[0].address.county';

COMMIT;
