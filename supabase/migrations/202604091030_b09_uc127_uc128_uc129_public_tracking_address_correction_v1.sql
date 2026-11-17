-- Plan: Batch 09 address correction closeout / Step: E01
-- Purpose:
--   - Persist landmark and drop-point details through the canonical public-tracking
--     shipment change path.
--   - Validate corrected map-pin coverage before the shipment address mutates.
--   - Propagate applied corrections onto any active route-stop manifest without
--     overlapping the separate next-wave/route requeue lane.
-- Date: 2026-04-09

BEGIN;

SELECT pg_advisory_lock(hashtext('202604091030_b09_uc127_uc128_uc129_public_tracking_address_correction_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Structured landmark / notes helpers backed by addresses.additional_directions
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_tracking_parse_address_directions_v1(
  p_directions TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_text TEXT := NULLIF(btrim(COALESCE(p_directions, '')), '');
  v_line TEXT;
  v_landmark TEXT := NULL;
  v_notes TEXT := NULL;
  v_other_lines TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_text IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  FOREACH v_line IN ARRAY regexp_split_to_array(v_text, E'\\r?\\n+') LOOP
    v_line := NULLIF(btrim(COALESCE(v_line, '')), '');
    IF v_line IS NULL THEN
      CONTINUE;
    END IF;

    IF v_line ~* '^landmark\\s*:' THEN
      v_landmark := NULLIF(
        btrim(regexp_replace(v_line, '^landmark\\s*:\\s*', '', 'i')),
        ''
      );
    ELSIF v_line ~* '^notes?\\s*:' THEN
      v_notes := concat_ws(
        E'\n',
        v_notes,
        NULLIF(btrim(regexp_replace(v_line, '^notes?\\s*:\\s*', '', 'i')), '')
      );
    ELSE
      v_other_lines := array_append(v_other_lines, v_line);
    END IF;
  END LOOP;

  IF COALESCE(array_length(v_other_lines, 1), 0) > 0 THEN
    v_notes := concat_ws(E'\n', v_notes, array_to_string(v_other_lines, E'\n'));
  END IF;

  IF v_landmark IS NULL AND v_notes IS NULL THEN
    RETURN jsonb_build_object('notes', v_text);
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'landmark', v_landmark,
      'notes', v_notes
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_compose_address_directions_v1(
  p_landmark TEXT,
  p_notes TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_landmark TEXT := NULLIF(btrim(COALESCE(p_landmark, '')), '');
  v_notes TEXT := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_lines TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_landmark IS NOT NULL THEN
    v_lines := array_append(v_lines, format('Landmark: %s', v_landmark));
  END IF;

  IF v_notes IS NOT NULL THEN
    v_lines := array_append(v_lines, format('Notes: %s', replace(v_notes, E'\r', '')));
  END IF;

  RETURN NULLIF(array_to_string(v_lines, E'\n'), '');
END;
$function$;

-------------------------------------------------------------------------------
-- 2) Shipment / requested snapshots and diff artifacts
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_tracking_shipment_snapshot_v1(
  p_shipment_id UUID,
  p_client_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT jsonb_strip_nulls(
    jsonb_build_object(
      'shipment_id', s.id,
      'tracking_number', s.tracking_number,
      'client_reference_number', NULLIF(btrim(s.client_reference_number), ''),
      'carrier_reference_number', NULLIF(btrim(s.carrier_reference_number), ''),
      'shipment_status', s.status,
      'service_type', s.service_type,
      'promised_delivery_date', s.promised_delivery_date,
      'promised_delivery_at', s.promised_delivery_at,
      'promised_window_start_at', s.promised_window_start_at,
      'promised_window_end_at', s.promised_window_end_at,
      'address', jsonb_strip_nulls(
        jsonb_build_object(
          'address_id', a.id,
          'raw_input', NULLIF(btrim(a.raw_input), ''),
          'line1', NULLIF(btrim(a.line1), ''),
          'line2', NULLIF(btrim(a.line2), ''),
          'drop_point', COALESCE(NULLIF(btrim(a.line2), ''), NULLIF(btrim(a.normalized_line2), '')),
          'landmark', NULLIF(btrim(v_directions->>'landmark'), ''),
          'district', NULLIF(btrim(a.district), ''),
          'city', NULLIF(btrim(a.city), ''),
          'province', NULLIF(btrim(a.province), ''),
          'postal_code', NULLIF(btrim(a.postal_code), ''),
          'country', NULLIF(btrim(a.country), ''),
          'building_number', NULLIF(btrim(a.building_number), ''),
          'short_national_address', public.public_tracking_short_address_value_v1(a.sa_short_code, a.building_number, a.postal_code),
          'map_pin', CASE
            WHEN a.coordinates IS NULL THEN NULL
            ELSE jsonb_build_object(
              'lat', round((ST_Y(a.coordinates::geometry)::numeric), 6),
              'lng', round((ST_X(a.coordinates::geometry)::numeric), 6)
            )
          END
        )
      ),
      'notes', NULLIF(btrim(v_directions->>'notes'), ''),
      'updated_at', s.updated_at
    )
  )
  FROM public.shipments s
  LEFT JOIN public.addresses a
    ON a.id = s.destination_address_id
   AND a.client_id = s.client_id
  LEFT JOIN LATERAL public.public_tracking_parse_address_directions_v1(a.additional_directions) AS v_directions
    ON TRUE
  WHERE s.id = p_shipment_id
    AND s.client_id = p_client_id
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_requested_snapshot_v1(
  p_request_type TEXT,
  p_before_snapshot JSONB,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_request_type TEXT := public.public_tracking_request_type_key_v1(p_request_type);
  v_before JSONB := COALESCE(p_before_snapshot, '{}'::jsonb);
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_drop_point TEXT := NULLIF(
    btrim(
      COALESCE(
        v_payload->>'drop_point',
        v_payload->>'drop_point_details',
        ''
      )
    ),
    ''
  );
BEGIN
  IF v_request_type = 'reschedule_date' THEN
    RETURN jsonb_set(
      v_before,
      ARRAY['promised_delivery_date'],
      to_jsonb(NULLIF(v_payload->>'requested_date', '')::date),
      TRUE
    );
  END IF;

  IF v_request_type = 'location_change' THEN
    RETURN public.deep_merge_jsonb(
      v_before,
      jsonb_strip_nulls(
        jsonb_build_object(
          'address', jsonb_strip_nulls(
            jsonb_build_object(
              'raw_input', NULLIF(btrim(COALESCE(v_payload->>'address_text', '')), ''),
              'line1', NULLIF(btrim(COALESCE(v_payload->>'address_text', '')), ''),
              'line2', v_drop_point,
              'drop_point', v_drop_point,
              'landmark', NULLIF(btrim(COALESCE(v_payload->>'landmark', '')), ''),
              'short_national_address', NULLIF(btrim(COALESCE(v_payload->>'short_national_address', '')), ''),
              'map_pin', CASE
                WHEN NULLIF(v_payload #>> ARRAY['map_pin','lat'], '') IS NOT NULL
                  AND NULLIF(v_payload #>> ARRAY['map_pin','lng'], '') IS NOT NULL
                THEN jsonb_build_object(
                  'lat', round((v_payload #>> ARRAY['map_pin','lat'])::numeric, 6),
                  'lng', round((v_payload #>> ARRAY['map_pin','lng'])::numeric, 6)
                )
                ELSE NULL
              END
            )
          ),
          'notes', NULLIF(btrim(COALESCE(v_payload->>'notes', '')), '')
        )
      )
    );
  END IF;

  RETURN v_before;
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_change_artifacts_v1(
  p_request_type TEXT,
  p_before_snapshot JSONB,
  p_requested_snapshot JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_request_type TEXT := public.public_tracking_request_type_key_v1(p_request_type);
  v_before JSONB := COALESCE(p_before_snapshot, '{}'::jsonb);
  v_requested JSONB := COALESCE(p_requested_snapshot, '{}'::jsonb);
  v_paths JSONB := '[]'::jsonb;
  v_path_json JSONB;
  v_path TEXT[];
  v_key TEXT;
  v_from JSONB;
  v_to JSONB;
  v_changed TEXT[] := ARRAY[]::TEXT[];
  v_diff JSONB := '{}'::jsonb;
  v_summary TEXT := NULL;
BEGIN
  IF v_request_type = 'reschedule_date' THEN
    v_paths := jsonb_build_array(
      jsonb_build_array('promised_delivery_date')
    );
  ELSIF v_request_type = 'location_change' THEN
    v_paths := jsonb_build_array(
      jsonb_build_array('address', 'raw_input'),
      jsonb_build_array('address', 'short_national_address'),
      jsonb_build_array('address', 'landmark'),
      jsonb_build_array('address', 'drop_point'),
      jsonb_build_array('address', 'map_pin', 'lat'),
      jsonb_build_array('address', 'map_pin', 'lng'),
      jsonb_build_array('notes')
    );
  END IF;

  FOR v_path_json IN
    SELECT value
    FROM jsonb_array_elements(v_paths)
  LOOP
    SELECT COALESCE(array_agg(path_part ORDER BY ordinality), ARRAY[]::TEXT[])
      INTO v_path
    FROM jsonb_array_elements_text(v_path_json) WITH ORDINALITY AS path_parts(path_part, ordinality);

    v_from := public.public_tracking_jsonb_path_value_v1(v_before, v_path);
    v_to := public.public_tracking_jsonb_path_value_v1(v_requested, v_path);
    IF v_from IS DISTINCT FROM v_to THEN
      v_key := array_to_string(v_path, '.');
      v_changed := array_append(v_changed, v_key);
      v_diff := v_diff || jsonb_build_object(
        v_key,
        jsonb_strip_nulls(
          jsonb_build_object(
            'from', NULLIF(v_from, 'null'::jsonb),
            'to', NULLIF(v_to, 'null'::jsonb)
          )
        )
      );
    END IF;
  END LOOP;

  IF v_request_type = 'reschedule_date' THEN
    v_summary := format(
      'Delivery date %s -> %s',
      COALESCE(v_before->>'promised_delivery_date', 'unscheduled'),
      COALESCE(v_requested->>'promised_delivery_date', 'unscheduled')
    );
  ELSIF v_request_type = 'location_change' THEN
    v_summary := format(
      'Address %s -> %s',
      COALESCE(v_before #>> ARRAY['address','short_national_address'], v_before #>> ARRAY['address','raw_input'], 'current address'),
      COALESCE(v_requested #>> ARRAY['address','short_national_address'], v_requested #>> ARRAY['address','raw_input'], 'new address')
    );
  END IF;

  RETURN jsonb_build_object(
    'changed_fields', to_jsonb(COALESCE(v_changed, ARRAY[]::TEXT[])),
    'diff', COALESCE(v_diff, '{}'::jsonb),
    'change_summary', v_summary
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 3) Validation-first coverage resolution for corrected addresses
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_tracking_validate_location_change_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID := NULL;
  v_client_id UUID := NULL;
  v_lat NUMERIC := NULL;
  v_lng NUMERIC := NULL;
  v_shipment RECORD;
  v_point GEOGRAPHY := NULL;
  v_district RECORD;
  v_zone_id UUID := NULL;
  v_branch_id UUID := NULL;
BEGIN
  BEGIN v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_lat := NULLIF(v_input #>> ARRAY['map_pin','lat'], '')::NUMERIC; EXCEPTION WHEN others THEN v_lat := NULL; END;
  BEGIN v_lng := NULLIF(v_input #>> ARRAY['map_pin','lng'], '')::NUMERIC; EXCEPTION WHEN others THEN v_lng := NULL; END;

  IF v_shipment_id IS NULL OR v_client_id IS NULL OR v_lat IS NULL OR v_lng IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.status
  INTO v_shipment
  FROM public.shipments s
  WHERE s.id = v_shipment_id
    AND s.client_id = v_client_id
  LIMIT 1;

  IF v_shipment.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'shipment_not_found'));
  END IF;

  IF lower(COALESCE(v_shipment.status, '')) IN ('delivered', 'cancelled', 'canceled') THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'shipment_state_blocked', 'status', v_shipment.status)
    );
  END IF;

  v_point := ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography;

  SELECT
    cd.id,
    cd.city_id,
    cd.name_canonical AS district_name,
    cc.name_canonical AS city_name,
    round((ST_Distance(cd.centroid, v_point))::numeric, 2) AS distance_meters
  INTO v_district
  FROM public.canonical_districts cd
  LEFT JOIN public.canonical_cities cc
    ON cc.id = cd.city_id
   AND cc.organization_id = cd.organization_id
  WHERE cd.organization_id = v_shipment.organization_id
    AND cd.is_active = TRUE
    AND cd.centroid IS NOT NULL
  ORDER BY ST_Distance(cd.centroid, v_point), cd.updated_at DESC NULLS LAST, cd.id
  LIMIT 1;

  IF v_district.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'canonical_district_missing'),
      'validation', jsonb_build_object(
        'status', 'failed',
        'reason', 'canonical_district_missing',
        'map_pin', jsonb_build_object('lat', round(v_lat, 6), 'lng', round(v_lng, 6))
      )
    );
  END IF;

  v_zone_id := public.resolve_zone_id_for_canonical_district(v_shipment.organization_id, v_district.id);
  IF v_zone_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'zone_unmapped'),
      'validation', jsonb_strip_nulls(
        jsonb_build_object(
          'status', 'failed',
          'reason', 'zone_unmapped',
          'canonical_district_id', v_district.id,
          'district', v_district.district_name,
          'city', v_district.city_name,
          'distance_meters', v_district.distance_meters,
          'map_pin', jsonb_build_object('lat', round(v_lat, 6), 'lng', round(v_lng, 6))
        )
      )
    );
  END IF;

  v_branch_id := public.resolve_branch_id_for_zone_at(v_zone_id, workflow_now());
  IF v_branch_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'branch_uncovered'),
      'validation', jsonb_strip_nulls(
        jsonb_build_object(
          'status', 'failed',
          'reason', 'branch_uncovered',
          'canonical_district_id', v_district.id,
          'district', v_district.district_name,
          'city', v_district.city_name,
          'zone_id', v_zone_id,
          'distance_meters', v_district.distance_meters,
          'map_pin', jsonb_build_object('lat', round(v_lat, 6), 'lng', round(v_lng, 6))
        )
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'shipment_id', v_shipment.id,
    'organization_id', v_shipment.organization_id,
    'client_id', v_shipment.client_id,
    'sender_id', v_shipment.sender_id,
    'validation', jsonb_strip_nulls(
      jsonb_build_object(
        'status', 'serviceable',
        'reason', 'serviceable',
        'canonical_district_id', v_district.id,
        'city_id', v_district.city_id,
        'district', v_district.district_name,
        'city', v_district.city_name,
        'zone_id', v_zone_id,
        'branch_id', v_branch_id,
        'distance_meters', v_district.distance_meters,
        'map_pin', jsonb_build_object('lat', round(v_lat, 6), 'lng', round(v_lng, 6))
      )
    )
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 4) Active-route propagation helper
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_tracking_sync_active_route_stops_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID := NULL;
  v_client_id UUID := NULL;
  v_address_id UUID := NULL;
  v_zone_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_short_national_address TEXT := NULLIF(btrim(COALESCE(v_input->>'short_national_address', '')), '');
  v_landmark TEXT := NULLIF(btrim(COALESCE(v_input->>'landmark', '')), '');
  v_drop_point TEXT := NULLIF(
    btrim(COALESCE(v_input->>'drop_point', v_input->>'drop_point_details', '')),
    ''
  );
  v_notes TEXT := NULLIF(btrim(COALESCE(v_input->>'notes', '')), '');
  v_address_text TEXT := NULLIF(btrim(COALESCE(v_input->>'address_text', '')), '');
  v_support_case_id UUID := NULL;
  v_lat NUMERIC := NULL;
  v_lng NUMERIC := NULL;
  v_stop_ids UUID[] := ARRAY[]::UUID[];
  v_route_run_ids UUID[] := ARRAY[]::UUID[];
  v_route_run_branch_ids UUID[] := ARRAY[]::UUID[];
  v_route_stop_count INTEGER := 0;
BEGIN
  BEGIN v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_address_id := NULLIF(v_input->>'address_id', '')::UUID; EXCEPTION WHEN others THEN v_address_id := NULL; END;
  BEGIN v_zone_id := NULLIF(v_input->>'zone_id', '')::UUID; EXCEPTION WHEN others THEN v_zone_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_input->>'branch_id', '')::UUID; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_support_case_id := NULLIF(v_input->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;
  BEGIN v_lat := NULLIF(v_input #>> ARRAY['map_pin','lat'], '')::NUMERIC; EXCEPTION WHEN others THEN v_lat := NULL; END;
  BEGIN v_lng := NULLIF(v_input #>> ARRAY['map_pin','lng'], '')::NUMERIC; EXCEPTION WHEN others THEN v_lng := NULL; END;

  IF v_shipment_id IS NULL OR v_client_id IS NULL THEN
    RETURN jsonb_build_object('mode', 'none', 'synced', FALSE, 'reason', 'invalid_request');
  END IF;

  WITH synced AS (
    UPDATE public.route_stops rs
       SET metadata = public.deep_merge_jsonb(
             COALESCE(rs.metadata, '{}'::jsonb),
             jsonb_build_object(
               'address_correction',
               jsonb_strip_nulls(
                 jsonb_build_object(
                   'address_id', v_address_id,
                   'support_case_id', v_support_case_id,
                   'address_text', v_address_text,
                   'short_national_address', v_short_national_address,
                   'landmark', v_landmark,
                   'drop_point', v_drop_point,
                   'notes', v_notes,
                   'zone_id', v_zone_id,
                   'branch_id', v_branch_id,
                   'map_pin', CASE
                     WHEN v_lat IS NULL OR v_lng IS NULL THEN NULL
                     ELSE jsonb_build_object('lat', round(v_lat, 6), 'lng', round(v_lng, 6))
                   END,
                   'synced_at', workflow_now()
                 )
               )
             )
           ),
           updated_at = workflow_now()
      FROM public.route_runs rr
     WHERE rr.id = rs.route_run_id
       AND rs.shipment_id = v_shipment_id
       AND rs.client_id = v_client_id
       AND COALESCE(lower(rr.status), '') NOT IN ('completed', 'cancelled', 'canceled')
    RETURNING rs.id, rs.route_run_id
  )
  SELECT
    COALESCE(array_agg(id ORDER BY id), ARRAY[]::UUID[]),
    COALESCE(array_agg(DISTINCT route_run_id), ARRAY[]::UUID[]),
    COUNT(*)::INT
  INTO v_stop_ids, v_route_run_ids, v_route_stop_count
  FROM synced;

  IF v_route_stop_count > 0 THEN
    SELECT COALESCE(
             array_agg(DISTINCT rr.branch_id) FILTER (WHERE rr.branch_id IS NOT NULL),
             ARRAY[]::UUID[]
           )
      INTO v_route_run_branch_ids
      FROM public.route_runs rr
     WHERE rr.id = ANY(v_route_run_ids);
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'mode', CASE WHEN v_route_stop_count > 0 THEN 'active_route' ELSE 'none' END,
      'synced', (v_route_stop_count > 0),
      'reason', CASE WHEN v_route_stop_count > 0 THEN NULL ELSE 'no_active_route' END,
      'route_stop_count', v_route_stop_count,
      'route_stop_ids', to_jsonb(v_stop_ids),
      'route_run_ids', to_jsonb(v_route_run_ids),
      'route_run_branch_ids', to_jsonb(v_route_run_branch_ids),
      'branch_mismatch', CASE
        WHEN v_route_stop_count > 0
         AND v_branch_id IS NOT NULL
         AND NOT COALESCE(v_branch_id = ANY(v_route_run_branch_ids), FALSE)
        THEN TRUE
        ELSE FALSE
      END
    )
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 5) Provider propagation helper (reuse canonical API gateway provider update lane)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_tracking_queue_provider_update_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID := NULL;
  v_client_id UUID := NULL;
  v_address_id UUID := NULL;
  v_support_case_id UUID := NULL;

  v_shipment RECORD;
  v_address RECORD;

  v_source_request_id UUID := NULL;
  v_source_id UUID := NULL;
  v_provider_shipment_id TEXT := NULL;
  v_route_result JSONB := '{}'::jsonb;
  v_route_id UUID := NULL;
  v_route_name TEXT := NULL;
  v_route_settings_resolution_id UUID := NULL;
  v_route public.api_routes%ROWTYPE;
  v_policy JSONB := '{}'::jsonb;
  v_provider_id UUID := NULL;
  v_provider_base_url TEXT := NULL;

  v_provider_account_policy JSONB := '{}'::jsonb;
  v_provider_account_category TEXT := NULL;
  v_provider_account_required BOOLEAN := TRUE;
  v_provider_account_require_company_id BOOLEAN := FALSE;
  v_provider_account_require_auth_config_id BOOLEAN := FALSE;
  v_provider_account_settings_id UUID := NULL;
  v_provider_account_settings_version_id UUID := NULL;
  v_provider_account_scope_type TEXT := NULL;
  v_provider_account_scope_id UUID := NULL;
  v_provider_account_value JSONB := '{}'::jsonb;
  v_provider_account_version INT := NULL;
  v_provider_account_scope_path JSONB := '[]'::jsonb;
  v_provider_account_settings_resolution_id UUID := NULL;
  v_provider_account_company_id TEXT := NULL;
  v_provider_account_auth_config_id UUID := NULL;

  v_path_params JSONB := '{}'::jsonb;
  v_request_headers JSONB := jsonb_build_object('content-type', 'application/json');
  v_request_body JSONB := '{}'::jsonb;
  v_outbound_headers JSONB := '{}'::jsonb;
  v_header_defaults JSONB := '{}'::jsonb;
  v_header_overrides JSONB := '{}'::jsonb;
  v_header_render_context JSONB := '{}'::jsonb;
  v_header_entry RECORD;
  v_header_name TEXT := NULL;
  v_header_value TEXT := NULL;
  v_auth JSONB := '{}'::jsonb;
  v_auth_mode TEXT := NULL;

  v_path TEXT := NULL;
  v_upstream_method TEXT := NULL;
  v_upstream_path TEXT := NULL;
  v_url TEXT := NULL;
  v_correlation_id UUID := gen_random_uuid();
  v_request_id UUID := NULL;
  v_outbound_id UUID := NULL;
BEGIN
  BEGIN v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_address_id := NULLIF(v_input->>'address_id', '')::UUID; EXCEPTION WHEN others THEN v_address_id := NULL; END;
  BEGIN v_support_case_id := NULLIF(v_input->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;

  IF v_shipment_id IS NULL OR v_client_id IS NULL OR v_address_id IS NULL THEN
    RETURN jsonb_build_object('mode', 'none', 'queued', FALSE, 'reason', 'invalid_request');
  END IF;

  IF v_support_case_id IS NOT NULL THEN
    v_correlation_id := v_support_case_id;
  END IF;

  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.tracking_number,
    s.metadata
  INTO v_shipment
  FROM public.shipments s
  WHERE s.id = v_shipment_id
    AND s.client_id = v_client_id
  LIMIT 1;

  IF v_shipment.id IS NULL THEN
    RETURN jsonb_build_object('mode', 'none', 'queued', FALSE, 'reason', 'shipment_not_found');
  END IF;

  SELECT
    a.id,
    a.line1,
    a.line2,
    a.normalized_line1,
    a.normalized_line2,
    a.city,
    a.province,
    a.district,
    a.country,
    a.postal_code,
    a.sa_short_code,
    CASE
      WHEN a.coordinates IS NULL THEN NULL
      ELSE round((ST_Y(a.coordinates::geometry)::numeric), 6)
    END AS latitude,
    CASE
      WHEN a.coordinates IS NULL THEN NULL
      ELSE round((ST_X(a.coordinates::geometry)::numeric), 6)
    END AS longitude
  INTO v_address
  FROM public.addresses a
  WHERE a.id = v_address_id
    AND a.client_id = v_shipment.client_id
  LIMIT 1;

  IF v_address.id IS NULL THEN
    RETURN jsonb_build_object('mode', 'none', 'queued', FALSE, 'reason', 'address_not_found');
  END IF;

  BEGIN
    v_source_request_id := NULLIF(v_shipment.metadata #>> ARRAY['source', 'api_gateway_request_id'], '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_source_request_id := NULL;
  END;

  IF v_source_request_id IS NULL THEN
    RETURN jsonb_build_object('mode', 'none', 'queued', FALSE, 'reason', 'provider_source_missing');
  END IF;

  SELECT agr.source_id
    INTO v_source_id
    FROM public.api_gateway_requests agr
   WHERE agr.id = v_source_request_id
   LIMIT 1;

  IF v_source_id IS NULL THEN
    RETURN jsonb_build_object('mode', 'none', 'queued', FALSE, 'reason', 'provider_source_missing');
  END IF;

  SELECT NULLIF(btrim(srn.reference_value), '')
    INTO v_provider_shipment_id
    FROM public.shipment_reference_numbers srn
   WHERE srn.shipment_id = v_shipment.id
     AND srn.client_id = v_shipment.client_id
     AND srn.reference_type = 'logistics_reference_number'
   ORDER BY srn.updated_at DESC NULLS LAST, srn.created_at DESC NULLS LAST, srn.reference_value
   LIMIT 1;

  v_provider_shipment_id := COALESCE(v_provider_shipment_id, NULLIF(btrim(v_shipment.tracking_number), ''));
  IF v_provider_shipment_id IS NULL THEN
    RETURN jsonb_build_object('mode', 'none', 'queued', FALSE, 'reason', 'provider_shipment_id_missing');
  END IF;

  v_route_result := public.resolve_api_route_v1(
    'PUT',
    '/api/guests/__company__/packages/__shipment__',
    v_shipment.organization_id,
    v_shipment.client_id,
    v_shipment.sender_id,
    v_source_id
  );

  IF COALESCE((v_route_result->>'found')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('mode', 'none', 'queued', FALSE, 'reason', 'provider_route_not_found');
  END IF;

  BEGIN v_route_id := NULLIF(v_route_result->>'route_id', '')::UUID; EXCEPTION WHEN others THEN v_route_id := NULL; END;
  BEGIN v_route_settings_resolution_id := NULLIF(v_route_result->>'settings_resolution_id', '')::UUID; EXCEPTION WHEN others THEN v_route_settings_resolution_id := NULL; END;
  v_route_name := NULLIF(v_route_result->>'route_name', '');

  SELECT *
    INTO v_route
    FROM public.api_routes
   WHERE id = v_route_id
   LIMIT 1;

  IF v_route.id IS NULL OR v_route.provider_id IS NULL THEN
    RETURN jsonb_build_object('mode', 'none', 'queued', FALSE, 'reason', 'provider_route_not_found');
  END IF;

  v_policy := COALESCE(v_route.policy, '{}'::jsonb);
  v_provider_id := v_route.provider_id;
  v_auth := COALESCE(v_policy->'auth', '{}'::jsonb);
  v_auth_mode := NULLIF(v_auth->>'mode', '');

  SELECT COALESCE(metadata->>'base_url', '')
    INTO v_provider_base_url
    FROM public.providers
   WHERE id = v_provider_id
   LIMIT 1;

  IF NULLIF(btrim(COALESCE(v_provider_base_url, '')), '') IS NULL THEN
    RETURN jsonb_build_object('mode', 'provider_update', 'queued', FALSE, 'reason', 'provider_base_url_missing');
  END IF;

  v_provider_account_policy := COALESCE(v_policy->'provider_account', '{}'::jsonb);
  v_provider_account_category := COALESCE(
    NULLIF(v_provider_account_policy->>'category', ''),
    NULLIF(v_auth->>'binding_category', '')
  );

  BEGIN
    v_provider_account_required := COALESCE((v_provider_account_policy->>'required')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_provider_account_required := TRUE;
  END;

  BEGIN
    v_provider_account_require_company_id := COALESCE((v_provider_account_policy->>'require_company_id')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_provider_account_require_company_id := FALSE;
  END;

  BEGIN
    v_provider_account_require_auth_config_id := COALESCE(
      (v_provider_account_policy->>'require_auth_config_id')::BOOLEAN,
      (v_auth_mode IS NOT NULL)
    );
  EXCEPTION
    WHEN others THEN
      v_provider_account_require_auth_config_id := (v_auth_mode IS NOT NULL);
  END;

  IF v_provider_account_category IS NULL THEN
    v_provider_account_required := FALSE;
    v_provider_account_require_company_id := FALSE;
    v_provider_account_require_auth_config_id := FALSE;
  END IF;

  IF v_provider_account_category IS NOT NULL THEN
    SELECT
      resolved.settings_id,
      resolved.settings_version_id,
      resolved.scope_type,
      resolved.scope_id,
      resolved.value,
      resolved.version,
      resolved.scope_path
    INTO
      v_provider_account_settings_id,
      v_provider_account_settings_version_id,
      v_provider_account_scope_type,
      v_provider_account_scope_id,
      v_provider_account_value,
      v_provider_account_version,
      v_provider_account_scope_path
    FROM public.resolve_settings_row(v_provider_account_category, 'source', v_source_id) AS resolved
    LIMIT 1;

    IF v_provider_account_settings_id IS NOT NULL THEN
      v_provider_account_settings_resolution_id := public.log_settings_resolution(
        p_organization_id := v_shipment.organization_id,
        p_category := v_provider_account_category,
        p_winning_scope_type := v_provider_account_scope_type,
        p_winning_scope_id := v_provider_account_scope_id,
        p_winning_settings_id := v_provider_account_settings_id,
        p_winning_settings_version_id := v_provider_account_settings_version_id,
        p_winning_version := v_provider_account_version,
        p_scope_path := v_provider_account_scope_path,
        p_inputs := jsonb_build_object(
          'source_id', v_source_id,
          'route_id', v_route.id,
          'shipment_id', v_shipment.id
        ),
        p_merge_notes := NULL
      );
    END IF;
  END IF;

  IF v_provider_account_required AND v_provider_account_settings_id IS NULL THEN
    RETURN jsonb_build_object('mode', 'provider_update', 'queued', FALSE, 'reason', 'provider_account_missing');
  END IF;

  v_provider_account_company_id := NULLIF(COALESCE(v_provider_account_value->>'company_id', ''), '');
  BEGIN
    v_provider_account_auth_config_id := NULLIF(COALESCE(v_provider_account_value->>'auth_config_id', ''), '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_provider_account_auth_config_id := NULL;
  END;

  IF v_provider_account_require_company_id AND v_provider_account_company_id IS NULL THEN
    RETURN jsonb_build_object('mode', 'provider_update', 'queued', FALSE, 'reason', 'provider_company_id_missing');
  END IF;

  IF v_provider_account_auth_config_id IS NOT NULL THEN
    v_auth := jsonb_set(v_auth, '{auth_config_id}', to_jsonb(v_provider_account_auth_config_id), TRUE);
  ELSIF v_provider_account_require_auth_config_id THEN
    RETURN jsonb_build_object('mode', 'provider_update', 'queued', FALSE, 'reason', 'provider_auth_config_missing');
  END IF;

  v_path_params := jsonb_strip_nulls(
    jsonb_build_object(
      'companyId', v_provider_account_company_id,
      'shipmentId', v_provider_shipment_id
    )
  );

  v_request_body := jsonb_strip_nulls(
    jsonb_build_object(
      'destinationAddress',
      jsonb_strip_nulls(
        jsonb_build_object(
          'addressLine1', COALESCE(NULLIF(btrim(v_address.normalized_line1), ''), NULLIF(btrim(v_address.line1), '')),
          'addressLine2', COALESCE(NULLIF(btrim(v_address.normalized_line2), ''), NULLIF(btrim(v_address.line2), '')),
          'city', NULLIF(btrim(v_address.city), ''),
          'region', NULLIF(btrim(v_address.province), ''),
          'district', NULLIF(btrim(v_address.district), ''),
          'country', NULLIF(btrim(v_address.country), ''),
          'zipCode', NULLIF(btrim(v_address.postal_code), ''),
          'nationalAddress', NULLIF(btrim(v_address.sa_short_code), ''),
          'latitude', v_address.latitude,
          'longitude', v_address.longitude
        )
      )
    )
  );

  v_path := public.api_render_path_template(v_route.path_template, v_path_params);
  v_upstream_method := upper(COALESCE(NULLIF(v_route.upstream_method, ''), v_route.method));
  v_upstream_path := public.api_render_path_template(
    COALESCE(NULLIF(v_route.upstream_path_template, ''), v_route.path_template),
    v_path_params
  );
  v_url := rtrim(v_provider_base_url, '/') || v_upstream_path;

  v_outbound_headers := COALESCE(v_request_headers, '{}'::jsonb)
    - 'authorization'
    - 'proxy-authorization'
    - 'x-webhook-token'
    - 'x-internal-edge-token';

  v_header_render_context := jsonb_build_object(
    'path_params', COALESCE(v_path_params, '{}'::jsonb),
    'headers', COALESCE(v_request_headers, '{}'::jsonb),
    'body', COALESCE(v_request_body, '{}'::jsonb),
    'source', jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_shipment.organization_id,
        'client_id', v_shipment.client_id,
        'sender_id', v_shipment.sender_id,
        'source_id', v_source_id
      )
    ),
    'provider', jsonb_strip_nulls(jsonb_build_object('id', v_provider_id)),
    'provider_account', COALESCE(v_provider_account_value, '{}'::jsonb)
  );

  v_header_defaults := COALESCE(v_policy #> '{headers,defaults}', '{}'::jsonb);
  IF jsonb_typeof(v_header_defaults) = 'object' THEN
    v_header_defaults := public.render_template(v_header_defaults, v_header_render_context);
    IF jsonb_typeof(v_header_defaults) = 'object' THEN
      FOR v_header_entry IN SELECT key, value FROM jsonb_each(v_header_defaults) LOOP
        v_header_name := lower(btrim(v_header_entry.key));
        IF v_header_name IS NULL OR v_header_name = '' THEN
          CONTINUE;
        END IF;

        IF v_header_name IN ('authorization', 'proxy-authorization', 'x-webhook-token', 'x-internal-edge-token') THEN
          CONTINUE;
        END IF;

        v_header_value := btrim(trim(both '"' FROM v_header_entry.value::TEXT));
        IF v_header_value IS NULL OR v_header_value = '' THEN
          CONTINUE;
        END IF;

        IF (v_outbound_headers ? v_header_name) IS FALSE OR btrim(COALESCE(v_outbound_headers->>v_header_name, '')) = '' THEN
          v_outbound_headers := jsonb_set(v_outbound_headers, ARRAY[v_header_name], to_jsonb(v_header_value), TRUE);
        END IF;
      END LOOP;
    END IF;
  END IF;

  v_header_overrides := COALESCE(v_policy #> '{headers,overrides}', '{}'::jsonb);
  IF jsonb_typeof(v_header_overrides) = 'object' THEN
    v_header_overrides := public.render_template(v_header_overrides, v_header_render_context);
    IF jsonb_typeof(v_header_overrides) = 'object' THEN
      FOR v_header_entry IN SELECT key, value FROM jsonb_each(v_header_overrides) LOOP
        v_header_name := lower(btrim(v_header_entry.key));
        IF v_header_name IS NULL OR v_header_name = '' THEN
          CONTINUE;
        END IF;

        IF v_header_name IN ('authorization', 'proxy-authorization', 'x-webhook-token', 'x-internal-edge-token') THEN
          CONTINUE;
        END IF;

        v_header_value := btrim(trim(both '"' FROM v_header_entry.value::TEXT));
        IF v_header_value IS NULL OR v_header_value = '' THEN
          CONTINUE;
        END IF;

        v_outbound_headers := jsonb_set(v_outbound_headers, ARRAY[v_header_name], to_jsonb(v_header_value), TRUE);
      END LOOP;
    END IF;
  END IF;

  INSERT INTO public.api_gateway_requests (
    organization_id,
    client_id,
    sender_id,
    source_id,
    correlation_id,
    route_id,
    settings_resolution_id,
    method,
    path,
    query_string,
    request_headers,
    request_body,
    received_at,
    created_at,
    updated_at
  )
  VALUES (
    v_shipment.organization_id,
    v_shipment.client_id,
    v_shipment.sender_id,
    v_source_id,
    v_correlation_id,
    v_route.id,
    v_route_settings_resolution_id,
    upper(v_route.method),
    v_path,
    NULL,
    COALESCE(v_request_headers, '{}'::jsonb),
    COALESCE(v_request_body, '{}'::jsonb),
    workflow_now(),
    workflow_now(),
    workflow_now()
  )
  RETURNING id INTO v_request_id;

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    status,
    priority,
    max_retries,
    scheduled_at,
    correlation_id,
    context,
    created_at
  )
  VALUES (
    'provider_api',
    'provider',
    v_provider_id,
    v_upstream_method,
    v_url,
    COALESCE(v_outbound_headers, '{}'::jsonb),
    COALESCE(v_request_body, '{}'::jsonb),
    'pending_edge',
    COALESCE(NULLIF(v_policy->>'priority', '')::INT, 100),
    COALESCE(NULLIF(v_policy->>'max_retries', '')::INT, 3),
    workflow_now(),
    v_correlation_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_shipment.organization_id,
        'client_id', v_shipment.client_id,
        'sender_id', v_shipment.sender_id,
        'source_id', v_source_id,
        'api_gateway_request_id', v_request_id,
        'api_gateway_route_id', v_route.id,
        'api_gateway_route_name', v_route_name,
        'api_gateway_path_params', v_path_params,
        'provider_account_category', v_provider_account_category,
        'provider_account_settings_resolution_id', v_provider_account_settings_resolution_id,
        'auth', v_auth
      )
    ),
    workflow_now()
  )
  RETURNING id INTO v_outbound_id;

  UPDATE public.api_gateway_requests
     SET outbound_call_id = v_outbound_id,
         updated_at = workflow_now()
   WHERE id = v_request_id;

  PERFORM public.log_decision(
    p_organization_id := v_shipment.organization_id,
    p_decision_category := 'api_gateway_postprocess',
    p_resource_type := 'shipment',
    p_resource_id := v_shipment.id,
    p_decision_point := 'public_tracking_provider_update_enqueued',
    p_decision_outcome := 'queued',
    p_performed_by_system := 'public_tracking_queue_provider_update_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(
      jsonb_build_object(
        'source_id', v_source_id,
        'route_id', v_route.id,
        'provider_id', v_provider_id,
        'provider_shipment_id', v_provider_shipment_id,
        'address_id', v_address.id,
        'api_gateway_request_id', v_request_id,
        'outbound_call_id', v_outbound_id
      )
    ),
    p_settings_resolution_id := COALESCE(v_provider_account_settings_resolution_id, v_route_settings_resolution_id)
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'mode', 'provider_update',
      'queued', TRUE,
      'source_id', v_source_id,
      'route_id', v_route.id,
      'route_name', v_route_name,
      'provider_id', v_provider_id,
      'provider_shipment_id', v_provider_shipment_id,
      'api_gateway_request_id', v_request_id,
      'outbound_call_id', v_outbound_id,
      'path', v_path
    )
  );
EXCEPTION
  WHEN others THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'mode', 'provider_update',
        'queued', FALSE,
        'reason', 'queue_failed',
        'error', left(SQLERRM, 800)
      )
    );
END;
$function$;

-------------------------------------------------------------------------------
-- 6) Canonical address mutation path with validation-first coverage gating
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.shipment_apply_destination_address_change_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID := NULL;
  v_client_id UUID := NULL;
  v_support_case_id UUID := NULL;
  v_request_type_key TEXT := public.public_tracking_request_type_key_v1(v_input->>'request_type_key');
  v_performed_by_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'performed_by_system', '')), ''), 'public_tracking');
  v_action_type TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'action_type', '')), ''), 'address_update');
  v_action_category TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'action_category', '')), ''), 'administrative');
  v_re_geocode BOOLEAN := COALESCE((v_input->>'re_geocode')::BOOLEAN, TRUE);
  v_geocode_template_name TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'geocode_template_name', '')), ''), 'workflow_geocoding_standard');
  v_address_text TEXT := NULLIF(btrim(COALESCE(v_input->>'address_text', '')), '');
  v_short_national_address TEXT := NULLIF(btrim(COALESCE(v_input->>'short_national_address', '')), '');
  v_landmark TEXT := NULLIF(btrim(COALESCE(v_input->>'landmark', '')), '');
  v_drop_point TEXT := NULLIF(
    btrim(COALESCE(v_input->>'drop_point', v_input->>'drop_point_details', '')),
    ''
  );
  v_notes TEXT := NULLIF(btrim(COALESCE(v_input->>'notes', '')), '');
  v_lat NUMERIC := NULL;
  v_lng NUMERIC := NULL;
  v_validation_result JSONB := '{}'::jsonb;
  v_validation JSONB := '{}'::jsonb;
  v_zone_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_shipment RECORD;
  v_existing_address RECORD;
  v_address_id UUID := NULL;
  v_geocode_template_id UUID := NULL;
  v_geocode_run_id UUID := NULL;
  v_action_id UUID := NULL;
  v_route_propagation JSONB := '{}'::jsonb;
  v_provider_propagation JSONB := '{}'::jsonb;
