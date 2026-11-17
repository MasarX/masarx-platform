-- Plan: PLAN-202603-b01-first-batch-execution / Step: S14
-- Migration: Workflow schedule recurring shipment glue
-- Purpose:
--   - Reuse workflow_templates + workflow_schedule_triggers for recurring shipment create.
--   - Derive shipment scope context from schedule scope instead of a parallel shipment_templates subsystem.
--   - Add a retry-safe schedule run idempotency key per trigger + due slot.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.workflow_schedule_trigger_run_key_v1(
  p_workflow_schedule_trigger_id UUID,
  p_due_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_due_at TIMESTAMPTZ := COALESCE(p_due_at, public.workflow_now());
BEGIN
  IF p_workflow_schedule_trigger_id IS NULL THEN
    RAISE EXCEPTION 'workflow_schedule_trigger_run_key_v1 requires workflow_schedule_trigger_id';
  END IF;

  RETURN lower(
    format(
      'schedule:%s:%s',
      p_workflow_schedule_trigger_id,
      to_char(timezone('UTC', v_due_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  );
END;
$$;

COMMENT ON FUNCTION public.workflow_schedule_trigger_run_key_v1(UUID, TIMESTAMPTZ)
  IS 'Build a deterministic idempotency key for one workflow_schedule_triggers due slot.';

CREATE OR REPLACE FUNCTION public.build_workflow_schedule_trigger_context_v1(
  p_trigger public.workflow_schedule_triggers,
  p_trigger_source TEXT,
  p_request_context_id UUID DEFAULT NULL,
  p_due_at TIMESTAMPTZ DEFAULT NULL,
  p_requested_by UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_context JSONB := COALESCE(p_trigger.context_patch, '{}'::jsonb);
  v_trigger_source TEXT := COALESCE(NULLIF(btrim(p_trigger_source), ''), 'worker');
  v_due_at TIMESTAMPTZ := COALESCE(p_due_at, p_trigger.next_run_at, public.workflow_now());
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_tracking_scope_type TEXT := NULL;
  v_tracking_scope_id UUID := NULL;
  v_idempotency_key TEXT := NULL;
BEGIN
  IF p_trigger.id IS NULL THEN
    RAISE EXCEPTION 'build_workflow_schedule_trigger_context_v1 requires workflow_schedule_triggers row';
  END IF;

  IF p_trigger.scope_type = 'client' THEN
    v_client_id := p_trigger.scope_id;
    v_tracking_scope_type := 'client';
    v_tracking_scope_id := p_trigger.scope_id;
  ELSIF p_trigger.scope_type = 'sender' THEN
    v_sender_id := p_trigger.scope_id;
    v_tracking_scope_type := 'sender';
    v_tracking_scope_id := p_trigger.scope_id;

    SELECT s.client_id
      INTO v_client_id
      FROM public.senders s
     WHERE s.id = p_trigger.scope_id
     LIMIT 1;
  ELSE
    v_tracking_scope_type := 'tenant';
    v_tracking_scope_id := p_trigger.organization_id;
  END IF;

  IF v_trigger_source = 'worker' THEN
    v_idempotency_key := public.workflow_schedule_trigger_run_key_v1(p_trigger.id, v_due_at);
  ELSIF v_trigger_source <> 'manual' THEN
    RAISE EXCEPTION 'build_workflow_schedule_trigger_context_v1 unsupported trigger_source: %', v_trigger_source;
  END IF;

  RETURN jsonb_strip_nulls(
    v_context || jsonb_build_object(
      'trigger_source', v_trigger_source,
      'organization_id', p_trigger.organization_id,
      'workflow_schedule_trigger_id', p_trigger.id,
      'scope_type', p_trigger.scope_type,
      'scope_id', p_trigger.scope_id,
      'tracking_scope_type', v_tracking_scope_type,
      'tracking_scope_id', v_tracking_scope_id,
      'performed_by_system',
        CASE
          WHEN v_trigger_source = 'manual' THEN 'ui_run_workflow_schedule_trigger_v1'
          ELSE 'workflow_schedule_triggers_worker'
        END,
      'request_context_id', p_request_context_id,
      'requested_by', p_requested_by,
      'schedule_due_at', timezone('UTC', v_due_at),
      'idempotency_key', v_idempotency_key,
      'client_id', v_client_id,
      'sender_id', v_sender_id
    )
  );
END;
$$;

COMMENT ON FUNCTION public.build_workflow_schedule_trigger_context_v1(public.workflow_schedule_triggers, TEXT, UUID, TIMESTAMPTZ, UUID)
  IS 'Resolve workflow_schedule_triggers run context, including scope-derived shipment fields and retry-safe idempotency for automatic schedule slots.';

CREATE OR REPLACE FUNCTION public.run_workflow_schedule_triggers_worker()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_items_processed INT := 0;
  v_error BOOLEAN := FALSE;
  v_row public.workflow_schedule_triggers%ROWTYPE;
  v_now TIMESTAMPTZ := public.workflow_now();
  v_run_id UUID;
  v_context_payload JSONB;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('workflow_schedule_triggers_worker');
  IF NOT v_throttle.should_run THEN
    RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_context := public.create_request_context('workflow_schedule_triggers_worker');

  FOR v_row IN
    SELECT *
    FROM public.workflow_schedule_triggers
    WHERE enabled = TRUE
      AND next_run_at <= v_now
    ORDER BY next_run_at ASC, id ASC
    LIMIT LEAST(v_throttle.batch_size, 100)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_items_processed := v_items_processed + 1;
    BEGIN
      v_context_payload := public.build_workflow_schedule_trigger_context_v1(
        v_row,
        'worker',
        v_context,
        v_row.next_run_at,
        NULL
      );

      v_run_id := public.start_workflow_run(v_row.workflow_template_id, v_context_payload);

      UPDATE public.workflow_schedule_triggers
      SET
        last_run_at = v_now,
        last_run_id = v_run_id,
        last_error = NULL,
        last_error_at = NULL,
        next_run_at = public.workflow_schedule_trigger_next_run_at(v_row.schedule, v_now),
        updated_at = now()
      WHERE id = v_row.id;
    EXCEPTION
      WHEN others THEN
        v_error := TRUE;
        UPDATE public.workflow_schedule_triggers
        SET
          last_run_at = v_now,
          last_run_id = NULL,
          last_error = SQLERRM,
          last_error_at = v_now,
          next_run_at = public.workflow_schedule_trigger_next_run_at(v_row.schedule, v_now),
          updated_at = now()
        WHERE id = v_row.id;
    END;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error, v_items_processed);
  PERFORM public.update_cron_config('workflow_schedule_triggers_worker');

  RETURN json_build_object(
    'status', 'completed',
    'items_processed', v_items_processed,
    'error', v_error
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_run_workflow_schedule_trigger_v1(
  p_workflow_schedule_trigger_id UUID
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
  v_row public.workflow_schedule_triggers%ROWTYPE;
  v_context JSONB;
  v_run_id UUID;
BEGIN
  IF p_workflow_schedule_trigger_id IS NULL THEN
    RAISE EXCEPTION 'ui_run_workflow_schedule_trigger_v1 requires workflow_schedule_trigger_id';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  SELECT *
  INTO v_row
  FROM public.workflow_schedule_triggers
  WHERE id = p_workflow_schedule_trigger_id
  LIMIT 1;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ui_run_workflow_schedule_trigger_v1 schedule trigger not found';
  END IF;

  v_context := public.build_workflow_schedule_trigger_context_v1(
    v_row,
    'manual',
    NULL,
    NULL,
    auth.uid()
  );

  v_run_id := public.start_workflow_run(v_row.workflow_template_id, v_context);

  RETURN jsonb_build_object(
    'status', 'workflow_started',
    'workflow_schedule_trigger_id', v_row.id,
    'workflow_template_id', v_row.workflow_template_id,
    'workflow_run_id', v_run_id
  );
END;
$$;

DO $$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'recurring_shipment_create_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    INSERT INTO public.workflow_templates (
      name,
      description,
      version,
      status,
      scope_type,
      scope_id,
      notes,
      created_at,
      updated_at
    )
    VALUES (
      'recurring_shipment_create_v1',
      'Reusable recurring shipment creation template built on reserve_shipment_identifiers plus shipment_create.',
      1,
      'active',
      'global',
      NULL,
      'Recurring shipment template: client/sender schedule scope derives shipment context; tenant scope must provide client_id in context_patch.',
      now(),
      now()
    )
    RETURNING id INTO v_template_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.workflow_template_steps
     WHERE workflow_template_id = v_template_id
       AND sequence_order = 0
       AND handler_key = 'reserve_shipment_identifiers'
  ) THEN
    INSERT INTO public.workflow_template_steps (
      workflow_template_id,
      sequence_order,
      operation_name,
      operation_settings_category,
      transition_condition,
      metadata,
      handler_key,
      handler_version,
      enabled,
      created_at,
      updated_at
    )
    VALUES (
      v_template_id,
      0,
      'reserve_identifiers',
      'workflow',
      'always',
      '{}'::jsonb,
      'reserve_shipment_identifiers',
      'v1',
      TRUE,
      now(),
      now()
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.workflow_template_steps
     WHERE workflow_template_id = v_template_id
       AND sequence_order = 1
       AND handler_key = 'shipment_create'
  ) THEN
    INSERT INTO public.workflow_template_steps (
      workflow_template_id,
      sequence_order,
      operation_name,
      operation_settings_category,
      transition_condition,
      metadata,
      handler_key,
      handler_version,
      enabled,
      created_at,
      updated_at
    )
    VALUES (
      v_template_id,
      1,
      'create_shipment',
      'workflow',
      'always',
      '{}'::jsonb,
      'shipment_create',
      'v1',
      TRUE,
      now(),
      now()
    );
  END IF;
END;
$$;

COMMIT;
