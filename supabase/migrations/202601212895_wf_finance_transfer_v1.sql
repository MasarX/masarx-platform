-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Workflow handler finance_transfer v1 (paired finance_events + optional settlement attach)
-- Date: 2026-01-21

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212895_wf_finance_transfer_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_finance_transfer_v1(
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

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'finance_transfer');
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');

  v_event_type TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'event_type', '')), ''));
  v_attach_to_settlement BOOLEAN := COALESCE((v_meta->>'attach_to_settlement')::boolean, TRUE);

  v_idempotency_base TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'idempotency_key', '')), ''),
    format('workflow_run:%s:step:%s', p_run.id, p_step.id)
  );

  v_settlement_batch_id UUID := NULL;
  v_settlement_batch_id_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'settlement_batch_id_path', '')), ''), '$.context.settlement_batch_id');

  v_amount_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'amount_path', '')), '');
  v_amount_task_context_key TEXT := NULLIF(btrim(COALESCE(v_meta->>'amount_task_context_key', '')), '');
  v_amount_task_payload_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'amount_task_payload_path', '')), ''), '$.payload.amount');

  v_currency TEXT := NULLIF(btrim(COALESCE(v_meta->>'currency', '')), '');
  v_currency_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'currency_path', '')), '');

  v_from_account_type TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'from_account_type', '')), ''));
  v_to_account_type TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'to_account_type', '')), ''));
  v_from_account_id_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'from_account_id_path', '')), '');
  v_to_account_id_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'to_account_id_path', '')), '');

  v_org_id UUID := NULL;
  v_amount NUMERIC := NULL;
  v_occurred_at TIMESTAMPTZ := now();

  v_from_account_id UUID := NULL;
  v_to_account_id UUID := NULL;

  v_batch public.settlement_batches%ROWTYPE;
  v_task public.tasks%ROWTYPE;
  v_last_event public.task_events%ROWTYPE;
  v_task_id UUID := NULL;

  v_candidate JSONB := NULL;
  v_amount_json JSONB := NULL;
  v_currency_json JSONB := NULL;
  v_transfer_id UUID := gen_random_uuid();

  v_policy_ctx JSONB := NULL;
  v_cod_policy_row RECORD;
  v_cod_policy_resolution_id UUID := NULL;
  v_decision_id UUID := NULL;

  v_from_event_id UUID := NULL;
  v_to_event_id UUID := NULL;
  v_from_created BOOLEAN := NULL;
  v_to_created BOOLEAN := NULL;

  v_from_attach_event_id UUID := NULL;
  v_to_attach_event_id UUID := NULL;
  v_attached BOOLEAN := NULL;

  v_resp workflow_handler_response;
