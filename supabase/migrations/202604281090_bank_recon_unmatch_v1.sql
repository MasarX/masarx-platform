-- Spec-Issue: Phase B5 - FINANCE RPCs canonical contracts
-- Step: B5-RPC-9
-- Migration: Canonical write RPC public.bank_recon_unmatch_v1(p_args jsonb).
-- Capability: finance.write
-- Behavior: undo a bank_recon_matches pair (transition matched -> unmatched).
--   Preserves the row for audit/history; status flips to 'unmatched' so the
--   pair no longer counts toward the unique active-match index.
-- Contract:
--   p_args := {
--     "bank_recon_match_id": uuid (required),
--     "unmatch_reason": text (required; non-empty)
--   }
--   Returns: { ok, bank_recon_match_id, correlation_id, settings_resolution_id, status }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281090_bank_recon_unmatch_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.bank_recon_unmatch_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_resource_id UUID;
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_match public.bank_recon_matches%ROWTYPE;
  v_unmatch_reason TEXT;
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'bank_recon_unmatch_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('finance.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'bank_recon_unmatch_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'bank_recon_match_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'bank_recon_unmatch_v1 requires bank_recon_match_id'
      USING ERRCODE = '23502';
  END IF;

  v_unmatch_reason := NULLIF(btrim(COALESCE(p_args->>'unmatch_reason', '')), '');
  IF v_unmatch_reason IS NULL THEN
    RAISE EXCEPTION 'bank_recon_unmatch_v1 requires non-empty unmatch_reason'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_match
    FROM public.bank_recon_matches
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_recon_unmatch_v1 bank_recon_match_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user() AND v_match.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'bank_recon_unmatch_v1 cannot unmatch reconciliation pairs in other organizations'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent: if already unmatched, return current state.
  IF v_match.status = 'unmatched' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'bank_recon_match_id', v_resource_id,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id,
      'status', 'unmatched',
      'already_processed', TRUE
    );
  END IF;

  UPDATE public.bank_recon_matches
     SET status = 'unmatched',
         unmatched_by = v_user_id,
         unmatched_at = now(),
         unmatch_reason = v_unmatch_reason,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'bank_statement_event_id', v_match.bank_statement_event_id,
    'bank_statement_occurred_at', v_match.bank_statement_occurred_at,
    'resource_type', v_match.resource_type,
    'resource_id', v_match.resource_id,
    'matched_amount', v_match.matched_amount,
    'currency', v_match.currency,
    'unmatch_reason', v_unmatch_reason
  ));

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_match.organization_id, 'bank_recon.unmatch', 'bank_recon_match', v_resource_id,
    'bank_recon_unmatch_v1', 'unmatched',
    v_payload,
    'bank_recon_unmatch_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_match.organization_id, 'bank_recon.unmatched', 'bank_recon_match', v_resource_id,
    v_payload,
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'bank_recon_match_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'status', 'unmatched'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bank_recon_unmatch_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bank_recon_unmatch_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_recon_unmatch_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.bank_recon_unmatch_v1(jsonb)
  IS 'Canonical write RPC: undo a bank_recon_matches pair (matched -> unmatched). Preserves row for audit/history. Capability: finance.write.';

SELECT pg_advisory_unlock(hashtext('202604281090_bank_recon_unmatch_v1'));
COMMIT;
