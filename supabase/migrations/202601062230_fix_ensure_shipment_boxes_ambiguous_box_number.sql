-- Fix plpgsql output-column ambiguity in ensure_shipment_boxes
--
-- Purpose:
--   - db-lint flags column reference "box_number" as ambiguous because it can
--     refer to either the output column variable (RETURNS TABLE) or the
--     shipment_boxes column.
--   - Qualify RETURNING columns via INSERT alias.

BEGIN;

CREATE OR REPLACE FUNCTION public.ensure_shipment_boxes(
  p_shipment_id UUID,
  p_box_count INT DEFAULT NULL
)
RETURNS TABLE (
  shipment_box_id UUID,
  box_number INT,
  inserted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_shipment RECORD;
  v_expected_count INT;
BEGIN
  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.tracking_number,
    s.box_count
  INTO v_shipment
  FROM public.shipments s
  WHERE s.id = p_shipment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shipment % not found', p_shipment_id;
  END IF;

  v_expected_count := COALESCE(NULLIF(p_box_count, 0), v_shipment.box_count, 1);
  IF v_expected_count < 1 THEN
    v_expected_count := 1;
  END IF;

  RETURN QUERY
  WITH desired AS (
    SELECT
      gs::int AS box_number,
      format('%s:%s', v_shipment.tracking_number, gs::int) AS barcode
    FROM generate_series(1, v_expected_count) gs
  ),
  inserted_rows AS (
    INSERT INTO public.shipment_boxes AS sb (
      shipment_id,
      organization_id,
      client_id,
      box_number,
      barcode,
      status,
      created_at
    )
    SELECT
      v_shipment.id,
      v_shipment.organization_id,
      v_shipment.client_id,
      d.box_number,
      d.barcode,
      'pending',
      now()
    FROM desired d
    ON CONFLICT (shipment_id, box_number) DO NOTHING
    RETURNING
      sb.id AS shipment_box_id,
      sb.box_number
  ),
  resolved AS (
    SELECT
      sb.id AS shipment_box_id,
      d.box_number,
      (ir.shipment_box_id IS NOT NULL) AS inserted
    FROM desired d
    LEFT JOIN inserted_rows ir
      ON ir.box_number = d.box_number
    LEFT JOIN public.shipment_boxes sb
      ON sb.shipment_id = v_shipment.id
     AND sb.box_number = d.box_number
    WHERE sb.id IS NOT NULL
  )
  SELECT
    r.shipment_box_id,
    r.box_number,
    r.inserted
  FROM resolved r
  ORDER BY r.box_number;
END;
$function$;

COMMIT;