BEGIN
  BEGIN v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_support_case_id := NULLIF(v_input->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;
  BEGIN v_lat := NULLIF(v_input #>> ARRAY['map_pin','lat'], '')::NUMERIC; EXCEPTION WHEN others THEN v_lat := NULL; END;
  BEGIN v_lng := NULLIF(v_input #>> ARRAY['map_pin','lng'], '')::NUMERIC; EXCEPTION WHEN others THEN v_lng := NULL; END;

  IF v_shipment_id IS NULL OR v_client_id IS NULL OR v_address_text IS NULL OR v_short_national_address IS NULL OR v_lat IS NULL OR v_lng IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  v_validation_result := public.public_tracking_validate_location_change_v1(
    jsonb_build_object(
      'shipment_id', v_shipment_id,
      'client_id', v_client_id,
      'map_pin', jsonb_build_object('lat', v_lat, 'lng', v_lng)
    )
  );

  IF COALESCE((v_validation_result->>'ok')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok', FALSE,
        'error', COALESCE(v_validation_result->'error', jsonb_build_object('code', 'invalid_request')),
        'validation', v_validation_result->'validation'
      )
    );
  END IF;

  v_validation := COALESCE(v_validation_result->'validation', '{}'::jsonb);
  BEGIN v_zone_id := NULLIF(v_validation->>'zone_id', '')::UUID; EXCEPTION WHEN others THEN v_zone_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_validation->>'branch_id', '')::UUID; EXCEPTION WHEN others THEN v_branch_id := NULL; END;

  BEGIN
    SELECT
      s.id,
      s.organization_id,
      s.client_id,
      s.sender_id,
      s.status,
      s.tracking_number,
      s.destination_address_id
    INTO v_shipment
    FROM public.shipments s
    WHERE s.id = v_shipment_id
      AND s.client_id = v_client_id
    FOR UPDATE;

    IF v_shipment.id IS NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'shipment_not_found'));
    END IF;

    IF lower(COALESCE(v_shipment.status, '')) IN ('delivered', 'cancelled', 'canceled') THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object('code', 'shipment_state_blocked', 'status', v_shipment.status)
      );
    END IF;

    SELECT
      a.id,
      a.city,
      a.district,
      a.province,
      a.postal_code,
      a.country,
      a.building_number
    INTO v_existing_address
    FROM public.addresses a
    WHERE a.id = v_shipment.destination_address_id
      AND a.client_id = v_shipment.client_id
    LIMIT 1;

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
      additional_directions,
      created_at,
      updated_at
    )
    VALUES (
      gen_random_uuid(),
      v_shipment.organization_id,
      v_shipment.client_id,
      v_address_text,
      v_short_national_address,
      v_address_text,
      v_drop_point,
      COALESCE(NULLIF(v_validation->>'district', ''), NULLIF(v_existing_address.district, '')),
      COALESCE(NULLIF(v_validation->>'city', ''), NULLIF(v_existing_address.city, ''), 'Pending geocode'),
      COALESCE(NULLIF(v_existing_address.province, ''), NULLIF(v_validation->>'city', ''), 'Pending geocode'),
      NULLIF(v_existing_address.postal_code, ''),
      COALESCE(NULLIF(v_existing_address.country, ''), 'SA'),
      v_address_text,
      v_drop_point,
      'pending',
      ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography,
      public.public_tracking_compose_address_directions_v1(v_landmark, v_notes),
      workflow_now(),
      workflow_now()
    )
    RETURNING id INTO v_address_id;

    UPDATE public.shipments
       SET destination_address_id = v_address_id,
           zone_id = COALESCE(v_zone_id, zone_id),
           branch_id = COALESCE(v_branch_id, branch_id),
           updated_at = workflow_now()
     WHERE id = v_shipment.id
       AND client_id = v_shipment.client_id;

    IF v_re_geocode THEN
      SELECT wt.id
        INTO v_geocode_template_id
        FROM public.workflow_templates wt
       WHERE wt.name = v_geocode_template_name
         AND wt.status = 'active'
       ORDER BY wt.updated_at DESC NULLS LAST
       LIMIT 1;

      IF v_geocode_template_id IS NOT NULL THEN
        v_geocode_run_id := public.start_workflow_run(
          v_geocode_template_id,
          jsonb_build_object(
            'organization_id', v_shipment.organization_id,
            'client_id', v_shipment.client_id,
            'sender_id', v_shipment.sender_id,
            'shipment_id', v_shipment.id,
            'destination_address_id', v_address_id
          )
        );
      END IF;
    END IF;

    v_route_propagation := public.public_tracking_sync_active_route_stops_v1(
      jsonb_build_object(
        'shipment_id', v_shipment.id,
        'client_id', v_shipment.client_id,
        'support_case_id', v_support_case_id,
        'address_id', v_address_id,
        'address_text', v_address_text,
        'short_national_address', v_short_national_address,
        'landmark', v_landmark,
        'drop_point', v_drop_point,
        'notes', v_notes,
        'zone_id', v_zone_id,
        'branch_id', v_branch_id,
        'map_pin', jsonb_build_object('lat', v_lat, 'lng', v_lng)
      )
    );

    v_provider_propagation := public.public_tracking_queue_provider_update_v1(
      jsonb_build_object(
        'shipment_id', v_shipment.id,
        'client_id', v_shipment.client_id,
        'support_case_id', v_support_case_id,
        'address_id', v_address_id
      )
    );

    v_action_id := workflow_handlers.record_shipment_action_v1(
      v_shipment.id,
      lower(v_action_type),
      lower(v_action_category),
      jsonb_strip_nulls(
        jsonb_build_object(
          'address_id', v_address_id,
          'support_case_id', v_support_case_id,
          'request_type_key', v_request_type_key,
          'geocode_workflow_run_id', v_geocode_run_id,
          'short_national_address', v_short_national_address,
          'landmark', v_landmark,
          'drop_point', v_drop_point,
          'map_pin', jsonb_build_object('lat', round(v_lat, 6), 'lng', round(v_lng, 6)),
          'validation', v_validation,
          'route_propagation', v_route_propagation,
          'provider_propagation', v_provider_propagation
        )
      ),
      v_notes,
      NULL,
      v_performed_by_system,
      NULL
    );

    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok', TRUE,
        'shipment_id', v_shipment.id,
        'address_id', v_address_id,
        'shipment_action_id', v_action_id,
        'geocode_workflow_run_id', v_geocode_run_id,
        'validation', v_validation,
        'route_propagation', v_route_propagation,
        'provider_propagation', v_provider_propagation
      )
    );
  EXCEPTION
    WHEN others THEN
      RETURN jsonb_strip_nulls(
        jsonb_build_object(
          'ok', FALSE,
          'error', jsonb_build_object('code', 'apply_failed', 'message', left(SQLERRM, 800)),
          'validation', v_validation
        )
      );
  END;