BEGIN
  IF v_event_type IS NULL THEN
    RAISE EXCEPTION 'finance_transfer: missing metadata.event_type (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_from_account_type IS NULL OR v_to_account_type IS NULL THEN
    RAISE EXCEPTION 'finance_transfer: missing from_account_type/to_account_type (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_candidate := public.safe_jsonpath_query_first(
    jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
    v_settlement_batch_id_path
  );
  BEGIN v_settlement_batch_id := NULLIF(btrim(COALESCE(v_candidate #>> '{}', '')), '')::uuid; EXCEPTION WHEN others THEN v_settlement_batch_id := NULL; END;

  IF v_settlement_batch_id IS NOT NULL THEN
    SELECT * INTO v_batch
    FROM public.settlement_batches b
    WHERE b.id = v_settlement_batch_id
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance_transfer: settlement_batch_id % not found', v_settlement_batch_id;
    END IF;
    v_org_id := v_batch.organization_id;

    v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_batch.organization_id,
      'client_id', v_batch.client_id,
      'sender_id', v_batch.sender_id,
      'resource_id', v_batch.branch_id
    ));
  END IF;

  -- Resolve org_id from context if not using settlement batch.
  IF v_org_id IS NULL THEN
    BEGIN v_org_id := NULLIF(v_ctx->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'finance_transfer: organization_id missing (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  -- Amount: try amount_path first, then fall back to last task_event payload.
  IF v_amount_path IS NOT NULL THEN
    v_amount_json := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_amount_path
    );
    BEGIN v_amount := NULLIF(btrim(COALESCE(v_amount_json #>> '{}', '')), '')::numeric; EXCEPTION WHEN others THEN v_amount := NULL; END;
  END IF;

  IF v_amount IS NULL AND v_amount_task_context_key IS NOT NULL THEN
    BEGIN v_task_id := NULLIF((v_ctx->v_amount_task_context_key)->>'task_id', '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;

    IF v_task_id IS NULL THEN
      RAISE EXCEPTION 'finance_transfer: amount_task_context_key=% missing task_id in workflow context', v_amount_task_context_key
        USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_task
    FROM public.tasks t
    WHERE t.id = v_task_id
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance_transfer: task_id % not found (amount source)', v_task_id;
    END IF;

    SELECT *
      INTO v_last_event
      FROM public.task_events te
     WHERE te.task_id = v_task_id
     ORDER BY te.task_version DESC
     LIMIT 1;

    v_amount_json := public.safe_jsonpath_query_first(
      jsonb_build_object('task', to_jsonb(v_task), 'event', to_jsonb(v_last_event), 'payload', COALESCE(v_last_event.payload, '{}'::jsonb)),
      v_amount_task_payload_path
    );
    BEGIN v_amount := NULLIF(btrim(COALESCE(v_amount_json #>> '{}', '')), '')::numeric; EXCEPTION WHEN others THEN v_amount := NULL; END;

    v_currency_json := public.safe_jsonpath_query_first(
      jsonb_build_object('task', to_jsonb(v_task), 'event', to_jsonb(v_last_event), 'payload', COALESCE(v_last_event.payload, '{}'::jsonb)),
      COALESCE(v_currency_path, '$.payload.currency')
    );
    IF v_currency IS NULL THEN
      v_currency := NULLIF(btrim(COALESCE(v_currency_json #>> '{}', '')), '');
    END IF;

    IF v_last_event.created_at IS NOT NULL THEN
      v_occurred_at := v_last_event.created_at;
    END IF;
  END IF;

  IF v_amount IS NULL OR v_amount < 0 THEN
    RAISE EXCEPTION 'finance_transfer: invalid amount (must be >= 0)' USING ERRCODE = '23514';
  END IF;

  -- Resolve COD policy currency when not explicitly provided.
  IF (v_currency IS NULL OR btrim(v_currency) = '') AND v_policy_ctx IS NOT NULL THEN
    SELECT * INTO v_cod_policy_row
    FROM public.resolve_cod_policy(v_policy_ctx)
    LIMIT 1;

    IF FOUND AND v_cod_policy_row.value IS NOT NULL THEN
      v_currency := NULLIF(btrim(COALESCE(v_cod_policy_row.value->>'currency', '')), '');

      v_cod_policy_resolution_id := public.log_settings_resolution(
        p_organization_id := v_org_id,
        p_category := 'cod_policy',
        p_winning_scope_type := v_cod_policy_row.scope_type,
        p_winning_scope_id := v_cod_policy_row.scope_id,
        p_winning_settings_id := v_cod_policy_row.settings_id,
        p_winning_settings_version_id := v_cod_policy_row.settings_version_id,
        p_winning_version := v_cod_policy_row.version,
        p_scope_path := v_cod_policy_row.scope_path,
        p_inputs := jsonb_strip_nulls(jsonb_build_object(
          'event_type', v_event_type,
          'amount', v_amount,
          'currency', v_currency
        )),
        p_merge_notes := NULL
      );
    END IF;
  END IF;

  IF v_currency IS NULL OR btrim(v_currency) = '' THEN
    RAISE EXCEPTION 'finance_transfer: currency missing (provide metadata.currency/currency_path or cod_policy.currency)' USING ERRCODE = '23514';
  END IF;

  -- Resolve account ids.
  IF v_from_account_id_path IS NOT NULL THEN
    v_candidate := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_from_account_id_path
    );
    BEGIN v_from_account_id := NULLIF(btrim(COALESCE(v_candidate #>> '{}', '')), '')::uuid; EXCEPTION WHEN others THEN v_from_account_id := NULL; END;
  END IF;

  IF v_to_account_id_path IS NOT NULL THEN
    v_candidate := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_to_account_id_path
    );
    BEGIN v_to_account_id := NULLIF(btrim(COALESCE(v_candidate #>> '{}', '')), '')::uuid; EXCEPTION WHEN others THEN v_to_account_id := NULL; END;
  END IF;

  -- Reasonable defaults when settlement_batch anchors exist.
  IF v_settlement_batch_id IS NOT NULL THEN
    IF v_from_account_id IS NULL THEN
      IF v_from_account_type = 'driver' AND v_batch.subject_id IS NOT NULL THEN
        v_from_account_id := v_batch.subject_id;
      ELSIF v_from_account_type = 'branch' AND v_batch.branch_id IS NOT NULL THEN
        v_from_account_id := v_batch.branch_id;
      ELSIF v_from_account_type = 'company' THEN
        v_from_account_id := v_batch.organization_id;
      END IF;
    END IF;
    IF v_to_account_id IS NULL THEN
      IF v_to_account_type = 'branch' AND v_batch.branch_id IS NOT NULL THEN
        v_to_account_id := v_batch.branch_id;
      ELSIF v_to_account_type = 'driver' AND v_batch.subject_id IS NOT NULL THEN
        v_to_account_id := v_batch.subject_id;
      ELSIF v_to_account_type = 'company' THEN
        v_to_account_id := v_batch.organization_id;
      END IF;
    END IF;
  END IF;

  IF v_from_account_id IS NULL OR v_to_account_id IS NULL THEN
    RAISE EXCEPTION 'finance_transfer: could not resolve from/to account_id (provide *_account_id_path or settlement batch anchors)' USING ERRCODE = '23514';
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'finance',
    p_resource_type := 'settlement_batch',
    p_resource_id := v_settlement_batch_id,
    p_decision_point := 'transfer',
    p_decision_outcome := 'recorded',
    p_performed_by_system := 'workflow_handlers.execute_finance_transfer_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'transfer_id', v_transfer_id,
      'event_type', v_event_type,
      'amount', v_amount,
      'currency', v_currency,
      'from_account_type', v_from_account_type,
      'from_account_id', v_from_account_id,
      'to_account_type', v_to_account_type,
      'to_account_id', v_to_account_id,
      'occurred_at', v_occurred_at,
      'task_id', v_task_id,
      'actor_system', v_actor_system
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_cod_policy_resolution_id
  );

  SELECT finance_event_id, created
    INTO v_from_event_id, v_from_created
    FROM public.record_finance_event_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'event_type', v_event_type,
        'direction', 'out',
        'amount', v_amount,
        'currency', v_currency,
        'account_type', v_from_account_type,
        'account_id', v_from_account_id,
        'subject_type', CASE WHEN v_settlement_batch_id IS NOT NULL THEN 'settlement_batch' ELSE NULL END,
        'subject_id', v_settlement_batch_id,
        'decision_log_id', v_decision_id,
        'settings_resolution_id', v_cod_policy_resolution_id,
        'idempotency_key', v_idempotency_base || ':from',
        'metadata', jsonb_strip_nulls(jsonb_build_object(
          'transfer_id', v_transfer_id,
          'side', 'from',
          'actor_system', v_actor_system
        )),
        'occurred_at', v_occurred_at
      ))
    )
    LIMIT 1;

  SELECT finance_event_id, created
    INTO v_to_event_id, v_to_created
    FROM public.record_finance_event_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'event_type', v_event_type,
        'direction', 'in',
        'amount', v_amount,
        'currency', v_currency,
        'account_type', v_to_account_type,
        'account_id', v_to_account_id,
        'subject_type', CASE WHEN v_settlement_batch_id IS NOT NULL THEN 'settlement_batch' ELSE NULL END,
        'subject_id', v_settlement_batch_id,
        'decision_log_id', v_decision_id,
        'settings_resolution_id', v_cod_policy_resolution_id,
        'idempotency_key', v_idempotency_base || ':to',
        'metadata', jsonb_strip_nulls(jsonb_build_object(
          'transfer_id', v_transfer_id,
          'side', 'to',
          'actor_system', v_actor_system
        )),
        'occurred_at', v_occurred_at
      ))
    )
    LIMIT 1;

  IF v_attach_to_settlement IS TRUE AND v_settlement_batch_id IS NOT NULL THEN
    SELECT settlement_event_id, attached
      INTO v_from_attach_event_id, v_attached
      FROM public.attach_finance_event_to_settlement_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'settlement_batch_id', v_settlement_batch_id,
          'finance_event_id', v_from_event_id,
          'finance_occurred_at', v_occurred_at,
          'idempotency_key', v_idempotency_base || ':attach:from',
          'actor_system', v_actor_system,
          'payload', jsonb_strip_nulls(jsonb_build_object(
            'transfer_id', v_transfer_id,
            'side', 'from'
          ))
        ))
      )
      LIMIT 1;

    SELECT settlement_event_id, attached
      INTO v_to_attach_event_id, v_attached
      FROM public.attach_finance_event_to_settlement_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'settlement_batch_id', v_settlement_batch_id,
          'finance_event_id', v_to_event_id,
          'finance_occurred_at', v_occurred_at,
          'idempotency_key', v_idempotency_base || ':attach:to',
          'actor_system', v_actor_system,
          'payload', jsonb_strip_nulls(jsonb_build_object(
            'transfer_id', v_transfer_id,
            'side', 'to'
          ))
        ))
      )
      LIMIT 1;
  END IF;

  v_resp.status := 'completed';
  v_resp.workflow_status := NULL;
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'transfer_id', v_transfer_id,
    'event_type', v_event_type,
    'amount', v_amount,
    'currency', v_currency,
    'occurred_at', v_occurred_at,
    'from_finance_event_id', v_from_event_id,
    'to_finance_event_id', v_to_event_id,
    'from_created', v_from_created,
    'to_created', v_to_created,
    'from_settlement_event_id', v_from_attach_event_id,
    'to_settlement_event_id', v_to_attach_event_id,
    'decision_log_id', v_decision_id,
    'settings_resolution_id', v_cod_policy_resolution_id
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'transfer_id', v_transfer_id,
      'event_type', v_event_type,
      'amount', v_amount,
      'currency', v_currency,
      'occurred_at', v_occurred_at,
      'from_finance_event_id', v_from_event_id,
      'to_finance_event_id', v_to_event_id,
      'decision_log_id', v_decision_id,
      'settings_resolution_id', v_cod_policy_resolution_id
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
  'finance_transfer',
  'workflow_handlers',
  'execute_finance_transfer_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Create paired finance_events (out/in) for a transfer and optionally attach them to a settlement batch (idempotent; policy-driven currency).',
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

SELECT pg_advisory_unlock(hashtext('202601212895_wf_finance_transfer_v1'));
COMMIT;

