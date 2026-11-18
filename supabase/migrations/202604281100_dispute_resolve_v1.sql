-- Spec-Issue: Phase B5 - FINANCE RPCs canonical contracts
-- Step: B5-RPC-10
-- Migration: Canonical write RPC public.dispute_resolve_v1(p_args jsonb).
-- Capability: disputes.write
-- Notes on capability choice:
--   The FE finance/disputes module audit cited `disputes.read` as the FE-side
--   capability key — but resolving/rejecting a dispute is a mutation, not a
--   read. Using `disputes.read` for a write path would break the SSOT
--   capability contract and let read-only roles mutate state. The canonical
--   marketplace-namespace capability `marketplace_disputes.write` exists, but
--   the FE finance surface uses the `disputes` namespace.
--   Therefore we introduce `disputes.write` (registered in
--   202604281000_phase_b5_finance_caps_v1) as the dedicated FINANCE-domain
--   write capability. ops_admin gets it by default through that migration.
-- Canonical table:
--   The canonical disputes table is `public.marketplace_disputes`
--   (introduced in 202603071100_marketplace_network_foundation_v1).
--   This RPC operates on that table; the namespace difference is purely
--   capability-key-level.
-- Behavior: transition open|under_review -> resolved.
-- Contract:
--   p_args := {
--     "dispute_id": uuid (required),
--     "resolution": text (required; non-empty),
--     "metadata": jsonb (optional, deep-merged)
--   }
--   Returns: { ok, dispute_id, correlation_id, settings_resolution_id, status }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281100_dispute_resolve_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.dispute_resolve_v1(p_args jsonb)
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
  v_resolution TEXT;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'dispute_resolve_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('disputes.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'dispute_resolve_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'dispute_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'dispute_resolve_v1 requires dispute_id'
      USING ERRCODE = '23502';
  END IF;

  v_resolution := NULLIF(btrim(COALESCE(p_args->>'resolution', '')), '');
  IF v_resolution IS NULL THEN
    RAISE EXCEPTION 'dispute_resolve_v1 requires non-empty resolution'
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
    RAISE EXCEPTION 'dispute_resolve_v1 dispute_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Tenant isolation: caller must be platform user OR a party to the dispute.
  IF NOT public.is_platform_user()
     AND v_dispute.opened_by_organization_id <> v_org_id
     AND v_dispute.counterparty_organization_id <> v_org_id THEN
    RAISE EXCEPTION 'dispute_resolve_v1 cannot resolve disputes outside caller organization'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent: if already resolved, return current state.
  IF v_dispute.status = 'resolved' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'dispute_id', v_resource_id,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id,
      'status', 'resolved',
      'already_processed', TRUE
    );
  END IF;

  -- Resolve only valid from open or under_review. rejected/resolved are terminal.
  IF v_dispute.status NOT IN ('open', 'under_review') THEN
    RAISE EXCEPTION 'dispute_resolve_v1 cannot resolve dispute in status=% (only open/under_review allowed)', v_dispute.status
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.marketplace_disputes
     SET status = 'resolved',
         resolution = v_resolution,
         resolved_at = now(),
         resolved_by_user_id = v_user_id,
         metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'resolution', v_resolution,
    'prior_status', v_dispute.status,
    'metadata', v_metadata,
    'resolved_by_user_id', v_user_id
  ));

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_dispute.opened_by_organization_id, 'dispute.resolve', 'marketplace_dispute', v_resource_id,
    'dispute_resolve_v1', 'resolved',
    v_payload,
    'dispute_resolve_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_dispute.opened_by_organization_id, 'dispute.resolved', 'marketplace_dispute', v_resource_id,
    v_payload,
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dispute_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'status', 'resolved'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispute_resolve_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispute_resolve_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispute_resolve_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.dispute_resolve_v1(jsonb)
  IS 'Canonical write RPC: resolve a dispute (open|under_review -> resolved). FE finance namespace; operates on marketplace_disputes. Capability: disputes.write.';

SELECT pg_advisory_unlock(hashtext('202604281100_dispute_resolve_v1'));
COMMIT;
