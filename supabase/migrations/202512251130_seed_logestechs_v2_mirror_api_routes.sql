-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Seed Logestechs V2 mirror route pack (API gateway)
-- Purpose:
--   - Provide an initial mirror pack so clients can switch base URL to MasarX and keep Logestechs-style paths.
--   - All behavior remains row-driven (routes + policy JSON).
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_pack_id UUID;
  v_provider_id UUID;
BEGIN
  SELECT id INTO v_provider_id
  FROM public.providers
  WHERE name = 'logestechs_3pl'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_provider_id IS NULL THEN
    RAISE NOTICE 'logestechs_3pl provider not found; skipping Logestechs V2 mirror route seed';
    RETURN;
  END IF;

  INSERT INTO public.api_route_packs (name, description, enabled, created_at, updated_at)
  VALUES (
    'logestechs_v2_mirror',
    'Mirror Logestechs V2 endpoints (client-facing compatibility pack).',
    TRUE,
    now(),
    now()
  )
  ON CONFLICT (name) DO UPDATE
    SET description = EXCLUDED.description,
        enabled = EXCLUDED.enabled,
        updated_at = now()
  RETURNING id INTO v_pack_id;

  -- Create shipment (Logestechs V2)
  INSERT INTO public.api_routes (
    pack_id,
    route_name,
    enabled,
    method,
    path_template,
    scope_type,
    scope_id,
    provider_id,
    upstream_method,
    upstream_path_template,
    policy,
    created_at,
    updated_at
  )
  VALUES (
    v_pack_id,
    'logestechs_v2_create_shipment_by_email',
    TRUE,
    'POST',
    '/api/ship/request/by-email',
    'global',
    NULL,
    v_provider_id,
    'POST',
    '/api/ship/request/by-email',
    jsonb_build_object(
      'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 60),
      'auth', jsonb_build_object(
        'mode', 'body_fields',
        'auth_type', 'basic_auth',
        'fields', jsonb_build_object(
          'email', 'username',
          'password', 'password'
        )
      ),
      'postprocess', jsonb_build_object(
        'enabled', TRUE,
        'mode', 'shipment_create_v1',
        'service_type', 'delivery',
        'shipment_status', 'pending',
        'extract', jsonb_build_object(
          'recipient_name_path', 'pkg.receiverName',
          'recipient_phone_path', 'pkg.receiverPhone|pkg.receiverPhone2',
          'client_reference_path', 'pkg.invoiceNumber|pkg.supplierInvoice',

          'origin_line1_path', 'originAddress.addressLine1|originAddress.street',
          'origin_line2_path', 'originAddress.addressLine2',
          'origin_city_path', 'originAddress.city|originAddress.arabicCityName',
          'origin_province_path', 'originAddress.region|originAddress.arabicRegionName',
          'origin_district_path', 'originAddress.district',
          'origin_country_path', 'originAddress.country',
          'origin_postal_path', 'originAddress.zipCode',
          'origin_lat_path', 'originAddress.latitude',
          'origin_lng_path', 'originAddress.longitude',

          'destination_line1_path', 'destinationAddress.addressLine1|destinationAddress.street',
          'destination_line2_path', 'destinationAddress.addressLine2',
          'destination_city_path', 'destinationAddress.city|destinationAddress.arabicCityName',
          'destination_province_path', 'destinationAddress.region|destinationAddress.arabicRegionName',
          'destination_district_path', 'destinationAddress.district',
          'destination_country_path', 'destinationAddress.country',
          'destination_postal_path', 'destinationAddress.zipCode',
          'destination_lat_path', 'destinationAddress.latitude',
          'destination_lng_path', 'destinationAddress.longitude',

          'provider_shipment_id_path', 'data.shipmentId|data.shipment_id',
          'provider_reference_id_path', 'data.orderId|data.order_id',
          'provider_tracking_number_path', 'data.shipmentId|data.shipment_id'
        ),
        'geocoding', jsonb_build_object(
          'enabled', TRUE,
          'workflow_template_name', 'workflow_geocoding_standard'
        ),
        'label', jsonb_build_object(
          'enabled', TRUE,
          'label_type', 'shipping'
        )
      )
    ),
    now(),
    now()
  )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
    SET provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = EXCLUDED.policy,
        enabled = EXCLUDED.enabled,
        route_name = EXCLUDED.route_name,
        updated_at = now();

  -- Cancel shipment
  INSERT INTO public.api_routes (
    pack_id, route_name, enabled,
    method, path_template,
    scope_type, scope_id,
    provider_id,
    upstream_method,
    upstream_path_template,
    policy,
    created_at, updated_at
  )
  VALUES (
    v_pack_id,
    'logestechs_v2_cancel_package',
    TRUE,
    'PUT',
    '/api/guests/{companyId}/packages/{shipmentId}/cancel',
    'global',
    NULL,
    v_provider_id,
    'PUT',
    '/api/guests/{companyId}/packages/{shipmentId}/cancel',
    jsonb_build_object(
      'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 60),
      'auth', jsonb_build_object(
        'mode', 'body_fields',
        'auth_type', 'basic_auth',
        'fields', jsonb_build_object(
          'email', 'username',
          'password', 'password'
        )
      )
    ),
    now(),
    now()
  )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
    SET provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = EXCLUDED.policy,
        enabled = EXCLUDED.enabled,
        route_name = EXCLUDED.route_name,
        updated_at = now();

  -- Print AWB (PDF) - response may be JSON or binary depending on provider; proxy mode preserves upstream headers/body.
  INSERT INTO public.api_routes (
    pack_id, route_name, enabled,
    method, path_template,
    scope_type, scope_id,
    provider_id,
    upstream_method,
    upstream_path_template,
    policy,
    created_at, updated_at
  )
  VALUES (
    v_pack_id,
    'logestechs_v2_print_packages_pdf',
    TRUE,
    'POST',
    '/api/guests/{companyId}/packages/pdf',
    'global',
    NULL,
    v_provider_id,
    'POST',
    '/api/guests/{companyId}/packages/pdf',
    jsonb_build_object(
      'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 120)
    ),
    now(),
    now()
  )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
    SET provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = EXCLUDED.policy,
        enabled = EXCLUDED.enabled,
        route_name = EXCLUDED.route_name,
        updated_at = now();

  -- Login (optional; clients may not need this if using /ship/request/by-email directly)
  INSERT INTO public.api_routes (
    pack_id, route_name, enabled,
    method, path_template,
    scope_type, scope_id,
    provider_id,
    upstream_method,
    upstream_path_template,
    policy,
    created_at, updated_at
  )
  VALUES (
    v_pack_id,
    'logestechs_v2_login_by_email',
    TRUE,
    'POST',
    '/api/auth/customer/login',
    'global',
    NULL,
    v_provider_id,
    'POST',
    '/api/auth/customer/login',
    jsonb_build_object(
      'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 60),
      'auth', jsonb_build_object(
        'mode', 'body_fields',
        'auth_type', 'basic_auth',
        'fields', jsonb_build_object(
          'email', 'username',
          'password', 'password'
        )
      )
    ),
    now(),
    now()
  )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
    SET provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = EXCLUDED.policy,
        enabled = EXCLUDED.enabled,
        route_name = EXCLUDED.route_name,
        updated_at = now();
END;
$$;

COMMIT;

