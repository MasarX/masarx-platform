-- Console V2 shipment file imports must persist the operational shipment
-- fields exposed by the row-driven import contract. The workflow handler owns
-- shipment creation; this wrapper preserves file-mapped fields that the base
-- handler does not yet materialize directly from flat tabular payloads.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605081910_console_v2_shipment_import_write_fields_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_cod_amount NUMERIC;
  v_cod_amount_text TEXT;
  v_cod_currency TEXT;
  v_box_count INT;
  v_box_count_text TEXT;
  v_promised_delivery_date DATE;
  v_promised_delivery_date_text TEXT;
  v_special_instructions TEXT;
  v_shipment_payload JSONB;
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
  v_cod_amount_text := NULLIF(btrim(COALESCE(v_payload->>'cod_amount', '')), '');
  v_cod_currency := NULLIF(btrim(COALESCE(v_payload->>'cod_currency', '')), '');
  v_box_count_text := NULLIF(btrim(COALESCE(v_payload->>'box_count', '')), '');
  v_promised_delivery_date_text := NULLIF(btrim(COALESCE(v_payload->>'promised_delivery_date', '')), '');
  v_special_instructions := NULLIF(btrim(COALESCE(v_payload->>'special_instructions', '')), '');

  IF v_org IS NULL OR v_client IS NULL OR v_tracking IS NULL THEN
    RAISE EXCEPTION 'tabular_import_write_shipment_v1 requires organization_id, client_id, and tracking_number';
  END IF;

  IF v_cod_amount_text IS NOT NULL THEN
    IF v_cod_amount_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
      v_cod_amount := v_cod_amount_text::NUMERIC;
    ELSE
      RAISE EXCEPTION 'tabular_import_write_shipment_v1 cod_amount must be numeric';
    END IF;
  END IF;

  IF v_box_count_text IS NOT NULL THEN
    IF v_box_count_text ~ '^[0-9]+$' THEN
      v_box_count := v_box_count_text::INT;
    ELSE
      RAISE EXCEPTION 'tabular_import_write_shipment_v1 box_count must be an integer';
    END IF;
    IF v_box_count < 1 THEN
      RAISE EXCEPTION 'tabular_import_write_shipment_v1 box_count must be at least 1';
    END IF;
  END IF;

  IF v_promised_delivery_date_text IS NOT NULL THEN
    BEGIN
      v_promised_delivery_date := v_promised_delivery_date_text::DATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'tabular_import_write_shipment_v1 promised_delivery_date must be a date';
    END;
  END IF;

  v_shipment_payload := jsonb_strip_nulls(jsonb_build_object(
    'tracking_number', v_tracking,
    'client_reference_number', v_client_reference,
    'carrier_reference_number', v_carrier_reference,
    'service_type', v_service_type,
    'status', v_status,
    'recipient_id', v_recipient_id,
    'destination_address_id', v_destination_address_id,
    'origin_address_id', v_origin_address_id,
    'cod_amount', v_cod_amount,
    'cod_currency', v_cod_currency,
    'box_count', v_box_count,
    'promised_delivery_date', v_promised_delivery_date,
    'special_instructions', v_special_instructions
  ));

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
    'shipment', v_shipment_payload,
    'payload', jsonb_build_object(
      'resource', jsonb_strip_nulls(
        v_payload || jsonb_build_object(
          'shipment', v_shipment_payload,
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
         cod_amount = COALESCE(v_cod_amount, cod_amount),
         cod_currency = COALESCE(v_cod_currency, cod_currency),
         box_count = COALESCE(v_box_count, box_count),
         promised_delivery_date = COALESCE(v_promised_delivery_date, promised_delivery_date),
         special_instructions = COALESCE(v_special_instructions, special_instructions),
         updated_at = now()
   WHERE id = v_shipment_id
     AND (
       v_recipient_id IS NOT NULL
       OR v_destination_address_id IS NOT NULL
       OR v_origin_address_id IS NOT NULL
       OR v_cod_amount IS NOT NULL
       OR v_cod_currency IS NOT NULL
       OR v_box_count IS NOT NULL
       OR v_promised_delivery_date IS NOT NULL
       OR v_special_instructions IS NOT NULL
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

SELECT pg_advisory_unlock(hashtext('202605081910_console_v2_shipment_import_write_fields_v1'));
COMMIT;
