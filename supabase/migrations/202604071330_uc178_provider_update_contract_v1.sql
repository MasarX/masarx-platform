-- Plan: PLAN-202604-b12-provider-update-closeout / Step: E01
-- Migration: UC178 provider update contract completion
-- Purpose:
--   - Extend the canonical Logestechs V2 compatibility pack with a shipment update route.
--   - Add shipment_update_v1 postprocess handling so provider-side updates can reconcile
--     canonical shipment destination state through the existing API gateway trail.
-- Date: 2026-04-07

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

DO $do$
DECLARE
  v_org_id UUID;
  v_provider_id UUID;
  v_pack_id UUID;
BEGIN
  SELECT p.organization_id
    INTO v_org_id
    FROM public.providers p
   WHERE p.organization_id IS NOT NULL
   ORDER BY p.created_at ASC
   LIMIT 1;

  IF v_org_id IS NULL THEN
    SELECT o.id
      INTO v_org_id
      FROM public.organizations o
     ORDER BY o.created_at ASC
     LIMIT 1;
  END IF;

  IF v_org_id IS NULL THEN
    RAISE NOTICE 'No organization row available; skipping Logestechs V2 provider update reconcile.';
    RETURN;
  END IF;

  SELECT p.id
    INTO v_provider_id
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
    'logestechs_v2_update_package',
    TRUE,
    'PUT',
    '/api/guests/{companyId}/packages/{shipmentId}',
    'global',
    NULL,
    v_provider_id,
    'PUT',
    '/api/guests/{companyId}/packages/{shipmentId}',
    jsonb_build_object(
      'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 60),
      'provider_account', jsonb_build_object(
        'category', 'logestechs_v2_account',
        'required', TRUE,
        'require_company_id', TRUE,
        'require_auth_config_id', TRUE
      ),
      'headers', jsonb_build_object(
        'overrides', jsonb_build_object(
          'company-id', '{{provider_account.company_id}}'
        )
      ),
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
        'mode', 'shipment_update_v1',
        'shipment_id_param', 'shipmentId',
        'extract', jsonb_build_object(
          'destination_line1_path', 'destinationAddress.addressLine1|destinationAddress.street',
          'destination_line2_path', 'destinationAddress.addressLine2',
          'destination_city_path', 'destinationAddress.city|destinationAddress.arabicCityName',
          'destination_province_path', 'destinationAddress.region|destinationAddress.arabicRegionName',
          'destination_district_path', 'destinationAddress.district',
          'destination_country_path', 'destinationAddress.country',
          'destination_postal_path', 'destinationAddress.zipCode',
          'destination_lat_path', 'destinationAddress.latitude',
          'destination_lng_path', 'destinationAddress.longitude',
          'destination_raw_path', 'destinationAddress',
          'destination_short_code_path', 'destinationAddress.nationalAddress'
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
END;
$do$;

CREATE OR REPLACE FUNCTION workflow_handlers.process_api_gateway_shipment_update_v1(
  p_job public.outbound_calls,
  p_response JSONB DEFAULT '{}'::jsonb,
  p_request public.api_gateway_requests DEFAULT NULL,
  p_route public.api_routes DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_result JSONB := jsonb_build_object('handled', FALSE, 'handler', 'api_gateway');
  v_request public.api_gateway_requests := p_request;
  v_route public.api_routes := p_route;
  v_policy JSONB;
  v_post JSONB;
  v_extract JSONB;
  v_mode TEXT;

  v_request_id UUID;
  v_org UUID;
  v_client UUID;
  v_sender UUID;
  v_source UUID;
  v_corr UUID;
  v_request_body JSONB;
  v_path_params JSONB;

  v_provider_id UUID;
  v_provider_name TEXT;
  v_ship_id_param TEXT;
  v_provider_shipment_id TEXT;

  v_destination_line1 TEXT;
  v_destination_city TEXT;
  v_destination_province TEXT;
  v_destination_country TEXT;
  v_destination_raw JSONB;
  v_destination JSONB;
  v_destination_address_id UUID;

  v_shipment_id UUID;
  v_shipment public.shipments%ROWTYPE;
  v_existing_action_id UUID;
  v_existing_request_id TEXT;
  v_action_id UUID;
BEGIN
  BEGIN
    v_request_id := COALESCE(
      p_request.id,
      NULLIF(p_job.context->>'api_gateway_request_id', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_request_id := p_request.id;
  END;

  IF v_request.id IS NULL AND v_request_id IS NOT NULL THEN
    SELECT *
      INTO v_request
      FROM public.api_gateway_requests
     WHERE id = v_request_id;
  END IF;

  IF v_request.id IS NULL THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'request_not_found');
  END IF;

  IF v_route.id IS NULL THEN
    SELECT *
      INTO v_route
      FROM public.api_routes
     WHERE id = v_request.route_id;
  END IF;

  IF v_route.id IS NULL THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'route_not_found');
  END IF;

  v_policy := COALESCE(v_route.policy, '{}'::jsonb);
  v_post := COALESCE(v_policy->'postprocess', '{}'::jsonb);

  IF COALESCE((v_post->>'enabled')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'postprocess_disabled');
  END IF;

  v_mode := COALESCE(NULLIF(v_post->>'mode', ''), '');
  IF v_mode <> 'shipment_update_v1' THEN
    RETURN v_result || jsonb_build_object('handled', FALSE, 'reason', 'postprocess_mode_mismatch', 'mode', v_mode);
  END IF;

  v_org := v_request.organization_id;
  v_client := v_request.client_id;
  v_sender := v_request.sender_id;
  v_source := v_request.source_id;
  v_corr := COALESCE(p_job.correlation_id, v_request.correlation_id);
  v_provider_id := p_job.target_id;
  v_request_body := COALESCE(p_job.body, v_request.request_body, '{}'::jsonb);
  v_extract := COALESCE(v_post->'extract', '{}'::jsonb);
  v_path_params := COALESCE(p_job.context->'api_gateway_path_params', '{}'::jsonb);

  SELECT name
    INTO v_provider_name
    FROM public.providers
   WHERE id = v_provider_id;

  v_ship_id_param := COALESCE(NULLIF(v_post->>'shipment_id_param', ''), 'shipmentId');
  v_provider_shipment_id := NULLIF(btrim(v_path_params->>v_ship_id_param), '');

  IF v_org IS NULL OR v_client IS NULL OR v_provider_shipment_id IS NULL THEN
    RETURN v_result || jsonb_build_object(
      'handled', TRUE,
      'postprocess', jsonb_build_object('mode', v_mode, 'status', 'skipped', 'reason', 'missing_scope_or_shipment_id')
    );
  END IF;

  IF p_job.status IS DISTINCT FROM 'completed'
     OR p_job.response_status_code IS NULL
     OR p_job.response_status_code < 200
     OR p_job.response_status_code > 299 THEN
    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'api_gateway_postprocess',
      p_resource_type := 'api_gateway_request',
      p_resource_id := v_request.id,
      p_decision_point := 'shipment_update_upstream',
      p_decision_outcome := 'skipped',
      p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_update_v1',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id_value', v_provider_shipment_id,
        'upstream_job_status', p_job.status,
        'upstream_response_status_code', p_job.response_status_code
      ))
    );

    RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
      'handled', TRUE,
      'postprocess', jsonb_strip_nulls(jsonb_build_object(
        'mode', v_mode,
        'status', 'skipped',
        'reason', 'upstream_not_successful',
        'upstream_job_status', p_job.status,
        'upstream_response_status_code', p_job.response_status_code
      ))
    ));
  END IF;

  SELECT s.id
    INTO v_shipment_id
    FROM public.shipments s
   WHERE s.client_id = v_client
     AND s.tracking_upper = upper(v_provider_shipment_id)
   LIMIT 1;

  IF v_shipment_id IS NULL THEN
    SELECT srn.shipment_id
      INTO v_shipment_id
      FROM public.shipment_reference_numbers srn
     WHERE srn.client_id = v_client
       AND srn.reference_type = 'logistics_reference_number'
       AND srn.reference_value_upper = upper(v_provider_shipment_id)
     ORDER BY srn.updated_at DESC
     LIMIT 1;
  END IF;

  IF v_shipment_id IS NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'api_gateway_postprocess',
      p_resource_type := 'api_gateway_request',
      p_resource_id := v_request.id,
      p_decision_point := 'shipment_update_lookup',
      p_decision_outcome := 'shipment_not_found',
      p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_update_v1',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'client_id', v_client,
        'shipment_id_value', v_provider_shipment_id
      ))
    );

    RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
      'handled', TRUE,
      'postprocess', jsonb_build_object('mode', v_mode, 'status', 'skipped', 'reason', 'shipment_not_found')
    ));
  END IF;

  SELECT *
    INTO v_shipment
    FROM public.shipments
   WHERE id = v_shipment_id
     AND client_id = v_client
   LIMIT 1;

  IF v_shipment.id IS NULL THEN
    RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
      'handled', TRUE,
      'postprocess', jsonb_build_object('mode', v_mode, 'status', 'skipped', 'reason', 'shipment_not_found')
    ));
  END IF;

  v_existing_request_id := NULLIF(v_shipment.metadata #>> '{provider_update,api_gateway_request_id}', '');

  SELECT sa.id
    INTO v_existing_action_id
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment_id
     AND sa.action_type = 'address_update'
     AND sa.action_category = 'administrative'
     AND sa.action_data->>'idempotency_key' = v_request.id::text
   ORDER BY sa.created_at DESC
   LIMIT 1;

  IF v_existing_action_id IS NOT NULL OR v_existing_request_id = v_request.id::text THEN
    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'api_gateway_postprocess',
      p_resource_type := 'shipment',
      p_resource_id := v_shipment_id,
      p_decision_point := 'shipment_update_apply',
      p_decision_outcome := 'noop',
      p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_update_v1',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'api_gateway_request_id', v_request.id,
        'provider_shipment_id', v_provider_shipment_id,
        'destination_address_id', v_shipment.destination_address_id,
        'shipment_action_id', v_existing_action_id
      )),
      p_decision_reason := 'duplicate_request_id'
    );

    RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
      'handled', TRUE,
      'postprocess', jsonb_strip_nulls(jsonb_build_object(
        'mode', v_mode,
        'shipment_id', v_shipment_id,
        'shipment_action_id', v_existing_action_id,
        'destination_address_id', v_shipment.destination_address_id,
        'status', 'noop',
        'reason', 'duplicate_request_id'
      ))
    ));
  END IF;

  v_destination_line1 := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'destination_line1_path');
  v_destination_city := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'destination_city_path');
  v_destination_province := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'destination_province_path');
  v_destination_country := workflow_handlers.resolve_path_text(v_request_body, v_extract->>'destination_country_path');
  v_destination_raw := public.jsonb_resolve_path(v_request_body, v_extract->>'destination_raw_path');

  IF NULLIF(btrim(COALESCE(v_destination_line1, '')), '') IS NULL
     AND NULLIF(btrim(COALESCE(v_destination_city, '')), '') IS NULL
     AND NULLIF(btrim(COALESCE(v_destination_province, '')), '') IS NULL
     AND NULLIF(btrim(COALESCE(v_destination_country, '')), '') IS NULL
     AND jsonb_typeof(v_destination_raw) NOT IN ('object', 'array') THEN
    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'api_gateway_postprocess',
      p_resource_type := 'api_gateway_request',
      p_resource_id := v_request.id,
      p_decision_point := 'shipment_update_address_extract',
      p_decision_outcome := 'skipped',
      p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_update_v1',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_shipment_id,
        'provider_shipment_id', v_provider_shipment_id
      )),
      p_decision_reason := 'destination_address_missing'
    );

    RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
      'handled', TRUE,
      'postprocess', jsonb_build_object('mode', v_mode, 'shipment_id', v_shipment_id, 'status', 'skipped', 'reason', 'destination_address_missing')
    ));
  END IF;

  v_destination := workflow_handlers.api_gateway_materialize_address_v1(
    v_org,
    v_client,
    v_request_body,
    v_extract,
    'destination'
  );

  BEGIN
    v_destination_address_id := NULLIF(v_destination->>'address_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_destination_address_id := NULL;
  END;

  IF v_destination_address_id IS NULL THEN
    RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
      'handled', TRUE,
      'postprocess', jsonb_build_object('mode', v_mode, 'shipment_id', v_shipment_id, 'status', 'skipped', 'reason', 'destination_address_missing')
    ));
  END IF;

  UPDATE public.shipments
     SET destination_address_id = v_destination_address_id,
         metadata = public.deep_merge_jsonb(
           COALESCE(public.shipments.metadata, '{}'::jsonb),
           jsonb_build_object(
             'provider_update', jsonb_strip_nulls(jsonb_build_object(
               'source', 'api_gateway',
               'api_gateway_request_id', v_request.id,
               'route_id', v_route.id,
               'provider_id', v_provider_id,
               'provider_name', v_provider_name,
               'provider_shipment_id', v_provider_shipment_id,
               'previous_destination_address_id', v_shipment.destination_address_id,
               'destination_address_id', v_destination_address_id,
               'updated_at', now()
             ))
           )
         ),
         updated_at = now()
   WHERE id = v_shipment_id
     AND client_id = v_client;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_shipment_id,
    'address_update',
    'administrative',
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key', v_request.id::text,
      'api_gateway_request_id', v_request.id,
      'route_id', v_route.id,
      'provider_id', v_provider_id,
      'provider_name', v_provider_name,
      'provider_shipment_id', v_provider_shipment_id,
      'path_params', v_path_params,
      'address_id', v_destination_address_id,
      'response', COALESCE(p_response, '{}'::jsonb)
    )),
    NULL,
    NULL,
    'workflow_handlers.process_api_gateway_shipment_update_v1',
    NULL,
    now()
  );

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'api_gateway_postprocess',
    p_resource_type := 'shipment',
    p_resource_id := v_shipment_id,
    p_decision_point := 'shipment_update_apply',
    p_decision_outcome := 'updated',
    p_performed_by_system := 'workflow_handlers.process_api_gateway_shipment_update_v1',
    p_correlation_id := v_corr,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'api_gateway_request_id', v_request.id,
      'provider_shipment_id', v_provider_shipment_id,
      'previous_destination_address_id', v_shipment.destination_address_id,
      'destination_address_id', v_destination_address_id,
      'shipment_action_id', v_action_id
    ))
  );

  RETURN jsonb_strip_nulls(v_result || jsonb_build_object(
    'handled', TRUE,
    'postprocess', jsonb_strip_nulls(jsonb_build_object(
      'mode', v_mode,
      'shipment_id', v_shipment_id,
      'shipment_action_id', v_action_id,
      'destination_address_id', v_destination_address_id,
      'status', 'updated'
    ))
  ));
