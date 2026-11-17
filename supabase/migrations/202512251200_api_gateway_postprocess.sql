-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: API gateway outbound response post-processing (shipments + geocoding + labels)
-- Purpose:
--   - Attach internal processing to gateway-originated outbound_calls using route policy (row-driven).
--   - Materialize recipients/addresses/shipments and enqueue geocoding + label jobs without affecting client response shape.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-------------------------------------------------------------------------------
-- Helper: materialize an address from gateway request body using extract config.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.api_gateway_materialize_address_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_request_body JSONB,
  p_extract JSONB,
  p_kind TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_kind TEXT := COALESCE(NULLIF(lower(p_kind), ''), '');
  v_extract JSONB := COALESCE(p_extract, '{}'::jsonb);
  v_body JSONB := COALESCE(p_request_body, '{}'::jsonb);

  v_line1 TEXT;
  v_line2 TEXT;
  v_city TEXT;
  v_province TEXT;
  v_district TEXT;
  v_country TEXT;
  v_postal TEXT;
  v_lat NUMERIC;
  v_lng NUMERIC;

  v_raw JSONB;
  v_address_id UUID;
  v_key TEXT;
BEGIN
  IF p_organization_id IS NULL OR p_client_id IS NULL THEN
    RETURN jsonb_build_object('created', FALSE, 'reason', 'scope_missing');
  END IF;

  IF v_kind NOT IN ('origin', 'destination') THEN
    RETURN jsonb_build_object('created', FALSE, 'reason', 'invalid_kind');
  END IF;

  v_key := v_kind || '_line1_path';
  v_line1 := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_line2_path';
  v_line2 := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_city_path';
  v_city := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_province_path';
  v_province := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_district_path';
  v_district := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_country_path';
  v_country := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);
  v_key := v_kind || '_postal_path';
  v_postal := workflow_handlers.resolve_path_text(v_body, v_extract->>v_key);

  v_key := v_kind || '_lat_path';
  BEGIN
    v_lat := NULLIF(workflow_handlers.resolve_path_text(v_body, v_extract->>v_key), '')::NUMERIC;
  EXCEPTION
    WHEN others THEN
      v_lat := NULL;
  END;

  v_key := v_kind || '_lng_path';
  BEGIN
    v_lng := NULLIF(workflow_handlers.resolve_path_text(v_body, v_extract->>v_key), '')::NUMERIC;
  EXCEPTION
    WHEN others THEN
      v_lng := NULL;
  END;

  v_country := COALESCE(NULLIF(v_country, ''), 'SA');
  v_city := COALESCE(NULLIF(v_city, ''), 'unknown');
  v_province := COALESCE(NULLIF(v_province, ''), 'unknown');
  v_line1 := NULLIF(v_line1, '');
  v_line2 := NULLIF(v_line2, '');
  v_district := NULLIF(v_district, '');
  v_postal := NULLIF(v_postal, '');

  v_raw := jsonb_strip_nulls(jsonb_build_object(
    'kind', v_kind,
    'line1', v_line1,
    'line2', v_line2,
    'district', v_district,
    'city', v_city,
    'province', v_province,
    'country', v_country,
    'postal_code', v_postal,
    'provided_coordinates', CASE
      WHEN v_lat IS NOT NULL AND v_lng IS NOT NULL
           AND v_lat BETWEEN -90 AND 90
           AND v_lng BETWEEN -180 AND 180 THEN jsonb_build_object('latitude', v_lat, 'longitude', v_lng)
      ELSE NULL
    END
  ));

  INSERT INTO public.addresses (
    id,
    organization_id,
    client_id,
    raw_input,
    normalized_line1,
    normalized_line2,
    district,
    city,
    province,
    postal_code,
    country,
    line1,
    line2,
    validation_status,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    p_organization_id,
    p_client_id,
    COALESCE(v_raw, '{}'::jsonb)::TEXT,
    v_line1,
    v_line2,
    v_district,
    v_city,
    v_province,
    v_postal,
    v_country,
    v_line1,
    v_line2,
    'pending',
    now(),
    now()
  )
  RETURNING id INTO v_address_id;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'created', TRUE,
    'address_id', v_address_id,
    'provided_coordinates', v_raw->'provided_coordinates'
  ));
