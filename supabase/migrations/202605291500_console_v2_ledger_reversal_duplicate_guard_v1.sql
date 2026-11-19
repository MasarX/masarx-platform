-- Console V2 ledger reversal duplicate guard.
-- Keeps the backend fail-closed when an operator or client retries a ledger
-- reversal with a different idempotency key after the original event already
-- has a recorded reversal.

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ui_reverse_finance_event_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_target_org_id uuid := NULL;
  v_finance_event_id uuid := NULL;
  v_finance_occurred_at timestamptz := NULL;
  v_original public.finance_events%ROWTYPE;
  v_existing_reversal public.finance_events%ROWTYPE;
  v_reverse_direction text := NULL;
  v_reason text;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_id uuid := NULL;
  v_reversal_event_id uuid := NULL;
  v_created boolean := NULL;
  v_idempotency text := NULLIF(btrim(COALESCE(v_args->>'idempotency_key', '')), '');
  v_link record;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('finance.write');
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN v_target_org_id := NULLIF(v_args->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_target_org_id := NULL; END;
  v_target_org_id := COALESCE(v_target_org_id, v_org_id);
  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_target_org_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 organization_id outside tenant scope'
      USING ERRCODE = '42501';
  END IF;
  v_org_id := v_target_org_id;

  BEGIN v_finance_event_id := NULLIF(v_args->>'finance_event_id', '')::uuid; EXCEPTION WHEN others THEN v_finance_event_id := NULL; END;
  BEGIN v_finance_occurred_at := NULLIF(v_args->>'finance_occurred_at', '')::timestamptz; EXCEPTION WHEN others THEN v_finance_occurred_at := NULL; END;
  IF v_finance_event_id IS NULL THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 requires finance_event_id'
      USING ERRCODE = '23502';
  END IF;
  v_reason := public.ui_finance_assert_reason_v1('ui_reverse_finance_event_v1', v_args->>'reason');

  SELECT *
    INTO v_original
    FROM public.finance_events fe
   WHERE fe.id = v_finance_event_id
     AND fe.organization_id = v_org_id
     AND (v_finance_occurred_at IS NULL OR fe.occurred_at = v_finance_occurred_at)
   ORDER BY fe.occurred_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 finance_event_id % not found in current organization', v_finance_event_id
      USING ERRCODE = 'P0002';
  END IF;
  v_finance_occurred_at := v_original.occurred_at;
  IF lower(v_original.event_type) = 'adjustment'
     AND NULLIF(v_original.metadata->>'reverses_finance_event_id', '') IS NOT NULL THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 cannot reverse a reversal event'
      USING ERRCODE = '23514';
  END IF;

  v_reverse_direction := CASE lower(v_original.direction)
    WHEN 'in' THEN 'out'
    WHEN 'out' THEN 'in'
    WHEN 'credit' THEN 'debit'
    WHEN 'debit' THEN 'credit'
    ELSE NULL
  END;
  IF v_reverse_direction IS NULL THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 cannot infer reverse direction for %', v_original.direction
      USING ERRCODE = '23514';
  END IF;
  IF v_idempotency IS NULL THEN
    v_idempotency := format('console-v2:finance-reversal:%s:%s', v_original.id, replace(v_original.occurred_at::text, ' ', 'T'));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(format('ui_reverse_finance_event_v1:%s:%s', v_org_id, v_original.id), 0));

  SELECT *
    INTO v_existing_reversal
    FROM public.finance_events fe
   WHERE fe.organization_id = v_org_id
     AND lower(fe.event_type) = 'adjustment'
     AND fe.metadata->>'reverses_finance_event_id' = v_original.id::text
   ORDER BY fe.created_at ASC, fe.occurred_at ASC
   LIMIT 1;

  IF FOUND THEN
    IF NULLIF(v_existing_reversal.idempotency_key, '') = v_idempotency THEN
      RETURN jsonb_strip_nulls(jsonb_build_object(
        'ok', TRUE,
        'finance_event_id', v_existing_reversal.id,
        'reversed_finance_event_id', v_original.id,
        'created', FALSE,
        'decision_log_id', v_existing_reversal.decision_log_id,
        'correlation_id', v_correlation_id,
        'organization_id', v_org_id
      ));
    END IF;

    RAISE EXCEPTION 'ui_reverse_finance_event_v1 finance_event_id % already has reversal %', v_original.id, v_existing_reversal.id
      USING ERRCODE = '23505';
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'finance',
    p_resource_type := 'finance_event',
    p_resource_id := v_original.id,
    p_decision_point := 'finance_event_reversal',
    p_decision_outcome := 'recorded',
    p_performed_by_system := 'ui_reverse_finance_event_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'finance_event_id', v_original.id,
      'finance_occurred_at', v_original.occurred_at,
      'original_direction', v_original.direction,
      'reverse_direction', v_reverse_direction,
      'amount', v_original.amount,
      'currency', v_original.currency,
      'reason', v_reason,
      'organization_id', v_org_id
    )),
    p_decision_reason := v_reason,
    p_settings_resolution_id := NULL
  );

  SELECT finance_event_id, created
    INTO v_reversal_event_id, v_created
  FROM public.record_finance_event_v1(jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'event_type', 'adjustment',
    'direction', v_reverse_direction,
    'amount', v_original.amount,
    'currency', v_original.currency,
    'account_type', v_original.account_type,
    'account_id', v_original.account_id,
    'subject_type', v_original.subject_type,
    'subject_id', v_original.subject_id,
    'decision_log_id', v_decision_id,
    'settings_resolution_id', v_original.settings_resolution_id,
    'idempotency_key', v_idempotency,
    'metadata', COALESCE(v_original.metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'reversal', TRUE,
      'reverses_finance_event_id', v_original.id,
      'reverses_finance_occurred_at', v_original.occurred_at,
      'reversal_reason', v_reason,
      'original_event_type', v_original.event_type,
      'original_direction', v_original.direction,
      'source', 'console-v2/finance/ledger'
    )),
    'occurred_at', now()
  )))
  LIMIT 1;

  FOR v_link IN
    SELECT sbfe.settlement_batch_id
      FROM public.settlement_batch_finance_events sbfe
     WHERE sbfe.organization_id = v_org_id
       AND sbfe.finance_event_id = v_original.id
       AND sbfe.finance_occurred_at = v_original.occurred_at
  LOOP
    PERFORM public.attach_finance_event_to_settlement_v1(jsonb_strip_nulls(jsonb_build_object(
      'settlement_batch_id', v_link.settlement_batch_id,
      'finance_event_id', v_reversal_event_id,
      'idempotency_key', v_idempotency || ':attach:' || v_link.settlement_batch_id::text,
      'actor_user_id', v_user_id,
      'actor_system', 'ui_reverse_finance_event_v1',
      'payload', jsonb_build_object('reverses_finance_event_id', v_original.id)
    )));
  END LOOP;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'finance_event_id', v_reversal_event_id,
    'reversed_finance_event_id', v_original.id,
    'created', v_created,
    'decision_log_id', v_decision_id,
    'correlation_id', v_correlation_id,
    'organization_id', v_org_id
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_reverse_finance_event_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_reverse_finance_event_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_reverse_finance_event_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_reverse_finance_event_v1(jsonb) IS
  'Console V2 finance ledger reversal wrapper. Requires finance.write; appends one inverse adjustment finance_event per original ledger row, is idempotent for the same reversal key, and fails closed on duplicate reversal attempts with a different key.';