END;
$function$;

-------------------------------------------------------------------------------
-- 6) Apply flow: pass landmark/drop-point through the canonical support-case lane
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_tracking_apply_support_case_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_support_case_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'public_tracking');
  v_case RECORD;
  v_policy JSONB;
  v_result JSONB;
  v_current_snapshot JSONB;
  v_applied_snapshot JSONB;
  v_action_id UUID := NULL;
BEGIN
  BEGIN v_support_case_id := NULLIF(v_input->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::UUID; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;

  IF v_support_case_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'support_case_id_required'));
  END IF;

  SELECT
    sc.id,
    sc.organization_id,
    sc.client_id,
    sc.sender_id,
    sc.resource_id,
    sc.status,
    sc.status_reason,
    sc.version,
    sc.request_source,
    sc.request_type_key,
    sc.metadata
  INTO v_case
  FROM public.support_cases sc
  WHERE sc.id = v_support_case_id
  FOR UPDATE;

  IF v_case.id IS NULL OR v_case.request_source <> 'public_tracking' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_case.status = 'resolved' AND v_case.status_reason = 'applied' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'support_case_id', v_case.id,
      'outcome', 'applied',
      'already_processed', TRUE,
      'current_snapshot', COALESCE(v_case.metadata->'current_snapshot', '{}'::jsonb)
    );
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_case.organization_id,
    'client_id', v_case.client_id,
    'sender_id', v_case.sender_id
  ));

  IF v_case.request_type_key = 'reschedule_date' THEN
    v_result := public.reserve_delivery_slot_v1(
      jsonb_build_object(
        'shipment_id', v_case.resource_id,
        'client_id', v_case.client_id,
        'slot_date', v_case.metadata #>> ARRAY['requested_snapshot','promised_delivery_date'],
        'performed_by_system', v_actor_system
      )
    );

    IF COALESCE((v_result->>'reserved')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object(
          'code', COALESCE(v_result->>'reason', 'apply_failed'),
          'message', COALESCE(v_result->>'reason', 'apply_failed')
        ),
        'current_snapshot', COALESCE(v_case.metadata->'current_snapshot', v_case.metadata->'before_snapshot', '{}'::jsonb)
      );
    END IF;
  ELSIF v_case.request_type_key = 'location_change' THEN
    v_result := public.shipment_apply_destination_address_change_v1(
      jsonb_build_object(
        'shipment_id', v_case.resource_id,
        'client_id', v_case.client_id,
        'support_case_id', v_case.id,
        'request_type_key', v_case.request_type_key,
        'performed_by_system', v_actor_system,
        'address_text', v_case.metadata #>> ARRAY['requested_snapshot','address','raw_input'],
        'short_national_address', v_case.metadata #>> ARRAY['requested_snapshot','address','short_national_address'],
        'landmark', v_case.metadata #>> ARRAY['requested_snapshot','address','landmark'],
        'drop_point', COALESCE(
          v_case.metadata #>> ARRAY['requested_snapshot','address','drop_point'],
          v_case.metadata #>> ARRAY['requested_snapshot','address','line2']
        ),
        'map_pin', COALESCE(v_case.metadata #> ARRAY['requested_snapshot','address','map_pin'], '{}'::jsonb),
        'notes', COALESCE(
          NULLIF(v_case.metadata->>'notes', ''),
          NULLIF(v_case.metadata #>> ARRAY['requested_snapshot','notes'], '')
        )
      )
    );

    IF COALESCE((v_result->>'ok')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
      RETURN jsonb_strip_nulls(
        jsonb_build_object(
          'ok', FALSE,
          'error', jsonb_build_object(
            'code', COALESCE(v_result #>> ARRAY['error','code'], 'apply_failed'),
            'message', COALESCE(v_result #>> ARRAY['error','message'], v_result #>> ARRAY['error','code'], 'apply_failed')
          ),
          'validation', v_result->'validation',
          'current_snapshot', COALESCE(v_case.metadata->'current_snapshot', v_case.metadata->'before_snapshot', '{}'::jsonb)
        )
      );
    END IF;

    BEGIN
      v_action_id := NULLIF(v_result->>'shipment_action_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_action_id := NULL;
    END;
  ELSE
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  v_current_snapshot := public.public_tracking_shipment_snapshot_v1(v_case.resource_id, v_case.client_id);
  v_applied_snapshot := COALESCE(v_current_snapshot, '{}'::jsonb);

  IF v_case.request_type_key = 'reschedule_date' THEN
    v_action_id := workflow_handlers.record_shipment_action_v1(
      v_case.resource_id,
      'customer_change_applied',
      'administrative',
      jsonb_build_object(
        'support_case_id', v_case.id,
        'request_type_key', v_case.request_type_key,
        'changed_fields', COALESCE(v_case.metadata->'changed_fields', '[]'::jsonb),
        'diff', COALESCE(v_case.metadata->'diff', '{}'::jsonb),
        'reservation_result', v_result
      ),
      NULL,
      NULL,
      v_actor_system,
      NULL
    );
  END IF;

  UPDATE public.support_cases
     SET status = 'resolved',
         status_reason = 'applied',
         resolved_at = COALESCE(resolved_at, workflow_now()),
         version = version + 1,
         metadata = public.deep_merge_jsonb(
           metadata,
           jsonb_strip_nulls(
             jsonb_build_object(
               'request_outcome', 'applied',
               'applied_snapshot', v_applied_snapshot,
               'current_snapshot', v_current_snapshot,
               'applied_at', workflow_now(),
               'last_apply_error', NULL
             )
           )
         ),
         updated_at = workflow_now()
   WHERE id = v_case.id
   RETURNING version, metadata INTO v_case.version, v_case.metadata;

  INSERT INTO public.support_case_events (
    support_case_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    case_version,
    created_at
  )
  VALUES (
    v_case.id,
    v_case.organization_id,
    'applied',
    v_case.status,
    'resolved',
    v_actor_user_id,
    v_actor_system,
    public.deep_merge_jsonb(
      public.public_tracking_event_payload_v1(
        v_case.request_type_key,
        COALESCE(v_case.metadata->'before_snapshot', '{}'::jsonb),
        COALESCE(v_case.metadata->'requested_snapshot', '{}'::jsonb),
        '{}'::jsonb
      ),
      jsonb_strip_nulls(
        jsonb_build_object(
          'apply_outcome', 'applied',
          'applied_snapshot', v_applied_snapshot,
          'current_snapshot', v_current_snapshot,
          'shipment_action_id', v_action_id,
          'apply_result', v_result
        )
      )
    ),
    format('customer-shipment-change:applied:%s:%s', v_case.id, v_case.version),
    v_case.version,
    workflow_now()
  );

  PERFORM public.public_tracking_emit_support_message_v1(
    v_case.id,
    v_case.organization_id,
    'internal',
    'internal',
    v_actor_system,
    format('Customer shipment change applied (%s).', v_case.request_type_key),
    jsonb_build_object('request_outcome', 'applied')
  );

  IF public.public_tracking_bool_v1(v_policy, ARRAY['notifications','requester_applied'], TRUE) THEN
    PERFORM public.public_tracking_enqueue_recipient_notification_v1(
      v_case.id,
      v_case.organization_id,
      NULLIF(v_case.metadata->>'recipient_id', '')::UUID,
      'applied',
      format('Your %s request was applied.', replace(v_case.request_type_key, '_', ' ')),
      jsonb_build_object('change_summary', v_case.metadata->>'change_summary')
    );
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'support_case_id', v_case.id,
      'outcome', 'applied',
      'current_snapshot', v_current_snapshot,
      'applied_snapshot', v_applied_snapshot,
      'apply_result', v_result
    )
  );
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202604091030_b09_uc127_uc128_uc129_public_tracking_address_correction_v1'));

COMMIT;
