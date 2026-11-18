BEGIN;

SET LOCAL lock_timeout = '30s';

-- Retain the existing service grants on the internal box writer.
REVOKE EXECUTE ON FUNCTION public.ensure_shipment_boxes(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;

COMMIT;
