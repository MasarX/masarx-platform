-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: bank_statement_match workflow handler v1 (statement->settlement matching)
-- Date: 2026-01-22
--
-- Goals:
--   - Provide a reusable workflow step that waits/polls for a bank statement finance_event and attaches it to a settlement batch.
--   - Resolve matching behavior from bank_reconciliation_policy (ladder-compliant; row-driven; no hardcoding).
--   - Keep SSOT: bank statement lines live in finance_events (event_type=bank_statement).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601221130_wf_bank_statement_match_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_bank_statement_match_v1(
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

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'bank_statement_match');
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');

  v_settlement_batch_id UUID := NULL;
  v_settlement_batch_id_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'settlement_batch_id_path', '')), ''), '$.context.settlement_batch_id');

  v_require_enabled BOOLEAN := COALESCE((v_meta->>'require_enabled')::boolean, FALSE);
  v_poll_seconds INT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'poll_interval_seconds', '')), '')::int, 300);

  -- Expected amount sources:
  v_expected_task_context_key TEXT := NULLIF(btrim(COALESCE(v_meta->>'expected_task_context_key', '')), '');
  v_expected_amount_task_payload_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'expected_amount_task_payload_path', '')), ''), '$.payload.amount');
  v_expected_currency_task_payload_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'expected_currency_task_payload_path', '')), ''), '$.payload.currency');

  -- Optional bank account sources:
  v_bank_account_id_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'bank_account_id_path', '')), '');
  v_bank_account_key_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'bank_account_key_path', '')), '');
  v_bank_account_key_task_payload_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'bank_account_key_task_payload_path', '')), ''), '$.payload.bank_account_key');

  -- Statement direction (deposit = in; withdrawals/fees = out).
  v_direction TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_meta->>'direction', '')), ''), 'in'));

  v_batch public.settlement_batches%ROWTYPE;

  v_expected_task_id UUID := NULL;
  v_expected_task public.tasks%ROWTYPE;
  v_expected_event public.task_events%ROWTYPE;

  v_expected_amount NUMERIC := NULL;
  v_expected_currency TEXT := NULL;
  v_anchor_at TIMESTAMPTZ := NULL;

  v_policy_ctx JSONB := NULL;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;

  v_policy_enabled BOOLEAN := FALSE;
  v_bank_statement_event_type TEXT := NULL;
  v_default_bank_account_key TEXT := NULL;

  v_window_days_before INT := NULL;
  v_window_days_after INT := NULL;
  v_amount_tolerance NUMERIC := NULL;
  v_require_unique BOOLEAN := TRUE;

  v_bank_account_id UUID := NULL;
  v_bank_account_key TEXT := NULL;

  v_window_start TIMESTAMPTZ := NULL;
  v_window_end TIMESTAMPTZ := NULL;

  v_match RECORD;
  v_match_count INT := 0;
  v_attach RECORD;

  v_policy_resolution_id UUID := NULL;
  v_decision_id UUID := NULL;

  v_candidate JSONB := NULL;
  v_amount_json JSONB := NULL;
  v_currency_json JSONB := NULL;
  v_resp workflow_handler_response;
