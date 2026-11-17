-- Migration: Brand-neutral taxonomy IDs (platform_v1 + platform_reference_number)
-- Purpose:
--   - Rename the canonical API gateway pack name from `masarx_v1` -> `platform_v1`.
--   - Rename the shipment reference taxonomy key from `masarx_reference_number` -> `platform_reference_number`.
-- Notes:
--   - Not live yet: breaking renames are acceptable.
--   - Uses defensive logic to avoid unique conflicts if partially applied.
-- Date: 2026-01-18

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) API gateway pack taxonomy
-------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.api_route_packs WHERE name = 'masarx_v1') THEN
    IF EXISTS (SELECT 1 FROM public.api_route_packs WHERE name = 'platform_v1') THEN
      -- Prefer platform_v1; disable the legacy-named pack to prevent accidental use.
      UPDATE public.api_route_packs
      SET enabled = FALSE,
          updated_at = now()
      WHERE name = 'masarx_v1';
    ELSE
      UPDATE public.api_route_packs
      SET name = 'platform_v1',
          description = 'Platform canonical REST API (v1).',
          updated_at = now()
      WHERE name = 'masarx_v1';
    END IF;
  END IF;

  UPDATE public.api_route_packs
  SET description = 'Platform canonical REST API (v1).',
      updated_at = now()
  WHERE name = 'platform_v1';
END $$;

-------------------------------------------------------------------------------
-- 2) Shipment reference taxonomy
-------------------------------------------------------------------------------
DO $$
DECLARE
  v_def_id UUID;
BEGIN
  SELECT id
  INTO v_def_id
  FROM public.lookup_definitions
  WHERE category = 'shipment_reference_type'
  LIMIT 1;

  IF v_def_id IS NULL THEN
    RAISE EXCEPTION 'Missing lookup_definitions category shipment_reference_type';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.lookup_values
    WHERE lookup_definition_id = v_def_id
      AND value = 'masarx_reference_number'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM public.lookup_values
      WHERE lookup_definition_id = v_def_id
        AND value = 'platform_reference_number'
    ) THEN
      UPDATE public.lookup_values
      SET status = 'inactive',
          updated_at = now()
      WHERE lookup_definition_id = v_def_id
        AND value = 'masarx_reference_number';
    ELSE
      UPDATE public.lookup_values
      SET value = 'platform_reference_number',
          label = 'Platform Reference',
          description = 'Platform internal reference number (if distinct from tracking_number).',
          sort_order = 40,
          status = 'active',
          updated_at = now()
      WHERE lookup_definition_id = v_def_id
        AND value = 'masarx_reference_number';
    END IF;
  END IF;

  UPDATE public.lookup_values
  SET label = 'Platform Reference',
      description = 'Platform internal reference number (if distinct from tracking_number).',
      sort_order = 40,
      status = 'active',
      updated_at = now()
  WHERE lookup_definition_id = v_def_id
    AND value = 'platform_reference_number';
END $$;

UPDATE public.shipment_reference_numbers
SET reference_type = 'platform_reference_number',
    updated_at = now()
WHERE reference_type = 'masarx_reference_number';

COMMIT;

