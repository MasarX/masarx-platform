-- Allow mixed-case provider/API tracking numbers in canonical box barcodes.
--
-- ensure_shipment_boxes preserves shipments.tracking_number as the tracking
-- segment of shipment_boxes.barcode. Some live intake/proof rows carry
-- mixed-case tracking identifiers, so the constraint must validate the
-- canonical shape without forcing a synthetic uppercase rewrite.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605262205_shipment_box_barcode_mixed_case_tracking_v1'));

SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.shipment_boxes
  DROP CONSTRAINT IF EXISTS shipment_boxes_barcode_format;

ALTER TABLE public.shipment_boxes
  ADD CONSTRAINT shipment_boxes_barcode_format
  CHECK (barcode ~ '^[A-Za-z0-9][A-Za-z0-9-]*:[1-9][0-9]*$');

COMMENT ON COLUMN public.shipment_boxes.barcode IS
  'Box barcode format: {TRACKING_NUMBER}:{BOX_NUMBER}; tracking segment preserves provider/API case and permits letters, digits, and hyphens; box number has no leading zeros.';

COMMENT ON CONSTRAINT shipment_boxes_barcode_format ON public.shipment_boxes IS
  'Enforces {TRACKING_NUMBER}:{BOX_NUMBER}; valid examples: DLX123:1, FT-LIVE-1996D1778794417763:1, Mv2Closeabc123:1; invalid examples: DLX123:001, TESTBOX.';

SELECT pg_advisory_unlock(hashtext('202605262205_shipment_box_barcode_mixed_case_tracking_v1'));

COMMIT;
