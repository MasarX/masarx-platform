-- Preserve payload and sender validation alongside the newer scope checks.
BEGIN;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_start_workflow_run_v1(
  p_workflow_template_id UUID,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_require_active BOOLEAN DEFAULT TRUE
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
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_require_active BOOLEAN := COALESCE(p_require_active, TRUE);
  v_context JSONB;
  v_run_id UUID;
BEGIN
  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  IF NOT v_is_service AND NOT EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    WHERE wt.id = p_workflow_template_id
      AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
  ) THEN
    RAISE EXCEPTION 'workflow template access denied' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_workflow_start_payload_policy_v1(
    p_workflow_template_id, COALESCE(p_payload, '{}'::jsonb)
  );

  v_context := jsonb_build_object(
    'trigger_source', 'manual',
    'organization_id', public.current_user_org_id(),
    'requested_by', auth.uid(),
    'payload', COALESCE(p_payload, '{}'::jsonb),
    'ui', jsonb_build_object(
      'allow_inactive', (NOT v_require_active),
      'workflow_template_id', p_workflow_template_id
    )
  ) || jsonb_strip_nulls(jsonb_build_object(
    'client_id', public.current_user_client_id(),
    'sender_id', public.current_user_sender_id()
  ));

  v_run_id := start_workflow_run(p_workflow_template_id, v_context);

  RETURN jsonb_build_object(
    'status', 'workflow_started',
    'workflow_template_id', p_workflow_template_id,
    'workflow_run_id', v_run_id
  );
END;
$$;

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
  v_sender_status TEXT;
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
    SELECT s.client_id, c.organization_id, s.status
      INTO v_sender_client_id, v_sender_org_id, v_sender_status
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
    IF v_sender_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender is inactive'
        USING ERRCODE = '42501';
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

COMMIT;
