-- F54 compatible destination capture and persisted proof. Unapplied proposal.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;
SELECT pg_advisory_xact_lock(hashtext('20260907120000_shipment_destination_capture_v1'));

-- Private proof shared by the two already-authorized workflow RPCs.
CREATE OR REPLACE FUNCTION public.shipment_destination_capture_result_v1(
  p_shipment_id UUID, p_address JSONB, p_completed BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $proof$
DECLARE
  v_expected_code TEXT;
  v_expected_coordinates geography;
  v_address RECORD;
  v_actual_coordinates geography;
BEGIN
  IF p_completed IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('status', 'pending');
  END IF;
  v_expected_code := public.address_sa_short_code_from_payload_v1(p_address);
  v_expected_coordinates := public.address_coordinates_from_payload_v1(p_address);
  SELECT a.id, a.client_id, a.sa_short_code, a.coordinates INTO v_address
    FROM public.shipments s
    JOIN public.addresses a ON a.id = s.destination_address_id
      AND a.organization_id = s.organization_id
      AND a.client_id IS NOT DISTINCT FROM s.client_id
   WHERE s.id = p_shipment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shipment destination address readback missing' USING ERRCODE = '22023';
  END IF;
  IF v_expected_code IS NOT NULL
     AND upper(COALESCE(v_address.sa_short_code, '')) <> upper(v_expected_code) THEN
    RAISE EXCEPTION 'shipment destination short address readback mismatch' USING ERRCODE = '22023';
  END IF;
  v_actual_coordinates := v_address.coordinates;
  IF v_actual_coordinates IS NULL AND v_expected_coordinates IS NOT NULL THEN
    SELECT g.coordinates INTO v_actual_coordinates
      FROM public.geocodes g
     WHERE g.address_id = v_address.id
       AND g.client_id IS NOT DISTINCT FROM v_address.client_id
       AND g.is_primary IS TRUE
       AND (g.expires_at IS NULL OR g.expires_at > now())
     ORDER BY g.geocoded_at DESC NULLS LAST, g.id
     LIMIT 1;
  END IF;
  IF v_expected_coordinates IS NOT NULL AND (
    v_actual_coordinates IS NULL
    OR abs(ST_Y(v_actual_coordinates::geometry) - ST_Y(v_expected_coordinates::geometry)) > 0.00001
    OR abs(ST_X(v_actual_coordinates::geometry) - ST_X(v_expected_coordinates::geometry)) > 0.00001
  ) THEN
    RAISE EXCEPTION 'shipment destination coordinates readback mismatch' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object(
    'status', 'verified', 'address_id', v_address.id, 'sa_short_code', v_address.sa_short_code,
    'coordinates', CASE WHEN v_actual_coordinates IS NOT NULL THEN jsonb_build_object(
      'latitude', ST_Y(v_actual_coordinates::geometry),
      'longitude', ST_X(v_actual_coordinates::geometry)
    ) END
  );
END;
$proof$;
REVOKE ALL ON FUNCTION public.shipment_destination_capture_result_v1(UUID, JSONB, BOOLEAN)
  FROM PUBLIC, anon, authenticated, service_role;

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
  v_short_code TEXT;
  v_coordinates geography;
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

  v_short_code := public.address_sa_short_code_from_payload_v1(v_address);
  v_coordinates := public.address_coordinates_from_payload_v1(v_address);

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
    validation_status,
    sa_short_code,
    coordinates
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
    v_validation_status,
    v_short_code,
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

CREATE OR REPLACE FUNCTION public.ui_create_shipment_v1(
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL,
  p_service_type TEXT DEFAULT NULL,
  p_tracking_number TEXT DEFAULT NULL,
  p_client_reference_number TEXT DEFAULT NULL,
  p_carrier_reference_number TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();
  v_template_id UUID;
  v_client_id UUID := p_client_id;
  v_sender_id UUID := p_sender_id;
  v_sender_client_id UUID;
  v_sender_org_id UUID;
  v_service_type TEXT := COALESCE(NULLIF(btrim(COALESCE(p_service_type, '')), ''), 'delivery');
  v_status TEXT := COALESCE(NULLIF(btrim(COALESCE(p_status, '')), ''), 'pending');
  v_tracking_number TEXT := NULLIF(btrim(COALESCE(p_tracking_number, '')), '');
  v_client_reference_number TEXT := NULLIF(btrim(COALESCE(p_client_reference_number, '')), '');
  v_carrier_reference_number TEXT := NULLIF(btrim(COALESCE(p_carrier_reference_number, '')), '');
  v_metadata JSONB := CASE
    WHEN jsonb_typeof(COALESCE(p_metadata, '{}'::jsonb)) = 'object' THEN COALESCE(p_metadata, '{}'::jsonb)
    ELSE '{}'::jsonb
  END;
  v_correlation_id UUID := gen_random_uuid();
  v_run_id UUID;
  v_context JSONB;
  v_run_context JSONB := '{}'::jsonb;
  v_progress JSONB;
  v_create_result JSONB := '{}'::jsonb;
  v_shipment_id UUID;
  v_attempt INT;
  v_workflow_status TEXT;
  v_operation TEXT;
  v_destination_address JSONB := v_metadata->'destination_address';
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires authenticated user';
  END IF;

  PERFORM public.assert_capability_v1('shipments.write', v_scope_type, v_scope_id);

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires organization context';
  END IF;

  IF v_scope_type = 'client' AND v_scope_id IS NOT NULL THEN
    IF v_client_id IS NOT NULL AND v_client_id <> v_scope_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 client scope cannot create for another client';
    END IF;
    v_client_id := v_scope_id;
  END IF;

  IF v_scope_type = 'sender' AND v_scope_id IS NOT NULL THEN
    IF v_sender_id IS NOT NULL AND v_sender_id <> v_scope_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender scope cannot create for another sender';
    END IF;
    v_sender_id := v_scope_id;
  END IF;

  IF v_sender_id IS NOT NULL THEN
    SELECT s.client_id, c.organization_id
      INTO v_sender_client_id, v_sender_org_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_sender_id
     LIMIT 1;

    IF v_sender_client_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender not found';
    END IF;
    IF v_sender_org_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender is outside the current organization';
    END IF;
    IF v_client_id IS NULL THEN
      v_client_id := v_sender_client_id;
    ELSIF v_client_id <> v_sender_client_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender must belong to the selected client';
    END IF;
  END IF;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 requires client_id';
  END IF;

  PERFORM 1
    FROM public.clients c
   WHERE c.id = v_client_id
     AND c.organization_id = v_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 client is outside the current organization';
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'shipment_manual_create_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 workflow template shipment_manual_create_v1 not found';
  END IF;

  PERFORM set_config('request.correlation_id', v_correlation_id::text, true);

  v_context := jsonb_strip_nulls(
    jsonb_build_object(
      'trigger_source', 'manual',
      'correlation_id', v_correlation_id,
      'organization_id', v_org_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'requested_by', auth.uid(),
      'service_type', v_service_type,
      'initial_status', v_status,
      'planned_tracking_number', v_tracking_number,
      'client_reference_number', v_client_reference_number,
      'carrier_reference_number', v_carrier_reference_number,
      'payload', jsonb_build_object(
        'resource', jsonb_strip_nulls(
          jsonb_build_object(
            'type', 'shipment',
            'service_type', v_service_type,
            'tracking_number', v_tracking_number,
            'client_reference_number', v_client_reference_number,
            'carrier_reference_number', v_carrier_reference_number,
            'status', v_status,
            'metadata', jsonb_strip_nulls(
              v_metadata
              || jsonb_build_object(
                'source', 'ui.manual_create',
                'requested_by', auth.uid(),
                'correlation_id', v_correlation_id
              )
            )
          )
        )
      ),
      'ui', jsonb_build_object(
        'source', 'shipment_manual_create',
        'workflow_template_id', v_template_id
      )
    )
  );

  IF v_destination_address IS NOT NULL THEN
    IF jsonb_typeof(v_destination_address) IS DISTINCT FROM 'object'
       OR v_destination_address = '{}'::jsonb THEN
      RAISE EXCEPTION 'destination_address must be a nonempty object' USING ERRCODE = '22023';
    END IF;
    IF NULLIF(btrim(v_destination_address->>'line1'), '') IS NULL
       OR NULLIF(btrim(v_destination_address->>'city'), '') IS NULL THEN
      RAISE EXCEPTION 'destination_address requires line1 and city' USING ERRCODE = '22023';
    END IF;
    PERFORM public.address_coordinates_from_payload_v1(v_destination_address);
    PERFORM public.address_sa_short_code_from_payload_v1(v_destination_address);
    v_context := v_context || jsonb_build_object('destination_address', v_destination_address);
  END IF;

  v_run_id := public.start_workflow_run(v_template_id, v_context);

  UPDATE public.workflow_runs
     SET triggered_by_request_id = COALESCE(triggered_by_request_id, v_correlation_id),
         updated_at = now()
   WHERE id = v_run_id;

  FOR v_attempt IN 1..6 LOOP
    SELECT public.progress_workflow_run(v_run_id) INTO v_progress;

    SELECT workflow_status, context
      INTO v_workflow_status, v_run_context
      FROM public.workflow_runs
     WHERE id = v_run_id;

    EXIT WHEN v_workflow_status IN ('completed', 'failed', 'waiting', 'blocked');
  END LOOP;

  SELECT step.operation_result
    INTO v_create_result
    FROM public.workflow_run_steps step
   WHERE step.workflow_run_id = v_run_id
     AND step.handler_key = 'shipment_create'
   ORDER BY step.sequence_order
   LIMIT 1;

  BEGIN
    v_shipment_id := COALESCE(
      NULLIF(v_run_context#>>'{shipment,id}', '')::UUID,
      NULLIF(v_run_context#>>'{workflow,context_patch,shipment,id}', '')::UUID,
      NULLIF(v_create_result->>'shipment_id', '')::UUID,
      NULLIF(v_run_context->>'planned_shipment_id', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  IF v_shipment_id IS NULL AND v_client_id IS NOT NULL THEN
    SELECT resolved.shipment_id, resolved.operation
      INTO v_shipment_id, v_operation
      FROM public.resolve_shipment_create_duplicate_v1(
        v_client_id,
        COALESCE(NULLIF(v_run_context#>>'{shipment,tracking_number}', ''), v_tracking_number),
        v_client_reference_number
      ) AS resolved
     LIMIT 1;
  END IF;

  v_operation := COALESCE(
    v_create_result->>'operation',
    v_operation,
    CASE WHEN v_shipment_id IS NOT NULL THEN 'inserted' ELSE NULL END
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'status', CASE
        WHEN v_workflow_status = 'completed' AND v_shipment_id IS NOT NULL THEN 'shipment_created'
        ELSE COALESCE(v_workflow_status, 'workflow_started')
      END,
      'workflow_template_id', v_template_id,
      'workflow_run_id', v_run_id,
      'workflow_status', v_workflow_status,
      'correlation_id', v_correlation_id,
      'shipment_id', v_shipment_id,
      'tracking_number', COALESCE(
        NULLIF(v_run_context#>>'{shipment,tracking_number}', ''),
        NULLIF(v_create_result->>'tracking_number', ''),
        v_tracking_number
      ),
      'operation', v_operation,
      'destination_address_capture', CASE
        WHEN v_destination_address IS NULL OR v_workflow_status IN ('failed', 'blocked', 'cancelled') THEN NULL
        ELSE public.shipment_destination_capture_result_v1(v_shipment_id, v_destination_address, v_workflow_status = 'completed')
      END
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.shipment_amend_cancel_v1(
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
  v_operation TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'operation', '')), ''));
  v_surface TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'surface', '')), ''));
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id UUID := public.current_user_scope_id();
  v_actor_system TEXT := CASE
    WHEN v_surface IN ('console', 'portal') THEN format('%s.shipment_amend_cancel', v_surface)
    ELSE 'ui.shipment_amend_cancel'
  END;
  v_target RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_options JSONB;
  v_guard JSONB;
  v_idempotency_key TEXT := NULL;
  v_audit_actor JSONB;
  v_action_types TEXT[] := ARRAY[]::TEXT[];
  v_existing_action RECORD;
  v_replay_workflow_status TEXT;
  v_template_name TEXT := NULL;
  v_template_id UUID := NULL;
  v_context JSONB := '{}'::jsonb;
  v_run_id UUID := NULL;
  v_progress JSONB := '{}'::jsonb;
  v_workflow_status TEXT := NULL;
  v_step_status TEXT := NULL;
  v_step_error TEXT := NULL;
  v_result JSONB := '{}'::jsonb;
  v_action_id UUID := NULL;
  v_changes JSONB := COALESCE(v_input->'changes', '{}'::jsonb);
  v_address JSONB := COALESCE(v_input->'address', v_input->'destination_address', '{}'::jsonb);
  v_slot_date DATE := NULL;
  v_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'reason', '')), '');
  v_inline_kick_max_attempts INT := 3;
  v_inline_kick_budget_ms INT := 500;
  v_inline_attempts INT := 0;
  v_inline_elapsed_ms INT := 0;
  v_inline_error TEXT := NULL;
  v_inline_next_run_at TIMESTAMPTZ := NULL;
  v_inline_explicit_input JSONB := jsonb_build_object(
    'ui_explicit_wake',
    TRUE,
    'source',
    'shipment_amend_cancel_v1'
  );
