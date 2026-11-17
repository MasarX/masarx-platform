-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Fix Logestechs V2 create-shipment postprocess extract paths
-- Purpose:
--   - Ensure gateway postprocess can extract provider shipment id + tracking from Logestechs V2 responses.
--   - Keep behavior row-driven (route policy only) and avoid any per-endpoint code changes.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_pack_id UUID;
BEGIN
  SELECT id INTO v_pack_id
  FROM public.api_route_packs
  WHERE name = 'logestechs_v2_mirror'
  LIMIT 1;

  IF v_pack_id IS NULL THEN
    RAISE NOTICE 'logestechs_v2_mirror pack not found; skipping extract paths fix';
    RETURN;
  END IF;

  -- Logestechs create shipment response (current observed shape) returns shipment id at root `id`
  -- and tracking at root `barcode`. Keep backward-compat fallbacks for any `{ data: ... }` wrappers.
  UPDATE public.api_routes
  SET policy = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(policy, '{}'::jsonb),
          '{postprocess,extract,provider_shipment_id_path}',
          to_jsonb('id|data.shipmentId|data.shipment_id'::text),
          TRUE
        ),
        '{postprocess,extract,provider_reference_id_path}',
        to_jsonb('barcode|id|data.orderId|data.order_id'::text),
        TRUE
      ),
      '{postprocess,extract,provider_tracking_number_path}',
      to_jsonb('barcode|trackingNumber|tracking_number|data.trackingNumber|data.tracking_number|id|data.shipmentId|data.shipment_id'::text),
      TRUE
    ),
    updated_at = now()
  WHERE pack_id = v_pack_id
    AND enabled = TRUE
    AND upper(method) = 'POST'
    AND path_template = '/api/ship/request/by-email'
    AND jsonb_typeof(policy #> '{postprocess}') = 'object'
    AND jsonb_typeof(policy #> '{postprocess,extract}') = 'object';
END;
$$;

COMMIT;
