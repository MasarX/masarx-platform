-- Plan: PLAN-202602-prega-data-rebaseline-reset / Step: S95
-- Migration: Reconcile canonical Logestechs V2 API gateway rows after pre-GA rebaseline resets
-- Purpose:
--   - Ensure canonical (non-test) Logestechs V2 provider + route pack/route config exists.
--   - Keep row-driven behavior deterministic when historical fixture-era seeds are absent.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Canonical enum mappings consumed by postprocess extract (provider -> canonical).
INSERT INTO public.field_mappings (
  mapping_domain,
  provider_name,
  direction,
  provider_value,
  canonical_value
)
VALUES
  ('service_type', 'logestechs_3pl', 'inbound', 'COD', 'delivery'),
  ('service_type', 'logestechs_3pl', 'inbound', 'REGULAR', 'delivery'),
  ('service_type', 'logestechs_3pl', 'inbound', 'SWAP', 'swap'),
  ('service_type', 'logestechs_3pl', 'inbound', 'BRING', 'pickup'),
  ('service_level', 'logestechs_3pl', 'inbound', 'STANDARD', 'standard')
ON CONFLICT (mapping_domain, provider_name, direction, provider_value) DO UPDATE
SET canonical_value = EXCLUDED.canonical_value,
    updated_at = now();

DO $$
DECLARE
  v_org_id UUID;
  v_provider_id UUID;
  v_pack_id UUID;
