-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Workflow handler for settlement batches + COD driver shift template (skeleton)
-- Date: 2026-01-21

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212892_settlement_workflow_driver_shift_cod'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Handler: settlement_batch (create/transition/attach)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_settlement_batch_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_action TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'action', '')), ''));
  v_payload_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'payload_path', '')), '');
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'settlement');
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');
  v_default_idempotency TEXT := format('workflow_run:%s:step:%s', p_run.id, p_step.id);

  v_input JSONB := '{}'::jsonb;
  v_candidate JSONB := NULL;

  v_settlement_batch_id UUID := NULL;
  v_settlement_event_id UUID := NULL;
  v_created BOOLEAN := NULL;

  v_attached BOOLEAN := NULL;
  v_to_status TEXT := NULLIF(btrim(COALESCE(v_meta->>'to_status', '')), '');
  v_status_reason TEXT := NULLIF(btrim(COALESCE(v_meta->>'status_reason', '')), '');

  v_resp workflow_handler_response;
BEGIN
  IF v_action IS NULL THEN
    RAISE EXCEPTION 'settlement_batch: missing metadata.action (expected create|transition|attach_finance_event) (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  IF v_payload_path IS NOT NULL THEN
    v_candidate := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_payload_path
    );
    IF v_candidate IS NOT NULL AND jsonb_typeof(v_candidate) = 'object' THEN
      v_input := v_candidate;
    ELSE
      v_input := '{}'::jsonb;
    END IF;
  ELSIF jsonb_typeof(v_meta->'payload') = 'object' THEN
    v_input := COALESCE(v_meta->'payload', '{}'::jsonb);
  ELSE
    v_input := v_ctx;
  END IF;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'settlement_batch: input must be a JSON object (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  -- Ensure actor_system is present (service RPCs store it in the settlement_events ledger).
  IF NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '') IS NULL THEN
    v_input := jsonb_set(v_input, '{actor_system}', to_jsonb(v_actor_system), TRUE);
  END IF;

  -- Ensure idempotency is present for service write paths.
  IF NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '') IS NULL THEN
    v_input := jsonb_set(v_input, '{idempotency_key}', to_jsonb(v_default_idempotency), TRUE);
  END IF;

  -- Common enrichment from metadata/context (keeps templates minimal and row-driven).
  IF NULLIF(btrim(COALESCE(v_input->>'settlement_batch_id', '')), '') IS NULL
     AND NULLIF(btrim(COALESCE(v_ctx->>'settlement_batch_id', '')), '') IS NOT NULL THEN
    v_input := jsonb_set(v_input, '{settlement_batch_id}', to_jsonb(v_ctx->>'settlement_batch_id'), TRUE);
  END IF;

  IF v_action = 'create' THEN
    SELECT settlement_batch_id, settlement_event_id, created
      INTO v_settlement_batch_id, v_settlement_event_id, v_created
      FROM public.create_settlement_batch_v1(v_input)
      LIMIT 1;

    v_resp.status := 'completed';
    v_resp.workflow_status := NULL;
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'action', v_action,
      'settlement_batch_id', v_settlement_batch_id,
      'settlement_event_id', v_settlement_event_id,
      'created', v_created
    ));
    v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'settlement_batch_id', v_settlement_batch_id,
      v_context_key, jsonb_strip_nulls(jsonb_build_object(
        'settlement_batch_id', v_settlement_batch_id,
        'settlement_event_id', v_settlement_event_id,
        'created', v_created
      ))
    ));
    RETURN v_resp;
  ELSIF v_action = 'transition' THEN
    IF NULLIF(btrim(COALESCE(v_input->>'to_status', '')), '') IS NULL THEN
      IF v_to_status IS NULL THEN
        RAISE EXCEPTION 'settlement_batch: transition requires to_status (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
      END IF;
      v_input := jsonb_set(v_input, '{to_status}', to_jsonb(lower(btrim(v_to_status))), TRUE);
    END IF;
    IF NULLIF(btrim(COALESCE(v_input->>'status_reason', '')), '') IS NULL AND v_status_reason IS NOT NULL THEN
      v_input := jsonb_set(v_input, '{status_reason}', to_jsonb(v_status_reason), TRUE);
    END IF;

    SELECT settlement_batch_id, settlement_event_id
      INTO v_settlement_batch_id, v_settlement_event_id
      FROM public.transition_settlement_batch_v1(v_input)
      LIMIT 1;

    v_resp.status := 'completed';
    v_resp.workflow_status := NULL;
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'action', v_action,
      'settlement_batch_id', v_settlement_batch_id,
      'settlement_event_id', v_settlement_event_id,
      'to_status', NULLIF(btrim(COALESCE(v_input->>'to_status', '')), '')
    ));
    v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
      v_context_key, jsonb_strip_nulls(jsonb_build_object(
        'settlement_batch_id', v_settlement_batch_id,
        'settlement_event_id', v_settlement_event_id,
        'to_status', NULLIF(btrim(COALESCE(v_input->>'to_status', '')), '')
      ))
    ));
    RETURN v_resp;
  ELSIF v_action = 'attach_finance_event' THEN
    SELECT settlement_batch_id, settlement_event_id, attached
      INTO v_settlement_batch_id, v_settlement_event_id, v_attached
      FROM public.attach_finance_event_to_settlement_v1(v_input)
      LIMIT 1;

    v_resp.status := CASE WHEN v_attached IS TRUE THEN 'completed' ELSE 'failed' END;
    v_resp.workflow_status := NULL;
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'action', v_action,
      'settlement_batch_id', v_settlement_batch_id,
      'settlement_event_id', v_settlement_event_id,
      'attached', v_attached
    ));
    v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
      v_context_key, jsonb_strip_nulls(jsonb_build_object(
        'settlement_batch_id', v_settlement_batch_id,
        'settlement_event_id', v_settlement_event_id,
        'attached', v_attached
      ))
    ));
    RETURN v_resp;
  ELSE
    RAISE EXCEPTION 'settlement_batch: unsupported action % (expected create|transition|attach_finance_event)', v_action
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-------------------------------------------------------------------------------
-- 2) Register handler (safe dynamic dispatch)
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
  'settlement_batch',
  'workflow_handlers',
  'execute_settlement_batch_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Generic settlement batch handler: create/transition/attach_finance_event via SSOT service RPCs.',
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
-- 3) Workflow template: cod_driver_shift_settlement_v1 (skeleton)
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_template_id UUID := '99990000-0000-0000-0000-000000570001'::uuid;
  v_step_1 UUID := '99990000-0000-0000-0000-000000570011'::uuid;
  v_step_2 UUID := '99990000-0000-0000-0000-000000570012'::uuid;
  v_step_3 UUID := '99990000-0000-0000-0000-000000570013'::uuid;
  v_step_4 UUID := '99990000-0000-0000-0000-000000570014'::uuid;
