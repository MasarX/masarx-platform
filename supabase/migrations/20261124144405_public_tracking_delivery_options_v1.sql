BEGIN;

UPDATE public.schema_registry
SET schema = jsonb_set(schema, '{properties,actions,properties,delivery_option}', '{
  "type":"object",
  "additionalProperties":false,
  "properties":{
    "allowed_statuses":{"type":"array","items":{"type":"string"},"uniqueItems":true},
    "branch_pickup_enabled":{"type":"boolean"},
    "safe_place_enabled":{"type":"boolean"},
    "consent_copy":{"type":"string"}
  }
}'::jsonb)
WHERE category = 'public_tracking_policy' AND version = 1;

-- Options use the existing tenant tracking policy and branch directory.
CREATE FUNCTION public.public_tracking_delivery_option_choices_v1(p_shipment public.shipments, p_policy jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_allowed_statuses jsonb := COALESCE(
    p_policy #> '{actions,delivery_option,allowed_statuses}',
    '["created","pending","pending_dispatch","in_transit"]'::jsonb
  );
  v_current text := COALESCE(p_shipment.metadata #>> '{recipient_delivery_option,option}', 'home_delivery');
  v_choices jsonb := '[]'::jsonb;
  v_place boolean := false;
BEGIN
  IF jsonb_typeof(v_allowed_statuses) = 'array'
    AND v_allowed_statuses ? p_shipment.status
    AND public.is_active_lookup_value_v1('shipment_status', p_shipment.status)
    AND COALESCE(p_shipment.service_type, '') = 'delivery'
    AND p_shipment.metadata->'recipient_delivery_option_switched_back' IS DISTINCT FROM 'true'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM public.route_stops rs
      JOIN public.route_runs rr ON rr.id = rs.route_run_id AND rr.organization_id = rs.organization_id
      WHERE (rs.organization_id, rs.client_id, rs.shipment_id) =
        (p_shipment.organization_id, p_shipment.client_id, p_shipment.id)
        AND rr.status = 'in_progress'
    ) THEN
    IF v_current <> 'home_delivery' THEN
      v_choices := '["home_delivery"]'::jsonb;
    ELSE
      IF public.public_tracking_bool_v1(p_policy, '{actions,delivery_option,branch_pickup_enabled}', false) THEN
        v_choices := v_choices || '"branch_pickup"'::jsonb;
      END IF;
      v_place := COALESCE(p_shipment.cod_amount, 0) = 0
        AND public.public_tracking_bool_v1(p_policy, '{actions,delivery_option,safe_place_enabled}', false);
      IF v_place THEN
        v_choices := v_choices || '"safe_place"'::jsonb;
      END IF;
      IF jsonb_array_length(v_choices) > 0 THEN
        v_choices := '["home_delivery"]'::jsonb || v_choices;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'changes_open', jsonb_array_length(v_choices) > 0,
    'choices', v_choices, 'branches', '[]'::jsonb,
    'safe_place', CASE WHEN v_place THEN jsonb_build_object(
      'places', jsonb_build_array('reception', 'neighbour', 'other'),
      'consent_copy', p_policy #> '{actions,delivery_option,consent_copy}'
    ) END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.public_tracking_delivery_option_choices_v1(public.shipments, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_tracking_delivery_option_choices_v1(public.shipments, jsonb) TO service_role;

CREATE FUNCTION api.public_tracking_delivery_options_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_body jsonb := public.public_tracking_session_v1(p_input);
  v_shipment public.shipments%ROWTYPE;
  v_options jsonb;
  v_branches jsonb;
  v_district geography;
BEGIN
  IF v_body->'ok' IS DISTINCT FROM 'true'::jsonb THEN
    RETURN v_body;
  END IF;

  SELECT s.* INTO v_shipment
  FROM public.tracking_sessions ts
  JOIN public.shipments s ON (s.id, s.client_id, s.organization_id) =
    (ts.shipment_id, ts.client_id, ts.organization_id)
  WHERE ts.status = 'active'
    AND (ts.expires_at IS NULL OR ts.expires_at > workflow_now())
    AND s.tracking_number = v_body #>> '{tracking,shipment,tracking_number}'
    AND ts.token_hash = crypt(btrim(p_input->>'session_token'), ts.token_hash)
  ORDER BY ts.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_session'));
  END IF;

  v_options := public.public_tracking_delivery_option_choices_v1(v_shipment,
    public.public_tracking_policy_v1(jsonb_build_object(
      'organization_id', v_shipment.organization_id,
      'client_id', v_shipment.client_id,
      'sender_id', v_shipment.sender_id
    ))
  );

  IF v_options->'choices' ? 'branch_pickup' THEN
    SELECT cd.centroid INTO v_district
    FROM public.addresses a
    JOIN public.canonical_districts cd ON cd.organization_id = v_shipment.organization_id
      AND cd.is_active AND lower(btrim(a.district)) IN (lower(cd.name_canonical), lower(cd.name_arabic))
    JOIN public.canonical_cities cc ON cc.id = cd.city_id AND cc.organization_id = cd.organization_id
      AND cc.is_active AND lower(btrim(a.city)) IN (lower(cc.name_canonical), lower(cc.name_arabic))
    WHERE a.id = v_shipment.destination_address_id AND a.client_id = v_shipment.client_id
    ORDER BY cd.centroid IS NULL, cd.id
    LIMIT 1;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name,
      'address', jsonb_strip_nulls(jsonb_build_object(
        'formatted', b.address->>'formatted', 'line1', b.address->>'line1', 'street', b.address->>'street',
        'district', b.address->>'district', 'city', b.address->>'city', 'postal_code', b.address->>'postal_code'
      )),
      'opening_hours', jsonb_strip_nulls(jsonb_build_object(
        'timezone', b.timezone,
        'opens_at', b.operating_hours->>'opens_at',
        'closes_at', b.operating_hours->>'closes_at'
      )),
      'distance_km', round((distance.metres / 1000)::numeric, 1)
    ) ORDER BY distance.metres NULLS LAST, b.name, b.id), '[]'::jsonb)
    INTO v_branches
    FROM public.branches b
    CROSS JOIN LATERAL (SELECT ST_Distance(b.coordinates, v_district) AS metres) distance
    WHERE b.organization_id = v_shipment.organization_id
      AND b.is_active AND b.metadata->'pickup_enabled' = 'true'::jsonb;

    v_options := jsonb_set(v_options, '{branches}', v_branches);
  END IF;

  RETURN jsonb_build_object('ok', true, 'delivery_options', v_options);