BEGIN
  BEGIN
    v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  BEGIN
    v_slot_date := NULLIF(v_input->>'slot_date', '')::DATE;
  EXCEPTION
    WHEN others THEN
      v_slot_date := NULL;
  END;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'shipment amend/cancel requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_shipment_id IS NULL OR v_operation NOT IN ('modify', 'reschedule', 'address', 'cancel') THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'invalid_request')
    );
  END IF;

  SELECT *
    INTO v_target
    FROM public.ui_shipment_mutation_access_v1(v_shipment_id)
   LIMIT 1;

  v_policy := public.resolve_shipment_operation_policy_v1(
    jsonb_build_object(
      'organization_id',
      v_target.organization_id,
      'client_id',
      v_target.client_id,
      'sender_id',
      v_target.sender_id,
      'shipment_id',
      v_target.shipment_id
    )
  );

    v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
    IF v_idempotency_key IS NULL THEN
      v_idempotency_key := encode(
        digest(
        format(
          '%s|%s|%s|%s|%s',
          v_operation,
          v_shipment_id,
          v_user_id,
          COALESCE(v_surface, 'ui'),
          COALESCE(
            CASE
              WHEN v_operation = 'modify' THEN v_changes::TEXT
              WHEN v_operation = 'address' THEN v_address::TEXT
              WHEN v_operation = 'reschedule' THEN COALESCE(v_slot_date::TEXT, '')
              WHEN v_operation = 'cancel' THEN COALESCE(v_reason, '')
              ELSE ''
            END,
            ''
          )
        ),
        'sha256'
      ),
      'hex'
    );
  END IF;

  v_audit_actor := jsonb_strip_nulls(
    jsonb_build_object(
      'user_id',
      v_user_id,
      'scope_type',
      v_scope_type,
      'scope_id',
      v_scope_id,
      'surface',
      COALESCE(v_surface, 'ui'),
      'source',
      v_actor_system
    )
  );

    v_action_types := CASE v_operation
      WHEN 'modify' THEN ARRAY['modify']
      WHEN 'reschedule' THEN ARRAY['delivery_slot_reserved']
      WHEN 'address' THEN ARRAY['address_update']
      WHEN 'cancel' THEN ARRAY['delete']
      ELSE ARRAY[]::TEXT[]
    END;

    SELECT
      sa.id,
      sa.action_type,
      sa.action_data,
      sa.canonical_status
    INTO v_existing_action
    FROM public.shipment_actions sa
    WHERE sa.shipment_id = v_shipment_id
      AND sa.action_type = ANY(v_action_types)
      AND sa.action_data->>'idempotency_key' = v_idempotency_key
    ORDER BY sa.created_at DESC
    LIMIT 1;

    v_options := public.shipment_amend_cancel_options_v1(v_shipment_id);
    v_guard := COALESCE(v_options#>ARRAY['operations', v_operation], '{}'::jsonb);

  IF v_existing_action.id IS NOT NULL THEN
    IF v_operation = 'address' THEN
      SELECT wr.workflow_status INTO v_replay_workflow_status
        FROM public.workflow_runs wr
       WHERE wr.id::TEXT = v_existing_action.action_data->>'workflow_run_id';
    END IF;
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok',
        CASE WHEN v_operation = 'address' THEN COALESCE(v_replay_workflow_status NOT IN ('failed', 'blocked', 'cancelled'), TRUE) ELSE TRUE END,
        'workflow_status', CASE WHEN v_operation = 'address' THEN v_replay_workflow_status END,
        'workflow_run_id', CASE WHEN v_operation = 'address' THEN v_existing_action.action_data->>'workflow_run_id' END,
        'already_processed',
        TRUE,
        'destination_address_capture', CASE WHEN v_operation = 'address'
          THEN CASE WHEN v_replay_workflow_status IN ('failed', 'blocked', 'cancelled') THEN NULL
            ELSE public.shipment_destination_capture_result_v1(v_shipment_id, v_address, v_replay_workflow_status = 'completed') END END,
        'shipment_id',
        v_shipment_id,
        'operation',
        v_operation,
        'shipment_action_id',
        v_existing_action.id,
        'lock_state',
        v_guard,
        'canonical_status',
        v_existing_action.canonical_status
        )
      );
    END IF;

    IF COALESCE((v_guard->>'allowed')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
      RETURN jsonb_strip_nulls(
        jsonb_build_object(
          'ok',
          FALSE,
          'error',
          jsonb_build_object(
            'code',
            COALESCE(v_guard->>'reason', 'shipment_mutation_blocked')
          ),
          'lock_state',
          v_guard
        )
      );
    END IF;

    IF v_operation = 'modify' AND jsonb_typeof(v_changes) <> 'object' THEN
      RETURN jsonb_build_object(
        'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'modify_patch_invalid'),
      'lock_state',
      v_guard
    );
  END IF;

  IF v_operation = 'modify' AND v_changes = '{}'::jsonb THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'modify_patch_empty'),
      'lock_state',
      v_guard
    );
  END IF;

  IF v_operation = 'address' AND jsonb_typeof(v_address) <> 'object' THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'address_payload_invalid'),
      'lock_state',
      v_guard
    );
  END IF;

  IF v_operation = 'address' AND v_address = '{}'::jsonb THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'address_payload_empty'),
      'lock_state',
      v_guard
    );
  END IF;

  IF v_operation = 'reschedule' AND v_slot_date IS NULL THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'slot_date_required'),
      'lock_state',
      v_guard
    );
  END IF;

  IF v_operation = 'address' THEN
    PERFORM public.address_coordinates_from_payload_v1(v_address);
    PERFORM public.address_sa_short_code_from_payload_v1(v_address);
  END IF;

  v_template_name := public.resolve_shipment_operation_template_name_v1(v_policy, v_operation);

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = v_template_name
     AND status = 'active'
   ORDER BY version DESC, updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',
      FALSE,
      'error',
      jsonb_build_object('code', 'workflow_template_missing', 'template_name', v_template_name),
      'lock_state',
      v_guard
    );
  END IF;

  v_context := jsonb_strip_nulls(
    jsonb_build_object(
      'trigger_source',
      'manual',
      'requested_by',
      v_user_id,
      'organization_id',
      v_target.organization_id,
      'client_id',
      v_target.client_id,
      'sender_id',
      v_target.sender_id,
      'shipment_id',
      v_target.shipment_id,
      'tracking_number',
      v_target.tracking_number,
      'performed_by_system',
      v_actor_system,
      'surface',
      COALESCE(v_surface, 'ui'),
      'idempotency_key',
      v_idempotency_key,
      'event_id',
      v_idempotency_key,
      'event',
      jsonb_build_object('id', v_idempotency_key),
      'audit_actor',
      v_audit_actor,
      'shipment',
      jsonb_strip_nulls(
        jsonb_build_object(
          'id',
          v_target.shipment_id,
          'organization_id',
          v_target.organization_id,
          'client_id',
          v_target.client_id,
          'sender_id',
          v_target.sender_id,
          'tracking_number',
          v_target.tracking_number
        )
      ),
      'changes',
      CASE WHEN v_operation = 'modify' THEN v_changes ELSE NULL END,
      'modify',
      CASE WHEN v_operation = 'modify' THEN v_changes ELSE NULL END,
      'address',
      CASE WHEN v_operation = 'address' THEN v_address ELSE NULL END,
      'slot_date',
      CASE WHEN v_operation = 'reschedule' THEN v_slot_date ELSE NULL END,
      'reason',
      CASE WHEN v_operation = 'cancel' THEN v_reason ELSE NULL END,
      'payload',
      jsonb_strip_nulls(
        jsonb_build_object(
          'shipment_id',
          v_target.shipment_id,
          'operation',
          v_operation,
          'changes',
          CASE WHEN v_operation = 'modify' THEN v_changes ELSE NULL END,
          'address',
          CASE WHEN v_operation = 'address' THEN v_address ELSE NULL END,
          'slot_date',
          CASE WHEN v_operation = 'reschedule' THEN v_slot_date ELSE NULL END,
          'reason',
          CASE WHEN v_operation = 'cancel' THEN v_reason ELSE NULL END
        )
      ),
      'ui_mutation',
      jsonb_build_object(
        'operation',
        v_operation,
        'lock_source',
        'shipment_operation_policy'
      )
    )
  );

  v_run_id := public.start_workflow_run(v_template_id, v_context);
  BEGIN
    v_progress := public.progress_workflow_run_until_wait_v1(
      v_run_id,
      v_inline_explicit_input,
      v_inline_kick_budget_ms,
      v_inline_kick_max_attempts
    );
    v_inline_attempts := COALESCE(NULLIF(v_progress->>'attempts', '')::INT, 0);
    v_inline_elapsed_ms := COALESCE(NULLIF(v_progress->>'elapsed_ms', '')::INT, 0);
    v_step_status := lower(NULLIF(v_progress->>'status', ''));
    v_inline_error := NULLIF(v_progress->>'error', '');

    BEGIN
      v_inline_next_run_at := NULLIF(v_progress->>'next_run_at', '')::TIMESTAMPTZ;
    EXCEPTION
      WHEN others THEN
        v_inline_next_run_at := NULL;
    END;
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      RAISE;
    WHEN others THEN
      v_inline_error := SQLERRM;
  END;

  SELECT workflow_status
    INTO v_workflow_status
    FROM public.workflow_runs
   WHERE id = v_run_id;

  SELECT
    wrs.step_status,
    wrs.operation_result,
    wrs.last_error
  INTO
    v_step_status,
    v_result,
    v_step_error
  FROM public.workflow_run_steps wrs
  WHERE wrs.workflow_run_id = v_run_id
  ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
  LIMIT 1;

  IF v_result IS NULL THEN
    v_result := '{}'::jsonb;
  END IF;

  BEGIN
    v_action_id := COALESCE(
      NULLIF(v_result->>'shipment_action_id', '')::UUID,
      NULLIF(v_result#>>'{reserve_result,action_id}', '')::UUID
    );
  EXCEPTION
    WHEN others THEN
      v_action_id := NULL;
  END;

    IF v_action_id IS NOT NULL THEN
      UPDATE public.shipment_actions sa
         SET performed_by_system = v_actor_system,
             notes = CASE
               WHEN v_operation = 'cancel' AND v_reason IS NOT NULL THEN v_reason
               ELSE sa.notes
             END,
           action_data = public.deep_merge_jsonb(
             COALESCE(sa.action_data, '{}'::jsonb),
             jsonb_strip_nulls(
               jsonb_build_object(
                 'idempotency_key',
                 v_idempotency_key,
                 'audit_actor',
                 v_audit_actor,
                 'ui_operation',
                 v_operation,
                 'surface',
                 COALESCE(v_surface, 'ui'),
                 'workflow_run_id',
                 v_run_id
               )
             )
           )
     WHERE sa.id = v_action_id;
  END IF;

  IF v_workflow_status IN ('failed', 'blocked', 'cancelled') THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok',
        FALSE,
        'shipment_id',
        v_shipment_id,
        'operation',
        v_operation,
        'workflow_run_id',
        v_run_id,
        'workflow_status',
        v_workflow_status,
        'workflow_inline_kick',
        jsonb_strip_nulls(
          jsonb_build_object(
            'attempts',
            v_inline_attempts,
            'elapsed_ms',
            v_inline_elapsed_ms,
            'next_run_at',
            v_inline_next_run_at,
            'error',
            v_inline_error
          )
        ),
        'error',
        jsonb_build_object(
          'code',
          COALESCE(v_step_error, v_result->>'error', 'shipment_mutation_failed')
        ),
        'lock_state',
        v_guard,
        'operation_result',
        v_result
      )
    );
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok',
      TRUE,
      'destination_address_capture', CASE WHEN v_operation = 'address'
        THEN public.shipment_destination_capture_result_v1(v_shipment_id, v_address, v_workflow_status = 'completed') END,
      'shipment_id',
      v_shipment_id,
      'operation',
      v_operation,
      'shipment_action_id',
      v_action_id,
      'workflow_run_id',
      v_run_id,
      'workflow_status',
      v_workflow_status,
      'workflow_step_status',
      v_step_status,
      'workflow_inline_kick',
      jsonb_strip_nulls(
        jsonb_build_object(
          'attempts',
          v_inline_attempts,
          'elapsed_ms',
          v_inline_elapsed_ms,
          'next_run_at',
          v_inline_next_run_at,
          'error',
          v_inline_error
        )
      ),
      'lock_state',
      v_guard,
      'operation_result',
      v_result
    )
  );
END;
$function$;

-- Existing public/API signatures and execute grants are preserved by CREATE OR REPLACE.
COMMIT;
