-- Spec-Issue: Phase B6 - Customer RPC contract: sender_suspend_v1
-- Step: B6-RPC-16
-- Capability: senders.write
-- Note: senders.suspension_reason column added by foundation migration.
-- Note: extends 'sender_status' lookup with 'suspended' value (was active|inactive only).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280216_sender_suspend_v1'));
SET search_path TO public, extensions, pg_temp;

-- Extend sender_status lookup with 'suspended' so senders.status='suspended'
-- passes the row-driven lookup_column_contracts enforcement trigger.
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'suspended', 'Suspended', 30, FALSE, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'sender_status'
  AND NOT EXISTS (
    SELECT 1 FROM public.lookup_values lv
    WHERE lv.lookup_definition_id = d.id AND lv.value = 'suspended'
  );

CREATE OR REPLACE FUNCTION public.sender_suspend_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'sender_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_before public.senders%ROWTYPE;
  v_client_org UUID;
  v_already_suspended BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'sender_suspend_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('senders.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'sender_suspend_v1 requires sender_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.senders WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'sender_suspend_v1 sender % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  SELECT organization_id INTO v_client_org FROM public.clients WHERE id = v_before.client_id;
  IF v_org_id IS NOT NULL
     AND v_client_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'sender_suspend_v1 sender % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  v_already_suspended := (v_before.status = 'suspended');

  IF NOT v_already_suspended THEN
    UPDATE public.senders
       SET status = 'suspended',
           suspension_reason = v_reason,
           updated_at = now()
     WHERE id = v_resource_id;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_client_org, 'senders.suspend', 'sender', v_resource_id,
    'sender_suspend_v1', CASE WHEN v_already_suspended THEN 'no_op' ELSE 'suspended' END,
    jsonb_strip_nulls(jsonb_build_object('reason', v_reason, 'previous_status', v_before.status)),
    'sender_suspend_v1', v_correlation_id::uuid
  );

  IF NOT v_already_suspended THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_client_org, 'sender.suspended', 'sender', v_resource_id,
      jsonb_strip_nulls(jsonb_build_object('reason', v_reason)),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sender_id', v_resource_id,
    'idempotent_no_op', v_already_suspended,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sender_suspend_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sender_suspend_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sender_suspend_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.sender_suspend_v1(jsonb)
  IS 'Canonical write RPC: suspend sender (idempotent; status=suspended). Capability: senders.write.';

SELECT pg_advisory_unlock(hashtext('202604280216_sender_suspend_v1'));
COMMIT;