BEGIN
  SELECT p.organization_id INTO v_org_id
  FROM public.providers p
  WHERE p.organization_id IS NOT NULL
  ORDER BY p.created_at ASC
  LIMIT 1;

  IF v_org_id IS NULL THEN
    SELECT o.id INTO v_org_id
    FROM public.organizations o
    ORDER BY o.created_at ASC
    LIMIT 1;
  END IF;

  IF v_org_id IS NULL THEN
    RAISE NOTICE 'No organization row available; skipping Logestechs V2 canonical route reconcile.';
    RETURN;
  END IF;

  SELECT p.id INTO v_provider_id
  FROM public.providers p
  WHERE p.name = 'logestechs_3pl'
  ORDER BY p.created_at DESC
  LIMIT 1;

  IF v_provider_id IS NULL THEN
    INSERT INTO public.providers (
      organization_id,
      name,
      provider_type,
      enabled,
      priority_rank,
      health_status,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      v_org_id,
      'logestechs_3pl',
      '3pl',
      TRUE,
      100,
      'healthy',
      jsonb_build_object(
        'base_url', 'https://apisv2.logestechs.com',
        'company_id', '362'
      ),
      now(),
      now()
    )
    RETURNING id INTO v_provider_id;
  ELSE
    UPDATE public.providers
    SET enabled = TRUE,
        provider_type = '3pl',
        metadata = jsonb_strip_nulls(
          COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object(
            'base_url', 'https://apisv2.logestechs.com',
            'company_id', '362'
          )
        ),
        updated_at = now()
    WHERE id = v_provider_id;
  END IF;

  INSERT INTO public.api_route_packs (
    name,
    description,
    enabled,
    created_at,
    updated_at
  )
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

  -- Create shipment route with full canonical policy.
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
      'delivery', jsonb_build_object(
        'mode', 'accepted_async',
        'status_code', 202,
        'headers', jsonb_build_object('content-type', 'application/json')
      ),
      'auth', jsonb_build_object(
        'mode', 'body_fields',
        'auth_type', 'basic_auth',
        'fields', jsonb_build_object(
          'email', 'username',
          'password', 'password'
        )
      ),
      'workflow', jsonb_build_object(
        'enabled', TRUE,
        'template_name', 'api_gateway_logestechs_v2_create_geocode_first_v1'
      ),
      'provider_account', jsonb_build_object(
        'category', 'logestechs_v2_account',
        'required', TRUE,
        'require_company_id', TRUE,
        'require_auth_config_id', TRUE
      ),
      'headers', jsonb_build_object(
        'defaults', '{}'::jsonb,
        'overrides', jsonb_build_object(
          'company-id', '{{provider_account.company_id}}'
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
          'provider_shipment_id_path', 'id|data.shipmentId|data.shipment_id',
          'provider_reference_id_path', 'barcode|id|data.orderId|data.order_id',
          'provider_tracking_number_path', 'barcode|trackingNumber|tracking_number|data.trackingNumber|data.tracking_number|id|data.shipmentId|data.shipment_id',
          'service_type_path', 'pkg.shipmentType',
          'service_level_path', 'pkg.serviceType',
          'cod_amount_path', 'pkg.toCollectFromReceiver|pkg.cod',
          'box_count_path', 'pkg.quantity',
          'special_instructions_path', 'pkg.notes',
          'promised_delivery_date_path', 'expectedDeliveryDate|data.expectedDeliveryDate',
          'origin_raw_path', 'originAddress',
          'destination_raw_path', 'destinationAddress',
          'origin_short_code_path', 'originAddress.nationalAddress',
          'destination_short_code_path', 'destinationAddress.nationalAddress'
        ),
        'geocoding', jsonb_build_object('enabled', FALSE),
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
    SET pack_id = EXCLUDED.pack_id,
        route_name = EXCLUDED.route_name,
        enabled = EXCLUDED.enabled,
        provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = public.jsonb_deep_merge(COALESCE(public.api_routes.policy, '{}'::jsonb), EXCLUDED.policy),
        updated_at = now();

  -- Keep cancel route canonical and postprocess-enabled.
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
      ),
      'postprocess', jsonb_build_object(
        'enabled', TRUE,
        'mode', 'shipment_cancel_v1',
        'shipment_status', 'cancelled',
        'shipment_id_param', 'shipmentId'
      )
    ),
    now(),
    now()
  )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
    SET pack_id = EXCLUDED.pack_id,
        route_name = EXCLUDED.route_name,
        enabled = EXCLUDED.enabled,
        provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = public.jsonb_deep_merge(COALESCE(public.api_routes.policy, '{}'::jsonb), EXCLUDED.policy),
        updated_at = now();

  -- Print AWB (PDF).
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
    SET pack_id = EXCLUDED.pack_id,
        route_name = EXCLUDED.route_name,
        enabled = EXCLUDED.enabled,
        provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = public.jsonb_deep_merge(COALESCE(public.api_routes.policy, '{}'::jsonb), EXCLUDED.policy),
        updated_at = now();

  -- Login by email.
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
    SET pack_id = EXCLUDED.pack_id,
        route_name = EXCLUDED.route_name,
        enabled = EXCLUDED.enabled,
        provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = public.jsonb_deep_merge(COALESCE(public.api_routes.policy, '{}'::jsonb), EXCLUDED.policy),
        updated_at = now();

  -- Read mirror routes.
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
  VALUES
    (
      v_pack_id,
      'logestechs_v2_get_villages',
      TRUE,
      'GET',
      '/api/addresses/villages',
      'global',
      NULL,
      v_provider_id,
      'GET',
      '/api/addresses/villages',
      jsonb_build_object(
        'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30),
        'postprocess', jsonb_build_object('enabled', FALSE)
      ),
      now(),
      now()
    ),
    (
      v_pack_id,
      'logestechs_v2_get_package_status',
      TRUE,
      'GET',
      '/api/guests/packages/status',
      'global',
      NULL,
      v_provider_id,
      'GET',
      '/api/guests/packages/status',
      jsonb_build_object(
        'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30),
        'postprocess', jsonb_build_object('enabled', FALSE)
      ),
      now(),
      now()
    ),
    (
      v_pack_id,
      'logestechs_v2_get_company_info_by_domain',
      TRUE,
      'GET',
      '/api/guests/companies/info-by-domain',
      'global',
      NULL,
      v_provider_id,
      'GET',
      '/api/guests/companies/info-by-domain',
      jsonb_build_object(
        'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30),
        'postprocess', jsonb_build_object('enabled', FALSE)
      ),
      now(),
      now()
    ),
    (
      v_pack_id,
      'logestechs_v2_get_packages_tracking',
      TRUE,
      'GET',
      '/api/guests/{companyId}/packages/tracking',
      'global',
      NULL,
      v_provider_id,
      'GET',
      '/api/guests/{companyId}/packages/tracking',
      jsonb_build_object(
        'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30),
        'postprocess', jsonb_build_object('enabled', FALSE)
      ),
      now(),
      now()
    )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
    SET pack_id = EXCLUDED.pack_id,
        route_name = EXCLUDED.route_name,
        enabled = EXCLUDED.enabled,
        provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = public.jsonb_deep_merge(COALESCE(public.api_routes.policy, '{}'::jsonb), EXCLUDED.policy),
        updated_at = now();

  -- Re-apply canonical policy contract across all enabled mirror routes.
  UPDATE public.api_routes r
  SET provider_id = v_provider_id,
      policy = jsonb_set(
        jsonb_set(
          COALESCE(r.policy, '{}'::jsonb),
          '{provider_account}',
          (
            CASE
              WHEN jsonb_typeof(r.policy->'provider_account') = 'object'
                THEN COALESCE(r.policy->'provider_account', '{}'::jsonb)
              ELSE '{}'::jsonb
            END
          ) || jsonb_build_object(
            'category', 'logestechs_v2_account',
            'required', TRUE,
            'require_company_id', TRUE,
            'require_auth_config_id', TRUE
          ),
          TRUE
        ),
        '{headers}',
        (
          CASE
            WHEN jsonb_typeof(r.policy->'headers') = 'object'
              THEN COALESCE(r.policy->'headers', '{}'::jsonb)
            ELSE '{}'::jsonb
          END
        ) || jsonb_build_object(
          'defaults',
          CASE
            WHEN jsonb_typeof(r.policy #> '{headers,defaults}') = 'object'
              THEN (r.policy #> '{headers,defaults}') - 'company-id'
            ELSE '{}'::jsonb
          END,
          'overrides',
          (
            CASE
              WHEN jsonb_typeof(r.policy #> '{headers,overrides}') = 'object'
                THEN COALESCE(r.policy #> '{headers,overrides}', '{}'::jsonb)
              ELSE '{}'::jsonb
            END
          ) || jsonb_build_object('company-id', '{{provider_account.company_id}}')
        ),
        TRUE
      ),
      updated_at = now()
  WHERE r.pack_id = v_pack_id
    AND r.enabled = TRUE;
END;
$$;

COMMIT;
