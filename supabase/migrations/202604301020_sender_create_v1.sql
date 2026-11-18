-- Spec-Issue: Phase B6 - Customer RPC contract: sender_create_v1
-- Step: B6-RPC-20
-- Capability: senders.write
-- Purpose: insert public.senders row + decision_log + domain_event.
--          Operator-side manual create path (auto-provisioning still owns the
--          dominant lane via webhook intake; this RPC covers operator overrides).
--          Lifecycle envelope shape mirrors sender_suspend/reactivate (202604280216/17).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301020_sender_create_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.sender_create_v1(p_args jsonb)
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
  v_resource_id UUID;
  v_client_id UUID := NULLIF(p_args->>'client_id', '')::uuid;
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_brand TEXT := NULLIF(btrim(COALESCE(p_args->>'brand_name', '')), '');
  v_auto_recreate BOOLEAN := COALESCE((p_args->>'auto_recreate')::boolean, TRUE);
  v_metadata JSONB := COALESCE(p_args->'settings_override', NULL);
  v_client_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'sender_create_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('senders.write');

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'sender_create_v1 requires client_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'sender_create_v1 requires name'
      USING ERRCODE = '23502';
  END IF;

  -- Tenant guard: client must belong to caller's org (platform users bypass)
  SELECT organization_id INTO v_client_org FROM public.clients WHERE id = v_client_id;
  IF v_client_org IS NULL THEN
    RAISE EXCEPTION 'sender_create_v1 client % not found', v_client_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_client_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'sender_create_v1 client % outside tenant scope', v_client_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.senders (
    client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override
  ) VALUES (
    v_client_id, v_name, v_brand, FALSE, v_auto_recreate, 'active', v_metadata
  ) RETURNING id INTO v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_client_org, 'senders.create', 'sender', v_resource_id,
    'sender_create_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object(
      'client_id', v_client_id,
      'name', v_name,
      'brand_name', v_brand,
      'auto_recreate', v_auto_recreate
    )),
    'sender_create_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_client_org, 'sender.created', 'sender', v_resource_id,
    jsonb_strip_nulls(jsonb_build_object('client_id', v_client_id, 'name', v_name)),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'sender_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sender_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sender_create_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sender_create_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.sender_create_v1(jsonb)
  IS 'Canonical write RPC: insert public.senders row (operator manual create) + decision_log + domain_event. Capability: senders.write.';

SELECT pg_advisory_unlock(hashtext('202604301020_sender_create_v1'));
COMMIT;
