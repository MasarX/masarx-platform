-- Maps/SNA canonical address projection.
-- Purpose:
-- - Project Saudi short national address and provided lat/lng into canonical
--   address fields for Console manual shipment creation/address updates.
-- - Persist provided API/intake coordinates into addresses.coordinates instead
--   of leaving them only in raw_input/workflow context.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606151330_maps_sna_canonical_projection_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.address_coordinates_from_payload_v1(p_payload JSONB)
RETURNS geography
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_raw JSONB;
  v_raw_type TEXT;
  v_lat_text TEXT;
  v_lng_text TEXT;
  v_lat DOUBLE PRECISION;
  v_lng DOUBLE PRECISION;
  v_wkt TEXT;
  v_geog geography;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN NULL;
  END IF;

  v_raw := COALESCE(p_payload->'coordinates', p_payload->'map_pin');
  IF v_raw IS NOT NULL AND v_raw <> 'null'::jsonb THEN
    v_raw_type := jsonb_typeof(v_raw);
    IF v_raw_type = 'object' THEN
      v_lat_text := COALESCE(
        NULLIF(btrim(v_raw->>'lat'), ''),
        NULLIF(btrim(v_raw->>'latitude'), '')
      );
      v_lng_text := COALESCE(
        NULLIF(btrim(v_raw->>'lng'), ''),
        NULLIF(btrim(v_raw->>'longitude'), '')
      );
    ELSIF v_raw_type = 'string' THEN
      v_wkt := NULLIF(btrim(v_raw #>> '{}'), '');
      IF v_wkt IS NOT NULL THEN
        v_geog := ST_GeogFromText(v_wkt);
        IF GeometryType(v_geog::geometry) <> 'POINT' THEN
          RAISE EXCEPTION 'address coordinates WKT must be a POINT'
            USING ERRCODE = '22023';
        END IF;
        RETURN v_geog;
      END IF;
    ELSE
      RAISE EXCEPTION 'address coordinates must be a JSON object, WKT string, or null'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_lat_text IS NULL AND v_lng_text IS NULL THEN
    v_lat_text := COALESCE(
      NULLIF(btrim(p_payload->>'lat'), ''),
      NULLIF(btrim(p_payload->>'latitude'), '')
    );
    v_lng_text := COALESCE(
      NULLIF(btrim(p_payload->>'lng'), ''),
      NULLIF(btrim(p_payload->>'longitude'), '')
    );
  END IF;

  IF v_lat_text IS NULL AND v_lng_text IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_lat_text IS NULL OR v_lng_text IS NULL THEN
    RAISE EXCEPTION 'address coordinates require both latitude and longitude'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_lat := v_lat_text::DOUBLE PRECISION;
    v_lng := v_lng_text::DOUBLE PRECISION;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'address coordinates must be numeric latitude/longitude'
        USING ERRCODE = '22023';
  END;

  IF v_lat < -90 OR v_lat > 90 OR v_lng < -180 OR v_lng > 180 THEN
    RAISE EXCEPTION 'address coordinates outside valid latitude/longitude bounds'
      USING ERRCODE = '22023';
  END IF;

  RETURN ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography;
END;
$function$;

CREATE OR REPLACE FUNCTION public.address_sa_short_code_from_payload_v1(p_payload JSONB)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_candidate TEXT;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN NULL;
  END IF;

  v_candidate := COALESCE(
    NULLIF(btrim(p_payload->>'sa_short_code'), ''),
    NULLIF(btrim(p_payload->>'short_national_address'), ''),
    NULLIF(btrim(p_payload->>'shortNationalAddress'), ''),
    NULLIF(btrim(p_payload->>'short_address'), ''),
    NULLIF(btrim(p_payload->>'shortAddress'), ''),
    NULLIF(btrim(p_payload->>'short_code'), ''),
    NULLIF(btrim(p_payload->>'shortCode'), ''),
    NULLIF(btrim(p_payload->>'nationalAddress'), ''),
    NULLIF(btrim(p_payload #>> ARRAY['address','sa_short_code']), ''),
    NULLIF(btrim(p_payload #>> ARRAY['address','short_national_address']), ''),
    NULLIF(btrim(p_payload #>> ARRAY['address','shortNationalAddress']), ''),
    NULLIF(btrim(p_payload #>> ARRAY['destination','sa_short_code']), ''),
    NULLIF(btrim(p_payload #>> ARRAY['destination','short_national_address']), ''),
    NULLIF(btrim(p_payload #>> ARRAY['destination','shortNationalAddress']), '')
  );

  RETURN public.geocoding_normalize_candidate_code(v_candidate, NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.address_coordinates_from_payload_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.address_sa_short_code_from_payload_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.address_coordinates_from_payload_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.address_sa_short_code_from_payload_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.address_coordinates_from_payload_v1(JSONB)
  IS 'Normalizes address payload lat/lng aliases into the canonical addresses.coordinates PostGIS point.';
COMMENT ON FUNCTION public.address_sa_short_code_from_payload_v1(JSONB)
  IS 'Normalizes Saudi short national address aliases from address payloads into addresses.sa_short_code format.';

DO $patch_shipment_create_address_projection$
DECLARE
  v_def TEXT;
  v_marker TEXT;
  v_replacement TEXT;
BEGIN
  SELECT pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 definition not found';
  END IF;

  IF position('public.address_sa_short_code_from_payload_v1(v_payload_address)' IN v_def) = 0 THEN
    v_marker := E'    v_address_lat NUMERIC;\n    v_address_lng NUMERIC;\n';
    v_replacement := E'    v_address_lat NUMERIC;\n    v_address_lng NUMERIC;\n    v_address_sa_short_code TEXT;\n    v_address_geocoding_policy JSONB;\n    v_address_short_plugin JSONB;\n    v_address_coordinates geography;\n';
    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch execute_shipment_create_v1 address projection declarations';
    END IF;
    v_def := replace(v_def, v_marker, v_replacement);

    v_marker := E'    IF v_planned_id IS NULL THEN\n        v_planned_id := gen_random_uuid();\n    END IF;\n\n';
    v_replacement := v_marker || E'    v_address_sa_short_code := public.address_sa_short_code_from_payload_v1(v_payload_address);\n    v_address_coordinates := public.address_coordinates_from_payload_v1(v_payload_address);\n    IF v_address_sa_short_code IS NOT NULL THEN\n      v_address_geocoding_policy := COALESCE(\n        public.resolve_settings(''geocoding_policy'', ''client'', v_client),\n        public.resolve_settings(''geocoding_policy'', ''tenant'', v_org),\n        public.resolve_settings(''geocoding_policy'', ''global'', NULL),\n        ''{}''::jsonb\n      );\n      v_address_short_plugin := workflow_handlers.geocoding_get_plugin(v_address_geocoding_policy, ''short_code'');\n      v_address_sa_short_code := public.geocoding_normalize_candidate_code(\n        v_address_sa_short_code,\n        NULLIF(v_address_short_plugin->''params''->>''code_regex'', '''')\n      );\n    END IF;\n\n';
    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch execute_shipment_create_v1 address projection normalization';
    END IF;
    v_def := replace(v_def, v_marker, v_replacement);

    v_marker := E'        raw_input,\n        normalized_line1,\n';
    v_replacement := E'        raw_input,\n        sa_short_code,\n        normalized_line1,\n';
    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch execute_shipment_create_v1 address insert columns';
    END IF;
    v_def := replace(v_def, v_marker, v_replacement);

    v_marker := E'        NULLIF(btrim(concat_ws('', '', v_address_line1, v_address_line2, v_address_district, v_address_city, v_address_province, v_address_country)), ''''),\n        v_address_line1,\n';
    v_replacement := E'        NULLIF(btrim(concat_ws('', '', v_address_line1, v_address_line2, v_address_district, v_address_city, v_address_province, v_address_country)), ''''),\n        v_address_sa_short_code,\n        v_address_line1,\n';
    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch execute_shipment_create_v1 address insert values';
    END IF;
    v_def := replace(v_def, v_marker, v_replacement);

    v_marker := E'        CASE\n          WHEN v_address_lat IS NOT NULL AND v_address_lng IS NOT NULL\n            THEN ST_SetSRID(ST_MakePoint(v_address_lng, v_address_lat), 4326)::geography\n          ELSE NULL\n        END\n';
    v_replacement := E'        COALESCE(\n          v_address_coordinates,\n          CASE\n            WHEN v_address_lat IS NOT NULL AND v_address_lng IS NOT NULL\n              THEN ST_SetSRID(ST_MakePoint(v_address_lng, v_address_lat), 4326)::geography\n            ELSE NULL\n          END\n        )\n';
    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch execute_shipment_create_v1 address coordinates value';
    END IF;
    v_def := replace(v_def, v_marker, v_replacement);

    IF position('public.address_coordinates_from_payload_v1(v_payload_address)' IN v_def) = 0
       OR position('sa_short_code,' IN v_def) = 0
       OR position('v_address_coordinates' IN v_def) = 0 THEN
      RAISE EXCEPTION 'execute_shipment_create_v1 address projection patch did not apply';
    END IF;

    EXECUTE v_def;
  END IF;
END;
$patch_shipment_create_address_projection$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_address_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := workflow_handlers.resolve_input_payload_v1(v_ctx);
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_address JSONB := COALESCE(
    v_ctx->'address',
    v_ctx->'destination_address',
    v_ctx#>'{shipment,address}',
    v_ctx#>'{shipment,destination_address}',
    v_payload->'address',
    v_payload->'destination_address',
    v_payload#>'{shipment,address}',
    v_payload#>'{shipment,destination_address}',
    v_payload#>'{shipment,recipient,address}',
    '{}'::jsonb
  );
  v_allowed_statuses JSONB := COALESCE(v_policy#>'{address,allowed_statuses}', '[]'::jsonb);
  v_validation_status TEXT := COALESCE(NULLIF(v_policy#>>'{address,validation_status}', ''), 'pending');
  v_line1 TEXT;
  v_line2 TEXT;
  v_city TEXT;
  v_province TEXT;
  v_country TEXT;
  v_default_country_code TEXT := COALESCE(
    NULLIF(v_policy#>>'{address,default_country_code}', ''),
    NULLIF(public.resolve_shipment_operation_policy_v1('{}'::jsonb)#>>'{address,default_country_code}', '')
  );
  v_postal_code TEXT;
  v_district TEXT;
  v_building_number TEXT;
  v_directions TEXT;
  v_sa_short_code TEXT;
  v_coordinates geography;
  v_coordinates_payload JSONB;
  v_geocoding_policy JSONB;
  v_short_plugin JSONB;
  v_reverse_geocode BOOLEAN := FALSE;
  v_address_id UUID;
  v_geocode_template_name TEXT := COALESCE(
    NULLIF(v_policy#>>'{address,geocode_template_name}', ''),
    NULLIF(v_policy#>>'{geocode,workflow_template_name}', ''),
    'workflow_geocoding_standard'
  );
  v_geocode_template_id UUID;
  v_geocode_run_id UUID;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
BEGIN
  SELECT *
    INTO v_target
    FROM workflow_handlers.resolve_shipment_target_v1(v_ctx)
   LIMIT 1;

  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF NOT workflow_handlers.shipment_status_allowed_v1(v_target.status, v_allowed_statuses) THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_status_not_allowed';
    v_result.operation_result := jsonb_build_object(
      'error',
      'shipment_status_not_allowed',
      'status',
      v_target.status
    );
    RETURN v_result;
  END IF;

  IF jsonb_typeof(v_address) <> 'object' THEN
    v_result.status := 'failed';
    v_result.last_error := 'address_payload_invalid';
    v_result.operation_result := jsonb_build_object('error', 'address_payload_invalid');
    RETURN v_result;
  END IF;

  v_line1 := COALESCE(NULLIF(v_address->>'line1', ''), NULLIF(v_address->>'addressLine1', ''));
  v_line2 := COALESCE(NULLIF(v_address->>'line2', ''), NULLIF(v_address->>'addressLine2', ''));
  v_city := COALESCE(NULLIF(v_address->>'city', ''), NULLIF(v_address->>'arabicCityName', ''));
  v_province := COALESCE(NULLIF(v_address->>'province', ''), NULLIF(v_address->>'region', ''), v_city);
  v_country := COALESCE(
    NULLIF(v_address->>'country', ''),
    NULLIF(v_address->>'country_code', ''),
    NULLIF(v_address->>'countryCode', ''),
    v_default_country_code
  );
  v_postal_code := COALESCE(NULLIF(v_address->>'postal_code', ''), NULLIF(v_address->>'zipCode', ''));
  v_district := NULLIF(v_address->>'district', '');
  v_building_number := NULLIF(v_address->>'building_number', '');
  v_directions := COALESCE(NULLIF(v_address->>'additional_directions', ''), NULLIF(v_address->>'notes', ''));
  v_sa_short_code := public.address_sa_short_code_from_payload_v1(v_address);
  v_coordinates := public.address_coordinates_from_payload_v1(v_address);

  IF v_sa_short_code IS NOT NULL THEN
    v_geocoding_policy := COALESCE(
      public.resolve_settings('geocoding_policy', 'client', v_target.client_id),
      public.resolve_settings('geocoding_policy', 'tenant', v_target.organization_id),
      public.resolve_settings('geocoding_policy', 'global', NULL),
      '{}'::jsonb
    );
    v_short_plugin := workflow_handlers.geocoding_get_plugin(v_geocoding_policy, 'short_code');
    v_sa_short_code := public.geocoding_normalize_candidate_code(
      v_sa_short_code,
      NULLIF(v_short_plugin->'params'->>'code_regex', '')
    );
    v_reverse_geocode := lower(COALESCE(v_short_plugin->'params'->>'reverse_geocode_on_hit', 'false')) = 'true';
  END IF;

  IF v_coordinates IS NOT NULL THEN
    v_coordinates_payload := jsonb_build_object(
      'latitude',
      ST_Y(v_coordinates::geometry),
      'longitude',
      ST_X(v_coordinates::geometry)
    );
  END IF;

  IF v_line1 IS NULL OR v_city IS NULL OR v_country IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'address_fields_missing';
    v_result.operation_result := jsonb_build_object('error', 'address_fields_missing');
    RETURN v_result;
  END IF;

  INSERT INTO public.addresses (
    organization_id,
    client_id,
    raw_input,
    sa_short_code,
    normalized_line1,
    normalized_line2,
    district,
    city,
    province,
    postal_code,
    country,
    building_number,
    additional_directions,
    validation_status,
    coordinates
  ) VALUES (
    v_target.organization_id,
    v_target.client_id,
    COALESCE(NULLIF(v_address->>'raw_input', ''), v_address::TEXT),
    v_sa_short_code,
    v_line1,
    v_line2,
    v_district,
    v_city,
    v_province,
    v_postal_code,
    v_country,
    v_building_number,
    v_directions,
    v_validation_status,
    v_coordinates
  )
  RETURNING id INTO v_address_id;

  UPDATE public.shipments
     SET destination_address_id = v_address_id,
         updated_at = now()
   WHERE id = v_target.shipment_id;

  IF COALESCE((v_policy#>>'{address,re_geocode}')::BOOLEAN, TRUE) THEN
    SELECT id
      INTO v_geocode_template_id
      FROM public.workflow_templates
     WHERE name = v_geocode_template_name
       AND status = 'active'
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1;

    IF v_geocode_template_id IS NOT NULL THEN
      v_geocode_run_id := start_workflow_run(
        v_geocode_template_id,
        jsonb_strip_nulls(
          jsonb_build_object(
            'organization_id',
            v_target.organization_id,
            'client_id',
            v_target.client_id,
            'sender_id',
            v_target.sender_id,
            'shipment_id',
            v_target.shipment_id,
            'destination_address_id',
            v_address_id,
            'address_input',
            jsonb_strip_nulls(
              v_address
              || jsonb_build_object(
                'sa_short_code',
                v_sa_short_code,
                'provided_coordinates',
                v_coordinates_payload
              )
            ),
            'geocoding',
            jsonb_strip_nulls(
              jsonb_build_object(
                'provided_coordinates',
                v_coordinates_payload,
                'short_code',
                v_sa_short_code,
                'sa_short_code',
                v_sa_short_code,
                'reverse_geocode',
                CASE
                  WHEN v_sa_short_code IS NOT NULL AND v_coordinates_payload IS NOT NULL THEN v_reverse_geocode
                  ELSE NULL
                END
              )
            )
          )
        )
      );
    END IF;
  END IF;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    'address_update',
    'administrative',
    jsonb_strip_nulls(
      jsonb_build_object(
        'idempotency_key',
        v_event_id,
        'address_id',
        v_address_id,
        'geocode_workflow_run_id',
        v_geocode_run_id,
        'sa_short_code',
        v_sa_short_code,
        'short_national_address',
        v_sa_short_code,
        'provided_coordinates',
        v_coordinates_payload,
        'reverse_geocode',
        CASE
          WHEN v_sa_short_code IS NOT NULL AND v_coordinates_payload IS NOT NULL THEN v_reverse_geocode
          ELSE NULL
        END
      )
    ),
    NULL,
    NULL,
    'workflow_handlers.execute_shipment_update_address_v1',
    NULL,
    NULL
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.context_patch := jsonb_strip_nulls(
    jsonb_build_object(
      'shipment',
      jsonb_build_object(
        'id',
        v_target.shipment_id,
        'tracking_number',
        v_target.tracking_number,
        'destination_address_id',
        v_address_id
      ),
      'address_input',
      jsonb_strip_nulls(
        v_address
        || jsonb_build_object(
          'sa_short_code',
          v_sa_short_code,
          'provided_coordinates',
          v_coordinates_payload
        )
      ),
      'geocoding',
      jsonb_strip_nulls(
        jsonb_build_object(
          'provided_coordinates',
          v_coordinates_payload,
          'short_code',
          v_sa_short_code,
          'sa_short_code',
          v_sa_short_code,
          'reverse_geocode',
          CASE
            WHEN v_sa_short_code IS NOT NULL AND v_coordinates_payload IS NOT NULL THEN v_reverse_geocode
            ELSE NULL
          END
        )
      )
    )
  );
  v_result.operation_result := jsonb_strip_nulls(
    jsonb_build_object(
      'shipment_id',
      v_target.shipment_id,
      'address_id',
      v_address_id,
      'shipment_action_id',
      v_action_id,
      'geocode_workflow_run_id',
      v_geocode_run_id,
      'sa_short_code',
      v_sa_short_code,
      'short_national_address',
      v_sa_short_code,
      'provided_coordinates',
      v_coordinates_payload,
      'reverse_geocode',
      CASE
        WHEN v_sa_short_code IS NOT NULL AND v_coordinates_payload IS NOT NULL THEN v_reverse_geocode
        ELSE NULL
      END
    )
  );
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_address_intake_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
    v_step_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_response public.workflow_handler_response;
    v_webhook_id UUID := NULLIF(v_ctx->>'webhook_id', '')::UUID;
    v_address_id UUID := NULLIF(v_ctx->>'address_id', '')::UUID;
    v_mapping_id UUID := COALESCE(
        NULLIF(v_step_metadata->>'mapping_config_id', '')::UUID,
        NULLIF(v_ctx->>'mapping_config_id', '')::UUID
    );
    v_webhook RECORD;
    v_source RECORD;
    v_payload JSONB := '{}'::jsonb;
    v_raw_payload JSONB := '{}'::jsonb;
    v_transformed_payload JSONB := '{}'::jsonb;
    v_mapping JSONB;
    v_address_map JSONB;
    v_line1 TEXT;
    v_line2 TEXT;
    v_city TEXT;
    v_city_raw TEXT;
    v_district TEXT;
    v_province TEXT;
    v_province_raw TEXT;
    v_country TEXT;
    v_postal TEXT;
    v_lat NUMERIC;
    v_lng NUMERIC;
    v_short_code TEXT;
    v_code_regex TEXT;
    v_address_policy JSONB;
    v_geocoding_policy JSONB;
    v_short_plugin JSONB;
    v_reverse_geocode BOOLEAN := FALSE;
    v_raw JSONB;
    v_inserted_id UUID;
    v_org UUID;
    v_client UUID;
    v_sender UUID;
    v_provided_coords JSONB;
    v_coordinates geography;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', FALSE);

    IF v_address_id IS NOT NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'address_present');
        RETURN v_response;
    END IF;

    IF v_webhook_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('created', FALSE, 'reason', 'webhook_missing');
        RETURN v_response;
    END IF;

    SELECT
        wi.raw_payload,
        wi.transformed_payload,
        wi.webhook_source_id
    INTO v_webhook
    FROM public.webhook_inbox wi
    WHERE wi.id = v_webhook_id;

    IF NOT FOUND THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('created', FALSE, 'reason', 'webhook_not_found');
        RETURN v_response;
    END IF;

    v_raw_payload := COALESCE(v_webhook.raw_payload, '{}'::jsonb);
    v_transformed_payload := COALESCE(v_webhook.transformed_payload, '{}'::jsonb);
    v_payload := CASE
      WHEN v_raw_payload <> '{}'::jsonb THEN v_raw_payload
      ELSE v_transformed_payload
    END;

    SELECT
        ws.organization_id,
        ws.sender_id,
        ws.mapping_config_id,
        s.client_id
    INTO v_source
    FROM public.webhook_sources ws
    LEFT JOIN public.senders s ON s.id = ws.sender_id
    WHERE ws.id = v_webhook.webhook_source_id;

    v_org := COALESCE(
        v_source.organization_id,
        NULLIF(v_ctx->>'organization_id', '')::UUID
    );
    v_client := COALESCE(
        v_source.client_id,
        NULLIF(v_ctx->>'client_id', '')::UUID
    );
    v_sender := COALESCE(
        v_source.sender_id,
        NULLIF(v_ctx->>'sender_id', '')::UUID
    );

    IF v_mapping_id IS NULL THEN
        v_mapping_id := v_source.mapping_config_id;
    END IF;

    IF v_mapping_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('created', FALSE, 'reason', 'mapping_missing');
        RETURN v_response;
    END IF;

    SELECT mapping_config
      INTO v_mapping
      FROM public.mapping_configs
     WHERE id = v_mapping_id
       AND mapping_type = 'webhook_inbound';

    IF NOT FOUND THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'created', FALSE,
            'reason', 'mapping_not_found',
            'mapping_config_id', v_mapping_id
        );
        RETURN v_response;
    END IF;

    v_address_map := COALESCE(v_mapping->'transforms'->'address', '{}'::jsonb);

    v_line1 := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'line1'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'line1')
    );
    v_line2 := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'line2'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'line2')
    );
    v_city := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'city'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'city')
    );
    v_district := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'district'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'district')
    );
    v_province := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'province'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'province')
    );
    v_country := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'country'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'country')
    );
    v_postal := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'postal_code'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'postal_code')
    );
    v_lat := NULLIF(COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'lat'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'lat')
    ), '')::NUMERIC;
    v_lng := NULLIF(COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'lng'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'lng')
    ), '')::NUMERIC;
    v_short_code := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'sa_short_code'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'sa_short_code'),
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'short_national_address'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'short_national_address'),
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'short_address'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'short_address'),
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'short_code'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'short_code')
    );

    v_city_raw := NULLIF(v_city, '');
    v_province_raw := NULLIF(v_province, '');
    v_city := COALESCE(v_city_raw, '');
    v_province := COALESCE(v_province_raw, '');

    v_line1 := NULLIF(v_line1, '');
    v_line2 := NULLIF(v_line2, '');
    v_district := NULLIF(v_district, '');
    v_postal := NULLIF(v_postal, '');
    v_short_code := NULLIF(v_short_code, '');

    IF v_org IS NULL OR v_client IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'created', FALSE,
            'reason', 'scope_missing',
            'organization_id', v_org,
            'client_id', v_client
        );
        RETURN v_response;
    END IF;

    v_address_policy := COALESCE(
        public.resolve_settings('address_policy', 'client', v_client),
        public.resolve_settings('address_policy', 'tenant', v_org),
        public.resolve_settings('address_policy', 'global', NULL),
        '{}'::jsonb
    );
    v_country := COALESCE(
        NULLIF(v_country, ''),
        NULLIF(v_address_policy->>'country_default', '')
    );

    IF v_country IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'created', FALSE,
            'reason', 'address_policy_country_default_missing',
            'organization_id', v_org,
            'client_id', v_client
        );
        RETURN v_response;
    END IF;

    IF v_short_code IS NOT NULL THEN
        v_geocoding_policy := COALESCE(
            public.resolve_settings('geocoding_policy', 'client', v_client),
            public.resolve_settings('geocoding_policy', 'tenant', v_org),
            public.resolve_settings('geocoding_policy', 'global', NULL),
            '{}'::jsonb
        );
        v_short_plugin := workflow_handlers.geocoding_get_plugin(v_geocoding_policy, 'short_code');
        v_code_regex := NULLIF(v_short_plugin->'params'->>'code_regex', '');
        v_short_code := public.geocoding_normalize_candidate_code(v_short_code, v_code_regex);
        v_reverse_geocode := lower(COALESCE(v_short_plugin->'params'->>'reverse_geocode_on_hit', 'false')) = 'true';
    END IF;

    v_raw := jsonb_strip_nulls(jsonb_build_object(
        'line1', v_line1,
        'line2', v_line2,
        'short_code', v_short_code,
        'sa_short_code', v_short_code,
        'district', v_district,
        'city', v_city_raw,
        'province', v_province_raw,
        'country', v_country,
        'postal_code', v_postal,
        'lat', v_lat,
        'lng', v_lng,
        'provided_coordinates', CASE
          WHEN v_lat IS NOT NULL AND v_lng IS NOT NULL
               AND v_lat BETWEEN -90 AND 90
               AND v_lng BETWEEN -180 AND 180 THEN jsonb_build_object('latitude', v_lat, 'longitude', v_lng)
          ELSE NULL
        END
    ));

    IF v_lat IS NOT NULL AND v_lng IS NOT NULL
       AND v_lat BETWEEN -90 AND 90
       AND v_lng BETWEEN -180 AND 180 THEN
        v_provided_coords := jsonb_build_object(
            'latitude', v_lat,
            'longitude', v_lng
        );
        v_coordinates := ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography;
    END IF;

    INSERT INTO public.addresses (
        id,
        organization_id,
        client_id,
        raw_input,
        sa_short_code,
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
        coordinates,
        created_at,
        updated_at
    )
    VALUES (
        gen_random_uuid(),
        v_org,
        v_client,
        COALESCE(v_raw, '{}'::jsonb)::TEXT,
        v_short_code,
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
        v_coordinates,
        now(),
        now()
    )
    RETURNING id INTO v_inserted_id;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'created', TRUE,
        'address_id', v_inserted_id,
        'mapping_config_id', v_mapping_id,
        'source_id', v_webhook.webhook_source_id,
        'short_code', v_short_code,
        'sa_short_code', v_short_code,
        'provided_coordinates', v_provided_coords,
        'reverse_geocode', CASE
          WHEN v_short_code IS NOT NULL AND v_provided_coords IS NOT NULL THEN v_reverse_geocode
          ELSE NULL
        END
    ));
    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
        'address_id', v_inserted_id,
        'organization_id', v_org,
        'client_id', v_client,
        'sender_id', v_sender,
        'address_input', v_raw,
        'geocoding', jsonb_build_object(
            'provided_coordinates', v_provided_coords,
            'short_code', v_short_code,
            'sa_short_code', v_short_code,
            'reverse_geocode', CASE
              WHEN v_short_code IS NOT NULL AND v_provided_coords IS NOT NULL THEN v_reverse_geocode
              ELSE NULL
            END
        )
    ));

    RETURN v_response;
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202606151330_maps_sna_canonical_projection_v1'));

COMMIT;
