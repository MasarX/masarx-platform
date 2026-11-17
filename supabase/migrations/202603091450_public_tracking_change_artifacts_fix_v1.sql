-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S04
-- Fix public tracking diff artifact generation to avoid jagged multidimensional arrays.

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
        jsonb_strip_nulls(jsonb_build_object('from', NULLIF(v_from, 'null'::jsonb), 'to', NULLIF(v_to, 'null'::jsonb)))
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
