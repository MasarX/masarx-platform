-- Plan: B08 Delivery proof & closeout / Step: E06
-- Migration: COD settlement summary contract replay v1
-- Purpose:
--   - Derive settlement expected totals from the latest canonical delivery payment_collection records.
--   - Enrich workflow settlement-batch context with canonical COD summary fields at create time.

-- Replay the canonical migration under a unique version because some local
-- histories already recorded `202604101200` for a different branch-only slice.
BEGIN;
SELECT pg_advisory_lock(hashtext('202604101386_b08_cod_settlement_summary_contract_replay_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Canonical COD payment collection summary helper
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_cod_payment_collection_summary_v1(
  p_organization_id UUID,
  p_branch_id UUID DEFAULT NULL,
  p_subject_type TEXT DEFAULT NULL,
  p_subject_id UUID DEFAULT NULL,
  p_window_start_at TIMESTAMPTZ DEFAULT NULL,
  p_window_end_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  WITH candidate_actions AS (
    SELECT
      rs.id AS route_stop_id,
      rr.id AS route_run_id,
      rr.driver_user_id,
      rr.branch_id,
      sa.payment_expected_amount AS expected_amount,
      sa.payment_collected_amount AS collected_amount,
      sa.payment_variance_amount AS variance_amount,
      sa.payment_collection_outcome AS outcome,
      sa.payment_has_discrepancy AS has_discrepancy,
      sa.payment_discrepancy_kind AS discrepancy_kind,
      sa.payment_currency AS currency,
      COALESCE(sa.timestamp, sa.created_at) AS payment_recorded_at,
      row_number() OVER (
        PARTITION BY rs.id
        ORDER BY COALESCE(sa.timestamp, sa.created_at) DESC, sa.created_at DESC, sa.id DESC
      ) AS rn
    FROM public.shipment_actions sa
    JOIN public.route_stops rs
      ON rs.id = COALESCE(
        NULLIF(sa.action_data->>'route_stop_id', '')::uuid,
        NULLIF(sa.action_data #>> '{delivery_completion,route_stop_id}', '')::uuid
      )
    JOIN public.route_runs rr
      ON rr.id = rs.route_run_id
    WHERE sa.organization_id = p_organization_id
      AND sa.payment_collection_outcome IS NOT NULL
      AND (p_branch_id IS NULL OR rr.branch_id = p_branch_id)
      AND (
        p_subject_type IS NULL
        OR p_subject_id IS NULL
        OR (
          lower(COALESCE(p_subject_type, '')) IN ('driver', 'user')
          AND rr.driver_user_id = p_subject_id
        )
        OR (
          lower(COALESCE(p_subject_type, '')) = 'branch'
          AND rr.branch_id = p_subject_id
        )
      )
      AND (p_window_start_at IS NULL OR COALESCE(sa.timestamp, sa.created_at) >= p_window_start_at)
      AND (p_window_end_at IS NULL OR COALESCE(sa.timestamp, sa.created_at) <= p_window_end_at)
  ),
  latest_actions AS (
    SELECT *
    FROM candidate_actions
    WHERE rn = 1
  )
  SELECT jsonb_strip_nulls(
    jsonb_build_object(
      'stop_count', COUNT(*)::int,
      'matched_stop_count', COUNT(*) FILTER (
        WHERE COALESCE(has_discrepancy, FALSE) IS FALSE
          AND COALESCE(outcome, '') <> 'refused'
      )::int,
      'discrepancy_count', COUNT(*) FILTER (
        WHERE COALESCE(has_discrepancy, FALSE) IS TRUE
           OR COALESCE(outcome, '') = 'refused'
      )::int,
      'refused_count', COUNT(*) FILTER (WHERE COALESCE(outcome, '') = 'refused')::int,
      'expected_amount', COALESCE(SUM(expected_amount), 0),
      'collected_amount', COALESCE(SUM(collected_amount), 0),
      'variance_amount', COALESCE(SUM(variance_amount), 0),
      'outstanding_amount', COALESCE(SUM(GREATEST(COALESCE(expected_amount, 0) - COALESCE(collected_amount, 0), 0)), 0),
      'currency', NULLIF(MAX(currency), ''),
      'latest_recorded_at', MAX(payment_recorded_at)
    )
  )
  FROM latest_actions;
$function$;

COMMENT ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  IS 'Summarize latest canonical COD payment_collection truth by visible route stop for settlement closeout.';

REVOKE ALL ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

-------------------------------------------------------------------------------
-- 2) Workflow settlement-batch handler enriches COD create context from canonical summary
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_settlement_batch_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $function$
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

  v_batch public.settlement_batches%ROWTYPE;
  v_cod_summary JSONB := NULL;
  v_summary_patch JSONB := '{}'::jsonb;
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

  IF NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '') IS NULL THEN
    v_input := jsonb_set(v_input, '{actor_system}', to_jsonb(v_actor_system), TRUE);
  END IF;

  IF NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '') IS NULL THEN
    v_input := jsonb_set(v_input, '{idempotency_key}', to_jsonb(v_default_idempotency), TRUE);
  END IF;

  IF NULLIF(btrim(COALESCE(v_input->>'settlement_batch_id', '')), '') IS NULL
     AND NULLIF(btrim(COALESCE(v_ctx->>'settlement_batch_id', '')), '') IS NOT NULL THEN
    v_input := jsonb_set(v_input, '{settlement_batch_id}', to_jsonb(v_ctx->>'settlement_batch_id'), TRUE);
  END IF;

  IF v_action = 'create' THEN
    SELECT settlement_batch_id, settlement_event_id, created
      INTO v_settlement_batch_id, v_settlement_event_id, v_created
      FROM public.create_settlement_batch_v1(v_input)
      LIMIT 1;

    SELECT *
      INTO v_batch
      FROM public.settlement_batches sb
     WHERE sb.id = v_settlement_batch_id
     LIMIT 1;

    IF FOUND AND lower(COALESCE(v_batch.kind, '')) = 'cod' THEN
      v_cod_summary := public.compute_cod_payment_collection_summary_v1(
        v_batch.organization_id,
        v_batch.branch_id,
        v_batch.subject_type,
        v_batch.subject_id,
        v_batch.window_start_at,
        v_batch.window_end_at
      );

      v_summary_patch := jsonb_strip_nulls(jsonb_build_object(
        'payment_collection_summary', v_cod_summary,
        'expected_amount', v_cod_summary->'expected_amount',
        'collected_amount', v_cod_summary->'collected_amount',
        'variance_amount', v_cod_summary->'variance_amount',
        'currency', NULLIF(btrim(COALESCE(v_cod_summary->>'currency', '')), '')
      ));

      UPDATE public.settlement_batches sb
         SET metadata = COALESCE(sb.metadata, '{}'::jsonb) || v_summary_patch,
             updated_at = now()
       WHERE sb.id = v_settlement_batch_id
       RETURNING * INTO v_batch;
    END IF;

    v_resp.status := 'completed';
    v_resp.workflow_status := NULL;
    v_resp.operation_result := jsonb_strip_nulls(
      jsonb_build_object(
        'action', v_action,
        'settlement_batch_id', v_settlement_batch_id,
        'settlement_event_id', v_settlement_event_id,
        'created', v_created
      ) || v_summary_patch
    );
    v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'settlement_batch_id', v_settlement_batch_id,
      v_context_key,
      jsonb_strip_nulls(
        jsonb_build_object(
          'settlement_batch_id', v_settlement_batch_id,
          'settlement_event_id', v_settlement_event_id,
          'created', v_created
        ) || v_summary_patch
      )
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
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_settlement_batch_v1(workflow_run_steps, workflow_runs, jsonb)
  IS 'Generic settlement batch handler that enriches COD batch create context from canonical delivery payment_collection truth.';

SELECT pg_advisory_unlock(hashtext('202604101386_b08_cod_settlement_summary_contract_replay_v1'));
COMMIT;
