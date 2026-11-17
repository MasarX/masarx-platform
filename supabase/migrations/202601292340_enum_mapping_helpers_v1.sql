-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Enum mapping helpers v1 (normalization + lookup validation)
-- Purpose:
--   - Eliminate duplicated provider enum normalization logic across handlers.
--   - Standardize provider->canonical mappings through SSOT `field_mappings`.
--   - Provide a canonical lookup validator for enum categories (lookup_definitions/lookup_values).
--   - Extend `shipment_status` taxonomy to cover internal/fixture statuses used by the platform.
-- Date: 2026-01-29

BEGIN;

-------------------------------------------------------------------------------
-- 1) Enum normalization (provider/input -> normalized token)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.normalize_enum_key_v1(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO public, pg_temp
AS $$
  SELECT NULLIF(
    btrim(
      regexp_replace(
        regexp_replace(
          upper(COALESCE(NULLIF(btrim(p_value), ''), '')),
          '[^A-Z0-9]+',
          '_',
          'g'
        ),
        '_{2,}',
        '_',
        'g'
      ),
      '_'
    ),
    ''
  );
$$;

COMMENT ON FUNCTION public.normalize_enum_key_v1(TEXT)
  IS 'Normalize an enum-like string into an uppercase underscore token (A-Z0-9_). Returns NULL for blank input.';

-------------------------------------------------------------------------------
-- 2) Lookup validator (active value in lookup_definitions/lookup_values)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_active_lookup_value_v1(
  p_category TEXT,
  p_value TEXT,
  p_require_definition BOOLEAN DEFAULT TRUE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  WITH v AS (
    SELECT NULLIF(btrim(p_category), '') AS category,
           NULLIF(btrim(p_value), '') AS value,
           COALESCE(p_require_definition, TRUE) AS require_definition
  ),
  d AS (
    SELECT ld.id
    FROM public.lookup_definitions ld
    JOIN v ON v.category = ld.category
    LIMIT 1
  )
  SELECT CASE
    WHEN (SELECT value FROM v) IS NULL THEN FALSE
    WHEN NOT EXISTS (SELECT 1 FROM d) THEN (SELECT NOT require_definition FROM v)
    ELSE EXISTS (
      SELECT 1
      FROM public.lookup_values lv
      JOIN d ON d.id = lv.lookup_definition_id
      WHERE lv.value = (SELECT value FROM v)
        AND lv.status = 'active'
    )
  END;
$$;

COMMENT ON FUNCTION public.is_active_lookup_value_v1(TEXT, TEXT, BOOLEAN)
  IS 'Returns TRUE when p_value is an active lookup_value in category p_category. When p_require_definition=true and category missing, returns FALSE.';

-------------------------------------------------------------------------------
-- 3) Field mapping resolver (enum-like mapping_domain)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_field_mapping_enum_v1(
  p_mapping_domain TEXT,
  p_provider_name TEXT,
  p_direction TEXT,
  p_provider_value TEXT
)
RETURNS TABLE (
  provider_value_normalized TEXT,
  canonical_value TEXT,
  mapping_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  WITH i AS (
    SELECT
      NULLIF(btrim(p_mapping_domain), '') AS mapping_domain,
      NULLIF(btrim(p_provider_name), '') AS provider_name,
      NULLIF(btrim(p_direction), '') AS direction,
      public.normalize_enum_key_v1(p_provider_value) AS provider_value_normalized
  )
  SELECT
    i.provider_value_normalized,
    m.canonical_value,
    m.id AS mapping_id
  FROM i
  LEFT JOIN LATERAL (
    SELECT fm.id, fm.canonical_value, fm.direction
    FROM public.field_mappings fm
    WHERE fm.mapping_domain = i.mapping_domain
      AND fm.provider_name = i.provider_name
      AND fm.provider_value = i.provider_value_normalized
      AND fm.direction IN (i.direction, 'both')
    ORDER BY CASE WHEN fm.direction = i.direction THEN 0 ELSE 1 END, fm.id
    LIMIT 1
  ) AS m ON TRUE;
$$;

COMMENT ON FUNCTION public.resolve_field_mapping_enum_v1(TEXT, TEXT, TEXT, TEXT)
  IS 'Resolve provider enum value -> canonical_value via field_mappings for an enum-like mapping_domain. Returns normalized provider value and mapping id.';

-------------------------------------------------------------------------------
-- 4) Shipment status taxonomy: extend to cover internal/fixture statuses
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('created', 'Created', 'Shipment created (order received) but not yet dispatched', 0, false),
  ('pending_dispatch', 'Pending Dispatch', 'Shipment pending dispatch/route assignment', 15, false)
) AS v(value, label, description, sort_order, is_default)
WHERE ld.category = 'shipment_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