END;
$$;

COMMENT ON FUNCTION workflow_handlers.api_gateway_materialize_address_v1(UUID, UUID, JSONB, JSONB, TEXT)
  IS 'Materialize an addresses row from API gateway request JSON using extract config; returns address_id + provided_coordinates.';

-------------------------------------------------------------------------------
-- Handler: gateway outbound response processing (policy-driven)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.process_api_gateway_outbound_response_v1(
  p_job public.outbound_calls,
  p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_result JSONB := jsonb_build_object('handled', FALSE, 'handler', 'api_gateway');

  v_request_id UUID;
  v_request public.api_gateway_requests%ROWTYPE;
  v_route public.api_routes%ROWTYPE;
  v_policy JSONB;
  v_post JSONB;
  v_mode TEXT;
  v_extract JSONB;

  v_org UUID;
  v_client UUID;
  v_sender UUID;
  v_request_body JSONB;

  v_recipient_name TEXT;
  v_recipient_phone TEXT;
  v_client_reference TEXT;
  v_recipient_id UUID;

  v_origin JSONB;
  v_destination JSONB;
  v_origin_address_id UUID;
  v_destination_address_id UUID;

  v_provider_shipment_id TEXT;
  v_provider_reference_id TEXT;
  v_tracking_number TEXT;

  v_service_type TEXT;
  v_shipment_status TEXT;
  v_shipment_id UUID;

  v_label_enabled BOOLEAN;
  v_label_type TEXT;
  v_label_job_id UUID;

  v_geocode_enabled BOOLEAN;
  v_geocode_template_name TEXT;
  v_geocode_template_id UUID;
  v_geocode_run_id UUID;
BEGIN
  -- Ensure RLS access for internal tables + label helpers.
  EXECUTE 'SET LOCAL ROLE service_role';

  BEGIN
    v_request_id := NULLIF(p_job.context->>'api_gateway_request_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_request_id := NULL;
  END;

  IF v_request_id IS NULL THEN
    RETURN v_result;
  END IF;

  SELECT * INTO v_request
  FROM public.api_gateway_requests
  WHERE id = v_request_id;

  IF NOT FOUND THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'request_not_found');
  END IF;

  SELECT * INTO v_route
  FROM public.api_routes
  WHERE id = v_request.route_id;

  IF NOT FOUND THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'route_not_found');
  END IF;

  v_policy := COALESCE(v_route.policy, '{}'::jsonb);
  v_post := COALESCE(v_policy->'postprocess', '{}'::jsonb);

  IF COALESCE((v_post->>'enabled')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'postprocess_disabled');
  END IF;

  v_mode := COALESCE(NULLIF(v_post->>'mode', ''), '');
  IF v_mode <> 'shipment_create_v1' THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'unsupported_mode', 'mode', v_mode);
  END IF;

  v_org := v_request.organization_id;
  v_client := v_request.client_id;
  v_sender := v_request.sender_id;
  v_request_body := COALESCE(p_job.body, v_request.request_body, '{}'::jsonb);
  v_extract := COALESCE(v_post->'extract', '{}'::jsonb);

  v_recipient_name := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'recipient_name_path');
  v_recipient_phone := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'recipient_phone_path');
  v_client_reference := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'client_reference_path');

  v_provider_shipment_id := workflow_handlers.resolve_path_text(p_response, v_extract->>'provider_shipment_id_path');
  v_provider_reference_id := workflow_handlers.resolve_path_text(p_response, v_extract->>'provider_reference_id_path');
  v_tracking_number := workflow_handlers.resolve_path_text(p_response, v_extract->>'provider_tracking_number_path');

  IF v_tracking_number IS NULL OR btrim(v_tracking_number) = '' THEN
    v_tracking_number := v_provider_shipment_id;
  END IF;

  v_service_type := COALESCE(NULLIF(v_post->>'service_type', ''), 'delivery');
  v_shipment_status := COALESCE(NULLIF(v_post->>'shipment_status', ''), 'pending');

  IF v_org IS NULL OR v_client IS NULL OR v_tracking_number IS NULL OR btrim(v_tracking_number) = '' THEN
    RETURN v_result || jsonb_build_object(
      'handled', TRUE,
      'postprocess', jsonb_build_object('status', 'skipped', 'reason', 'missing_scope_or_tracking')
    );
  END IF;

  -- Upsert recipient by (client_id, phone_number) best-effort.
  IF v_recipient_phone IS NOT NULL AND btrim(v_recipient_phone) <> '' THEN
    SELECT id INTO v_recipient_id
    FROM public.recipients
    WHERE client_id = v_client
      AND phone_number = v_recipient_phone
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF v_recipient_id IS NULL THEN
    INSERT INTO public.recipients (
      organization_id,
      client_id,
      name,
      phone_number,
      preferred_language,
      created_at,
      updated_at
    ) VALUES (
      v_org,
      v_client,
      COALESCE(NULLIF(v_recipient_name, ''), 'Unknown'),
      COALESCE(NULLIF(v_recipient_phone, ''), 'unknown'),
      'en',
      now(),
      now()
    )
    RETURNING id INTO v_recipient_id;
  ELSE
    UPDATE public.recipients
    SET name = COALESCE(NULLIF(v_recipient_name, ''), name),
        updated_at = now()
    WHERE id = v_recipient_id;
  END IF;

  v_origin := workflow_handlers.api_gateway_materialize_address_v1(v_org, v_client, v_request_body, v_extract, 'origin');
  v_destination := workflow_handlers.api_gateway_materialize_address_v1(v_org, v_client, v_request_body, v_extract, 'destination');

  BEGIN
    v_origin_address_id := NULLIF(v_origin->>'address_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_origin_address_id := NULL;
  END;
  BEGIN
    v_destination_address_id := NULLIF(v_destination->>'address_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_destination_address_id := NULL;
  END;

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    carrier_reference_number,
    client_reference_number,
    recipient_id,
    destination_address_id,
    origin_address_id,
    status,
    status_updated_at,
    metadata,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    v_org,
    v_client,
    v_sender,
    v_service_type,
    v_tracking_number,
    COALESCE(NULLIF(v_provider_reference_id, ''), NULLIF(v_provider_shipment_id, '')),
    NULLIF(v_client_reference, ''),
    v_recipient_id,
    v_destination_address_id,
    v_origin_address_id,
    v_shipment_status,
    now(),
    jsonb_strip_nulls(jsonb_build_object(
      'source', jsonb_strip_nulls(jsonb_build_object(
        'type', 'api_gateway',
        'api_gateway_request_id', v_request_id,
        'route_id', v_route.id
      )),
      'provider', jsonb_strip_nulls(jsonb_build_object(
        'name', (SELECT name FROM public.providers WHERE id = p_job.target_id),
        'shipment_id', v_provider_shipment_id,
        'reference_id', v_provider_reference_id
      ))
    )),
    now(),
    now()
  )
  ON CONFLICT (tracking_number, client_id) DO UPDATE
  SET carrier_reference_number = COALESCE(EXCLUDED.carrier_reference_number, public.shipments.carrier_reference_number),
      client_reference_number = COALESCE(EXCLUDED.client_reference_number, public.shipments.client_reference_number),
      recipient_id = COALESCE(EXCLUDED.recipient_id, public.shipments.recipient_id),
      destination_address_id = COALESCE(EXCLUDED.destination_address_id, public.shipments.destination_address_id),
      origin_address_id = COALESCE(EXCLUDED.origin_address_id, public.shipments.origin_address_id),
      sender_id = COALESCE(EXCLUDED.sender_id, public.shipments.sender_id),
      status = COALESCE(NULLIF(public.shipments.status, ''), EXCLUDED.status),
      status_updated_at = now(),
      metadata = COALESCE(public.shipments.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
      updated_at = now()
  RETURNING id INTO v_shipment_id;

  -- Optional: start geocoding workflows for the destination (and origin if present) based on policy.
  v_geocode_enabled := COALESCE((v_post->'geocoding'->>'enabled')::BOOLEAN, FALSE);
  v_geocode_template_name := NULLIF(v_post->'geocoding'->>'workflow_template_name', '');
  IF v_geocode_enabled AND v_geocode_template_name IS NOT NULL THEN
    SELECT id INTO v_geocode_template_id
    FROM public.workflow_templates
    WHERE name = v_geocode_template_name
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1;

    IF v_geocode_template_id IS NOT NULL AND v_destination_address_id IS NOT NULL THEN
      v_geocode_run_id := public.start_workflow_run(
        v_geocode_template_id,
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org,
          'client_id', v_client,
          'sender_id', v_sender,
          'address_id', v_destination_address_id,
          'api_gateway_request_id', v_request_id,
          'shipment_id', v_shipment_id,
          'geocoding', jsonb_strip_nulls(jsonb_build_object(
            'provided_coordinates', v_destination->'provided_coordinates'
          ))
        ))
      );
    END IF;

    IF v_geocode_template_id IS NOT NULL AND v_origin_address_id IS NOT NULL THEN
      PERFORM public.start_workflow_run(
        v_geocode_template_id,
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org,
          'client_id', v_client,
          'sender_id', v_sender,
          'address_id', v_origin_address_id,
          'api_gateway_request_id', v_request_id,
          'shipment_id', v_shipment_id,
          'geocoding', jsonb_strip_nulls(jsonb_build_object(
            'provided_coordinates', v_origin->'provided_coordinates'
          ))
        ))
      );
    END IF;
  END IF;

  -- Optional: enqueue label generation.
  v_label_enabled := COALESCE((v_post->'label'->>'enabled')::BOOLEAN, FALSE);
  v_label_type := COALESCE(NULLIF(v_post->'label'->>'label_type', ''), 'shipping');
  IF v_label_enabled AND v_shipment_id IS NOT NULL THEN
    v_label_job_id := public.request_label_generation(
      v_shipment_id,
      v_label_type,
      NULL,
      'api_gateway',
      NULL,
      'primary'
    );
  END IF;

  RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
    'handled', TRUE,
    'postprocess', jsonb_strip_nulls(jsonb_build_object(
      'mode', v_mode,
      'shipment_id', v_shipment_id,
      'recipient_id', v_recipient_id,
      'origin_address_id', v_origin_address_id,
      'destination_address_id', v_destination_address_id,
      'geocoding_workflow_run_id', v_geocode_run_id,
      'label_job_id', v_label_job_id
    ))
  ));
