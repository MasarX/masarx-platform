BEGIN;

CREATE OR REPLACE FUNCTION public.tabular_import_write_shipment_v1(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_org UUID;
  v_client UUID;
  v_sender UUID;
  v_tracking TEXT;
  v_client_reference TEXT;
  v_carrier_reference TEXT;
  v_service_type TEXT;
  v_status TEXT;
  v_recipient_id UUID;
  v_destination_address_id UUID;
  v_origin_address_id UUID;
  v_run_id UUID := gen_random_uuid();
  v_step_id UUID := gen_random_uuid();
  v_run_context JSONB;
  v_run public.workflow_runs;
  v_step public.workflow_run_steps;
  v_response public.workflow_handler_response;
  v_shipment_id UUID;
  v_result JSONB;
BEGIN
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'tabular_import_write_shipment_v1 requires payload object';
  END IF;

  v_org := NULLIF(btrim(COALESCE(v_payload->>'organization_id', '')), '')::UUID;
  v_client := NULLIF(btrim(COALESCE(v_payload->>'client_id', '')), '')::UUID;
  v_sender := NULLIF(btrim(COALESCE(v_payload->>'sender_id', '')), '')::UUID;
  v_tracking := NULLIF(btrim(COALESCE(v_payload->>'tracking_number', '')), '');
  v_client_reference := NULLIF(btrim(COALESCE(v_payload->>'client_reference_number', '')), '');
  v_carrier_reference := NULLIF(btrim(COALESCE(v_payload->>'carrier_reference_number', '')), '');
  v_service_type := COALESCE(NULLIF(btrim(COALESCE(v_payload->>'service_type', '')), ''), 'delivery');
  v_status := COALESCE(NULLIF(btrim(COALESCE(v_payload->>'status', '')), ''), 'pending');
  v_recipient_id := public.mapping_studio_try_uuid_v1(v_payload->>'recipient_id');
  v_destination_address_id := public.mapping_studio_try_uuid_v1(v_payload->>'destination_address_id');
  v_origin_address_id := public.mapping_studio_try_uuid_v1(v_payload->>'origin_address_id');

  IF v_org IS NULL OR v_client IS NULL OR v_tracking IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_shipment_v1 requires organization_id, client_id, and tracking_number';
  END IF;

  v_run_context := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org,
    'client_id', v_client,
    'sender_id', v_sender,
    'planned_tracking_number', v_tracking,
    'client_reference_number', v_client_reference,
    'carrier_reference_number', v_carrier_reference,
    'recipient_id', v_recipient_id,
    'destination_address_id', v_destination_address_id,
    'origin_address_id', v_origin_address_id,
    'service_type', v_service_type,
    'initial_status', v_status,
    'payload', jsonb_build_object(
      'resource', jsonb_strip_nulls(
        v_payload || jsonb_build_object(
          'tracking_number', v_tracking,
          'client_reference_number', v_client_reference,
          'carrier_reference_number', v_carrier_reference,
          'recipient_id', v_recipient_id,
          'destination_address_id', v_destination_address_id,
          'origin_address_id', v_origin_address_id,
          'references', jsonb_strip_nulls(jsonb_build_object(
            'client_reference_number', v_client_reference,
            'carrier_reference_number', v_carrier_reference
          ))
        )
      )
    )
  ));

  v_run := jsonb_populate_record(
    NULL::public.workflow_runs,
    jsonb_build_object(
      'id', v_run_id,
      'context', v_run_context
    )
  );
  v_step := jsonb_populate_record(
    NULL::public.workflow_run_steps,
    jsonb_build_object(
      'id', v_step_id,
      'workflow_run_id', v_run_id
    )
  );

  v_response := workflow_handlers.execute_shipment_create_v1(
    v_step,
    v_run,
    '{}'::jsonb
  );

  v_shipment_id := NULLIF(
    btrim(
      COALESCE(
        v_response.operation_result->>'shipment_id',
        v_response.context_patch #>> '{shipment,id}',
        ''
      )
    ),
    ''
  )::UUID;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_shipment_v1 failed to resolve shipment id';
  END IF;

  UPDATE public.shipments
     SET recipient_id = COALESCE(recipient_id, v_recipient_id),
         destination_address_id = COALESCE(destination_address_id, v_destination_address_id),
         origin_address_id = COALESCE(origin_address_id, v_origin_address_id),
         updated_at = now()
   WHERE id = v_shipment_id
     AND (
       v_recipient_id IS NOT NULL
       OR v_destination_address_id IS NOT NULL
       OR v_origin_address_id IS NOT NULL
     );

  SELECT to_jsonb(s.*)
    INTO v_result
    FROM public.shipments s
   WHERE s.id = v_shipment_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_shipment_v1 failed to load shipment %', v_shipment_id;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tabular_import_write_shipment_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_write_shipment_v1(JSONB) TO service_role;

COMMIT;