END;
$function$;

REVOKE ALL ON FUNCTION api.public_tracking_delivery_options_v1(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.public_tracking_delivery_options_v1(jsonb) TO service_role;

CREATE FUNCTION public.public_tracking_validate_delivery_option_v1(
  p_org uuid, p_client uuid, p_shipment uuid, p_payload jsonb, p_policy jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_shipment public.shipments%ROWTYPE;
  v_choice text := p_payload->>'option';
  v_place text := p_payload->>'place';
  v_instruction text := NULLIF(btrim(p_payload->>'instruction'), '');
  v_options jsonb;
  v_branch uuid;
  v_selection jsonb;
BEGIN
  -- Lock the run before the shipment, in departure's order.
  PERFORM rr.id
  FROM public.route_stops rs
  JOIN public.route_runs rr ON rr.id = rs.route_run_id AND rr.organization_id = rs.organization_id
  WHERE (rs.organization_id, rs.client_id, rs.shipment_id) = (p_org, p_client, p_shipment)
    AND rr.status IN ('planned', 'in_progress')
  ORDER BY rr.id FOR SHARE OF rr;

  SELECT s.* INTO v_shipment FROM public.shipments s
  WHERE (s.organization_id, s.client_id, s.id) = (p_org, p_client, p_shipment)
  FOR UPDATE;

  v_options := public.public_tracking_delivery_option_choices_v1(v_shipment, p_policy);
  IF NOT FOUND OR v_options->'changes_open' = 'false'::jsonb THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'changes_closed'));
  END IF;
  IF NOT COALESCE(v_options->'choices' ? v_choice, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  v_selection := jsonb_build_object('option', v_choice);
  IF v_choice = 'branch_pickup' THEN
    SELECT b.id INTO v_branch
    FROM public.branches b
    WHERE b.organization_id = p_org AND b.id::text = p_payload->>'branch_id'
      AND b.is_active AND b.metadata->'pickup_enabled' = 'true'::jsonb
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_request'));
    END IF;
    v_selection := v_selection || jsonb_build_object('branch_id', v_branch);
  ELSIF v_choice = 'safe_place' THEN
    IF NOT COALESCE((v_options #> '{safe_place,places}') ? v_place, false)
      OR p_payload->'consent' IS DISTINCT FROM 'true'::jsonb
      OR (v_place = 'other' AND (v_instruction IS NULL OR length(v_instruction) > 120))
      OR (v_place <> 'other' AND v_instruction IS NOT NULL) THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_request'));
    END IF;
    v_selection := v_selection || jsonb_strip_nulls(jsonb_build_object(
      'place', v_place, 'instruction', v_instruction, 'consent', true
    ));
  ELSIF COALESCE(v_shipment.metadata #>> '{recipient_delivery_option,option}', 'home_delivery') = 'home_delivery' THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'selection', v_selection, 'previous', v_shipment.metadata->'recipient_delivery_option'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.public_tracking_validate_delivery_option_v1(uuid, uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_tracking_validate_delivery_option_v1(uuid, uuid, uuid, jsonb, jsonb) TO service_role;

CREATE FUNCTION public.public_tracking_apply_delivery_option_v1(
  p_org uuid, p_client uuid, p_shipment uuid, p_payload jsonb, p_policy jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_result jsonb := public.public_tracking_validate_delivery_option_v1(p_org, p_client, p_shipment, p_payload, p_policy);
  v_option jsonb := (v_result->'selection') - 'consent';
BEGIN
  IF v_result->'ok' IS DISTINCT FROM 'true'::jsonb THEN
    RETURN v_result;
  END IF;
  IF v_option IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'changes_closed'));
  END IF;

  UPDATE public.shipments s
  SET metadata = COALESCE(s.metadata, '{}'::jsonb) || jsonb_build_object(
    'recipient_delivery_option', v_option,
    'recipient_delivery_option_switched_back', v_option->>'option' = 'home_delivery'
  )
  WHERE (s.organization_id, s.client_id, s.id) = (p_org, p_client, p_shipment);

  UPDATE public.route_stops rs
  SET metadata = rs.metadata || jsonb_build_object('recipient_delivery_option', v_option)
  FROM public.route_runs rr
  WHERE rr.id = rs.route_run_id AND rr.organization_id = rs.organization_id AND rr.status = 'planned'
    AND (rs.organization_id, rs.client_id, rs.shipment_id) = (p_org, p_client, p_shipment)
    AND rs.stop_kind = 'delivery' AND rs.metadata->>'shipment_action' IS NULL;

  RETURN jsonb_build_object('ok', true, 'recipient_delivery_option', v_option);
END;
$function$;

REVOKE ALL ON FUNCTION public.public_tracking_apply_delivery_option_v1(uuid, uuid, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_tracking_apply_delivery_option_v1(uuid, uuid, uuid, jsonb, jsonb) TO service_role;

CREATE FUNCTION public.route_stop_inherit_recipient_delivery_option_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_option jsonb;
BEGIN
  IF NEW.stop_kind = 'delivery' THEN
    SELECT s.metadata->'recipient_delivery_option' INTO v_option
    FROM public.shipments s
    WHERE (s.organization_id, s.client_id, s.id) = (NEW.organization_id, NEW.client_id, NEW.shipment_id);
    NEW.metadata := NEW.metadata - 'recipient_delivery_option';
    IF v_option IS NOT NULL THEN
      NEW.metadata := NEW.metadata || jsonb_build_object('recipient_delivery_option', v_option);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.route_stop_inherit_recipient_delivery_option_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.route_stop_inherit_recipient_delivery_option_v1() TO service_role;

CREATE TRIGGER trg_route_stop_inherit_recipient_delivery_option
BEFORE INSERT ON public.route_stops FOR EACH ROW
EXECUTE FUNCTION public.route_stop_inherit_recipient_delivery_option_v1();

-- Extend the live catalog bodies and retain all existing intake, review, and audit behavior.
DO $migration$
DECLARE
  v_submit text := pg_get_functiondef('public.public_tracking_submit_request_v2(jsonb)'::regprocedure);
  v_apply text := pg_get_functiondef('public.public_tracking_apply_support_case_v1(jsonb)'::regprocedure);
  v_type constant text := $anchor$public.public_tracking_request_type_key_v1(v_input->>'request_type')$anchor$;
  v_submit_branch constant text := $anchor$  IF v_request_type = 'reschedule_date' THEN$anchor$;
  v_snapshot constant text := $anchor$  v_requested_snapshot := public.public_tracking_requested_snapshot_v1(v_request_type, v_before_snapshot, v_payload);$anchor$;
  v_apply_branch constant text := $anchor$  IF v_case.request_type_key = 'reschedule_date' THEN
    v_result := public.reserve_delivery_slot_v1($anchor$;
  v_applied_snapshot constant text := $anchor$  v_applied_snapshot := COALESCE(v_current_snapshot, '{}'::jsonb);$anchor$;
BEGIN
  IF cardinality(string_to_array(v_submit, v_type)) <> 2
    OR cardinality(string_to_array(v_submit, v_submit_branch)) <> 2
    OR cardinality(string_to_array(v_submit, v_snapshot)) <> 2
    OR cardinality(string_to_array(v_apply, v_apply_branch)) <> 2
    OR cardinality(string_to_array(v_apply, v_applied_snapshot)) <> 2 THEN
    RAISE EXCEPTION 'public tracking support-case contract changed';
  END IF;

  v_submit := replace(v_submit, v_type, $replacement$
  CASE WHEN v_input->>'request_type' = 'delivery_option' THEN 'delivery_option'
       ELSE public.public_tracking_request_type_key_v1(v_input->>'request_type') END$replacement$);
  v_submit := replace(v_submit, v_submit_branch, $replacement$
  IF v_request_type = 'delivery_option' THEN
    v_execution_mode := 'review_required';
    v_requester_channel := 'public_tracking';
    v_apply_result := public.public_tracking_validate_delivery_option_v1(
      v_session.organization_id, v_session.client_id, v_session.shipment_id, v_payload, v_policy
    );
    IF v_apply_result->'ok' IS DISTINCT FROM 'true'::jsonb THEN
      PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'invalid_request',
        v_session.organization_id, v_session.client_id, v_session.shipment_id, v_session.id);
      RETURN v_apply_result;
    END IF;
    SELECT sc.id, sc.metadata INTO v_case_id, v_case_metadata
    FROM public.support_cases sc
    WHERE (sc.organization_id, sc.client_id, sc.resource_id) =
      (v_session.organization_id, v_session.client_id, v_session.shipment_id)
      AND sc.request_source = 'public_tracking' AND sc.request_type_key = 'delivery_option'
      AND sc.status = 'open'
    ORDER BY sc.created_at DESC, sc.id DESC
    LIMIT 1;
    IF FOUND THEN
      IF v_case_metadata #> '{requested_snapshot,recipient_delivery_option}' IS DISTINCT FROM v_apply_result->'selection' THEN
        PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'invalid_request',
          v_session.organization_id, v_session.client_id, v_session.shipment_id, v_session.id);
        RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'changes_closed'));
      END IF;
      RETURN jsonb_build_object('ok', true, 'submitted', false, 'deduped', true, 'support_case_id', v_case_id,
        'request_type', v_request_type, 'outcome', 'pending_review',
        'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy));
    END IF;
    IF v_apply_result->'unchanged' = 'true'::jsonb THEN
      RETURN jsonb_build_object('ok', true, 'submitted', false, 'request_type', v_request_type, 'outcome', 'applied',
        'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy));
    END IF;
    v_payload := v_apply_result->'selection';
  ELSIF v_request_type = 'reschedule_date' THEN$replacement$);
  v_submit := replace(v_submit, v_snapshot, $replacement$
  IF v_request_type = 'delivery_option' THEN
    v_before_snapshot := v_before_snapshot || jsonb_build_object('recipient_delivery_option', v_apply_result->'previous');
    v_requested_snapshot := v_before_snapshot || jsonb_build_object('recipient_delivery_option', v_payload);
  ELSE
    v_requested_snapshot := public.public_tracking_requested_snapshot_v1(v_request_type, v_before_snapshot, v_payload);
  END IF;$replacement$);
  EXECUTE v_submit;

  v_apply := replace(v_apply, v_apply_branch, $replacement$
  IF v_case.request_type_key = 'delivery_option' THEN
    v_result := public.public_tracking_apply_delivery_option_v1(
      v_case.organization_id, v_case.client_id, v_case.resource_id,
      v_case.metadata #> '{requested_snapshot,recipient_delivery_option}', v_policy
    );
    IF v_result->'ok' IS DISTINCT FROM 'true'::jsonb THEN
      RETURN v_result;
    END IF;
  ELSIF v_case.request_type_key = 'reschedule_date' THEN
    v_result := public.reserve_delivery_slot_v1($replacement$);
  v_apply := replace(v_apply, v_applied_snapshot, $replacement$
  IF v_case.request_type_key = 'delivery_option' THEN
    v_current_snapshot := v_current_snapshot || jsonb_build_object(
      'recipient_delivery_option', v_result->'recipient_delivery_option'
    );
  END IF;
  v_applied_snapshot := COALESCE(v_current_snapshot, '{}'::jsonb);$replacement$);
  EXECUTE v_apply;
END;
$migration$;

COMMIT;
