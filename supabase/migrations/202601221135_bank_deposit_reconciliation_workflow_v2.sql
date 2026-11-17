-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Bank deposit reconciliation workflow template v2 (adds bank statement matching)
-- Date: 2026-01-22
--
-- Notes:
--   - v2 adds a bank_statement_match step (policy-driven) and records the deposit transfer based on the matched statement amount.
--   - v1 template remains for manual accounting bank-match flows (task-based).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601221135_bank_deposit_reconciliation_workflow_v2'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Workflow template: bank_deposit_reconciliation_v2
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_template_id UUID := '99990000-0000-0000-0000-000000570004'::uuid;

  v_step_1 UUID := '99990000-0000-0000-0000-000000570041'::uuid;
  v_step_2 UUID := '99990000-0000-0000-0000-000000570042'::uuid;
  v_step_3 UUID := '99990000-0000-0000-0000-000000570043'::uuid;
  v_step_4 UUID := '99990000-0000-0000-0000-000000570044'::uuid;
  v_step_5 UUID := '99990000-0000-0000-0000-000000570045'::uuid;
  v_step_6 UUID := '99990000-0000-0000-0000-000000570046'::uuid;
  v_step_7 UUID := '99990000-0000-0000-0000-000000570047'::uuid;
  v_step_8 UUID := '99990000-0000-0000-0000-000000570048'::uuid;
  v_step_9 UUID := '99990000-0000-0000-0000-000000570049'::uuid;
  v_step_10 UUID := '99990000-0000-0000-0000-00000057004a'::uuid;
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
    'bank_deposit_reconciliation_v2',
    'Bank deposit reconciliation v2: deposit slip -> bank statement match -> finance transfer -> variance gate -> optional manager approval -> lock+approve.',
    'active',
    2,
    'global',
    NULL,
    'Row-driven template. Requires bank_reconciliation_policy.enabled=true (resolved by ladder) with a default bank_account_key for the branch/tenant. Workflow context must provide settlement inputs (organization_id, kind=deposit, scope_type=branch_day, branch_id, subject_type/subject_id, window_start_at/window_end_at). Variance between deposit slip and bank statement match drives optional manager approval (when_path).',
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
    'deposit_settlement_batch_create',
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

  -- Step 2: enqueue deposit slip task (branch cashier)
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
    'deposit_slip_task_enqueue',
    'always',
    jsonb_build_object(
      'task_type_key', 'bank_deposit_slip_create',
      'context_key', 'deposit_slip_task',
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

  -- Step 3: wait for deposit slip completion
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
    'deposit_slip_task_wait',
    'always',
    jsonb_build_object(
      'context_key', 'deposit_slip_task',
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

  -- Step 4: match bank statement line and attach to settlement batch (policy-driven)
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
    'deposit_bank_statement_match',
    'always',
    jsonb_build_object(
      'context_key', 'bank_statement_match',
      'actor_system', 'workflow_engine',
      'expected_task_context_key', 'deposit_slip_task',
      'expected_amount_task_payload_path', '$.payload.amount',
      'expected_currency_task_payload_path', '$.payload.currency',
      'direction', 'in',
      'require_enabled', TRUE,
      'poll_interval_seconds', 60
    ),
    TRUE,
    'bank_statement_match',
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

  -- Step 5: record finance transfer branch -> bank_account and attach to settlement batch
  -- Amount source is matched statement amount (actual).
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
    'deposit_finance_transfer',
    'always',
    jsonb_build_object(
      'context_key', 'deposit_transfer',
      'actor_system', 'workflow_engine',
      'event_type', 'deposit',
      'from_account_type', 'branch',
      'to_account_type', 'bank_account',
      'to_account_id_path', '$.context.bank_statement_match.bank_account_id',
      'attach_to_settlement', TRUE,
      'amount_path', '$.context.bank_statement_match.matched_amount',
      'currency_path', '$.context.bank_statement_match.currency'
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

  -- Step 6: compute variance between deposit slip and bank statement match (settlement_policy-driven)
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
    'deposit_variance_gate',
    'always',
    jsonb_build_object(
      'context_key', 'deposit_variance',
      'actor_system', 'workflow_engine',
      'expected_amount_context_path', '$.context.bank_statement_match.expected_amount',
      'actual_amount_context_path', '$.context.bank_statement_match.matched_amount',
      'currency_path', '$.context.bank_statement_match.currency',
      'use_cod_policy', FALSE,
      'prefer_settlement_policy', TRUE
    ),
    TRUE,
    'variance_gate',
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

  -- Step 7: lock settlement batch (pre-approval)
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
    'deposit_settlement_batch_lock',
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

  -- Step 8: enqueue manager approval task only when variance requires it
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
    'deposit_manager_approval_task_enqueue',
    'always',
    jsonb_build_object(
      'task_type_key', 'bank_deposit_manager_approval',
      'context_key', 'deposit_manager_approval_task',
      'actor_system', 'workflow_engine',
      'resource_type', 'settlement_batch',
      'resource_id_path', '$.context.settlement_batch_id',
      'when_path', '$.context.deposit_variance.requires_manager_approval'
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

  -- Step 9: wait for manager approval task when present; allow missing when skipped
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
    'deposit_manager_approval_task_wait',
    'always',
    jsonb_build_object(
      'context_key', 'deposit_manager_approval_task',
      'poll_interval_seconds', 60,
      'success_statuses', jsonb_build_array('completed'),
      'failure_statuses', jsonb_build_array('canceled'),
      'allow_missing_task', TRUE,
      'when_path', '$.context.deposit_variance.requires_manager_approval'
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

  -- Step 10: approve settlement batch (post-variance approval)
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
    'deposit_settlement_batch_approve',
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

-------------------------------------------------------------------------------
-- 2) Safety: ensure deposit v1 variance uses settlement_policy (avoid cod_policy coupling)
-------------------------------------------------------------------------------

UPDATE public.workflow_template_steps
SET metadata = public.jsonb_deep_merge(
  COALESCE(metadata, '{}'::jsonb),
  jsonb_build_object(
    'use_cod_policy', FALSE,
    'prefer_settlement_policy', TRUE
  )
),
updated_at = now()
WHERE workflow_template_id = (SELECT id FROM public.workflow_templates WHERE name = 'bank_deposit_reconciliation_v1' LIMIT 1)
  AND sequence_order = 6;

SELECT pg_advisory_unlock(hashtext('202601221135_bank_deposit_reconciliation_workflow_v2'));
COMMIT;

