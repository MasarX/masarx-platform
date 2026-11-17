-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Warehouse transfer execute workflow v1 (task-driven)
-- Date: 2026-01-26
--
-- Goals:
--   - Add warehouse transfer execution parity: pack -> dispatch -> receive -> reconcile as workflow-driven tasks.
--   - Keep scans as the immutable ledger (scan_events). This workflow manages only manifest status/timestamps.
--   - Ensure zero-setup for new tenants by extending task_type_catalog (warehouse_transfer_*).
--   - Keep least-privilege: status transitions occur via service-only RPC invoked by workflow engine.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601261330_warehouse_transfer_execute_workflow_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) task_type_catalog: add warehouse_transfer_* task types (global default)
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings_version_id UUID;
  v_value JSONB;
  v_task_types JSONB;
  v_new_items JSONB := jsonb_build_array(
    jsonb_build_object('key', 'warehouse_transfer_pack', 'name', 'Warehouse Transfer Pack', 'description', 'Pack items into handling units and prepare a transfer manifest.', 'default_priority', 50, 'default_queue_key', 'warehouse', 'enabled', TRUE),
    jsonb_build_object('key', 'warehouse_transfer_dispatch', 'name', 'Warehouse Transfer Dispatch', 'description', 'Dispatch a transfer manifest (load and depart).', 'default_priority', 50, 'default_queue_key', 'warehouse', 'enabled', TRUE),
    jsonb_build_object('key', 'warehouse_transfer_receive', 'name', 'Warehouse Transfer Receive', 'description', 'Receive a transfer manifest at destination branch.', 'default_priority', 50, 'default_queue_key', 'warehouse', 'enabled', TRUE),
    jsonb_build_object('key', 'warehouse_transfer_reconcile', 'name', 'Warehouse Transfer Reconcile', 'description', 'Reconcile received items vs manifest; capture variance evidence.', 'default_priority', 50, 'default_queue_key', 'warehouse', 'enabled', TRUE)
  );
  v_item JSONB;
  v_key TEXT;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_value
    FROM public.settings s
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_execute_workflow_v1: global task_type_catalog settings missing'
      USING ERRCODE = '23503';
  END IF;

  v_task_types := COALESCE(v_value->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) IS DISTINCT FROM 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(v_new_items)
  LOOP
    v_key := lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), ''));
    IF v_key IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_task_types) AS t(value)
      WHERE lower(NULLIF(btrim(COALESCE(t.value->>'key', '')), '')) = v_key
    ) THEN
      v_task_types := v_task_types || jsonb_build_array(v_item);
    END IF;
  END LOOP;

  v_value := jsonb_set(COALESCE(v_value, '{}'::jsonb), '{task_types}', v_task_types, TRUE);
  IF NULLIF(btrim(COALESCE(v_value->>'version', '')), '') IS NULL THEN
    v_value := jsonb_set(v_value, '{version}', to_jsonb(1), TRUE);
  END IF;

  UPDATE public.settings_versions sv
     SET value = v_value,
         approved_at = now()
   WHERE sv.id = v_settings_version_id;

  UPDATE public.settings s
     SET cached_value = v_value,
         last_updated = now()
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash;
END;
$do$;

-------------------------------------------------------------------------------
-- 2) Service RPC: transition_warehouse_transfer_v1(jsonb)
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
    OR (v_vehicle_id IS NOT NULL AND v_before.vehicle_id IS NULL)
    OR (v_driver_user_id IS NOT NULL AND v_before.driver_user_id IS NULL)
  );

  IF v_should_update IS TRUE THEN
    UPDATE public.warehouse_transfers wt
       SET status = v_to_status,
           dispatched_at = CASE WHEN v_set_dispatched IS TRUE THEN COALESCE(wt.dispatched_at, v_effective_at) ELSE wt.dispatched_at END,
           received_at = CASE WHEN v_set_received IS TRUE THEN COALESCE(wt.received_at, v_effective_at) ELSE wt.received_at END,
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
      'vehicle_id', v_vehicle_id,
      'driver_user_id', v_driver_user_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.transition_warehouse_transfer_v1(JSONB)
  IS 'Service-only: transition warehouse_transfers.status and optionally set dispatched_at/received_at based on workflow-driven inputs. Validates status via lookup_definitions/lookup_values. Idempotent when already in target state.';

REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_warehouse_transfer_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 3) Workflow handler: warehouse_transfer (transition)
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
  v_set_dispatched BOOLEAN := FALSE;
  v_set_received BOOLEAN := FALSE;

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
    'to_status', lower(btrim(COALESCE(v_to_status, ''))),
    'effective_at', v_effective_at,
    'set_dispatched_at', v_set_dispatched,
    'set_received_at', v_set_received,
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

COMMENT ON FUNCTION workflow_handlers.execute_warehouse_transfer_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Workflow handler: transition warehouse_transfers via service-only transition_warehouse_transfer_v1(jsonb). Designed for task/workflow-driven execution parity.';

-------------------------------------------------------------------------------
-- 4) Register handler (safe dynamic dispatch)
-------------------------------------------------------------------------------

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

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
VALUES (
  'warehouse_transfer',
  'workflow_handlers',
  'execute_warehouse_transfer_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Warehouse transfer transition handler: update warehouse_transfers status/timestamps via service-only RPC (idempotent).',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

-------------------------------------------------------------------------------
-- 5) Workflow template: warehouse_transfer_execute_v1 (pack -> dispatch -> receive -> reconcile)
-------------------------------------------------------------------------------

INSERT INTO public.workflow_templates (name, description, version, status, scope_type, scope_id, created_by, created_at, updated_at, notes)
VALUES (
  'warehouse_transfer_execute_v1',
  'Warehouse transfer execution: enqueue tasks (pack/dispatch/receive/reconcile) and transition manifest status/timestamps via handlers (row-driven; scans SSOT).',
  1,
  'active',
  'global',
  NULL,
  NULL,
  now(),
  now(),
  'Workflow context must include organization_id and warehouse_transfer_id. Optional context keys can include from_branch_id/to_branch_id/vehicle_id/driver_user_id for downstream apps.'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    notes = EXCLUDED.notes,
    updated_at = now();

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'warehouse_transfer_execute_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_execute_v1 template id missing after upsert';
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
    );
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601261330_warehouse_transfer_execute_workflow_v1'));
COMMIT;

