-- FieldOps Mobile V2 hold-decision readback.
--
-- The native Hold queue decision path must reconcile from canonical backend
-- state, not optimistic app-only filtering. This replaces the original
-- decision-only write with an atomic hold-row transition plus decision_log
-- lineage so resolve_fieldops_hold_v1 immediately removes resolved rows.

SELECT pg_advisory_lock(hashtext('202605292300_fieldops_mobile_v2_hold_decision_readback_v1'));

CREATE OR REPLACE FUNCTION public.submit_fieldops_hold_decision_v1(
  p_hold_id UUID,
  p_action TEXT,
  p_note TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_action TEXT := lower(btrim(COALESCE(p_action, '')));
  v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_existing UUID;
  v_decision_id UUID;
  v_hold public.shipment_holds%ROWTYPE;
  v_hold_status TEXT;
  v_resolved_at TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1 requires organization context'
      USING ERRCODE = '42501';
  END IF;

  IF p_hold_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1 requires hold_id'
      USING ERRCODE = '22023';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1 requires idempotency_key'
      USING ERRCODE = '22023';
  END IF;

  IF v_action NOT IN ('reinduct', 'escalate', 'discard') THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1: invalid action %', p_action
      USING ERRCODE = '22023';
  END IF;

  IF v_action = 'discard' AND v_note IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1: discard requires a non-empty note'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_hold
    FROM public.shipment_holds
   WHERE id = p_hold_id
     AND organization_id = v_org
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1: hold is not visible for this organization'
      USING ERRCODE = '42501';
  END IF;

  v_hold_status := CASE v_action
    WHEN 'reinduct' THEN 'resolved'
    WHEN 'escalate' THEN 'escalated'
    ELSE 'discarded'
  END;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_hold_decision', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'action', v_action,
      'hold_id', p_hold_id,
      'hold_status', v_hold.status,
      'resolved_at', v_hold.resolved_at
    );
  END IF;

  IF v_hold.status <> 'open' THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1: hold is already %', v_hold.status
      USING ERRCODE = '22023';
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'fieldops_hold_decision',
    p_resource_type := 'hold_queue_item',
    p_resource_id := p_hold_id,
    p_decision_point := 'decide_hold',
    p_decision_outcome := v_action,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id := p_idempotency_key,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'hold_id', p_hold_id,
      'action', v_action,
      'hold_status', v_hold_status,
      'note', v_note,
      'actor_user_id', v_user_id
    )),
    p_decision_reason := v_note,
    p_settings_resolution_id := NULL
  );

  UPDATE public.shipment_holds
     SET status = v_hold_status,
         resolved_at = now(),
         decision_log_id = v_decision_id,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
           'latest_mobile_v2_hold_decision', jsonb_build_object(
             'action', v_action,
             'status', v_hold_status,
             'note', v_note,
             'decision_log_id', v_decision_id,
             'actor_user_id', v_user_id,
             'decided_at', now()
           )
         ))
   WHERE id = p_hold_id
     AND organization_id = v_org
   RETURNING status, resolved_at
        INTO v_hold_status, v_resolved_at;

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', v_action,
    'action', v_action,
    'hold_id', p_hold_id,
    'hold_status', v_hold_status,
    'resolved_at', v_resolved_at
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_hold_decision_v1(UUID, TEXT, TEXT, UUID) IS
  'Mobile V2 supervisor hold-queue decision write. Atomically validates scope, logs decision lineage, transitions shipment_holds, and returns same-screen readback metadata.';

REVOKE ALL ON FUNCTION public.submit_fieldops_hold_decision_v1(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_hold_decision_v1(UUID, TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_hold_decision_v1(
  p_hold_id UUID,
  p_action TEXT,
  p_note TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_hold_decision_v1(p_hold_id, p_action, p_note, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_hold_decision_v1(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_hold_decision_v1(UUID, TEXT, TEXT, UUID) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regprocedure('public.submit_fieldops_hold_decision_v1(uuid,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'public.submit_fieldops_hold_decision_v1 hold-decision readback contract missing';
  END IF;
  IF to_regprocedure('api.submit_fieldops_hold_decision_v1(uuid,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'api.submit_fieldops_hold_decision_v1 hold-decision readback wrapper missing';
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605292300_fieldops_mobile_v2_hold_decision_readback_v1'));
