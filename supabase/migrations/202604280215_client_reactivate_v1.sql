-- Spec-Issue: Phase B6 - Customer RPC contract: client_reactivate_v1
-- Step: B6-RPC-15
-- Capability: clients.write

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280215_client_reactivate_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.client_reactivate_v1(p_args jsonb)
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
  v_resource_id UUID := NULLIF(p_args->>'client_id', '')::uuid;
  v_before public.clients%ROWTYPE;
  v_already_active BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'client_reactivate_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('clients.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'client_reactivate_v1 requires client_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.clients WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'client_reactivate_v1 client % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'client_reactivate_v1 client % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;
  IF v_before.status = 'terminated' THEN
    RAISE EXCEPTION 'client_reactivate_v1 cannot reactivate terminated client %', v_resource_id
      USING ERRCODE = '23514';
  END IF;

  v_already_active := (v_before.status = 'active');

  IF NOT v_already_active THEN
    UPDATE public.clients
       SET status = 'active',
           suspension_reason = NULL,
           updated_at = now()
     WHERE id = v_resource_id;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id, 'clients.reactivate', 'client', v_resource_id,
    'client_reactivate_v1', CASE WHEN v_already_active THEN 'no_op' ELSE 'reactivated' END,
    jsonb_build_object('previous_status', v_before.status),
    'client_reactivate_v1', v_correlation_id::uuid
  );

  IF NOT v_already_active THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_before.organization_id, 'client.reactivated', 'client', v_resource_id,
      jsonb_build_object('previous_status', v_before.status),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'client_id', v_resource_id,
    'idempotent_no_op', v_already_active,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.client_reactivate_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.client_reactivate_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.client_reactivate_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.client_reactivate_v1(jsonb)
  IS 'Canonical write RPC: reactivate suspended client (idempotent). Capability: clients.write.';

SELECT pg_advisory_unlock(hashtext('202604280215_client_reactivate_v1'));
COMMIT;
