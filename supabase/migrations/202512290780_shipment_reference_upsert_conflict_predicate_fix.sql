-- Plan: PLAN-202512-shipment-references-ssot / Step: S95
-- Migration: Fix shipment_reference_numbers upsert ON CONFLICT predicate
-- Purpose:
--   - Postgres requires matching index predicate when inferring partial unique indexes.
--   - shipment_reference_numbers enforces uniqueness via a partial unique index:
--       uniq_shipment_reference_numbers_shipment_type_value
--       ON (client_id, shipment_id, reference_type, reference_value_upper)
--       WHERE reference_value_upper IS NOT NULL
--   - upsert_shipment_reference_number_v1 must include the same predicate in
--     its ON CONFLICT clause to avoid runtime failures.
-- Date: 2025-12-29

BEGIN;

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
AS $function$
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
  ON CONFLICT (client_id, shipment_id, reference_type, reference_value_upper)
    WHERE reference_value_upper IS NOT NULL
  DO UPDATE
  SET source_type = COALESCE(EXCLUDED.source_type, public.shipment_reference_numbers.source_type),
      source_id = COALESCE(EXCLUDED.source_id, public.shipment_reference_numbers.source_id),
      metadata = COALESCE(public.shipment_reference_numbers.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
      updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

COMMIT;

