-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Workflow handler variance_gate v1 (task variance -> manager approval flag)
-- Date: 2026-01-21

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212896_wf_variance_gate_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_variance_gate_v1(
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

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'variance');
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');

  v_settlement_batch_id UUID := NULL;
  v_settlement_batch_id_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'settlement_batch_id_path', '')), ''), '$.context.settlement_batch_id');

  v_expected_task_key TEXT := NULLIF(btrim(COALESCE(v_meta->>'expected_task_context_key', '')), '');
  v_actual_task_key TEXT := NULLIF(btrim(COALESCE(v_meta->>'actual_task_context_key', '')), '');

  v_expected_amount_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'expected_amount_path', '')), ''), '$.payload.amount');
  v_actual_amount_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actual_amount_path', '')), ''), '$.payload.amount');

  v_currency TEXT := NULLIF(btrim(COALESCE(v_meta->>'currency', '')), '');
  v_currency_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'currency_path', '')), '');

  v_expected_task_id UUID := NULL;
  v_actual_task_id UUID := NULL;
  v_expected_event public.task_events%ROWTYPE;
  v_actual_event public.task_events%ROWTYPE;

  v_expected_amount NUMERIC := NULL;
  v_actual_amount NUMERIC := NULL;
  v_variance_amount NUMERIC := NULL;
  v_abs_variance_amount NUMERIC := NULL;

  v_batch public.settlement_batches%ROWTYPE;
  v_policy_ctx JSONB := NULL;
  v_cod_policy_row RECORD;
  v_settlement_policy_row RECORD;
  v_cod_policy_resolution_id UUID := NULL;
  v_settlement_policy_resolution_id UUID := NULL;

  v_tolerance_amount NUMERIC := NULL;
  v_require_manager BOOLEAN := FALSE;
  v_requires_approval BOOLEAN := FALSE;

  v_decision_id UUID := NULL;

  v_candidate JSONB := NULL;
  v_amount_json JSONB := NULL;
  v_currency_json JSONB := NULL;
  v_resp workflow_handler_response;