END;
$function$;

DO $patch$
DECLARE
  v_def TEXT;
  v_start_marker TEXT := E'\n  ---------------------------------------------------------------------------\n  -- Mode: shipment_create_v1\n  ---------------------------------------------------------------------------';
  v_end_marker TEXT := E'\n  ---------------------------------------------------------------------------\n  -- Mode: shipment_cancel_v1\n  ---------------------------------------------------------------------------';
  v_start_pos INT;
  v_end_pos INT;
  v_replacement TEXT := E'\n  ---------------------------------------------------------------------------\n  -- Mode: shipment_create_v1\n  ---------------------------------------------------------------------------\n  IF v_mode = ''shipment_create_v1'' THEN\n    RETURN workflow_handlers.process_api_gateway_shipment_create_v1(\n      p_job,\n      COALESCE(p_response, ''{}''::jsonb),\n      v_request,\n      v_route\n    );\n  END IF;\n\n  ---------------------------------------------------------------------------\n  -- Mode: shipment_update_v1\n  ---------------------------------------------------------------------------\n  IF v_mode = ''shipment_update_v1'' THEN\n    RETURN workflow_handlers.process_api_gateway_shipment_update_v1(\n      p_job,\n      COALESCE(p_response, ''{}''::jsonb),\n      v_request,\n      v_route\n    );\n  END IF;\n';
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_outbound_response_v1(public.outbound_calls, jsonb)'::regprocedure
  ) INTO v_def;

  IF v_def IS NULL OR v_def = '' THEN
    RAISE EXCEPTION 'process_api_gateway_outbound_response_v1 function definition not found';
  END IF;

  v_start_pos := strpos(v_def, v_start_marker);
  v_end_pos := strpos(v_def, v_end_marker);

  IF v_start_pos = 0 OR v_end_pos = 0 OR v_end_pos <= v_start_pos THEN
    RAISE EXCEPTION 'Failed to locate shipment_create block in process_api_gateway_outbound_response_v1';
  END IF;

  v_def := substring(v_def FROM 1 FOR v_start_pos - 1)
        || v_replacement
        || substring(v_def FROM v_end_pos);

  EXECUTE v_def;
END;
$patch$;

COMMIT;
