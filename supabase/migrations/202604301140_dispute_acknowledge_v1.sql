-- Spec-Issue: W8-4 FINANCE gap closure (REVISION 77%)
-- Step: W8-4-RPC-2
-- Migration: Canonical write RPC public.dispute_acknowledge_v1(p_args jsonb).
-- Capability: disputes.write
-- Behavior:
--   Transition open -> under_review (operator acknowledges they have started
--   reviewing the dispute). Idempotent: re-acknowledging an under_review or
--   resolved/rejected dispute returns success without state change.
-- Contract:
--   p_args := {
--     "dispute_id": uuid (required),
--     "acknowledgement_notes": text (optional),
--     "metadata": jsonb (optional, deep-merged)
--   }
--   Returns: { ok, dispute_id, correlation_id, settings_resolution_id, status }
--
-- Capability rationale: see header of 202604281100_dispute_resolve_v1.sql.
-- disputes.write is the canonical FINANCE-domain write capability for the
-- FE finance disputes surface (apps/console-v2/src/modules/finance/disputes.tsx).
-- Closes the toast-only "Acknowledge" sites at disputes.tsx:299-303 + 431-436.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301140_dispute_acknowledge_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.dispute_acknowledge_v1(p_args jsonb)
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
  v_notes TEXT;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'dispute_acknowledge_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('disputes.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'dispute_acknowledge_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'dispute_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'dispute_acknowledge_v1 requires dispute_id'
      USING ERRCODE = '23502';
  END IF;

  v_notes := NULLIF(btrim(COALESCE(p_args->>'acknowledgement_notes', '')), '');

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  SELECT * INTO v_dispute
    FROM public.marketplace_disputes
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispute_acknowledge_v1 dispute_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Tenant isolation: caller must be platform user OR a party to the dispute.
  IF NOT public.is_platform_user()
     AND v_dispute.opened_by_organization_id <> v_org_id
     AND v_dispute.counterparty_organization_id <> v_org_id THEN
    RAISE EXCEPTION 'dispute_acknowledge_v1 cannot acknowledge disputes outside caller organization'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent: if already under_review (or terminal), return current state.
  IF v_dispute.status IN ('under_review', 'resolved', 'rejected') THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'dispute_id', v_resource_id,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id,
      'status', v_dispute.status,
      'already_processed', TRUE
    );
  END IF;

  -- Acknowledge only valid from open. Other statuses are either already
  -- acknowledged (under_review) or terminal (resolved/rejected) — handled above.
  IF v_dispute.status <> 'open' THEN
    RAISE EXCEPTION 'dispute_acknowledge_v1 cannot acknowledge dispute in status=% (only open allowed)', v_dispute.status
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.marketplace_disputes
     SET status = 'under_review',
         metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata
                    || jsonb_build_object(
                         'acknowledged_at', now(),
                         'acknowledged_by_user_id', v_user_id
                       )
                    || CASE WHEN v_notes IS NOT NULL
                            THEN jsonb_build_object('acknowledgement_notes', v_notes)
                            ELSE '{}'::jsonb
                       END,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'acknowledgement_notes', v_notes,
    'prior_status', v_dispute.status,
    'metadata', v_metadata,
    'acknowledged_by_user_id', v_user_id
  ));

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_dispute.opened_by_organization_id, 'dispute.acknowledge', 'marketplace_dispute', v_resource_id,
    'dispute_acknowledge_v1', 'under_review',
    v_payload,
    'dispute_acknowledge_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_dispute.opened_by_organization_id, 'dispute.acknowledged', 'marketplace_dispute', v_resource_id,
    v_payload,
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dispute_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'status', 'under_review'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispute_acknowledge_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispute_acknowledge_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispute_acknowledge_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.dispute_acknowledge_v1(jsonb)
  IS 'Canonical write RPC: acknowledge a dispute (open -> under_review). FE finance namespace; operates on marketplace_disputes. Capability: disputes.write.';

SELECT pg_advisory_unlock(hashtext('202604301140_dispute_acknowledge_v1'));
COMMIT;
