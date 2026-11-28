-- Restore template evidence from the workflow run for authorized shipment mutations.
-- Carry forward the destination capture definition and the later dry-run preview patch.
BEGIN;
SET LOCAL lock_timeout = '30s';

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
  v_dry_run BOOLEAN := lower(COALESCE(v_input->>'dry_run', 'false')) IN ('true', 't', '1', 'yes', 'on');
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
  v_template_readback JSONB;
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

  IF v_existing_action.id IS NOT NULL AND NOT v_dry_run THEN
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

  IF v_dry_run THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'ok', TRUE,
      'dry_run', TRUE,
      'shipment_id', v_shipment_id,
      'operation', v_operation,
      'workflow_template_id', v_template_id,
      'workflow_template_name', v_template_name,
      'workflow_status', 'preview',
      'workflow_step_status', 'not_started',
      'lock_state', v_guard,
      'current_values', v_options->'current_values',
      'policy_source', 'shipment_operation_policy',
      'operation_result', jsonb_build_object(
        'dry_run', TRUE,
        'would_start_workflow', TRUE,
        'would_mutate', FALSE,
        'mutation_suppressed', TRUE,
        'workflow_template_id', v_template_id,
        'workflow_template_name', v_template_name,
        'idempotency_key', v_idempotency_key,
        'audit_actor', v_audit_actor,
        'policy_source', 'shipment_operation_policy'
      )
    ));
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

  SELECT wr.workflow_status, wr.workflow_template_id, wt.name
    INTO v_workflow_status, v_template_id, v_template_name
    FROM public.workflow_runs wr
    LEFT JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
   WHERE wr.id = v_run_id;

  v_template_readback := jsonb_build_object(
    'workflow_template', COALESCE(v_template_name, v_template_id::TEXT),
    'workflow_template_id', v_template_id,
    'workflow_template_name', v_template_name
  );

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
      ) || v_template_readback
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
    ) || v_template_readback
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.shipment_amend_cancel_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shipment_amend_cancel_v1(JSONB) TO authenticated, service_role;

COMMIT;