BEGIN
  IF v_poll_seconds < 0 THEN
    v_poll_seconds := 300;
  END IF;

  -- Resolve settlement_batch_id from context.
  v_candidate := public.safe_jsonpath_query_first(
    jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
    v_settlement_batch_id_path
  );
  BEGIN v_settlement_batch_id := NULLIF(btrim(COALESCE(v_candidate #>> '{}', '')), '')::uuid; EXCEPTION WHEN others THEN v_settlement_batch_id := NULL; END;
  IF v_settlement_batch_id IS NULL THEN
    RAISE EXCEPTION 'bank_statement_match: settlement_batch_id missing from context' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_batch
  FROM public.settlement_batches b
  WHERE b.id = v_settlement_batch_id
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_statement_match: settlement_batch_id % not found', v_settlement_batch_id;
  END IF;

  -- Expected amount from a task context key (recommended).
  IF v_expected_task_context_key IS NOT NULL THEN
    BEGIN v_expected_task_id := NULLIF((v_ctx->v_expected_task_context_key)->>'task_id', '')::uuid; EXCEPTION WHEN others THEN v_expected_task_id := NULL; END;
    IF v_expected_task_id IS NULL THEN
      RAISE EXCEPTION 'bank_statement_match: expected_task_context_key=% missing task_id in workflow context', v_expected_task_context_key
        USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_expected_task
    FROM public.tasks t
    WHERE t.id = v_expected_task_id
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bank_statement_match: expected task_id % not found', v_expected_task_id;
    END IF;

    SELECT * INTO v_expected_event
    FROM public.task_events te
    WHERE te.task_id = v_expected_task_id
    ORDER BY te.task_version DESC
    LIMIT 1;

    v_amount_json := public.safe_jsonpath_query_first(
      jsonb_build_object('task', to_jsonb(v_expected_task), 'event', to_jsonb(v_expected_event), 'payload', COALESCE(v_expected_event.payload, '{}'::jsonb)),
      v_expected_amount_task_payload_path
    );
    BEGIN v_expected_amount := NULLIF(btrim(COALESCE(v_amount_json #>> '{}', '')), '')::numeric; EXCEPTION WHEN others THEN v_expected_amount := NULL; END;

    v_currency_json := public.safe_jsonpath_query_first(
      jsonb_build_object('task', to_jsonb(v_expected_task), 'event', to_jsonb(v_expected_event), 'payload', COALESCE(v_expected_event.payload, '{}'::jsonb)),
      v_expected_currency_task_payload_path
    );
    v_expected_currency := NULLIF(btrim(COALESCE(v_currency_json #>> '{}', '')), '');

    v_anchor_at := COALESCE(v_expected_event.created_at, now());

    v_candidate := public.safe_jsonpath_query_first(
      jsonb_build_object('task', to_jsonb(v_expected_task), 'event', to_jsonb(v_expected_event), 'payload', COALESCE(v_expected_event.payload, '{}'::jsonb)),
      v_bank_account_key_task_payload_path
    );
    v_bank_account_key := lower(NULLIF(btrim(COALESCE(v_candidate #>> '{}', '')), ''));
  END IF;

  IF v_expected_amount IS NULL OR v_expected_amount < 0 THEN
    RAISE EXCEPTION 'bank_statement_match: invalid expected amount (must be >= 0)' USING ERRCODE = '23514';
  END IF;

  IF v_anchor_at IS NULL THEN
    v_anchor_at := COALESCE(v_batch.window_end_at, now());
  END IF;

  -- Resolve bank_account_id, preferring explicit paths when present.
  IF v_bank_account_id_path IS NOT NULL THEN
    v_candidate := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_bank_account_id_path
    );
    BEGIN v_bank_account_id := NULLIF(btrim(COALESCE(v_candidate #>> '{}', '')), '')::uuid; EXCEPTION WHEN others THEN v_bank_account_id := NULL; END;
  END IF;

  IF v_bank_account_id IS NULL AND v_bank_account_key_path IS NOT NULL THEN
    v_candidate := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_bank_account_key_path
    );
    v_bank_account_key := lower(NULLIF(btrim(COALESCE(v_candidate #>> '{}', '')), ''));
  END IF;

  -- Resolve policy (ladder-compliant).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_batch.organization_id,
    'client_id', v_batch.client_id,
    'sender_id', v_batch.sender_id,
    'resource_id', v_batch.branch_id
  ));

  SELECT * INTO v_policy_row
  FROM public.resolve_bank_reconciliation_policy(v_policy_ctx)
  LIMIT 1;

  IF FOUND AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  BEGIN v_policy_enabled := COALESCE((v_policy->>'enabled')::boolean, FALSE); EXCEPTION WHEN others THEN v_policy_enabled := FALSE; END;

  v_bank_statement_event_type := lower(NULLIF(btrim(COALESCE(v_policy->>'bank_statement_event_type', 'bank_statement')), ''));
  IF v_bank_statement_event_type IS NULL THEN
    v_bank_statement_event_type := 'bank_statement';
  END IF;

  v_default_bank_account_key := lower(NULLIF(btrim(COALESCE(v_policy->>'default_bank_account_key', '')), ''));

  BEGIN v_window_days_before := NULLIF(btrim(COALESCE(v_policy #>> '{match,window_days_before}', '')), '')::int; EXCEPTION WHEN others THEN v_window_days_before := NULL; END;
  BEGIN v_window_days_after := NULLIF(btrim(COALESCE(v_policy #>> '{match,window_days_after}', '')), '')::int; EXCEPTION WHEN others THEN v_window_days_after := NULL; END;
  BEGIN v_amount_tolerance := NULLIF(btrim(COALESCE(v_policy #>> '{match,amount_tolerance}', '')), '')::numeric; EXCEPTION WHEN others THEN v_amount_tolerance := NULL; END;
  BEGIN v_require_unique := COALESCE((v_policy #>> '{match,require_unique}')::boolean, TRUE); EXCEPTION WHEN others THEN v_require_unique := TRUE; END;

  v_window_days_before := COALESCE(v_window_days_before, 2);
  v_window_days_after := COALESCE(v_window_days_after, 2);
  IF v_window_days_before < 0 THEN v_window_days_before := 0; END IF;
  IF v_window_days_after < 0 THEN v_window_days_after := 0; END IF;

  v_amount_tolerance := COALESCE(v_amount_tolerance, 0);
  IF v_amount_tolerance < 0 THEN v_amount_tolerance := 0; END IF;

  IF v_policy_enabled IS NOT TRUE THEN
    IF v_require_enabled IS TRUE THEN
      v_policy_resolution_id := public.log_settings_resolution(
        p_organization_id := v_batch.organization_id,
        p_category := 'bank_reconciliation_policy',
        p_winning_scope_type := v_policy_row.scope_type,
        p_winning_scope_id := v_policy_row.scope_id,
        p_winning_settings_id := v_policy_row.settings_id,
        p_winning_settings_version_id := v_policy_row.settings_version_id,
        p_winning_version := v_policy_row.version,
        p_scope_path := v_policy_row.scope_path,
        p_inputs := jsonb_strip_nulls(jsonb_build_object(
          'expected_amount', v_expected_amount,
          'direction', v_direction
        )),
        p_merge_notes := NULL
      );

      v_resp.status := 'failed';
      v_resp.workflow_status := NULL;
      v_resp.last_error := 'bank_statement_match: bank_reconciliation_policy is disabled';
      v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'failed',
        'reason', 'policy_disabled',
        'bank_reconciliation_policy_settings_resolution_id', v_policy_resolution_id
      ));
      RETURN v_resp;
    END IF;

    v_resp.status := 'completed';
    v_resp.workflow_status := NULL;
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'status', 'skipped',
      'skipped', TRUE,
      'reason', 'policy_disabled'
    ));
    v_resp.context_patch := jsonb_build_object(
      v_context_key,
      jsonb_strip_nulls(jsonb_build_object(
        'status', 'skipped',
        'skipped', TRUE,
        'reason', 'policy_disabled'
      ))
    );
    RETURN v_resp;
  END IF;

  -- bank_account_key fallback from policy when missing.
  IF v_bank_account_id IS NULL AND (v_bank_account_key IS NULL OR btrim(v_bank_account_key) = '') THEN
    v_bank_account_key := v_default_bank_account_key;
  END IF;

  IF v_bank_account_id IS NULL THEN
    IF v_bank_account_key IS NULL OR btrim(v_bank_account_key) = '' THEN
      RAISE EXCEPTION 'bank_statement_match: missing bank_account_id/bank_account_key (policy.default_bank_account_key also missing)'
        USING ERRCODE = '23514';
    END IF;

    SELECT ba.id
      INTO v_bank_account_id
      FROM public.bank_accounts ba
     WHERE ba.organization_id = v_batch.organization_id
       AND ba.key = v_bank_account_key
       AND ba.is_active IS TRUE
     LIMIT 1;

    IF v_bank_account_id IS NULL THEN
      RAISE EXCEPTION 'bank_statement_match: bank_account_key % not found for organization_id %', v_bank_account_key, v_batch.organization_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_window_start := v_anchor_at - make_interval(days => v_window_days_before);
  v_window_end := v_anchor_at + make_interval(days => v_window_days_after);

  SELECT COUNT(*)::int
    INTO v_match_count
    FROM public.finance_events fe
    LEFT JOIN public.settlement_batch_finance_events sbfe
      ON sbfe.organization_id = fe.organization_id
     AND sbfe.finance_event_id = fe.id
     AND sbfe.finance_occurred_at = fe.occurred_at
     AND sbfe.settlement_batch_id <> v_batch.id
   WHERE fe.organization_id = v_batch.organization_id
     AND fe.event_type = v_bank_statement_event_type
     AND fe.account_type = 'bank_account'
     AND fe.account_id = v_bank_account_id
     AND fe.direction = v_direction
     AND fe.occurred_at >= v_window_start
     AND fe.occurred_at <= v_window_end
     AND fe.amount >= (v_expected_amount - v_amount_tolerance)
     AND fe.amount <= (v_expected_amount + v_amount_tolerance)
     AND (v_expected_currency IS NULL OR fe.currency = v_expected_currency)
     AND sbfe.settlement_batch_id IS NULL;

  IF v_match_count = 0 THEN
    v_resp.status := 'pending';
    v_resp.workflow_status := NULL;
    v_resp.next_run_at := now() + make_interval(secs => v_poll_seconds);
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'status', 'pending',
      'reason', 'no_match',
      'expected_amount', v_expected_amount,
      'expected_currency', v_expected_currency,
      'direction', v_direction,
      'bank_account_id', v_bank_account_id,
      'bank_account_key', v_bank_account_key,
      'match_window_days_before', v_window_days_before,
      'match_window_days_after', v_window_days_after,
      'amount_tolerance', v_amount_tolerance,
      'next_poll_seconds', v_poll_seconds
    ));
    RETURN v_resp;
  END IF;

  IF v_require_unique IS TRUE AND v_match_count > 1 THEN
    v_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_batch.organization_id,
      p_category := 'bank_reconciliation_policy',
      p_winning_scope_type := v_policy_row.scope_type,
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := v_policy_row.version,
      p_scope_path := v_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'expected_amount', v_expected_amount,
        'direction', v_direction,
        'match_count', v_match_count
      )),
      p_merge_notes := NULL
    );

    v_decision_id := public.log_decision(
      p_organization_id := v_batch.organization_id,
      p_decision_category := 'finance',
      p_resource_type := 'settlement_batch',
      p_resource_id := v_batch.id,
      p_decision_point := 'bank_statement_match',
      p_decision_outcome := 'ambiguous',
      p_performed_by_system := 'workflow_handlers.execute_bank_statement_match_v1',
      p_correlation_id := public.current_correlation_id(),
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'expected_amount', v_expected_amount,
        'expected_currency', v_expected_currency,
        'direction', v_direction,
        'bank_account_id', v_bank_account_id,
        'bank_account_key', v_bank_account_key,
        'match_count', v_match_count,
        'match_window_start', v_window_start,
        'match_window_end', v_window_end,
        'amount_tolerance', v_amount_tolerance
      )),
      p_decision_reason := NULL,
      p_settings_resolution_id := v_policy_resolution_id
    );

    v_resp.status := 'failed';
    v_resp.workflow_status := NULL;
    v_resp.last_error := format('bank_statement_match: ambiguous matches (%s)', v_match_count);
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'status', 'failed',
      'reason', 'ambiguous',
      'match_count', v_match_count,
      'decision_log_id', v_decision_id,
      'bank_reconciliation_policy_settings_resolution_id', v_policy_resolution_id
    ));
    RETURN v_resp;
  END IF;

  SELECT fe.id, fe.occurred_at, fe.amount, fe.currency
    INTO v_match
    FROM public.finance_events fe
    LEFT JOIN public.settlement_batch_finance_events sbfe
      ON sbfe.organization_id = fe.organization_id
     AND sbfe.finance_event_id = fe.id
     AND sbfe.finance_occurred_at = fe.occurred_at
     AND sbfe.settlement_batch_id <> v_batch.id
   WHERE fe.organization_id = v_batch.organization_id
     AND fe.event_type = v_bank_statement_event_type
     AND fe.account_type = 'bank_account'
     AND fe.account_id = v_bank_account_id
     AND fe.direction = v_direction
     AND fe.occurred_at >= v_window_start
     AND fe.occurred_at <= v_window_end
     AND fe.amount >= (v_expected_amount - v_amount_tolerance)
     AND fe.amount <= (v_expected_amount + v_amount_tolerance)
     AND (v_expected_currency IS NULL OR fe.currency = v_expected_currency)
     AND sbfe.settlement_batch_id IS NULL
   ORDER BY abs(extract(epoch FROM (fe.occurred_at - v_anchor_at))) ASC, fe.occurred_at ASC
   LIMIT 1;

  IF v_match.id IS NULL THEN
    v_resp.status := 'pending';
    v_resp.workflow_status := NULL;
    v_resp.next_run_at := now() + make_interval(secs => v_poll_seconds);
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'status', 'pending',
      'reason', 'no_match_selected',
      'expected_amount', v_expected_amount,
      'expected_currency', v_expected_currency
    ));
    RETURN v_resp;
  END IF;

  v_policy_resolution_id := public.log_settings_resolution(
    p_organization_id := v_batch.organization_id,
    p_category := 'bank_reconciliation_policy',
    p_winning_scope_type := v_policy_row.scope_type,
    p_winning_scope_id := v_policy_row.scope_id,
    p_winning_settings_id := v_policy_row.settings_id,
    p_winning_settings_version_id := v_policy_row.settings_version_id,
    p_winning_version := v_policy_row.version,
    p_scope_path := v_policy_row.scope_path,
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'expected_amount', v_expected_amount,
      'matched_amount', v_match.amount,
      'matched_currency', v_match.currency,
      'direction', v_direction,
      'bank_account_id', v_bank_account_id
    )),
    p_merge_notes := NULL
  );

  SELECT settlement_event_id, attached
    INTO v_attach
    FROM public.attach_finance_event_to_settlement_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'settlement_batch_id', v_batch.id,
        'finance_event_id', v_match.id,
        'finance_occurred_at', v_match.occurred_at,
        'idempotency_key', format('workflow_run:%s:step:%s:bank_statement_attach', p_run.id, p_step.id),
        'actor_system', v_actor_system,
        'payload', jsonb_strip_nulls(jsonb_build_object(
          'bank_account_id', v_bank_account_id,
          'bank_account_key', v_bank_account_key,
          'event_type', v_bank_statement_event_type
        ))
      ))
    )
    LIMIT 1;

  v_decision_id := public.log_decision(
    p_organization_id := v_batch.organization_id,
    p_decision_category := 'finance',
    p_resource_type := 'settlement_batch',
    p_resource_id := v_batch.id,
    p_decision_point := 'bank_statement_match',
    p_decision_outcome := 'matched',
    p_performed_by_system := 'workflow_handlers.execute_bank_statement_match_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'expected_task_id', v_expected_task_id,
      'expected_amount', v_expected_amount,
      'expected_currency', v_expected_currency,
      'matched_finance_event_id', v_match.id,
      'matched_finance_occurred_at', v_match.occurred_at,
      'matched_amount', v_match.amount,
      'matched_currency', v_match.currency,
      'direction', v_direction,
      'bank_account_id', v_bank_account_id,
      'bank_account_key', v_bank_account_key,
      'match_window_start', v_window_start,
      'match_window_end', v_window_end,
      'amount_tolerance', v_amount_tolerance,
      'settlement_event_id', v_attach.settlement_event_id,
      'actor_system', v_actor_system
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_policy_resolution_id
  );

  v_resp.status := 'completed';
  v_resp.workflow_status := NULL;
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'status', 'matched',
    'expected_task_id', v_expected_task_id,
    'expected_amount', v_expected_amount,
    'expected_currency', v_expected_currency,
    'bank_account_id', v_bank_account_id,
    'bank_account_key', v_bank_account_key,
    'bank_statement_event_type', v_bank_statement_event_type,
    'matched_finance_event_id', v_match.id,
    'matched_finance_occurred_at', v_match.occurred_at,
    'matched_amount', v_match.amount,
    'matched_currency', v_match.currency,
    'settlement_event_id', v_attach.settlement_event_id,
    'decision_log_id', v_decision_id,
    'bank_reconciliation_policy_settings_resolution_id', v_policy_resolution_id
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'status', 'matched',
      'expected_task_id', v_expected_task_id,
      'expected_amount', v_expected_amount,
      'currency', COALESCE(v_match.currency, v_expected_currency),
      'bank_account_id', v_bank_account_id,
      'bank_account_key', v_bank_account_key,
      'bank_statement_event_type', v_bank_statement_event_type,
      'matched_finance_event_id', v_match.id,
      'matched_finance_occurred_at', v_match.occurred_at,
      'matched_amount', v_match.amount,
      'settlement_event_id', v_attach.settlement_event_id,
      'decision_log_id', v_decision_id,
      'bank_reconciliation_policy_settings_resolution_id', v_policy_resolution_id
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
  'bank_statement_match',
  'workflow_handlers',
  'execute_bank_statement_match_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Wait/poll for a matching finance_events bank statement line (event_type=bank_statement) and attach it to a settlement batch (ladder-resolved; row-driven).',
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

SELECT pg_advisory_unlock(hashtext('202601221130_wf_bank_statement_match_v1'));
COMMIT;

