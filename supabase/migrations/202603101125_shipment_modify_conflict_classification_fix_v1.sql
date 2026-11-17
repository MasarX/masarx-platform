BEGIN;

-- Timestamp realigned to keep active migration history unique across dev and this feature branch.

CREATE OR REPLACE FUNCTION public.shipment_client_reference_conflict_exists_v1(
  p_client_id UUID,
  p_shipment_id UUID,
  p_client_reference_number TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  SELECT CASE
    WHEN p_client_id IS NULL OR NULLIF(btrim(COALESCE(p_client_reference_number, '')), '') IS NULL THEN FALSE
    ELSE EXISTS (
      SELECT 1
        FROM public.find_shipment_by_client_reference_v1(p_client_id, p_client_reference_number) AS ref
       WHERE ref.shipment_id IS DISTINCT FROM p_shipment_id
    )
  END
$function$;

COMMENT ON FUNCTION public.shipment_client_reference_conflict_exists_v1(UUID, UUID, TEXT)
  IS 'Classify client reference conflicts without relying on one hardcoded unique-constraint name.';

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
    v_result.operation_result := jsonb_build_object('error', 'shipment_status_not_allowed', 'status', v_target.status);
    RETURN v_result;
  END IF;

  IF jsonb_typeof(v_changes) <> 'object' THEN
    v_result.status := 'failed';
    v_result.last_error := 'modify_patch_invalid';
    v_result.operation_result := jsonb_build_object('error', 'modify_patch_invalid');
    RETURN v_result;
  END IF;

  FOR v_key IN
    SELECT jsonb_object_keys(v_changes)
  LOOP
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
        WHEN public.shipment_client_reference_conflict_exists_v1(
          v_target.client_id,
          v_target.shipment_id,
          v_client_reference_number
        ) THEN 'client_reference_number_conflict'
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

COMMIT;