BEGIN
  IF v_expected_task_key IS NULL OR v_actual_task_key IS NULL THEN
    RAISE EXCEPTION 'variance_gate: missing expected_task_context_key/actual_task_context_key (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_candidate := public.safe_jsonpath_query_first(
    jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
    v_settlement_batch_id_path
  );
  BEGIN v_settlement_batch_id := NULLIF(btrim(COALESCE(v_candidate #>> '{}', '')), '')::uuid; EXCEPTION WHEN others THEN v_settlement_batch_id := NULL; END;
  IF v_settlement_batch_id IS NULL THEN
    RAISE EXCEPTION 'variance_gate: settlement_batch_id missing from context' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_batch
  FROM public.settlement_batches b
  WHERE b.id = v_settlement_batch_id
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'variance_gate: settlement_batch_id % not found', v_settlement_batch_id;
  END IF;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_batch.organization_id,
    'client_id', v_batch.client_id,
    'sender_id', v_batch.sender_id,
    'resource_id', v_batch.branch_id
  ));

  -- Resolve terminal task events.
  BEGIN v_expected_task_id := NULLIF((v_ctx->v_expected_task_key)->>'task_id', '')::uuid; EXCEPTION WHEN others THEN v_expected_task_id := NULL; END;
  BEGIN v_actual_task_id := NULLIF((v_ctx->v_actual_task_key)->>'task_id', '')::uuid; EXCEPTION WHEN others THEN v_actual_task_id := NULL; END;
  IF v_expected_task_id IS NULL OR v_actual_task_id IS NULL THEN
    RAISE EXCEPTION 'variance_gate: expected/actual task_id missing from workflow context';
  END IF;

  SELECT * INTO v_expected_event
  FROM public.task_events te
  WHERE te.task_id = v_expected_task_id
  ORDER BY te.task_version DESC
  LIMIT 1;

  SELECT * INTO v_actual_event
  FROM public.task_events te
  WHERE te.task_id = v_actual_task_id
  ORDER BY te.task_version DESC
  LIMIT 1;

  v_amount_json := public.safe_jsonpath_query_first(
    jsonb_build_object('event', to_jsonb(v_expected_event), 'payload', COALESCE(v_expected_event.payload, '{}'::jsonb)),
    v_expected_amount_path
  );
  BEGIN v_expected_amount := NULLIF(btrim(COALESCE(v_amount_json #>> '{}', '')), '')::numeric; EXCEPTION WHEN others THEN v_expected_amount := NULL; END;

  v_amount_json := public.safe_jsonpath_query_first(
    jsonb_build_object('event', to_jsonb(v_actual_event), 'payload', COALESCE(v_actual_event.payload, '{}'::jsonb)),
    v_actual_amount_path
  );
  BEGIN v_actual_amount := NULLIF(btrim(COALESCE(v_amount_json #>> '{}', '')), '')::numeric; EXCEPTION WHEN others THEN v_actual_amount := NULL; END;

  IF v_expected_amount IS NULL OR v_expected_amount < 0 OR v_actual_amount IS NULL OR v_actual_amount < 0 THEN
    RAISE EXCEPTION 'variance_gate: invalid expected/actual amount (must be >= 0)' USING ERRCODE = '23514';
  END IF;

  IF v_currency IS NULL AND v_currency_path IS NOT NULL THEN
    v_currency_json := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_currency_path
    );
    v_currency := NULLIF(btrim(COALESCE(v_currency_json #>> '{}', '')), '');
  END IF;

  SELECT * INTO v_cod_policy_row
  FROM public.resolve_cod_policy(v_policy_ctx)
  LIMIT 1;

  IF FOUND AND v_cod_policy_row.value IS NOT NULL THEN
    BEGIN v_tolerance_amount := NULLIF(btrim(COALESCE(v_cod_policy_row.value #>> '{handover,variance_tolerance_amount}', '')), '')::numeric; EXCEPTION WHEN others THEN v_tolerance_amount := NULL; END;
    IF v_currency IS NULL THEN
      v_currency := NULLIF(btrim(COALESCE(v_cod_policy_row.value->>'currency', '')), '');
    END IF;
    v_cod_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_batch.organization_id,
      p_category := 'cod_policy',
      p_winning_scope_type := v_cod_policy_row.scope_type,
      p_winning_scope_id := v_cod_policy_row.scope_id,
      p_winning_settings_id := v_cod_policy_row.settings_id,
      p_winning_settings_version_id := v_cod_policy_row.settings_version_id,
      p_winning_version := v_cod_policy_row.version,
      p_scope_path := v_cod_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'expected_amount', v_expected_amount,
        'actual_amount', v_actual_amount
      )),
      p_merge_notes := NULL
    );
  END IF;

  SELECT * INTO v_settlement_policy_row
  FROM public.resolve_settlement_policy(v_policy_ctx)
  LIMIT 1;

  IF FOUND AND v_settlement_policy_row.value IS NOT NULL THEN
    IF v_tolerance_amount IS NULL THEN
      BEGIN v_tolerance_amount := NULLIF(btrim(COALESCE(v_settlement_policy_row.value #>> '{locking,max_variance_amount}', '')), '')::numeric; EXCEPTION WHEN others THEN v_tolerance_amount := NULL; END;
    END IF;
    BEGIN v_require_manager := COALESCE((v_settlement_policy_row.value #>> '{locking,require_manager_approval}')::boolean, FALSE); EXCEPTION WHEN others THEN v_require_manager := FALSE; END;

    v_settlement_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_batch.organization_id,
      p_category := 'settlement_policy',
      p_winning_scope_type := v_settlement_policy_row.scope_type,
      p_winning_scope_id := v_settlement_policy_row.scope_id,
      p_winning_settings_id := v_settlement_policy_row.settings_id,
      p_winning_settings_version_id := v_settlement_policy_row.settings_version_id,
      p_winning_version := v_settlement_policy_row.version,
      p_scope_path := v_settlement_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'expected_amount', v_expected_amount,
        'actual_amount', v_actual_amount
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_tolerance_amount IS NULL OR v_tolerance_amount < 0 THEN
    v_tolerance_amount := 0;
  END IF;

  v_variance_amount := v_expected_amount - v_actual_amount;
  v_abs_variance_amount := abs(v_variance_amount);
  v_requires_approval := (v_require_manager IS TRUE) AND (v_abs_variance_amount > v_tolerance_amount);

  v_decision_id := public.log_decision(
    p_organization_id := v_batch.organization_id,
    p_decision_category := 'settlement',
    p_resource_type := 'settlement_batch',
    p_resource_id := v_settlement_batch_id,
    p_decision_point := 'variance_gate',
    p_decision_outcome := CASE WHEN v_requires_approval THEN 'approval_required' ELSE 'within_tolerance' END,
    p_performed_by_system := 'workflow_handlers.execute_variance_gate_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'expected_task_id', v_expected_task_id,
      'actual_task_id', v_actual_task_id,
      'expected_amount', v_expected_amount,
      'actual_amount', v_actual_amount,
      'variance_amount', v_variance_amount,
      'abs_variance_amount', v_abs_variance_amount,
      'tolerance_amount', v_tolerance_amount,
      'currency', v_currency,
      'require_manager_approval', v_require_manager,
      'actor_system', v_actor_system
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := COALESCE(v_cod_policy_resolution_id, v_settlement_policy_resolution_id)
  );

  v_resp.status := 'completed';
  v_resp.workflow_status := NULL;
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'expected_task_id', v_expected_task_id,
    'actual_task_id', v_actual_task_id,
    'expected_amount', v_expected_amount,
    'actual_amount', v_actual_amount,
    'variance_amount', v_variance_amount,
    'abs_variance_amount', v_abs_variance_amount,
    'tolerance_amount', v_tolerance_amount,
    'currency', v_currency,
    'requires_manager_approval', v_requires_approval,
    'decision_log_id', v_decision_id,
    'cod_policy_settings_resolution_id', v_cod_policy_resolution_id,
    'settlement_policy_settings_resolution_id', v_settlement_policy_resolution_id
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'expected_task_id', v_expected_task_id,
      'actual_task_id', v_actual_task_id,
      'expected_amount', v_expected_amount,
      'actual_amount', v_actual_amount,
      'variance_amount', v_variance_amount,
      'abs_variance_amount', v_abs_variance_amount,
      'tolerance_amount', v_tolerance_amount,
      'currency', v_currency,
      'requires_manager_approval', v_requires_approval,
      'decision_log_id', v_decision_id,
      'cod_policy_settings_resolution_id', v_cod_policy_resolution_id,
      'settlement_policy_settings_resolution_id', v_settlement_policy_resolution_id
    ))
  );
  RETURN v_resp;
END;
$$;

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
  'variance_gate',
  'workflow_handlers',
  'execute_variance_gate_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Compute variance between two task amounts and set requires_manager_approval based on resolved cod_policy/settlement_policy.',
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

SELECT pg_advisory_unlock(hashtext('202601212896_wf_variance_gate_v1'));
COMMIT;

