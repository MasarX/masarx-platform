-- Plan: PLAN-202603-webhook-api-hardening-remediation / Step: S04
-- Migration: Shipment operation handlers v1
-- Purpose:
--   - Implement shipment modify/delete/address/geocode/driver/action/attachment workflow handlers.
--   - Add shipment_operation_policy-driven guardrails.
--   - Wire placeholder templates to real handlers through operation_handlers/workflow_template_steps.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS driver_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shipments_driver_user_id
  ON ONLY public.shipments (driver_user_id)
  WHERE driver_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION workflow_handlers.resolve_event_id_v1(
  p_context JSONB
)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(btrim(p_context->>'idempotency_key'), ''),
    NULLIF(btrim(p_context->>'event_id'), ''),
    NULLIF(btrim(p_context#>>'{payload,event,id}'), ''),
    NULLIF(btrim(p_context#>>'{transformed_payload,event,id}'), ''),
    NULLIF(btrim(p_context#>>'{webhook,idempotency_key}'), '')
  );
$$;

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
      NULLIF(v_context#>>'{shipment,shipment_id}', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  BEGIN
    v_org_id := NULLIF(v_context->>'organization_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;

  BEGIN
    v_client_id := COALESCE(
      NULLIF(v_context->>'client_id', '')::UUID,
      NULLIF(v_context#>>'{shipment,client_id}', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_client_id := NULL;
  END;

  v_tracking := COALESCE(
    NULLIF(btrim(v_context->>'tracking_number'), ''),
    NULLIF(btrim(v_context#>>'{shipment,tracking_number}'), '')
  );
  v_client_reference := COALESCE(
    NULLIF(btrim(v_context->>'client_reference_number'), ''),
    NULLIF(btrim(v_context#>>'{shipment,client_reference_number}'), '')
  );
  v_carrier_reference := COALESCE(
    NULLIF(btrim(v_context->>'carrier_reference_number'), ''),
    NULLIF(btrim(v_context#>>'{shipment,carrier_reference_number}'), '')
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

CREATE OR REPLACE FUNCTION workflow_handlers.shipment_status_allowed_v1(
  p_status TEXT,
  p_allowed JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_allowed IS NULL OR jsonb_typeof(p_allowed) <> 'array' OR jsonb_array_length(p_allowed) = 0 THEN TRUE
    ELSE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(p_allowed) AS x(value)
      WHERE lower(btrim(x.value)) = lower(btrim(COALESCE(p_status, '')))
    )
  END;
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.record_shipment_action_v1(
  p_shipment_id UUID,
  p_action_type TEXT,
  p_action_category TEXT,
  p_action_data JSONB DEFAULT '{}'::jsonb,
  p_notes TEXT DEFAULT NULL,
  p_canonical_status TEXT DEFAULT NULL,
  p_performed_by_system TEXT DEFAULT 'workflow_handlers',
  p_assigned_to UUID DEFAULT NULL
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
    now()
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

  UPDATE public.shipments
     SET service_type = COALESCE(NULLIF(v_changes->>'service_type', ''), public.shipments.service_type),
         service_level = COALESCE(NULLIF(v_changes->>'service_level', ''), public.shipments.service_level),
         special_instructions = COALESCE(NULLIF(v_changes->>'special_instructions', ''), public.shipments.special_instructions),
         cod_amount = COALESCE(NULLIF(v_changes->>'cod_amount', '')::numeric, public.shipments.cod_amount),
         client_reference_number = COALESCE(NULLIF(v_changes->>'client_reference_number', ''), public.shipments.client_reference_number),
         carrier_reference_number = COALESCE(NULLIF(v_changes->>'carrier_reference_number', ''), public.shipments.carrier_reference_number),
         metadata = CASE
           WHEN v_metadata_patch IS NULL THEN public.shipments.metadata
           ELSE public.deep_merge_jsonb(COALESCE(public.shipments.metadata, '{}'::jsonb), v_metadata_patch)
         END,
         updated_at = now()
   WHERE id = v_target.shipment_id;

  PERFORM public.upsert_shipment_reference_numbers_v1(
    v_target.organization_id,
    v_target.client_id,
    v_target.shipment_id,
    v_changes->'references',
    'workflow',
    p_run.id,
    jsonb_build_object('handler_key', 'shipment_modify')
  );

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    'modify',
    'administrative',
    jsonb_strip_nulls(jsonb_build_object('idempotency_key', v_event_id, 'changes', v_changes)),
    NULL,
    NULL,
    'workflow_handlers.execute_shipment_modify_v1',
    NULL
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.context_patch := jsonb_build_object('shipment', jsonb_build_object('id', v_target.shipment_id, 'tracking_number', v_target.tracking_number));
  v_result.operation_result := jsonb_build_object('shipment_id', v_target.shipment_id, 'shipment_action_id', v_action_id, 'operation', 'modified');
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
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_address JSONB := COALESCE(v_ctx->'address', v_ctx->'destination_address', v_ctx#>'{shipment,address}', v_ctx#>'{shipment,destination_address}', '{}'::jsonb);
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

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(
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
  v_address_id UUID := NULL;
  v_template_name TEXT := COALESCE(NULLIF(v_policy#>>'{geocode,workflow_template_name}', ''), 'workflow_geocoding_standard');
  v_template_id UUID;
  v_workflow_run_id UUID;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;
  BEGIN
    v_address_id := COALESCE(NULLIF(v_ctx->>'address_id', '')::UUID, NULLIF(v_ctx->>'destination_address_id', '')::UUID);
  EXCEPTION
    WHEN others THEN
      v_address_id := NULL;
  END;
  IF v_address_id IS NULL THEN
    v_address_id := v_target.destination_address_id;
  END IF;
  IF v_address_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'address_id_missing';
    v_result.operation_result := jsonb_build_object('error', 'address_id_missing');
    RETURN v_result;
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = v_template_name
     AND status = 'active'
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'geocode_template_missing';
    v_result.operation_result := jsonb_build_object('error', 'geocode_template_missing', 'template_name', v_template_name);
    RETURN v_result;
  END IF;

  v_workflow_run_id := start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', COALESCE(v_target.organization_id, NULLIF(v_ctx->>'organization_id', '')::UUID),
      'client_id', COALESCE(v_target.client_id, NULLIF(v_ctx->>'client_id', '')::UUID),
      'sender_id', COALESCE(v_target.sender_id, NULLIF(v_ctx->>'sender_id', '')::UUID),
      'shipment_id', v_target.shipment_id,
      'destination_address_id', v_address_id
    ))
  );

  IF v_target.shipment_id IS NOT NULL THEN
    v_action_id := workflow_handlers.record_shipment_action_v1(
      v_target.shipment_id,
      'geocode_request',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'idempotency_key', v_event_id,
        'address_id', v_address_id,
        'workflow_run_id', v_workflow_run_id
      )),
      NULL,
      NULL,
      'workflow_handlers.execute_shipment_update_geocode_v1',
      NULL
    );
  END IF;

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'address_id', v_address_id,
    'geocode_workflow_run_id', v_workflow_run_id,
    'shipment_action_id', v_action_id
  ));
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
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_allowed_statuses JSONB := COALESCE(v_policy#>'{driver,allowed_statuses}', '[]'::jsonb);
  v_allow_unassign BOOLEAN := COALESCE((v_policy#>>'{driver,allow_unassign}')::BOOLEAN, TRUE);
  v_driver_user_id UUID := NULL;
  v_driver_exists BOOLEAN := FALSE;
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
    v_driver_user_id := COALESCE(NULLIF(v_ctx->>'driver_user_id', '')::UUID, NULLIF(v_ctx#>>'{driver,id}', '')::UUID);
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
    SELECT EXISTS(
      SELECT 1
      FROM public.users u
      WHERE u.id = v_driver_user_id
        AND u.organization_id = v_target.organization_id
    ) INTO v_driver_exists;

    IF NOT v_driver_exists THEN
      v_result.status := 'failed';
      v_result.last_error := 'driver_not_found';
      v_result.operation_result := jsonb_build_object('error', 'driver_not_found');
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
    v_driver_user_id
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
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_action JSONB := COALESCE(v_ctx->'action', '{}'::jsonb);
  v_action_type TEXT := COALESCE(NULLIF(v_action->>'action_type', ''), NULLIF(v_action->>'type', ''), COALESCE(NULLIF(v_policy#>>'{action,default_action_type}', ''), 'note'));
  v_action_category TEXT := COALESCE(NULLIF(v_action->>'action_category', ''), COALESCE(NULLIF(v_policy#>>'{action,default_action_category}', ''), 'operational'));
  v_notes TEXT := COALESCE(NULLIF(v_action->>'notes', ''), NULLIF(v_ctx->>'notes', ''));
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

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    lower(v_action_type),
    lower(v_action_category),
    jsonb_strip_nulls(jsonb_build_object('idempotency_key', v_event_id, 'action', v_action)),
    v_notes,
    NULL,
    'workflow_handlers.execute_shipment_update_action_v1',
    NULL
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'shipment_action_id', v_action_id
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
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_attachment JSONB := COALESCE(v_ctx->'attachment', CASE WHEN jsonb_typeof(v_ctx->'attachments') = 'array' THEN (v_ctx->'attachments'->0) ELSE NULL END, '{}'::jsonb);
  v_bucket TEXT;
  v_key TEXT;
  v_mime TEXT;
  v_size BIGINT;
  v_sha TEXT;
  v_relation_type TEXT := COALESCE(NULLIF(v_policy#>>'{attachment,relation_type}', ''), 'evidence');
  v_allowed_mime JSONB := COALESCE(v_policy#>'{attachment,allowed_mime_types}', '[]'::jsonb);
  v_max_size BIGINT := COALESCE(NULLIF(v_policy#>>'{attachment,max_size_bytes}', '')::BIGINT, 10485760);
  v_artifact_id UUID;
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

  IF v_mime IS NOT NULL AND jsonb_array_length(v_allowed_mime) > 0 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_allowed_mime) AS x(value) WHERE lower(x.value) = lower(v_mime)
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
    lower(v_relation_type),
    jsonb_strip_nulls(jsonb_build_object('idempotency_key', v_event_id))
  )
  ON CONFLICT (organization_id, artifact_id, resource_type, resource_id, relation_type) DO NOTHING;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_target.shipment_id,
    'attachment_added',
    'administrative',
    jsonb_strip_nulls(jsonb_build_object('idempotency_key', v_event_id, 'artifact_id', v_artifact_id, 'relation_type', lower(v_relation_type))),
    NULL,
    NULL,
    'workflow_handlers.execute_shipment_update_attachment_v1',
    NULL
  );

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'artifact_id', v_artifact_id,
    'shipment_action_id', v_action_id
  );
  RETURN v_result;
END;
$function$;

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES
  ('shipment_modify', 'workflow_handlers', 'execute_shipment_modify_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Modify shipment mutable business fields under shipment_operation_policy.', 'docs/ops/runbooks/workflow_engine_runbook.md'),
  ('shipment_delete', 'workflow_handlers', 'execute_shipment_delete_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Soft-cancel shipment under shipment_operation_policy.', 'docs/ops/runbooks/workflow_engine_runbook.md'),
  ('shipment_update_address', 'workflow_handlers', 'execute_shipment_update_address_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Update shipment destination address and optionally enqueue geocoding.', 'docs/ops/runbooks/workflow_engine_runbook.md'),
  ('shipment_update_geocode', 'workflow_handlers', 'execute_shipment_update_geocode_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Enqueue shipment geocoding workflow.', 'docs/ops/runbooks/workflow_engine_runbook.md'),
  ('shipment_update_driver', 'workflow_handlers', 'execute_shipment_update_driver_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Assign/unassign shipment driver linkage.', 'docs/ops/runbooks/workflow_engine_runbook.md'),
  ('shipment_update_action', 'workflow_handlers', 'execute_shipment_update_action_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Append auditable shipment action rows.', 'docs/ops/runbooks/workflow_engine_runbook.md'),
  ('shipment_update_attachment', 'workflow_handlers', 'execute_shipment_update_attachment_v1', '(public.workflow_run_steps,public.workflow_runs,jsonb)', 'v1', TRUE, 'Register artifact + link to shipment.', 'docs/ops/runbooks/workflow_engine_runbook.md')
ON CONFLICT (handler_key) DO UPDATE
SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

DO $do$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT *
    FROM (
      VALUES
        ('shipment_modify_v1', 'shipment_modify', 'modify_shipment'),
        ('shipment_delete_v1', 'shipment_delete', 'delete_shipment'),
        ('shipment_update_address_v1', 'shipment_update_address', 'update_address'),
        ('shipment_update_geocode_v1', 'shipment_update_geocode', 'update_geocode'),
        ('shipment_update_driver_v1', 'shipment_update_driver', 'update_driver'),
        ('shipment_update_action_v1', 'shipment_update_action', 'update_action'),
        ('shipment_update_attachment_v1', 'shipment_update_attachment', 'update_attachment')
    ) AS x(template_name, handler_key, operation_name)
  LOOP
    IF EXISTS (SELECT 1 FROM public.workflow_templates WHERE name = rec.template_name) THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.workflow_template_steps wts
        JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
        WHERE wt.name = rec.template_name
          AND wts.handler_key = 'context_extract_from_mapping'
      ) THEN
        UPDATE public.workflow_template_steps
           SET sequence_order = sequence_order + 1,
               updated_at = now()
         WHERE workflow_template_id = (SELECT id FROM public.workflow_templates WHERE name = rec.template_name LIMIT 1);

        INSERT INTO public.workflow_template_steps (
          id, workflow_template_id, sequence_order, operation_name, operation_settings_category,
          transition_condition, handler_key, handler_version, metadata, manual_action_required, enabled, created_at, updated_at
        )
        VALUES (
          gen_random_uuid(),
          (SELECT id FROM public.workflow_templates WHERE name = rec.template_name LIMIT 1),
          0,
          'context_extract_from_mapping',
          'workflow',
          'always',
          'context_extract_from_mapping',
          'v1',
          '{}'::jsonb,
          FALSE,
          TRUE,
          now(),
          now()
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM public.workflow_template_steps wts
        JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
        WHERE wt.name = rec.template_name
          AND wts.handler_key = rec.handler_key
      ) THEN
        INSERT INTO public.workflow_template_steps (
          id, workflow_template_id, sequence_order, operation_name, operation_settings_category,
          transition_condition, handler_key, handler_version, metadata, manual_action_required, enabled, created_at, updated_at
        )
        VALUES (
          gen_random_uuid(),
          (SELECT id FROM public.workflow_templates WHERE name = rec.template_name LIMIT 1),
          1,
          rec.operation_name,
          'workflow',
          'always',
          rec.handler_key,
          'v1',
          '{}'::jsonb,
          FALSE,
          TRUE,
          now(),
          now()
        );
      END IF;
    END IF;
  END LOOP;
END;
$do$;

WITH recalculated AS (
  SELECT
    wts.workflow_template_id,
    md5(
      string_agg(
        concat_ws(
          '|',
          wts.sequence_order,
          COALESCE(wts.operation_name, ''),
          COALESCE(wts.operation_settings_category, ''),
          COALESCE(wts.transition_condition, ''),
          COALESCE(wts.handler_key, ''),
          COALESCE(wts.handler_version, ''),
          COALESCE(wts.metadata::TEXT, '')
        ),
        '||' ORDER BY wts.sequence_order
      )
    ) AS checksum
  FROM public.workflow_template_steps wts
  WHERE wts.workflow_template_id IN (
    SELECT id
    FROM public.workflow_templates
    WHERE name IN (
      'shipment_modify_v1',
      'shipment_delete_v1',
      'shipment_update_address_v1',
      'shipment_update_geocode_v1',
      'shipment_update_driver_v1',
      'shipment_update_action_v1',
      'shipment_update_attachment_v1'
    )
  )
  GROUP BY wts.workflow_template_id
)
UPDATE public.workflow_templates wt
   SET steps_checksum = recalculated.checksum,
       updated_at = now()
  FROM recalculated
 WHERE wt.id = recalculated.workflow_template_id;

COMMIT;
