BEGIN;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.shipment_boxes
  ALTER COLUMN status SET DEFAULT 'pending';

COMMIT;
