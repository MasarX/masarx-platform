-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Warehouse transfer reconcile finalize v1
-- Date: 2026-01-26
--
-- Goals:
--   - Add warehouse_transfer_status='reconciled' and warehouse_transfers.reconciled_at (query-friendly timestamp).
--   - Extend transition_warehouse_transfer_v1 to set reconciled_at (flag-driven; no hardcoded enum logic).
--   - Extend warehouse_transfer_execute_v1 to transition received -> reconciled after reconcile task completion.
--
-- Notes:
--   - Status validation remains lookup-driven (lookup_definitions/lookup_values).
--   - No new event ledger is introduced; scans remain SSOT in scan_events.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601261740_warehouse_transfer_reconcile_finalize_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup: add warehouse_transfer_status.reconciled (idempotent)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('reconciled', 'Reconciled', 'Transfer reconciled (manifest variance captured and closed)', 35, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'warehouse_transfer_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Schema: reconciled_at timestamp + safety constraint
-------------------------------------------------------------------------------

ALTER TABLE public.warehouse_transfers
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ NULL;

ALTER TABLE public.warehouse_transfers
  DROP CONSTRAINT IF EXISTS warehouse_transfers_reconciled_range_ck;

ALTER TABLE public.warehouse_transfers
  ADD CONSTRAINT warehouse_transfers_reconciled_range_ck CHECK (
    reconciled_at IS NULL
    OR received_at IS NULL
    OR reconciled_at >= received_at
  );

-------------------------------------------------------------------------------
-- 3) Service RPC: transition_warehouse_transfer_v1(jsonb) supports reconciled_at
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.transition_warehouse_transfer_v1(
  p_input JSONB
)
RETURNS TABLE (
  warehouse_transfer_id UUID,
  updated BOOLEAN,
  status TEXT,
  dispatched_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;

  v_in JSONB := COALESCE(p_input, '{}'::jsonb);
  v_transfer_id UUID := NULL;
  v_org_id UUID := NULL;
  v_to_status TEXT := NULL;
  v_from_status TEXT := NULL;

  v_effective_at TIMESTAMPTZ := NULL;
  v_set_dispatched BOOLEAN := FALSE;
  v_set_received BOOLEAN := FALSE;
  v_set_reconciled BOOLEAN := FALSE;

  v_vehicle_id UUID := NULL;
  v_driver_user_id UUID := NULL;

  v_before public.warehouse_transfers%ROWTYPE;
  v_should_update BOOLEAN := FALSE;
  v_updated BOOLEAN := FALSE;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 requires service_role context';
  END IF;

  IF jsonb_typeof(v_in) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_transfer_id := NULLIF(btrim(COALESCE(v_in->>'warehouse_transfer_id', v_in->>'transfer_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_transfer_id := NULL; END;
  BEGIN v_org_id := NULLIF(btrim(COALESCE(v_in->>'organization_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  v_to_status := lower(NULLIF(btrim(COALESCE(v_in->>'to_status', '')), ''));
  v_from_status := lower(NULLIF(btrim(COALESCE(v_in->>'from_status', '')), ''));

  BEGIN v_effective_at := NULLIF(btrim(COALESCE(v_in->>'effective_at', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_effective_at := NULL; END;
  v_effective_at := COALESCE(v_effective_at, now());

  BEGIN v_set_dispatched := COALESCE((v_in->>'set_dispatched_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_dispatched := FALSE; END;
  BEGIN v_set_received := COALESCE((v_in->>'set_received_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_received := FALSE; END;
  BEGIN v_set_reconciled := COALESCE((v_in->>'set_reconciled_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_reconciled := FALSE; END;

  BEGIN v_vehicle_id := NULLIF(btrim(COALESCE(v_in->>'vehicle_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;
  BEGIN v_driver_user_id := NULLIF(btrim(COALESCE(v_in->>'driver_user_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;

  IF v_transfer_id IS NULL THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 requires warehouse_transfer_id' USING ERRCODE = '23514';
  END IF;
  IF v_to_status IS NULL THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 requires to_status' USING ERRCODE = '23514';
  END IF;

  -- Validate status against lookup (dynamic; no hardcoded enum).
  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'warehouse_transfer_status'
    AND lv.value = v_to_status
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 invalid to_status: %', v_to_status USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_before
    FROM public.warehouse_transfers wt
   WHERE wt.id = v_transfer_id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1 warehouse_transfer not found: %', v_transfer_id USING ERRCODE = '23503';
  END IF;

  v_org_id := COALESCE(v_org_id, v_before.organization_id);
  IF v_org_id IS DISTINCT FROM v_before.organization_id THEN
    RAISE EXCEPTION 'transition_warehouse_transfer_v1: organization mismatch (input org %, transfer org %)', v_org_id, v_before.organization_id
      USING ERRCODE = '23514';
  END IF;

  -- Idempotency-friendly: if already at target state, treat as no-op (still returns current state).
  IF lower(v_before.status) IS DISTINCT FROM v_to_status THEN
    IF v_from_status IS NOT NULL AND lower(v_before.status) IS DISTINCT FROM v_from_status THEN
      RAISE EXCEPTION 'transition_warehouse_transfer_v1: from_status mismatch (expected %, current %)', v_from_status, v_before.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_should_update := (
    lower(v_before.status) IS DISTINCT FROM v_to_status
    OR (v_set_dispatched IS TRUE AND v_before.dispatched_at IS NULL)
    OR (v_set_received IS TRUE AND v_before.received_at IS NULL)
    OR (v_set_reconciled IS TRUE AND v_before.reconciled_at IS NULL)
    OR (v_vehicle_id IS NOT NULL AND v_before.vehicle_id IS NULL)
    OR (v_driver_user_id IS NOT NULL AND v_before.driver_user_id IS NULL)
  );

  IF v_should_update IS TRUE THEN
    UPDATE public.warehouse_transfers wt
       SET status = v_to_status,
           dispatched_at = CASE WHEN v_set_dispatched IS TRUE THEN COALESCE(wt.dispatched_at, v_effective_at) ELSE wt.dispatched_at END,
           received_at = CASE WHEN v_set_received IS TRUE THEN COALESCE(wt.received_at, v_effective_at) ELSE wt.received_at END,
           reconciled_at = CASE WHEN v_set_reconciled IS TRUE THEN COALESCE(wt.reconciled_at, v_effective_at) ELSE wt.reconciled_at END,
           vehicle_id = CASE WHEN v_vehicle_id IS NOT NULL AND wt.vehicle_id IS NULL THEN v_vehicle_id ELSE wt.vehicle_id END,
           driver_user_id = CASE WHEN v_driver_user_id IS NOT NULL AND wt.driver_user_id IS NULL THEN v_driver_user_id ELSE wt.driver_user_id END,
           updated_at = now()
     WHERE wt.id = v_transfer_id
     RETURNING wt.id, wt.status, wt.dispatched_at, wt.received_at
      INTO warehouse_transfer_id, status, dispatched_at, received_at;

    v_updated := TRUE;
  ELSE
    warehouse_transfer_id := v_before.id;
    status := v_before.status;
    dispatched_at := v_before.dispatched_at;
    received_at := v_before.received_at;
    v_updated := FALSE;
  END IF;

  updated := v_updated;

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'warehouse',
    p_resource_type := 'warehouse_transfer',
    p_resource_id := v_transfer_id,
    p_decision_point := 'transition',
    p_decision_outcome := CASE WHEN v_updated IS TRUE THEN 'applied' ELSE 'noop' END,
    p_performed_by_system := 'transition_warehouse_transfer_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'warehouse_transfer_id', v_transfer_id,
      'from_status', v_from_status,
      'to_status', v_to_status,
      'effective_at', v_effective_at,
      'set_dispatched_at', v_set_dispatched,
      'set_received_at', v_set_received,
      'set_reconciled_at', v_set_reconciled,
      'vehicle_id', v_vehicle_id,
      'driver_user_id', v_driver_user_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 4) Workflow handler: warehouse_transfer supports from_status + reconciled_at
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_warehouse_transfer_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_action TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'action', '')), ''));
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'warehouse_transfer');
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');
  v_default_idempotency TEXT := format('workflow_run:%s:step:%s', p_run.id, p_step.id);

  v_effective_at_context_key TEXT := NULLIF(btrim(COALESCE(v_meta->>'effective_at_context_key', '')), '');
  v_effective_at TIMESTAMPTZ := NULL;

  v_input JSONB := '{}'::jsonb;
  v_to_status TEXT := NULLIF(btrim(COALESCE(v_meta->>'to_status', '')), '');
  v_from_status TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'from_status', '')), ''));
  v_set_dispatched BOOLEAN := FALSE;
  v_set_received BOOLEAN := FALSE;
  v_set_reconciled BOOLEAN := FALSE;

  v_transfer_id UUID := NULL;
  v_org_id UUID := NULL;

  v_out RECORD;
  v_resp public.workflow_handler_response;
BEGIN
  IF v_action IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer: missing metadata.action (expected transition) (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_action IS DISTINCT FROM 'transition' THEN
    RAISE EXCEPTION 'warehouse_transfer: unsupported action % (expected transition)', v_action
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_ctx) IS DISTINCT FROM 'object' THEN
    v_ctx := '{}'::jsonb;
  END IF;

  BEGIN v_transfer_id := NULLIF(btrim(COALESCE(v_ctx->>'warehouse_transfer_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_transfer_id := NULL; END;
  BEGIN v_org_id := NULLIF(btrim(COALESCE(v_ctx->>'organization_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;

  IF v_transfer_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer: warehouse_transfer_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer: organization_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  BEGIN v_set_dispatched := COALESCE((v_meta->>'set_dispatched_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_dispatched := FALSE; END;
  BEGIN v_set_received := COALESCE((v_meta->>'set_received_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_received := FALSE; END;
  BEGIN v_set_reconciled := COALESCE((v_meta->>'set_reconciled_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_reconciled := FALSE; END;

  IF v_effective_at_context_key IS NOT NULL AND jsonb_typeof(v_ctx->v_effective_at_context_key) = 'object' THEN
    BEGIN v_effective_at := NULLIF(btrim(COALESCE((v_ctx->v_effective_at_context_key)#>>'{last_event,created_at}', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_effective_at := NULL; END;
    IF v_effective_at IS NULL THEN
      BEGIN v_effective_at := NULLIF(btrim(COALESCE((v_ctx->v_effective_at_context_key)#>>'{completed_at}', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_effective_at := NULL; END;
    END IF;
  END IF;
  v_effective_at := COALESCE(v_effective_at, now());

  v_input := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'warehouse_transfer_id', v_transfer_id,
    'from_status', v_from_status,
    'to_status', lower(btrim(COALESCE(v_to_status, ''))),
    'effective_at', v_effective_at,
    'set_dispatched_at', v_set_dispatched,
    'set_received_at', v_set_received,
    'set_reconciled_at', v_set_reconciled,
    'idempotency_key', v_default_idempotency,
    'actor_system', v_actor_system
  ));

  SELECT * INTO v_out
  FROM public.transition_warehouse_transfer_v1(v_input)
  LIMIT 1;

  v_resp.status := 'completed';
  v_resp.workflow_status := NULL;
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'action', v_action,
    'warehouse_transfer_id', v_out.warehouse_transfer_id,
    'updated', v_out.updated,
    'status', v_out.status,
    'dispatched_at', v_out.dispatched_at,
    'received_at', v_out.received_at
  ));
  v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'warehouse_transfer_id', v_out.warehouse_transfer_id,
      'updated', v_out.updated,
      'status', v_out.status,
      'dispatched_at', v_out.dispatched_at,
      'received_at', v_out.received_at,
      'effective_at', v_effective_at
    ))
  ));
  RETURN v_resp;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_warehouse_transfer_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 5) Workflow template: add final transition step (received -> reconciled)
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'warehouse_transfer_execute_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_execute_v1 template id missing';
  END IF;

  DELETE FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id;

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    next_operation_name,
    next_operation_priority,
    next_operation_delay_seconds,
    manual_action_required,
    metadata,
    enabled,
    handler_key,
    handler_version,
    created_at,
    updated_at
  ) VALUES
    (
      v_template_id,
      1,
      'task_enqueue',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_pack',
        'task_type_key', 'warehouse_transfer_pack',
        'resource_type', 'warehouse_transfer',
        'resource_id_path', '$.context.warehouse_transfer_id',
        'queue_key', 'warehouse'
      ),
      TRUE,
      'task_enqueue',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      2,
      'task_wait',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_pack',
        'poll_interval_seconds', 60
      ),
      TRUE,
      'task_wait',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      3,
      'task_enqueue',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_dispatch',
        'task_type_key', 'warehouse_transfer_dispatch',
        'resource_type', 'warehouse_transfer',
        'resource_id_path', '$.context.warehouse_transfer_id',
        'queue_key', 'warehouse'
      ),
      TRUE,
      'task_enqueue',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      4,
      'task_wait',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_dispatch',
        'poll_interval_seconds', 60
      ),
      TRUE,
      'task_wait',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      5,
      'warehouse_transfer',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'action', 'transition',
        'to_status', 'in_transit',
        'set_dispatched_at', TRUE,
        'effective_at_context_key', 'warehouse_transfer_dispatch',
        'context_key', 'warehouse_transfer'
      ),
      TRUE,
      'warehouse_transfer',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      6,
      'task_enqueue',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_receive',
        'task_type_key', 'warehouse_transfer_receive',
        'resource_type', 'warehouse_transfer',
        'resource_id_path', '$.context.warehouse_transfer_id',
        'queue_key', 'warehouse'
      ),
      TRUE,
      'task_enqueue',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      7,
      'task_wait',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_receive',
        'poll_interval_seconds', 60
      ),
      TRUE,
      'task_wait',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      8,
      'warehouse_transfer',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'action', 'transition',
        'to_status', 'received',
        'set_received_at', TRUE,
        'effective_at_context_key', 'warehouse_transfer_receive',
        'context_key', 'warehouse_transfer'
      ),
      TRUE,
      'warehouse_transfer',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      9,
      'task_enqueue',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_reconcile',
        'task_type_key', 'warehouse_transfer_reconcile',
        'resource_type', 'warehouse_transfer',
        'resource_id_path', '$.context.warehouse_transfer_id',
        'queue_key', 'warehouse'
      ),
      TRUE,
      'task_enqueue',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      10,
      'task_wait',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'warehouse_transfer_reconcile',
        'poll_interval_seconds', 60
      ),
      TRUE,
      'task_wait',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      11,
      'warehouse_transfer',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'action', 'transition',
        'from_status', 'received',
        'to_status', 'reconciled',
        'set_reconciled_at', TRUE,
        'effective_at_context_key', 'warehouse_transfer_reconcile',
        'context_key', 'warehouse_transfer'
      ),
      TRUE,
      'warehouse_transfer',
      'v1',
      now(),
      now()
    );
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601261740_warehouse_transfer_reconcile_finalize_v1'));
COMMIT;

