-- Plan: PLAN-202603-webhook-shipment-ingestion-contract-hardening / Step: S04
-- Migration: Shipment operation handler hardening v1
-- Purpose:
--   - Eliminate modify/reference drift by synchronizing shipment_reference_numbers from a canonical patch map.
--   - Enforce soft-cancel delete mode, active-driver assignment, and strict action timing/taxonomy checks.
--   - Process attachment arrays up to policy limits instead of silently dropping all but the first item.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.parse_external_timestamp_v1(
  p_value TEXT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_value TEXT := NULLIF(btrim(COALESCE(p_value, '')), '');
BEGIN
  IF v_value IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN to_timestamp((v_value::NUMERIC) / 1000.0);
  EXCEPTION
    WHEN others THEN
      BEGIN
        RETURN v_value::TIMESTAMPTZ;
      EXCEPTION
        WHEN others THEN
          RETURN NULL;
      END;
  END;
END;
$function$;

COMMENT ON FUNCTION public.parse_external_timestamp_v1(TEXT)
  IS 'Parse external webhook timestamps from epoch-millis strings or ISO-8601 timestamptz text.';

CREATE OR REPLACE FUNCTION public.jsonb_first_nonempty_text_v1(
  p_value JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_value JSONB := COALESCE(p_value, 'null'::jsonb);
  v_text TEXT := NULL;
BEGIN
  IF v_value IS NULL OR v_value = 'null'::jsonb THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(v_value) = 'array' THEN
    SELECT NULLIF(btrim(x.value), '')
      INTO v_text
      FROM jsonb_array_elements_text(v_value) AS x(value)
     WHERE NULLIF(btrim(x.value), '') IS NOT NULL
     LIMIT 1;
    RETURN v_text;
  END IF;

  IF jsonb_typeof(v_value) IN ('string', 'number', 'boolean') THEN
    RETURN NULLIF(btrim(v_value #>> '{}'), '');
  END IF;

  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.jsonb_first_nonempty_text_v1(JSONB)
  IS 'Return the first non-empty scalar text from a JSONB scalar or array, otherwise NULL.';

CREATE OR REPLACE FUNCTION public.merge_shipment_reference_patch_v1(
  p_changes JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_changes JSONB := COALESCE(p_changes, '{}'::jsonb);
  v_reference_map JSONB := '{}'::jsonb;
  v_client_reference TEXT := NULL;
  v_carrier_reference TEXT := NULL;
BEGIN
  IF jsonb_typeof(v_changes) <> 'object' THEN
    RETURN '{}'::jsonb;
  END IF;

  IF jsonb_typeof(v_changes->'references') = 'object' THEN
    v_reference_map := v_changes->'references';
  END IF;

  v_client_reference := public.jsonb_first_nonempty_text_v1(v_changes->'client_reference_number');
  IF v_client_reference IS NOT NULL THEN
    v_reference_map := jsonb_set(v_reference_map, '{client_reference_number}', to_jsonb(v_client_reference), TRUE);
  END IF;

  v_carrier_reference := public.jsonb_first_nonempty_text_v1(v_changes->'carrier_reference_number');
  IF v_carrier_reference IS NOT NULL THEN
    v_reference_map := jsonb_set(v_reference_map, '{carrier_reference_number}', to_jsonb(v_carrier_reference), TRUE);
  END IF;

  RETURN jsonb_strip_nulls(v_reference_map);
END;
$function$;

COMMENT ON FUNCTION public.merge_shipment_reference_patch_v1(JSONB)
  IS 'Merge top-level shipment reference columns and references{} into one canonical reference patch map.';

CREATE OR REPLACE FUNCTION public.sync_shipment_reference_numbers_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_shipment_id UUID,
  p_reference_map JSONB,
  p_source_type TEXT DEFAULT NULL,
  p_source_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_reference_map JSONB := COALESCE(p_reference_map, '{}'::jsonb);
  v_key TEXT;
  v_val JSONB;
  v_deleted INT := 0;
  v_processed INT := 0;
  v_row_count INT := 0;
  v_result JSONB := '{}'::jsonb;
BEGIN
  IF p_organization_id IS NULL OR p_client_id IS NULL OR p_shipment_id IS NULL THEN
    RETURN jsonb_build_object('processed', 0, 'deleted', 0);
  END IF;

  IF jsonb_typeof(v_reference_map) <> 'object' THEN
    RETURN jsonb_build_object('processed', 0, 'deleted', 0);
  END IF;

  FOR v_key, v_val IN
    SELECT key, value
    FROM jsonb_each(v_reference_map)
  LOOP
    DELETE FROM public.shipment_reference_numbers srn
     WHERE srn.organization_id = p_organization_id
       AND srn.client_id = p_client_id
       AND srn.shipment_id = p_shipment_id
       AND srn.reference_type = v_key;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_deleted := v_deleted + COALESCE(v_row_count, 0);

    IF public.jsonb_has_present_value_v1(v_val) THEN
      v_result := public.upsert_shipment_reference_numbers_v1(
        p_organization_id,
        p_client_id,
        p_shipment_id,
        jsonb_build_object(v_key, v_val),
        p_source_type,
        p_source_id,
        p_metadata
      );
      v_processed := v_processed + COALESCE(NULLIF(v_result->>'processed', '')::INT, 0);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'deleted', v_deleted
  );
END;
$function$;

COMMENT ON FUNCTION public.sync_shipment_reference_numbers_v1(UUID, UUID, UUID, JSONB, TEXT, UUID, JSONB)
  IS 'Replace the shipment_reference_numbers rows for the patched reference types with the canonical reference map.';

CREATE OR REPLACE FUNCTION workflow_handlers.resolve_input_payload_v1(
  p_context JSONB
)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(p_context->'transformed_payload', p_context->'payload', '{}'::jsonb);
$$;

COMMENT ON FUNCTION workflow_handlers.resolve_input_payload_v1(JSONB)
  IS 'Resolve the canonical inbound payload from workflow context, preferring transformed_payload over raw payload.';

CREATE OR REPLACE FUNCTION workflow_handlers.resolve_shipment_target_v1(
  p_context JSONB
)
RETURNS TABLE (
  shipment_id UUID,
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  tracking_number TEXT,
  status TEXT,
  destination_address_id UUID,
  recipient_id UUID,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_payload JSONB := workflow_handlers.resolve_input_payload_v1(v_context);
  v_shipment_id UUID := NULL;
  v_org_id UUID := NULL;
  v_client_id UUID := NULL;
  v_tracking TEXT := NULL;
  v_client_reference TEXT := NULL;
  v_carrier_reference TEXT := NULL;
BEGIN
  BEGIN
    v_shipment_id := COALESCE(
      NULLIF(v_context->>'shipment_id', '')::UUID,
      NULLIF(v_context#>>'{shipment,id}', '')::UUID,
      NULLIF(v_context->>'planned_shipment_id', '')::UUID,
      NULLIF(v_context#>>'{shipment,shipment_id}', '')::UUID,
      NULLIF(v_payload->>'shipment_id', '')::UUID,
      NULLIF(v_payload#>>'{shipment,id}', '')::UUID,
      NULLIF(v_payload#>>'{resource,id}', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  BEGIN
    v_org_id := COALESCE(
      NULLIF(v_context->>'organization_id', '')::UUID,
      NULLIF(v_payload->>'organization_id', '')::UUID,
      NULLIF(v_payload#>>'{shipment,organization_id}', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;

  BEGIN
    v_client_id := COALESCE(
      NULLIF(v_context->>'client_id', '')::UUID,
      NULLIF(v_context#>>'{shipment,client_id}', '')::UUID,
      NULLIF(v_payload->>'client_id', '')::UUID,
      NULLIF(v_payload#>>'{shipment,client_id}', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_client_id := NULL;
  END;

  v_tracking := COALESCE(
    NULLIF(btrim(v_context->>'tracking_number'), ''),
    NULLIF(btrim(v_context#>>'{shipment,tracking_number}'), ''),
    NULLIF(btrim(v_payload->>'tracking_number'), ''),
    NULLIF(btrim(v_payload#>>'{shipment,tracking_number}'), ''),
    NULLIF(btrim(v_payload#>>'{resource,tracking_number}'), '')
  );
  v_client_reference := COALESCE(
    NULLIF(btrim(v_context->>'client_reference_number'), ''),
    NULLIF(btrim(v_context#>>'{shipment,client_reference_number}'), ''),
    NULLIF(btrim(v_payload->>'client_reference_number'), ''),
    NULLIF(btrim(v_payload#>>'{shipment,client_reference_number}'), '')
  );
  v_carrier_reference := COALESCE(
    NULLIF(btrim(v_context->>'carrier_reference_number'), ''),
    NULLIF(btrim(v_context#>>'{shipment,carrier_reference_number}'), ''),
    NULLIF(btrim(v_payload->>'carrier_reference_number'), ''),
    NULLIF(btrim(v_payload#>>'{shipment,carrier_reference_number}'), '')
  );

  IF v_shipment_id IS NOT NULL THEN
    RETURN QUERY
    SELECT s.id, s.organization_id, s.client_id, s.sender_id, s.tracking_number, s.status, s.destination_address_id, s.recipient_id, s.created_at
    FROM public.shipments s
    WHERE s.id = v_shipment_id
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  IF v_client_id IS NOT NULL AND v_tracking IS NOT NULL THEN
    RETURN QUERY
    SELECT s.id, s.organization_id, s.client_id, s.sender_id, s.tracking_number, s.status, s.destination_address_id, s.recipient_id, s.created_at
    FROM public.shipments s
    WHERE s.client_id = v_client_id
      AND s.tracking_upper = upper(v_tracking)
    ORDER BY s.created_at DESC
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  IF v_org_id IS NOT NULL AND v_tracking IS NOT NULL THEN
    RETURN QUERY
    SELECT s.id, s.organization_id, s.client_id, s.sender_id, s.tracking_number, s.status, s.destination_address_id, s.recipient_id, s.created_at
    FROM public.shipments s
    WHERE s.organization_id = v_org_id
      AND s.tracking_upper = upper(v_tracking)
    ORDER BY s.created_at DESC
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  IF v_client_id IS NOT NULL AND v_client_reference IS NOT NULL THEN
    RETURN QUERY
    SELECT s.id, s.organization_id, s.client_id, s.sender_id, s.tracking_number, s.status, s.destination_address_id, s.recipient_id, s.created_at
    FROM public.shipments s
    JOIN public.find_shipment_by_client_reference_v1(v_client_id, v_client_reference) ref
      ON ref.shipment_id = s.id
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  IF v_client_id IS NOT NULL AND v_carrier_reference IS NOT NULL THEN
    RETURN QUERY
    SELECT s.id, s.organization_id, s.client_id, s.sender_id, s.tracking_number, s.status, s.destination_address_id, s.recipient_id, s.created_at
    FROM public.shipments s
    JOIN public.shipment_reference_numbers srn
      ON srn.shipment_id = s.id
     AND srn.client_id = s.client_id
    WHERE s.client_id = v_client_id
      AND srn.reference_type = 'carrier_reference_number'
      AND srn.reference_value_upper = upper(v_carrier_reference)
    ORDER BY srn.created_at DESC
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.resolve_shipment_target_v1(JSONB)
  IS 'Resolve shipment targets from workflow context or canonical payload fallback without requiring custom context extraction.';

CREATE OR REPLACE FUNCTION workflow_handlers.record_shipment_action_v1(
  p_shipment_id UUID,
  p_action_type TEXT,
  p_action_category TEXT,
  p_action_data JSONB DEFAULT '{}'::jsonb,
  p_notes TEXT DEFAULT NULL,
  p_canonical_status TEXT DEFAULT NULL,
  p_performed_by_system TEXT DEFAULT 'workflow_handlers',
  p_assigned_to UUID DEFAULT NULL,
  p_action_timestamp TIMESTAMPTZ DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_action_id UUID;
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(p_action_data->>'idempotency_key', '')), '');
BEGIN
  IF p_shipment_id IS NULL OR NULLIF(btrim(COALESCE(p_action_type, '')), '') IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_idempotency_key IS NOT NULL THEN
    SELECT sa.id
      INTO v_action_id
      FROM public.shipment_actions sa
     WHERE sa.shipment_id = p_shipment_id
       AND sa.action_type = p_action_type
       AND sa.action_category = p_action_category
       AND sa.action_data->>'idempotency_key' = v_idempotency_key
     ORDER BY sa.created_at DESC
     LIMIT 1;

    IF v_action_id IS NOT NULL THEN
      RETURN v_action_id;
    END IF;
  END IF;

  INSERT INTO public.shipment_actions (
    shipment_id,
    action_type,
    action_category,
    canonical_status,
    assigned_to,
    performed_by_system,
    action_data,
    notes,
    timestamp
  ) VALUES (
    p_shipment_id,
    p_action_type,
    p_action_category,
    p_canonical_status,
    p_assigned_to,
    p_performed_by_system,
    COALESCE(p_action_data, '{}'::jsonb),
    p_notes,
    COALESCE(p_action_timestamp, now())
  )
  RETURNING id INTO v_action_id;

  RETURN v_action_id;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_modify_v1(
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
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_changes JSONB := COALESCE(v_ctx->'modify', v_ctx->'shipment_patch', v_ctx->'changes', '{}'::jsonb);
  v_allowed JSONB := COALESCE(v_policy#>'{modify,allowed_fields}', '[]'::jsonb);
  v_allowed_statuses JSONB := COALESCE(v_policy#>'{modify,allowed_statuses}', '[]'::jsonb);
  v_key TEXT;
  v_invalid TEXT[] := ARRAY[]::TEXT[];
  v_metadata_patch JSONB := NULL;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
  v_cod_amount NUMERIC := NULL;
  v_has_cod_amount BOOLEAN := FALSE;
  v_reference_patch JSONB := '{}'::jsonb;
  v_reference_sync JSONB := jsonb_build_object('processed', 0, 'deleted', 0);
  v_client_reference_number TEXT := NULL;
  v_carrier_reference_number TEXT := NULL;
  v_constraint_name TEXT := NULL;
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;
  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF NOT workflow_handlers.shipment_status_allowed_v1(v_target.status, v_allowed_statuses) THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_status_not_allowed';
    v_result.operation_result := jsonb_build_object('error', 'shipment_status_not_allowed', 'status', v_target.status);
    RETURN v_result;
  END IF;

  IF jsonb_typeof(v_changes) <> 'object' THEN
    v_result.status := 'failed';
    v_result.last_error := 'modify_patch_invalid';
    v_result.operation_result := jsonb_build_object('error', 'modify_patch_invalid');
    RETURN v_result;
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(v_changes) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_allowed) AS x(value)
      WHERE x.value = v_key
    ) THEN
      v_invalid := array_append(v_invalid, v_key);
    END IF;
  END LOOP;

  IF array_length(v_invalid, 1) IS NOT NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'modify_fields_not_allowed';
    v_result.operation_result := jsonb_build_object('error', 'modify_fields_not_allowed', 'fields', to_jsonb(v_invalid));
    RETURN v_result;
  END IF;

  IF jsonb_typeof(v_changes->'metadata') = 'object' THEN
    v_metadata_patch := v_changes->'metadata';
  END IF;

  IF v_changes ? 'cod_amount' AND NULLIF(v_changes->>'cod_amount', '') IS NOT NULL THEN
    BEGIN
      v_cod_amount := NULLIF(v_changes->>'cod_amount', '')::NUMERIC;
      v_has_cod_amount := TRUE;
    EXCEPTION
      WHEN others THEN
        v_result.status := 'failed';
        v_result.last_error := 'cod_amount_invalid';
        v_result.operation_result := jsonb_build_object('error', 'cod_amount_invalid', 'value', v_changes->>'cod_amount');
        RETURN v_result;
    END;
  END IF;

  v_reference_patch := public.merge_shipment_reference_patch_v1(v_changes);
  v_client_reference_number := COALESCE(
    public.jsonb_first_nonempty_text_v1(v_changes->'client_reference_number'),
    public.jsonb_first_nonempty_text_v1(v_reference_patch->'client_reference_number')
  );
  v_carrier_reference_number := COALESCE(
    public.jsonb_first_nonempty_text_v1(v_changes->'carrier_reference_number'),
    public.jsonb_first_nonempty_text_v1(v_reference_patch->'carrier_reference_number')
  );

  BEGIN
    UPDATE public.shipments
       SET service_type = COALESCE(NULLIF(v_changes->>'service_type', ''), public.shipments.service_type),
           service_level = COALESCE(NULLIF(v_changes->>'service_level', ''), public.shipments.service_level),
           special_instructions = COALESCE(NULLIF(v_changes->>'special_instructions', ''), public.shipments.special_instructions),
           cod_amount = CASE WHEN v_has_cod_amount THEN v_cod_amount ELSE public.shipments.cod_amount END,
           client_reference_number = COALESCE(v_client_reference_number, public.shipments.client_reference_number),
           carrier_reference_number = COALESCE(v_carrier_reference_number, public.shipments.carrier_reference_number),
           metadata = CASE
             WHEN v_metadata_patch IS NULL THEN public.shipments.metadata
             ELSE public.deep_merge_jsonb(COALESCE(public.shipments.metadata, '{}'::jsonb), v_metadata_patch)
           END,
           updated_at = now()
     WHERE id = v_target.shipment_id;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      v_result.status := 'failed';
      v_result.last_error := CASE
        WHEN v_constraint_name = 'uniq_shipments_client_client_reference_upper'
          THEN 'client_reference_number_conflict'
        ELSE 'shipment_modify_conflict'
      END;
      v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'error', v_result.last_error,
        'constraint', v_constraint_name,
        'client_reference_number', v_client_reference_number
      ));
      RETURN v_result;
  END;

  IF jsonb_typeof(v_reference_patch) = 'object' AND v_reference_patch <> '{}'::jsonb THEN
    v_reference_sync := public.sync_shipment_reference_numbers_v1(
      v_target.organization_id,
      v_target.client_id,
      v_target.shipment_id,
      v_reference_patch,
      'workflow',
      p_run.id,
      jsonb_build_object('handler_key', 'shipment_modify')
    );
  END IF;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    'modify',
    'administrative',
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key', v_event_id,
      'changes', v_changes,
      'reference_sync', v_reference_sync
    )),
    NULL,
    NULL,
    'workflow_handlers.execute_shipment_modify_v1',
    NULL,
    NULL
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.context_patch := jsonb_build_object('shipment', jsonb_build_object('id', v_target.shipment_id, 'tracking_number', v_target.tracking_number));
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'shipment_action_id', v_action_id,
    'operation', 'modified',
    'reference_sync', v_reference_sync
  ));
  RETURN v_result;
END;
$function$;

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
  v_postal_code TEXT;
  v_district TEXT;
  v_building_number TEXT;
  v_directions TEXT;
  v_address_id UUID;
  v_geocode_template_name TEXT := COALESCE(NULLIF(v_policy#>>'{address,geocode_template_name}', ''), NULLIF(v_policy#>>'{geocode,workflow_template_name}', ''), 'workflow_geocoding_standard');
  v_geocode_template_id UUID;
  v_geocode_run_id UUID;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;
  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF NOT workflow_handlers.shipment_status_allowed_v1(v_target.status, v_allowed_statuses) THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_status_not_allowed';
    v_result.operation_result := jsonb_build_object('error', 'shipment_status_not_allowed', 'status', v_target.status);
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
  v_country := COALESCE(NULLIF(v_address->>'country', ''), NULLIF(v_address->>'country_code', ''), NULLIF(v_address->>'countryCode', ''), 'SA');
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
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key', v_event_id,
      'address_id', v_address_id,
      'geocode_workflow_run_id', v_geocode_run_id
    )),
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
    'shipment', jsonb_build_object('id', v_target.shipment_id, 'tracking_number', v_target.tracking_number, 'destination_address_id', v_address_id)
  );
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'address_id', v_address_id,
    'shipment_action_id', v_action_id,
    'geocode_workflow_run_id', v_geocode_run_id
  ));
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_delete_v1(
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
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_allowed_statuses JSONB := COALESCE(v_policy#>'{delete,allowed_statuses}', '[]'::jsonb);
  v_target_status TEXT := COALESCE(NULLIF(v_policy#>>'{delete,target_status}', ''), 'cancelled');
  v_window_hours INT := COALESCE(NULLIF(v_policy#>>'{delete,window_hours}', '')::INT, 24);
  v_delete_mode TEXT := lower(COALESCE(NULLIF(v_policy#>>'{delete,mode}', ''), 'soft_cancel'));
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
BEGIN
  IF v_delete_mode <> 'soft_cancel' THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_delete_mode_not_supported';
    v_result.operation_result := jsonb_build_object('error', 'shipment_delete_mode_not_supported', 'mode', v_delete_mode);
    RETURN v_result;
  END IF;

  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;
  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF NOT workflow_handlers.shipment_status_allowed_v1(v_target.status, v_allowed_statuses) THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_status_not_allowed';
    v_result.operation_result := jsonb_build_object('error', 'shipment_status_not_allowed', 'status', v_target.status);
    RETURN v_result;
  END IF;

  IF v_window_hours > 0 AND v_target.created_at < now() - make_interval(hours => v_window_hours) THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_delete_window_expired';
    v_result.operation_result := jsonb_build_object('error', 'shipment_delete_window_expired', 'window_hours', v_window_hours);
    RETURN v_result;
  END IF;

  UPDATE public.shipments
     SET status = v_target_status,
         status_updated_at = now(),
         updated_at = now(),
         metadata = public.deep_merge_jsonb(COALESCE(metadata, '{}'::jsonb), jsonb_build_object('deleted_by_workflow', TRUE, 'delete_operation', 'soft_cancel'))
   WHERE id = v_target.shipment_id;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    'delete',
    'administrative',
    jsonb_strip_nulls(jsonb_build_object('idempotency_key', v_event_id, 'target_status', v_target_status)),
    NULL,
    v_target_status,
    'workflow_handlers.execute_shipment_delete_v1',
    NULL,
    NULL
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.context_patch := jsonb_build_object('shipment', jsonb_build_object('id', v_target.shipment_id, 'tracking_number', v_target.tracking_number));
  v_result.operation_result := jsonb_build_object('shipment_id', v_target.shipment_id, 'shipment_action_id', v_action_id, 'status', v_target_status, 'operation', 'soft_cancel');
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_driver_v1(
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
  v_allowed_statuses JSONB := COALESCE(v_policy#>'{driver,allowed_statuses}', '[]'::jsonb);
  v_allow_unassign BOOLEAN := COALESCE((v_policy#>>'{driver,allow_unassign}')::BOOLEAN, TRUE);
  v_driver_user_id UUID := NULL;
  v_driver_status TEXT := NULL;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;
  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF NOT workflow_handlers.shipment_status_allowed_v1(v_target.status, v_allowed_statuses) THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_status_not_allowed';
    v_result.operation_result := jsonb_build_object('error', 'shipment_status_not_allowed', 'status', v_target.status);
    RETURN v_result;
  END IF;

  BEGIN
    v_driver_user_id := COALESCE(
      NULLIF(v_ctx->>'driver_user_id', '')::UUID,
      NULLIF(v_ctx#>>'{driver,id}', '')::UUID,
      NULLIF(v_ctx#>>'{driver,user_id}', '')::UUID,
      NULLIF(v_payload->>'driver_user_id', '')::UUID,
      NULLIF(v_payload#>>'{driver,id}', '')::UUID,
      NULLIF(v_payload#>>'{driver,user_id}', '')::UUID,
      NULLIF(v_payload#>>'{shipment,driver,id}', '')::UUID,
      NULLIF(v_payload#>>'{shipment,driver,user_id}', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_driver_user_id := NULL;
  END;

  IF v_driver_user_id IS NULL AND NOT v_allow_unassign THEN
    v_result.status := 'failed';
    v_result.last_error := 'driver_required';
    v_result.operation_result := jsonb_build_object('error', 'driver_required');
    RETURN v_result;
  END IF;

  IF v_driver_user_id IS NOT NULL THEN
    SELECT lower(COALESCE(u.status, ''))
      INTO v_driver_status
      FROM public.users u
     WHERE u.id = v_driver_user_id
       AND u.organization_id = v_target.organization_id
     LIMIT 1;

    IF v_driver_status IS NULL THEN
      v_result.status := 'failed';
      v_result.last_error := 'driver_not_found';
      v_result.operation_result := jsonb_build_object('error', 'driver_not_found');
      RETURN v_result;
    END IF;

    IF v_driver_status <> 'active' THEN
      v_result.status := 'failed';
      v_result.last_error := 'driver_not_active';
      v_result.operation_result := jsonb_build_object('error', 'driver_not_active', 'status', v_driver_status);
      RETURN v_result;
    END IF;
  END IF;

  UPDATE public.shipments
     SET driver_user_id = v_driver_user_id,
         updated_at = now(),
         metadata = public.deep_merge_jsonb(COALESCE(metadata, '{}'::jsonb), jsonb_strip_nulls(jsonb_build_object('driver_user_id', v_driver_user_id)))
   WHERE id = v_target.shipment_id;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    'driver_update',
    'operational',
    jsonb_strip_nulls(jsonb_build_object('idempotency_key', v_event_id, 'driver_user_id', v_driver_user_id)),
    NULL,
    NULL,
    'workflow_handlers.execute_shipment_update_driver_v1',
    v_driver_user_id,
    NULL
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'driver_user_id', v_driver_user_id,
    'shipment_action_id', v_action_id
  ));
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_action_v1(
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
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_action JSONB := COALESCE(v_ctx->'action', v_payload->'action', v_payload#>'{shipment,action}', '{}'::jsonb);
  v_action_type TEXT := lower(NULLIF(btrim(COALESCE(v_action->>'action_type', v_action->>'type', '')), ''));
  v_action_category TEXT := lower(NULLIF(btrim(COALESCE(v_action->>'action_category', v_action->>'category', '')), ''));
  v_notes TEXT := COALESCE(NULLIF(v_action->>'notes', ''), NULLIF(v_ctx->>'notes', ''));
  v_occurred_at_raw TEXT := COALESCE(NULLIF(v_action->>'occurred_at', ''), NULLIF(v_ctx->>'occurred_at', ''));
  v_occurred_at TIMESTAMPTZ := public.parse_external_timestamp_v1(v_occurred_at_raw);
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;
  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF jsonb_typeof(v_action) <> 'object' THEN
    v_result.status := 'failed';
    v_result.last_error := 'action_payload_invalid';
    v_result.operation_result := jsonb_build_object('error', 'action_payload_invalid');
    RETURN v_result;
  END IF;

  IF v_action_type IS NULL OR v_action_category IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'action_fields_missing';
    v_result.operation_result := jsonb_build_object('error', 'action_fields_missing');
    RETURN v_result;
  END IF;

  IF v_occurred_at_raw IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'action_occurred_at_missing';
    v_result.operation_result := jsonb_build_object('error', 'action_occurred_at_missing');
    RETURN v_result;
  END IF;

  IF v_occurred_at IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'action_occurred_at_invalid';
    v_result.operation_result := jsonb_build_object('error', 'action_occurred_at_invalid', 'occurred_at', v_occurred_at_raw);
    RETURN v_result;
  END IF;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    v_action_type,
    v_action_category,
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key', v_event_id,
      'action', v_action,
      'occurred_at', v_occurred_at
    )),
    v_notes,
    NULL,
    'workflow_handlers.execute_shipment_update_action_v1',
    NULL,
    v_occurred_at
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'shipment_action_id', v_action_id,
    'occurred_at', v_occurred_at
  );
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_attachment_v1(
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
  v_attachments JSONB := CASE
    WHEN jsonb_typeof(v_ctx->'attachments') = 'array' THEN v_ctx->'attachments'
    WHEN jsonb_typeof(v_ctx->'attachment') = 'object' THEN jsonb_build_array(v_ctx->'attachment')
    WHEN jsonb_typeof(v_payload->'attachments') = 'array' THEN v_payload->'attachments'
    WHEN jsonb_typeof(v_payload->'attachment') = 'object' THEN jsonb_build_array(v_payload->'attachment')
    WHEN jsonb_typeof(v_payload#>'{shipment,attachments}') = 'array' THEN v_payload#>'{shipment,attachments}'
    WHEN jsonb_typeof(v_payload#>'{shipment,attachment}') = 'object' THEN jsonb_build_array(v_payload#>'{shipment,attachment}')
    ELSE '[]'::jsonb
  END;
  v_attachment JSONB;
  v_bucket TEXT;
  v_key TEXT;
  v_mime TEXT;
  v_size BIGINT;
  v_sha TEXT;
  v_relation_type TEXT := lower(COALESCE(NULLIF(v_policy#>>'{attachment,relation_type}', ''), 'evidence'));
  v_allowed_mime JSONB := COALESCE(v_policy#>'{attachment,allowed_mime_types}', '[]'::jsonb);
  v_max_size BIGINT := COALESCE(NULLIF(v_policy#>>'{attachment,max_size_bytes}', '')::BIGINT, 10485760);
  v_max_items INT := COALESCE(NULLIF(v_policy#>>'{attachment,max_items_per_event}', '')::INT, 10);
  v_artifact_id UUID;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
  v_attachment_count INT := 0;
  v_artifact_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;
  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  IF jsonb_typeof(v_attachments) <> 'array' OR jsonb_array_length(v_attachments) = 0 THEN
    v_result.status := 'failed';
    v_result.last_error := 'attachment_payload_invalid';
    v_result.operation_result := jsonb_build_object('error', 'attachment_payload_invalid');
    RETURN v_result;
  END IF;

  v_attachment_count := jsonb_array_length(v_attachments);
  IF v_attachment_count > v_max_items THEN
    v_result.status := 'failed';
    v_result.last_error := 'attachment_item_count_exceeded';
    v_result.operation_result := jsonb_build_object('error', 'attachment_item_count_exceeded', 'item_count', v_attachment_count, 'max_items_per_event', v_max_items);
    RETURN v_result;
  END IF;

  FOR v_attachment IN
    SELECT value
    FROM jsonb_array_elements(v_attachments)
  LOOP
    IF jsonb_typeof(v_attachment) <> 'object' THEN
      v_result.status := 'failed';
      v_result.last_error := 'attachment_payload_invalid';
      v_result.operation_result := jsonb_build_object('error', 'attachment_payload_invalid');
      RETURN v_result;
    END IF;

    v_bucket := NULLIF(v_attachment->>'storage_bucket', '');
    v_key := NULLIF(v_attachment->>'storage_key', '');
    IF v_bucket IS NULL OR v_key IS NULL THEN
      v_key := COALESCE(v_key, NULLIF(v_attachment->>'content_url', ''));
      IF v_key IS NOT NULL THEN
        v_bucket := COALESCE(v_bucket, 'external_url');
      END IF;
    END IF;
    v_mime := NULLIF(v_attachment->>'mime_type', '');
    v_sha := NULLIF(v_attachment->>'sha256', '');
    BEGIN
      v_size := NULLIF(v_attachment->>'size_bytes', '')::BIGINT;
    EXCEPTION
      WHEN others THEN
        v_size := NULL;
    END;

    IF v_bucket IS NULL OR v_key IS NULL THEN
      v_result.status := 'failed';
      v_result.last_error := 'attachment_storage_reference_missing';
      v_result.operation_result := jsonb_build_object('error', 'attachment_storage_reference_missing');
      RETURN v_result;
    END IF;

    IF v_mime IS NOT NULL
       AND jsonb_typeof(v_allowed_mime) = 'array'
       AND jsonb_array_length(v_allowed_mime) > 0
       AND NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(v_allowed_mime) AS x(value)
         WHERE lower(x.value) = lower(v_mime)
       ) THEN
      v_result.status := 'failed';
      v_result.last_error := 'attachment_mime_not_allowed';
      v_result.operation_result := jsonb_build_object('error', 'attachment_mime_not_allowed', 'mime_type', v_mime);
      RETURN v_result;
    END IF;

    IF v_size IS NOT NULL AND v_size > v_max_size THEN
      v_result.status := 'failed';
      v_result.last_error := 'attachment_size_exceeded';
      v_result.operation_result := jsonb_build_object('error', 'attachment_size_exceeded', 'size_bytes', v_size, 'max_size_bytes', v_max_size);
      RETURN v_result;
    END IF;
  END LOOP;

  FOR v_attachment IN
    SELECT value
    FROM jsonb_array_elements(v_attachments)
  LOOP
    v_bucket := NULLIF(v_attachment->>'storage_bucket', '');
    v_key := NULLIF(v_attachment->>'storage_key', '');
    IF v_bucket IS NULL OR v_key IS NULL THEN
      v_key := COALESCE(v_key, NULLIF(v_attachment->>'content_url', ''));
      IF v_key IS NOT NULL THEN
        v_bucket := COALESCE(v_bucket, 'external_url');
      END IF;
    END IF;
    v_mime := NULLIF(v_attachment->>'mime_type', '');
    v_sha := NULLIF(v_attachment->>'sha256', '');
    BEGIN
      v_size := NULLIF(v_attachment->>'size_bytes', '')::BIGINT;
    EXCEPTION
      WHEN others THEN
        v_size := NULL;
    END;

    INSERT INTO public.artifacts (
      organization_id,
      storage_bucket,
      storage_key,
      mime_type,
      size_bytes,
      sha256,
      source_system,
      metadata
    ) VALUES (
      v_target.organization_id,
      v_bucket,
      v_key,
      v_mime,
      v_size,
      v_sha,
      'shipment_update_attachment',
      COALESCE(v_attachment - 'storage_bucket' - 'storage_key' - 'content_url', '{}'::jsonb)
    )
    ON CONFLICT (organization_id, storage_bucket, storage_key) DO UPDATE
    SET mime_type = COALESCE(EXCLUDED.mime_type, public.artifacts.mime_type),
        size_bytes = COALESCE(EXCLUDED.size_bytes, public.artifacts.size_bytes),
        sha256 = COALESCE(EXCLUDED.sha256, public.artifacts.sha256),
        metadata = public.deep_merge_jsonb(COALESCE(public.artifacts.metadata, '{}'::jsonb), COALESCE(EXCLUDED.metadata, '{}'::jsonb)),
        updated_at = now()
    RETURNING id INTO v_artifact_id;

    INSERT INTO public.artifact_links (
      organization_id,
      artifact_id,
      resource_type,
      resource_id,
      relation_type,
      metadata
    ) VALUES (
      v_target.organization_id,
      v_artifact_id,
      'shipment',
      v_target.shipment_id,
      v_relation_type,
      jsonb_strip_nulls(jsonb_build_object('idempotency_key', v_event_id))
    )
    ON CONFLICT (organization_id, artifact_id, resource_type, resource_id, relation_type) DO NOTHING;

    v_artifact_ids := array_append(v_artifact_ids, v_artifact_id);
  END LOOP;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    'attachment_added',
    'administrative',
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key', v_event_id,
      'artifact_ids', to_jsonb(v_artifact_ids),
      'relation_type', v_relation_type
    )),
    NULL,
    NULL,
    'workflow_handlers.execute_shipment_update_attachment_v1',
    NULL,
    NULL
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'artifact_id', CASE WHEN array_length(v_artifact_ids, 1) > 0 THEN v_artifact_ids[1] ELSE NULL END,
    'artifact_ids', to_jsonb(v_artifact_ids),
    'artifact_count', COALESCE(array_length(v_artifact_ids, 1), 0),
    'shipment_action_id', v_action_id
  ));
  RETURN v_result;
END;
$function$;

COMMIT;
