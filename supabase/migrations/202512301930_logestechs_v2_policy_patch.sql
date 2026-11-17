-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- Migration: Logestechs V2 mirror policy patch (types/COD/service time)
-- Purpose:
--   - Keep API gateway behavior row-driven by extending route policy extract paths (no hardcoding in SQL).
--   - Seed SSOT field_mappings for Logestechs V2 enums (shipmentType/serviceType).
-- Date: 2025-12-30

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- 1) Field mappings (SSOT): Logestechs V2 enums -> canonical
-- -----------------------------------------------------------------------------

INSERT INTO public.field_mappings (
  mapping_domain,
  provider_name,
  direction,
  provider_value,
  canonical_value
)
VALUES
  -- Logestechs pkg.shipmentType -> MasarX shipments.service_type (lookup category: service_type)
  ('service_type', 'logestechs_3pl', 'inbound', 'COD', 'delivery'),
  ('service_type', 'logestechs_3pl', 'inbound', 'REGULAR', 'delivery'),
  ('service_type', 'logestechs_3pl', 'inbound', 'SWAP', 'swap'),
  ('service_type', 'logestechs_3pl', 'inbound', 'BRING', 'pickup'),

  -- Logestechs pkg.serviceType -> MasarX shipments.service_level (lookup category: service_level)
  ('service_level', 'logestechs_3pl', 'inbound', 'STANDARD', 'standard')
ON CONFLICT (mapping_domain, provider_name, direction, provider_value) DO UPDATE
SET canonical_value = EXCLUDED.canonical_value,
    updated_at = now();

-- -----------------------------------------------------------------------------
-- 2) API gateway route patch: extend postprocess extract paths + enable cancel postprocess
-- -----------------------------------------------------------------------------

DO $do$
DECLARE
  v_pack_id UUID;
BEGIN
  SELECT id INTO v_pack_id
  FROM public.api_route_packs
  WHERE name = 'logestechs_v2_mirror'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_pack_id IS NULL THEN
    RAISE NOTICE 'logestechs_v2_mirror pack missing; skipping Logestechs V2 policy patch';
    RETURN;
  END IF;

  -- Create shipment: add missing extract paths (request + response).
  UPDATE public.api_routes r
  SET policy = public.jsonb_deep_merge(
        COALESCE(r.policy, '{}'::jsonb),
        jsonb_build_object(
          'postprocess', jsonb_build_object(
            'extract', jsonb_build_object(
              'service_type_path', 'pkg.shipmentType',
              'service_level_path', 'pkg.serviceType',
              'cod_amount_path', 'pkg.toCollectFromReceiver|pkg.cod',
              'box_count_path', 'pkg.quantity',
              'special_instructions_path', 'pkg.notes',
              'promised_delivery_date_path', 'expectedDeliveryDate|data.expectedDeliveryDate',
              'origin_raw_path', 'originAddress',
              'destination_raw_path', 'destinationAddress'
            )
          )
        )
      ),
      updated_at = now()
  WHERE r.pack_id = v_pack_id
    AND upper(r.method) = 'POST'
    AND r.path_template = '/api/ship/request/by-email'
    AND r.scope_type = 'global'
    AND r.enabled = TRUE;

  -- Cancel shipment: enable postprocess (status update + optional client webhook).
  UPDATE public.api_routes r
  SET policy = public.jsonb_deep_merge(
        COALESCE(r.policy, '{}'::jsonb),
        jsonb_build_object(
          'postprocess', jsonb_build_object(
            'enabled', TRUE,
            'mode', 'shipment_cancel_v1',
            'shipment_status', 'cancelled',
            'shipment_id_param', 'shipmentId'
          )
        )
      ),
      updated_at = now()
  WHERE r.pack_id = v_pack_id
    AND upper(r.method) = 'PUT'
    AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}/cancel'
    AND r.scope_type = 'global'
    AND r.enabled = TRUE;
END;
$do$;

COMMIT;

