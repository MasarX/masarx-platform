-- Plan: PLAN-202512-shipment-references-ssot / Step: S01
-- Migration: Shipment reference helpers
-- Purpose:
--   - Provide reusable helper functions for SSOT shipment references.
--   - Centralize normalized lookup + upsert behavior (no duplicated logic).
-- Date: 2025-12-29

BEGIN;

-------------------------------------------------------------------------------
-- 1) Lookup helper: shipment by client business reference (normalized)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.find_shipment_by_client_reference_v1(
  p_client_id UUID,
  p_client_reference_number TEXT
)
RETURNS TABLE (
  shipment_id UUID,
  tracking_number TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT s.id AS shipment_id, s.tracking_number
  FROM public.shipments s
  WHERE s.client_id = p_client_id
    AND s.client_reference_upper = upper(NULLIF(btrim(p_client_reference_number), ''))
  ORDER BY s.created_at DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.find_shipment_by_client_reference_v1(UUID, TEXT)
  IS 'Find a shipment by normalized client_reference_number within a client scope (case/trim-insensitive).';

-------------------------------------------------------------------------------
-- 2) Upsert helper: single reference row (idempotent by normalized value)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_shipment_reference_number_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_shipment_id UUID,
  p_reference_type TEXT,
  p_reference_value TEXT,
  p_source_type TEXT DEFAULT NULL,
  p_source_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_reference_type TEXT := NULLIF(btrim(p_reference_type), '');
  v_reference_value TEXT := NULLIF(btrim(p_reference_value), '');
  v_source_type TEXT := NULLIF(btrim(p_source_type), '');
  v_id UUID;
BEGIN
  IF p_organization_id IS NULL OR p_client_id IS NULL OR p_shipment_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_reference_type IS NULL OR v_reference_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'shipment_reference_type'
      AND lv.value = v_reference_type
      AND lv.status = 'active'
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.shipment_reference_numbers (
    organization_id,
    client_id,
    shipment_id,
    reference_type,
    reference_value,
    source_type,
    source_id,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    p_organization_id,
    p_client_id,
    p_shipment_id,
    v_reference_type,
    v_reference_value,
    v_source_type,
    p_source_id,
    p_metadata,
    now(),
    now()
  )
  ON CONFLICT (client_id, shipment_id, reference_type, reference_value_upper) DO UPDATE
  SET source_type = COALESCE(EXCLUDED.source_type, public.shipment_reference_numbers.source_type),
      source_id = COALESCE(EXCLUDED.source_id, public.shipment_reference_numbers.source_id),
      metadata = COALESCE(public.shipment_reference_numbers.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
      updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_shipment_reference_number_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID, JSONB)
  IS 'Upsert a canonical shipment_reference_numbers row by normalized reference_value (case/trim-insensitive).';

-------------------------------------------------------------------------------
-- 3) Upsert helper: JSON map of references (supports multi-value per type)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_shipment_reference_numbers_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_shipment_id UUID,
  p_reference_map JSONB,
  p_source_type TEXT DEFAULT NULL,
  p_source_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_key TEXT;
  v_val JSONB;
  v_text TEXT;
  v_processed INT := 0;
BEGIN
  IF p_reference_map IS NULL OR jsonb_typeof(p_reference_map) <> 'object' THEN
    RETURN jsonb_build_object('processed', 0);
  END IF;

  FOR v_key, v_val IN
    SELECT key, value FROM jsonb_each(p_reference_map)
  LOOP
    IF v_val IS NULL OR v_val = 'null'::jsonb THEN
      CONTINUE;
    END IF;

    IF jsonb_typeof(v_val) = 'array' THEN
      FOR v_text IN
        SELECT NULLIF(btrim(x.value), '')
        FROM jsonb_array_elements_text(v_val) AS x(value)
      LOOP
        IF v_text IS NULL THEN
          CONTINUE;
        END IF;

        PERFORM public.upsert_shipment_reference_number_v1(
          p_organization_id,
          p_client_id,
          p_shipment_id,
          v_key,
          v_text,
          p_source_type,
          p_source_id,
          p_metadata
        );
        v_processed := v_processed + 1;
      END LOOP;
    ELSE
      v_text := NULLIF(btrim(v_val #>> '{}'), '');
      IF v_text IS NULL THEN
        CONTINUE;
      END IF;

      PERFORM public.upsert_shipment_reference_number_v1(
        p_organization_id,
        p_client_id,
        p_shipment_id,
        v_key,
        v_text,
        p_source_type,
        p_source_id,
        p_metadata
      );
      v_processed := v_processed + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('processed', v_processed);
END;
$$;

COMMENT ON FUNCTION public.upsert_shipment_reference_numbers_v1(UUID, UUID, UUID, JSONB, TEXT, UUID, JSONB)
  IS 'Upsert multiple shipment reference numbers from a JSON map {reference_type: value|[values]} (row-driven types).';

COMMIT;
