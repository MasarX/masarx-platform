-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Fix record_bank_statement_event_v1 ambiguous column reference (OUT params vs SELECT list)
-- Date: 2026-01-22

BEGIN;
SELECT pg_advisory_lock(hashtext('202601221140_record_bank_statement_event_v1_fix'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.record_bank_statement_event_v1(
  p_input JSONB
)
RETURNS TABLE (
  finance_event_id UUID,
  created BOOLEAN,
  decision_log_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);

  v_org_id UUID := NULL;
  v_bank_account_id UUID := NULL;
  v_bank_account_key TEXT := NULL;

  v_event_type TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'event_type', 'bank_statement')), ''));
  v_direction TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'direction', '')), ''));
  v_amount NUMERIC := NULL;
  v_currency TEXT := NULLIF(btrim(COALESCE(v_input->>'currency', '')), '');
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_occurred_at TIMESTAMPTZ := now();

  v_metadata JSONB := COALESCE(v_input->'metadata', '{}'::jsonb);
  v_decision_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_bank_account_id := NULLIF(v_input->>'bank_account_id', '')::uuid; EXCEPTION WHEN others THEN v_bank_account_id := NULL; END;
  v_bank_account_key := lower(NULLIF(btrim(COALESCE(v_input->>'bank_account_key', '')), ''));
  BEGIN v_amount := NULLIF(v_input->>'amount', '')::numeric; EXCEPTION WHEN others THEN v_amount := NULL; END;
  BEGIN v_occurred_at := COALESCE(NULLIF(v_input->>'occurred_at', '')::timestamptz, now()); EXCEPTION WHEN others THEN v_occurred_at := now(); END;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 missing organization_id' USING ERRCODE = '23514';
  END IF;
  IF v_event_type IS NULL THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 missing event_type' USING ERRCODE = '23514';
  END IF;
  IF v_direction IS NULL THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 missing direction' USING ERRCODE = '23514';
  END IF;
  IF v_amount IS NULL OR v_amount < 0 THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 invalid amount' USING ERRCODE = '23514';
  END IF;
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 missing currency' USING ERRCODE = '23514';
  END IF;
  IF v_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 missing idempotency_key' USING ERRCODE = '23514';
  END IF;

  IF v_bank_account_id IS NULL THEN
    IF v_bank_account_key IS NULL THEN
      RAISE EXCEPTION 'record_bank_statement_event_v1 requires bank_account_id or bank_account_key' USING ERRCODE = '23514';
    END IF;

    SELECT ba.id
      INTO v_bank_account_id
      FROM public.bank_accounts ba
     WHERE ba.organization_id = v_org_id
       AND ba.key = v_bank_account_key
       AND ba.is_active IS TRUE
     LIMIT 1;

    IF v_bank_account_id IS NULL THEN
      RAISE EXCEPTION 'record_bank_statement_event_v1 bank_account_key % not found for organization_id %', v_bank_account_key, v_org_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  v_metadata := public.jsonb_deep_merge(
    v_metadata,
    jsonb_strip_nulls(jsonb_build_object(
      'bank_account_id', v_bank_account_id,
      'bank_account_key', v_bank_account_key
    ))
  );

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'finance',
    p_resource_type := 'bank_account',
    p_resource_id := v_bank_account_id,
    p_decision_point := 'bank_statement_ingest',
    p_decision_outcome := 'recorded',
    p_performed_by_system := 'record_bank_statement_event_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'event_type', v_event_type,
      'direction', v_direction,
      'amount', v_amount,
      'currency', v_currency,
      'occurred_at', v_occurred_at,
      'idempotency_key', v_idempotency_key
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  -- Qualify output fields to avoid OUT-param ambiguity.
  SELECT r.finance_event_id, r.created
    INTO finance_event_id, created
    FROM public.record_finance_event_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'event_type', v_event_type,
        'direction', v_direction,
        'amount', v_amount,
        'currency', v_currency,
        'account_type', 'bank_account',
        'account_id', v_bank_account_id,
        'subject_type', 'bank_account',
        'subject_id', v_bank_account_id,
        'decision_log_id', v_decision_id,
        'settings_resolution_id', NULL,
        'idempotency_key', v_idempotency_key,
        'metadata', v_metadata,
        'occurred_at', v_occurred_at
      ))
    ) AS r
   LIMIT 1;

  decision_log_id := v_decision_id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.record_bank_statement_event_v1(JSONB) IS
  'Service-only ingestion path for bank statement lines: records an immutable finance_events row (account_type=bank_account) and logs a decision; idempotent via finance_event_dedupe.';

REVOKE ALL ON FUNCTION public.record_bank_statement_event_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_bank_statement_event_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601221140_record_bank_statement_event_v1_fix'));
COMMIT;

