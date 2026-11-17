-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: COD driver shift settlement workflow template v2 (handover + cashier count + variance gate + optional manager approval)
-- Date: 2026-01-21

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212897_settlement_workflow_driver_shift_cod_v2'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_template_id UUID := '99990000-0000-0000-0000-000000570002'::uuid;

  v_step_1 UUID := '99990000-0000-0000-0000-000000570021'::uuid;
  v_step_2 UUID := '99990000-0000-0000-0000-000000570022'::uuid;
  v_step_3 UUID := '99990000-0000-0000-0000-000000570023'::uuid;
  v_step_4 UUID := '99990000-0000-0000-0000-000000570024'::uuid;
  v_step_5 UUID := '99990000-0000-0000-0000-000000570025'::uuid;
  v_step_6 UUID := '99990000-0000-0000-0000-000000570026'::uuid;
  v_step_7 UUID := '99990000-0000-0000-0000-000000570027'::uuid;
  v_step_8 UUID := '99990000-0000-0000-0000-000000570028'::uuid;
  v_step_9 UUID := '99990000-0000-0000-0000-000000570029'::uuid;
  v_step_10 UUID := '99990000-0000-0000-0000-00000057002a'::uuid;
  v_step_11 UUID := '99990000-0000-0000-0000-00000057002b'::uuid;
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
    'cod_driver_shift_settlement_v2',
    'COD settlement v2: driver handover -> cashier count -> variance gate -> optional manager approval -> lock+approve.',
    'active',
    2,
    'global',
    NULL,
    'Row-driven template. Workflow context must provide settlement inputs (organization_id, kind=cod, scope_type=driver_shift, branch_id, subject_type/subject_id, window_start_at/window_end_at). Tasks are optionalized via metadata.when_path + allow_missing_task.',
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

  -- Step 1: create settlement batch (open)
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

  -- Step 2: enqueue driver handover task
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
    'cod_driver_handover_task_enqueue',
    'always',
    jsonb_build_object(
      'task_type_key', 'cod_cash_handover',
      'context_key', 'driver_handover_task',
      'actor_system', 'workflow_engine',
      'resource_type', 'settlement_batch',
      'resource_id_path', '$.context.settlement_batch_id'
    ),
    TRUE,
    'task_enqueue',
    'v2'
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

  -- Step 3: wait for driver handover task completion
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
    'cod_driver_handover_task_wait',
    'always',
    jsonb_build_object(
      'context_key', 'driver_handover_task',
      'poll_interval_seconds', 60,
      'success_statuses', jsonb_build_array('completed'),
      'failure_statuses', jsonb_build_array('canceled')
    ),
    TRUE,
    'task_wait',
    'v2'
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

  -- Step 4: enqueue cashier count/accept task
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
    'cod_cashier_count_task_enqueue',
    'always',
    jsonb_build_object(
      'task_type_key', 'cod_cashier_count',
      'context_key', 'cashier_count_task',
      'actor_system', 'workflow_engine',
      'resource_type', 'settlement_batch',
      'resource_id_path', '$.context.settlement_batch_id'
    ),
    TRUE,
    'task_enqueue',
    'v2'
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

  -- Step 5: wait for cashier count/accept task completion
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
    v_step_5,
    v_template_id,
    5,
    'cod_cashier_count_task_wait',
    'always',
    jsonb_build_object(
      'context_key', 'cashier_count_task',
      'poll_interval_seconds', 60,
      'success_statuses', jsonb_build_array('completed'),
      'failure_statuses', jsonb_build_array('canceled')
    ),
    TRUE,
    'task_wait',
    'v2'
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

  -- Step 6: compute variance between driver handover and cashier count (policy-driven)
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
    v_step_6,
    v_template_id,
    6,
    'cod_handover_variance_gate',
    'always',
    jsonb_build_object(
      'context_key', 'cod_variance',
      'actor_system', 'workflow_engine',
      'expected_task_context_key', 'driver_handover_task',
      'actual_task_context_key', 'cashier_count_task',
      'expected_amount_path', '$.payload.amount',
      'actual_amount_path', '$.payload.amount'
    ),
    TRUE,
    'variance_gate',
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

  -- Step 7: record finance transfer driver -> branch and attach to settlement batch (amount from cashier count task payload)
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
    v_step_7,
    v_template_id,
    7,
    'cod_handover_finance_transfer',
    'always',
    jsonb_build_object(
      'context_key', 'cod_handover_transfer',
      'actor_system', 'workflow_engine',
      'event_type', 'cod_handover',
      'from_account_type', 'driver',
      'to_account_type', 'branch',
      'attach_to_settlement', TRUE,
      'amount_task_context_key', 'cashier_count_task',
      'amount_task_payload_path', '$.payload.amount'
    ),
    TRUE,
    'finance_transfer',
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

  -- Step 8: lock settlement batch (pre-approval)
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
    v_step_8,
    v_template_id,
    8,
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

  -- Step 9: enqueue manager approval task only when variance requires it
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
    v_step_9,
    v_template_id,
    9,
    'cod_manager_approval_task_enqueue',
    'always',
    jsonb_build_object(
      'task_type_key', 'cod_manager_approval',
      'context_key', 'manager_approval_task',
      'actor_system', 'workflow_engine',
      'resource_type', 'settlement_batch',
      'resource_id_path', '$.context.settlement_batch_id',
      'when_path', '$.context.cod_variance.requires_manager_approval'
    ),
    TRUE,
    'task_enqueue',
    'v2'
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

  -- Step 10: wait for manager approval task when present; allow missing when skipped
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
    v_step_10,
    v_template_id,
    10,
    'cod_manager_approval_task_wait',
    'always',
    jsonb_build_object(
      'context_key', 'manager_approval_task',
      'poll_interval_seconds', 60,
      'success_statuses', jsonb_build_array('completed'),
      'failure_statuses', jsonb_build_array('canceled'),
      'allow_missing_task', TRUE,
      'when_path', '$.context.cod_variance.requires_manager_approval'
    ),
    TRUE,
    'task_wait',
    'v2'
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

  -- Step 11: approve settlement batch (post-variance approval)
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
    v_step_11,
    v_template_id,
    11,
    'cod_settlement_batch_approve',
    'always',
    jsonb_build_object(
      'action', 'transition',
      'context_key', 'settlement',
      'actor_system', 'workflow_engine',
      'payload_path', '$.context',
      'to_status', 'approved'
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

SELECT pg_advisory_unlock(hashtext('202601212897_settlement_workflow_driver_shift_cod_v2'));
COMMIT;

