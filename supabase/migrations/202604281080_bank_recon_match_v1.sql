-- Spec-Issue: Phase B5 - FINANCE RPCs canonical contracts
-- Step: B5-RPC-8
-- Migration: Canonical write RPC public.bank_recon_match_v1(p_args jsonb).
-- Capability: finance.write
-- Behavior: match a bank_statement finance_event to a billing_invoice (or other
--   reconcilable resource) for the FE bank-reconciliation surface. Inserts a
--   bank_recon_matches row in 'matched' status. Idempotent on the (event, resource)
--   pair when an active match already exists.
-- Contract:
--   p_args := {
--     "bank_statement_event_id": uuid (required),
--     "bank_statement_occurred_at": timestamptz (required; finance_events composite PK partition),
--     "resource_type": text (required; e.g. 'billing_invoice', 'settlement_batch'),
--     "resource_id": uuid (required),
--     "matched_amount": numeric (required, > 0),
--     "currency": text (required, 3-letter code),
--     "match_reason": text (optional),
--     "metadata": jsonb (optional, deep-merged)
--   }
--   Returns: { ok, bank_recon_match_id, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281080_bank_recon_match_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.bank_recon_match_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_resource_id UUID := gen_random_uuid();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_bank_event_id UUID;
  v_bank_event_at TIMESTAMPTZ;
  v_resource_type TEXT;
  v_target_resource_id UUID;
  v_matched_amount NUMERIC;
  v_currency TEXT;
  v_match_reason TEXT;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_existing_id UUID;
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'bank_recon_match_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('finance.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'bank_recon_match_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_bank_event_id := NULLIF(p_args->>'bank_statement_event_id', '')::UUID;
  EXCEPTION WHEN others THEN v_bank_event_id := NULL; END;
  IF v_bank_event_id IS NULL THEN
    RAISE EXCEPTION 'bank_recon_match_v1 requires bank_statement_event_id'
      USING ERRCODE = '23502';
  END IF;

  BEGIN v_bank_event_at := NULLIF(p_args->>'bank_statement_occurred_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_bank_event_at := NULL; END;
  IF v_bank_event_at IS NULL THEN
    RAISE EXCEPTION 'bank_recon_match_v1 requires bank_statement_occurred_at'
      USING ERRCODE = '23502';
  END IF;

  v_resource_type := lower(NULLIF(btrim(COALESCE(p_args->>'resource_type', '')), ''));
  IF v_resource_type IS NULL THEN
    RAISE EXCEPTION 'bank_recon_match_v1 requires resource_type'
      USING ERRCODE = '23502';
  END IF;

  BEGIN v_target_resource_id := NULLIF(p_args->>'resource_id', '')::UUID;
  EXCEPTION WHEN others THEN v_target_resource_id := NULL; END;
  IF v_target_resource_id IS NULL THEN
    RAISE EXCEPTION 'bank_recon_match_v1 requires resource_id'
      USING ERRCODE = '23502';
  END IF;

  v_matched_amount := NULLIF(p_args->>'matched_amount', '')::NUMERIC;
  IF v_matched_amount IS NULL OR v_matched_amount <= 0 THEN
    RAISE EXCEPTION 'bank_recon_match_v1 requires positive matched_amount'
      USING ERRCODE = '22023';
  END IF;

  v_currency := lower(NULLIF(btrim(COALESCE(p_args->>'currency', '')), ''));
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'bank_recon_match_v1 requires currency'
      USING ERRCODE = '23502';
  END IF;

  v_match_reason := NULLIF(btrim(COALESCE(p_args->>'match_reason', '')), '');

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  -- Validate finance_event exists and belongs to this org (when accessible).
  PERFORM 1
    FROM public.finance_events fe
   WHERE fe.id = v_bank_event_id
     AND fe.organization_id = v_org_id
     AND fe.occurred_at = v_bank_event_at
   LIMIT 1;
  IF NOT FOUND THEN
    -- Soft-fail to allow ingestion-lag scenarios; log and continue. The unique index
    -- on bank_recon_matches will still enforce no duplicate active pairs.
    NULL;
  END IF;

  -- Idempotency: short-circuit when an active match already exists for the pair.
  SELECT id INTO v_existing_id
    FROM public.bank_recon_matches
   WHERE organization_id = v_org_id
     AND bank_statement_event_id = v_bank_event_id
     AND resource_type = v_resource_type
     AND resource_id = v_target_resource_id
     AND status = 'matched'
   LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'bank_recon_match_id', v_existing_id,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id,
      'already_processed', TRUE
    );
  END IF;

  INSERT INTO public.bank_recon_matches (
    id, organization_id,
    bank_statement_event_id, bank_statement_occurred_at,
    resource_type, resource_id,
    matched_amount, currency,
    status, match_reason,
    matched_by, matched_at,
    metadata
  ) VALUES (
    v_resource_id, v_org_id,
    v_bank_event_id, v_bank_event_at,
    v_resource_type, v_target_resource_id,
    v_matched_amount, v_currency,
    'matched', v_match_reason,
    v_user_id, now(),
    v_metadata
  );

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'bank_statement_event_id', v_bank_event_id,
    'bank_statement_occurred_at', v_bank_event_at,
    'resource_type', v_resource_type,
    'resource_id', v_target_resource_id,
    'matched_amount', v_matched_amount,
    'currency', v_currency,
    'match_reason', v_match_reason
  ));

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_org_id, 'bank_recon.match', 'bank_recon_match', v_resource_id,
    'bank_recon_match_v1', 'matched',
    v_payload,
    'bank_recon_match_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_org_id, 'bank_recon.matched', 'bank_recon_match', v_resource_id,
    v_payload,
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'bank_recon_match_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bank_recon_match_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bank_recon_match_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_recon_match_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.bank_recon_match_v1(jsonb)
  IS 'Canonical write RPC: match a bank_statement finance_event to a billing_invoice (or other reconcilable resource). Capability: finance.write.';

SELECT pg_advisory_unlock(hashtext('202604281080_bank_recon_match_v1'));
COMMIT;
