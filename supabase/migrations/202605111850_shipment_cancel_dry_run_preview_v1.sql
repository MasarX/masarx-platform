-- Repair Console V2 shipment amend/cancel dry-run semantics.
-- dry_run=true must preview policy/template readiness without starting the
-- canonical workflow or mutating shipment state.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605111850_shipment_cancel_dry_run_preview_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $block$
BEGIN
  IF to_regprocedure('public.shipment_amend_cancel_execute_v1(jsonb)') IS NULL THEN
    ALTER FUNCTION public.shipment_amend_cancel_v1(JSONB)
      RENAME TO shipment_amend_cancel_execute_v1;
  END IF;
END;
$block$;

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
  v_options JSONB := '{}'::jsonb;
  v_guard JSONB := '{}'::jsonb;
  v_template_name TEXT := NULL;
  v_template_id UUID := NULL;
  v_changes JSONB := COALESCE(v_input->'changes', '{}'::jsonb);
  v_address JSONB := COALESCE(v_input->'address', v_input->'destination_address', '{}'::jsonb);
  v_slot_date DATE := NULL;
  v_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'reason', '')), '');
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_audit_actor JSONB;
BEGIN
  IF NOT v_dry_run THEN
    RETURN public.shipment_amend_cancel_execute_v1(v_input);
  END IF;

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
      'dry_run',
      TRUE,
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

  v_options := public.shipment_amend_cancel_options_v1(v_shipment_id);
  v_guard := COALESCE(v_options#>ARRAY['operations', v_operation], '{}'::jsonb);

  IF COALESCE((v_guard->>'allowed')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok',
        FALSE,
        'dry_run',
        TRUE,
        'shipment_id',
        v_shipment_id,
        'operation',
        v_operation,
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
      'dry_run',
      TRUE,
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
      'dry_run',
      TRUE,
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
      'dry_run',
      TRUE,
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
      'dry_run',
      TRUE,
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
      'dry_run',
      TRUE,
      'error',
      jsonb_build_object('code', 'slot_date_required'),
      'lock_state',
      v_guard
    );
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
      'dry_run',
      TRUE,
      'error',
      jsonb_build_object('code', 'workflow_template_missing', 'template_name', v_template_name),
      'lock_state',
      v_guard
    );
  END IF;

  IF v_idempotency_key IS NULL THEN
    v_idempotency_key := encode(
      digest(
        format(
          '%s|%s|%s|%s|%s|dry_run',
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

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok',
      TRUE,
      'dry_run',
      TRUE,
      'shipment_id',
      v_shipment_id,
      'operation',
      v_operation,
      'workflow_template_id',
      v_template_id,
      'workflow_template_name',
      v_template_name,
      'workflow_status',
      'preview',
      'workflow_step_status',
      'not_started',
      'lock_state',
      v_guard,
      'current_values',
      v_options->'current_values',
      'policy_source',
      'shipment_operation_policy',
      'operation_result',
      jsonb_build_object(
        'dry_run',
        TRUE,
        'would_start_workflow',
        TRUE,
        'would_mutate',
        FALSE,
        'mutation_suppressed',
        TRUE,
        'workflow_template_id',
        v_template_id,
        'workflow_template_name',
        v_template_name,
        'idempotency_key',
        v_idempotency_key,
        'audit_actor',
        v_audit_actor,
        'policy_source',
        'shipment_operation_policy'
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.shipment_amend_cancel_execute_v1(JSONB)
  IS 'Internal executor for authenticated shipment amend/cancel operations; starts canonical workflow-engine runs and must not be called for dry-run previews.';

COMMENT ON FUNCTION public.shipment_amend_cancel_v1(JSONB)
  IS 'Authenticated console/portal shipment amend-cancel RPC. dry_run=true validates policy/template readiness without starting workflows or mutating shipment state; non-dry-run delegates to the canonical workflow executor.';

REVOKE ALL ON FUNCTION public.shipment_amend_cancel_execute_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shipment_amend_cancel_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shipment_amend_cancel_execute_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.shipment_amend_cancel_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605111850_shipment_cancel_dry_run_preview_v1'));

COMMIT;
