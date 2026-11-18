-- Allow provider/API tracking numbers with hyphens in canonical box barcodes.
--
-- API Gateway materializes shipment tracking numbers such as
-- FT-LIVE-1996D1778794417763. ensure_shipment_boxes derives the barcode from
-- the canonical tracking number, so the box barcode contract must allow those
-- provider-facing tracking identifiers instead of forcing a synthetic rewrite.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605142245_shipment_box_barcode_tracking_hyphen_v1'));

SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.shipment_boxes
  DROP CONSTRAINT IF EXISTS shipment_boxes_barcode_format;

ALTER TABLE public.shipment_boxes
  ADD CONSTRAINT shipment_boxes_barcode_format
  CHECK (barcode ~ '^[A-Z0-9][A-Z0-9-]*:[1-9][0-9]*$');

COMMENT ON COLUMN public.shipment_boxes.barcode IS
  'Box barcode format: {TRACKING_NUMBER}:{BOX_NUMBER}; tracking segment permits uppercase letters, digits, and hyphens for API/provider tracking numbers; box number has no leading zeros.';

COMMENT ON CONSTRAINT shipment_boxes_barcode_format ON public.shipment_boxes IS
  'Enforces {TRACKING_NUMBER}:{BOX_NUMBER}; valid examples: DLX123:1, FT-LIVE-1996D1778794417763:1; invalid examples: DLX123:001, TESTBOX.';

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
    ON CONFLICT ON CONSTRAINT shipment_boxes_unique_number DO NOTHING
    RETURNING
      sb.id AS shipment_box_id,
      sb.box_number
  ),
  existing_rows AS (
    SELECT
      sb.id AS shipment_box_id,
      d.box_number
    FROM desired d
    JOIN public.shipment_boxes sb
      ON sb.shipment_id = v_shipment.id
     AND sb.box_number = d.box_number
    WHERE NOT EXISTS (
      SELECT 1
      FROM inserted_rows ir
      WHERE ir.box_number = d.box_number
    )
  ),
  resolved AS (
    SELECT
      ir.shipment_box_id,
      ir.box_number,
      TRUE AS inserted
    FROM inserted_rows ir
    UNION ALL
    SELECT
      er.shipment_box_id,
      er.box_number,
      FALSE AS inserted
    FROM existing_rows er
  )
  SELECT
    r.shipment_box_id,
    r.box_number,
    r.inserted
  FROM resolved r
  ORDER BY r.box_number;
END;
$function$;

COMMENT ON FUNCTION public.ensure_shipment_boxes(UUID, INT) IS
  'Ensures canonical shipment_boxes exist for a shipment and returns both newly inserted rows and existing rows. Barcodes preserve the shipment tracking number, including provider/API hyphens.';

SELECT pg_advisory_unlock(hashtext('202605142245_shipment_box_barcode_tracking_hyphen_v1'));

COMMIT;
