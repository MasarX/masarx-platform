-- Spec-Issue: Phase B5 - FINANCE RPCs canonical contracts
-- Step: B5-RPC-11
-- Migration: Canonical write RPC public.dispute_reject_v1(p_args jsonb).
-- Capability: disputes.write
-- Behavior: transition open|under_review -> rejected; operates on canonical
--   public.marketplace_disputes table (FE finance namespace).
-- Contract:
--   p_args := {
--     "dispute_id": uuid (required),
--     "rejection_reason": text (required; non-empty),
--     "metadata": jsonb (optional, deep-merged)
--   }
--   Returns: { ok, dispute_id, correlation_id, settings_resolution_id, status }
--
-- Capability rationale: see header of 202604281100_dispute_resolve_v1.sql.
-- disputes.write is the canonical FINANCE-domain write capability for this
-- surface; it is distinct from marketplace_disputes.write.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281110_dispute_reject_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.dispute_reject_v1(p_args jsonb)
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
  v_dispute public.marketplace_disputes%ROWTYPE;
  v_rejection_reason TEXT;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'dispute_reject_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('disputes.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'dispute_reject_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'dispute_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'dispute_reject_v1 requires dispute_id'
      USING ERRCODE = '23502';
  END IF;

  v_rejection_reason := NULLIF(btrim(COALESCE(p_args->>'rejection_reason', '')), '');
  IF v_rejection_reason IS NULL THEN
    RAISE EXCEPTION 'dispute_reject_v1 requires non-empty rejection_reason'
      USING ERRCODE = '23502';
  END IF;

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  SELECT * INTO v_dispute
    FROM public.marketplace_disputes
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispute_reject_v1 dispute_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user()
     AND v_dispute.opened_by_organization_id <> v_org_id
     AND v_dispute.counterparty_organization_id <> v_org_id THEN
    RAISE EXCEPTION 'dispute_reject_v1 cannot reject disputes outside caller organization'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent: if already rejected, return current state.
  IF v_dispute.status = 'rejected' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'dispute_id', v_resource_id,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id,
      'status', 'rejected',
      'already_processed', TRUE
    );
  END IF;

  -- Reject only valid from open or under_review. resolved/rejected are terminal.
  IF v_dispute.status NOT IN ('open', 'under_review') THEN
    RAISE EXCEPTION 'dispute_reject_v1 cannot reject dispute in status=% (only open/under_review allowed)', v_dispute.status
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.marketplace_disputes
     SET status = 'rejected',
         resolution = v_rejection_reason,
         resolved_at = now(),
         resolved_by_user_id = v_user_id,
         metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'rejection_reason', v_rejection_reason,
    'prior_status', v_dispute.status,
    'metadata', v_metadata,
    'rejected_by_user_id', v_user_id
  ));

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_dispute.opened_by_organization_id, 'dispute.reject', 'marketplace_dispute', v_resource_id,
    'dispute_reject_v1', 'rejected',
    v_payload,
    'dispute_reject_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_dispute.opened_by_organization_id, 'dispute.rejected', 'marketplace_dispute', v_resource_id,
    v_payload,
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dispute_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'status', 'rejected'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispute_reject_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispute_reject_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispute_reject_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.dispute_reject_v1(jsonb)
  IS 'Canonical write RPC: reject a dispute (open|under_review -> rejected). FE finance namespace; operates on marketplace_disputes. Capability: disputes.write.';

SELECT pg_advisory_unlock(hashtext('202604281110_dispute_reject_v1'));
COMMIT;
