-- Plan: PLAN-B01-UC030 / Step: S05
-- Migration: Keep shipment address fallback country policy-driven in an append-only override

BEGIN;

SELECT pg_advisory_lock(hashtext('202603211120_shipment_address_policy_country_default_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
    normalized_line1,
    normalized_line2,
    district,
    city,
    province,
    postal_code,
    country,
    building_number,
    additional_directions,
    validation_status
  ) VALUES (
    v_target.organization_id,
    v_target.client_id,
    COALESCE(NULLIF(v_address->>'raw_input', ''), v_address::TEXT),
    v_line1,
    v_line2,
    v_district,
    v_city,
    v_province,
    v_postal_code,
    v_country,
    v_building_number,
    v_directions,
    v_validation_status
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
        jsonb_build_object(
          'organization_id', v_target.organization_id,
          'client_id', v_target.client_id,
          'sender_id', v_target.sender_id,
          'shipment_id', v_target.shipment_id,
          'destination_address_id', v_address_id
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
        'idempotency_key', v_event_id,
        'address_id', v_address_id,
        'geocode_workflow_run_id', v_geocode_run_id
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
  v_result.context_patch := jsonb_build_object(
    'shipment',
    jsonb_build_object(
      'id',
      v_target.shipment_id,
      'tracking_number',
      v_target.tracking_number,
      'destination_address_id',
      v_address_id
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
      v_geocode_run_id
    )
  );
  RETURN v_result;
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202603211120_shipment_address_policy_country_default_v1'));

COMMIT;
