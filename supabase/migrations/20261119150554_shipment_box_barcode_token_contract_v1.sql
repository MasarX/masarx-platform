BEGIN;

SET LOCAL lock_timeout = '30s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('20261119150554_shipment_box_barcode_token_contract_v1')
);

-- Accept only the receiving function body, with either newline format.
DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc
    WHERE oid = pg_catalog.to_regprocedure('public.ensure_shipment_boxes(uuid,integer)')
      AND prosecdef
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(prosrc, E'\r\n', E'\n'), 'UTF8')),
        'hex'
      ) = '044e1a5bbf6c6196f9b3b74d9c1e14350364ed7ec1eae355255c96fc50a416ef'
  ) THEN
    RAISE EXCEPTION 'Shipment box barcode update requires the exact current ensure_shipment_boxes definition';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.normalize_shipment_box_barcode_token(
  p_value TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT CASE
    WHEN p_value ~ '^[A-Za-z0-9][A-Za-z0-9-]*$' THEN p_value
  END;
$function$;

REVOKE ALL ON FUNCTION public.normalize_shipment_box_barcode_token(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_shipment_box_barcode_token(TEXT) TO service_role;

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
  v_tracking_token TEXT;
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

  v_tracking_token := public.normalize_shipment_box_barcode_token(v_shipment.tracking_number);
  IF v_tracking_token IS NULL THEN
    RAISE EXCEPTION 'Shipment tracking number must be a valid barcode token' USING ERRCODE = '23514';
  END IF;

  v_expected_count := COALESCE(NULLIF(p_box_count, 0), v_shipment.box_count, 1);
  IF v_expected_count < 1 THEN
    v_expected_count := 1;
  END IF;

  RETURN QUERY
  WITH desired AS (
    SELECT
      gs::int AS box_number,
      format('%s:%s', v_tracking_token, gs::int) AS barcode
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
  'Ensures canonical shipment boxes and returns new and existing rows, preserving the case and hyphens of valid shipment tracking numbers.';

COMMIT;
