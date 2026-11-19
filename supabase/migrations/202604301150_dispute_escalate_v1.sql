-- Spec-Issue: W9-3 FINANCE residual gap closure (escalate path)
-- Migration: Canonical write RPC public.dispute_escalate_v1(p_args jsonb).
-- Capability: disputes.write
-- Behavior:
--   Escalate a dispute (open|under_review) by recording an escalation marker
--   on the dispute row's metadata + emitting decision_log + domain_events
--   entries. Status transitions to `under_review` if currently `open`
--   (escalation implies operator review has begun); already-`under_review`
--   escalations record the escalation event without status change.
--
--   Resolve/reject paths exist for terminal transitions; escalate is
--   intentionally non-terminal so the operator queue remains actionable.
--
-- Contract:
--   p_args := {
--     "dispute_id": uuid (required),
--     "escalation_reason": text (required; non-empty),
--     "metadata": jsonb (optional, deep-merged)
--   }
--   Returns: { ok, dispute_id, correlation_id, settings_resolution_id, status, escalation_count }
--
-- Capability rationale: see header of 202604281100_dispute_resolve_v1.sql.
-- disputes.write is the canonical FINANCE-domain write capability for the
-- FE finance disputes surface (apps/console-v2/src/modules/finance/disputes.tsx).
-- Closes the toast-only "Escalate" sites (drawer footer + row + bulk).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301150_dispute_escalate_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.dispute_escalate_v1(p_args jsonb)
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
  v_reason TEXT;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_payload JSONB;
  v_existing_count INT := 0;
  v_new_count INT;
  v_new_status TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'dispute_escalate_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('disputes.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'dispute_escalate_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'dispute_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'dispute_escalate_v1 requires dispute_id'
      USING ERRCODE = '23502';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_args->>'escalation_reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'dispute_escalate_v1 requires non-empty escalation_reason'
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
    RAISE EXCEPTION 'dispute_escalate_v1 dispute_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user()
     AND v_dispute.opened_by_organization_id <> v_org_id
     AND v_dispute.counterparty_organization_id <> v_org_id THEN
    RAISE EXCEPTION 'dispute_escalate_v1 cannot escalate disputes outside caller organization'
      USING ERRCODE = '42501';
  END IF;

  -- Disallow escalation on terminal statuses (resolved/rejected).
  IF v_dispute.status IN ('resolved', 'rejected') THEN
    RAISE EXCEPTION 'dispute_escalate_v1 cannot escalate dispute in terminal status=%', v_dispute.status
      USING ERRCODE = '22023';
  END IF;

  -- Track escalation count in metadata.escalation_count (defaults to 0).
  v_existing_count := COALESCE(
    NULLIF(btrim(COALESCE(v_dispute.metadata->>'escalation_count', '')), '')::INT,
    0
  );
  v_new_count := v_existing_count + 1;

  -- Status transitions to under_review on escalation from open; otherwise unchanged.
  v_new_status := CASE WHEN v_dispute.status = 'open' THEN 'under_review' ELSE v_dispute.status END;

  UPDATE public.marketplace_disputes
     SET status = v_new_status,
         metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata
                    || jsonb_build_object(
                         'last_escalated_at', now(),
                         'last_escalated_by_user_id', v_user_id,
                         'last_escalation_reason', v_reason,
                         'escalation_count', v_new_count
                       ),
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'escalation_reason', v_reason,
    'prior_status', v_dispute.status,
    'new_status', v_new_status,
    'escalation_count', v_new_count,
    'metadata', v_metadata,
    'escalated_by_user_id', v_user_id
  ));

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_dispute.opened_by_organization_id, 'dispute.escalate', 'marketplace_dispute', v_resource_id,
    'dispute_escalate_v1', v_new_status,
    v_payload,
    'dispute_escalate_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_dispute.opened_by_organization_id, 'dispute.escalated', 'marketplace_dispute', v_resource_id,
    v_payload,
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dispute_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'status', v_new_status,
    'escalation_count', v_new_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispute_escalate_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispute_escalate_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispute_escalate_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.dispute_escalate_v1(jsonb)
  IS 'Canonical write RPC: escalate a dispute (records escalation marker + emits decision/domain events; transitions open -> under_review, otherwise non-terminal). FE finance namespace; operates on marketplace_disputes. Capability: disputes.write.';

SELECT pg_advisory_unlock(hashtext('202604301150_dispute_escalate_v1'));
COMMIT;
