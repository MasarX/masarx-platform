-- Spec-Issue: Phase B5 - FINANCE RPCs canonical contracts
-- Step: B5-RPC-6
-- Migration: Canonical write RPC public.apply_settlement_v1(p_args jsonb).
-- Capability: settlements.write
-- Behavior: approve a settlement batch (transition open|locked -> approved).
-- Contract:
--   p_args := {
--     "settlement_batch_id": uuid (required),
--     "approval_notes": text (optional),
--     "metadata": jsonb (optional, deep-merged into events.payload)
--   }
--   Returns: { ok, settlement_batch_id, correlation_id, settings_resolution_id, version, status }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281060_apply_settlement_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.apply_settlement_v1(p_args jsonb)
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
  v_batch public.settlement_batches%ROWTYPE;
  v_approval_notes TEXT;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_next_version INT;
  v_payload JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'apply_settlement_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('settlements.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'apply_settlement_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_resource_id := NULLIF(p_args->>'settlement_batch_id', '')::UUID;
  EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'apply_settlement_v1 requires settlement_batch_id'
      USING ERRCODE = '23502';
  END IF;

  v_approval_notes := NULLIF(btrim(COALESCE(p_args->>'approval_notes', '')), '');

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  SELECT * INTO v_batch
    FROM public.settlement_batches
   WHERE id = v_resource_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_settlement_v1 settlement_batch_id % not found', v_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user() AND v_batch.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'apply_settlement_v1 cannot approve settlements in other organizations'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent: if already approved/posted, return current state.
  IF v_batch.status IN ('approved', 'posted') THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'settlement_batch_id', v_resource_id,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id,
      'version', v_batch.version,
      'status', v_batch.status,
      'already_processed', TRUE
    );
  END IF;

  -- Approve only valid from open or locked. Final states (canceled/posted) blocked.
  IF v_batch.status NOT IN ('open', 'locked') THEN
    RAISE EXCEPTION 'apply_settlement_v1 cannot approve settlement in status=% (only open/locked allowed)', v_batch.status
      USING ERRCODE = '22023';
  END IF;

  v_next_version := v_batch.version + 1;

  UPDATE public.settlement_batches
     SET status = 'approved',
         status_reason = v_approval_notes,
         version = v_next_version,
         metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata,
         updated_at = now()
   WHERE id = v_resource_id;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'approval_notes', v_approval_notes,
    'prior_status', v_batch.status,
    'metadata', v_metadata
  ));

  -- Append immutable settlement event (SSOT ledger).
  INSERT INTO public.settlement_events (
    settlement_batch_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, batch_version
  ) VALUES (
    v_resource_id, v_batch.organization_id,
    'settlement_batch.approved', v_batch.status, 'approved',
    v_user_id, v_payload, v_next_version
  );

  -- Append decision_log entry.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_batch.organization_id, 'settlement_batch.apply', 'settlement_batch', v_resource_id,
    'apply_settlement_v1', 'approved',
    v_payload,
    'apply_settlement_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger).
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_batch.organization_id, 'settlement_batch.approved', 'settlement_batch', v_resource_id,
    v_payload,
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'settlement_batch_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id,
    'version', v_next_version,
    'status', 'approved'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_settlement_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_settlement_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_settlement_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.apply_settlement_v1(jsonb)
  IS 'Canonical write RPC: approve a settlement batch (open|locked -> approved). Capability: settlements.write.';

SELECT pg_advisory_unlock(hashtext('202604281060_apply_settlement_v1'));
COMMIT;