END;
$$;

COMMENT ON FUNCTION workflow_handlers.process_api_gateway_outbound_response_v1(public.outbound_calls, JSONB)
  IS 'API gateway outbound response post-processing based on route policy (materialize shipment + enqueue geocoding/labels).';

-------------------------------------------------------------------------------
-- Wire into the outbound response router
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.process_outbound_response_v1(
    p_job public.outbound_calls,
    p_response JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_result JSONB := jsonb_build_object('handled', FALSE);
    v_template_id UUID;
    v_template public.operation_templates%ROWTYPE;
BEGIN
    -- API gateway: post-process provider_api calls linked to api_gateway_requests.
    IF p_job.context ? 'api_gateway_request_id' THEN
        RETURN workflow_handlers.process_api_gateway_outbound_response_v1(p_job, p_response);
    END IF;

    -- Comms first: call_type drives comms handling (independent of operation_name).
    IF p_job.call_type IN ('comms_whatsapp', 'comms_sms', 'comms_email', 'comms_voice') THEN
        v_template_id := NULLIF(p_job.context->>'operation_template_id', '')::UUID;
        IF v_template_id IS NOT NULL THEN
            SELECT * INTO v_template
              FROM public.operation_templates
             WHERE id = v_template_id;
        END IF;

        IF v_template.id IS NULL THEN
            -- Best-effort fallback to provider-scoped template for response mapping.
            SELECT * INTO v_template
              FROM public.operation_templates ot
             WHERE ot.provider_id = p_job.target_id
               AND ot.call_type = p_job.call_type
             ORDER BY ot.updated_at DESC
             LIMIT 1;
        END IF;

        RETURN workflow_handlers.process_comms_outbound_response_v1(p_job, v_template, p_response);
    END IF;

    -- Geocoding (and any other future outbound response handlers) are routed through the
    -- dedicated geocoding handler, which returns handled=false for non-geocoding jobs.
    RETURN workflow_handlers.process_geocoding_outbound_response_v1(p_job, p_response);
END;
$$;

COMMIT;