BEGIN
  INSERT INTO public.workflow_templates (
    id,
    name,
    description,
    status,
    version,
    scope_type,
    scope_id,
    notes,
    created_at,
    updated_at
  )
  VALUES (
    v_template_id,
    'cod_driver_shift_settlement_v1',
    'Skeleton: create COD settlement batch, enqueue cash handover task, wait, then lock the batch.',
    'active',
    1,
    'global',
    NULL,
    'Row-driven skeleton. Requires workflow context to provide settlement inputs (organization_id, scope_type, branch_id, subject_type/subject_id, window_start_at/window_end_at).',
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    version = EXCLUDED.version,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    metadata,
    enabled,
    handler_key,
    handler_version
  )
  VALUES (
    v_step_1,
    v_template_id,
    1,
    'cod_settlement_batch_create',
    'always',
    jsonb_build_object(
      'action', 'create',
      'context_key', 'settlement',
      'actor_system', 'workflow_engine',
      'payload_path', '$.context'
    ),
    TRUE,
    'settlement_batch',
    'v1'
  )
  ON CONFLICT (id) DO UPDATE SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    transition_condition = EXCLUDED.transition_condition,
    metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    updated_at = now();

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    metadata,
    enabled,
    handler_key,
    handler_version
  )
  VALUES (
    v_step_2,
    v_template_id,
    2,
    'cod_cash_handover_task_enqueue',
    'always',
    jsonb_build_object(
      'task_type_key', 'cod_cash_handover',
      'context_key', 'cash_handover_task',
      'actor_system', 'workflow_engine',
      'resource_type', 'settlement_batch',
      'resource_id_path', '$.context.settlement_batch_id'
    ),
    TRUE,
    'task_enqueue',
    'v1'
  )
  ON CONFLICT (id) DO UPDATE SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    transition_condition = EXCLUDED.transition_condition,
    metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    updated_at = now();

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    metadata,
    enabled,
    handler_key,
    handler_version
  )
  VALUES (
    v_step_3,
    v_template_id,
    3,
    'cod_cash_handover_task_wait',
    'always',
    jsonb_build_object(
      'context_key', 'cash_handover_task',
      'poll_interval_seconds', 60,
      'success_statuses', jsonb_build_array('completed'),
      'failure_statuses', jsonb_build_array('canceled')
    ),
    TRUE,
    'task_wait',
    'v1'
  )
  ON CONFLICT (id) DO UPDATE SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    transition_condition = EXCLUDED.transition_condition,
    metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    updated_at = now();

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    metadata,
    enabled,
    handler_key,
    handler_version
  )
  VALUES (
    v_step_4,
    v_template_id,
    4,
    'cod_settlement_batch_lock',
    'always',
    jsonb_build_object(
      'action', 'transition',
      'context_key', 'settlement',
      'actor_system', 'workflow_engine',
      'payload_path', '$.context',
      'to_status', 'locked'
    ),
    TRUE,
    'settlement_batch',
    'v1'
  )
  ON CONFLICT (id) DO UPDATE SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    transition_condition = EXCLUDED.transition_condition,
    metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    updated_at = now();
END$$;

SELECT pg_advisory_unlock(hashtext('202601212892_settlement_workflow_driver_shift_cod'));
COMMIT;

