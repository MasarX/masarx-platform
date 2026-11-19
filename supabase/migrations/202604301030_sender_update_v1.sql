-- Spec-Issue: Phase B6 - Customer RPC contract: sender_update_v1
-- Step: B6-RPC-21
-- Capability: senders.write
-- Purpose: update editable fields on public.senders row + decision_log +
--          domain_event. Editable fields: name, brand_name, auto_recreate,
--          warehouse_address_id, settings_override.
--          Status mutations remain owned by sender_suspend/reactivate (202604280216/17);
--          this RPC explicitly forbids status edits to keep lifecycle SSOT clean.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301030_sender_update_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.sender_update_v1(p_args jsonb)
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
  v_before public.senders%ROWTYPE;
  v_client_org UUID;
  v_changed JSONB := '{}'::jsonb;
  v_no_op BOOLEAN := TRUE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'sender_update_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('senders.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'sender_update_v1 requires sender_id'
      USING ERRCODE = '23502';
  END IF;

  IF p_args ? 'status' THEN
    RAISE EXCEPTION 'sender_update_v1 cannot mutate status — use sender_suspend_v1 / sender_reactivate_v1'
      USING ERRCODE = '42P01';
  END IF;

  SELECT * INTO v_before FROM public.senders WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'sender_update_v1 sender % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  SELECT organization_id INTO v_client_org FROM public.clients WHERE id = v_before.client_id;
  IF v_org_id IS NOT NULL
     AND v_client_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'sender_update_v1 sender % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  IF p_args ? 'name' THEN
    UPDATE public.senders SET name = btrim(p_args->>'name'), updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('name', p_args->>'name');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'brand_name' THEN
    UPDATE public.senders SET brand_name = NULLIF(btrim(p_args->>'brand_name'), ''), updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('brand_name', p_args->>'brand_name');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'auto_recreate' THEN
    UPDATE public.senders SET auto_recreate = (p_args->>'auto_recreate')::boolean, updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('auto_recreate', p_args->>'auto_recreate');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'warehouse_address_id' THEN
    UPDATE public.senders SET
      warehouse_address_id = NULLIF(p_args->>'warehouse_address_id', '')::uuid,
      updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('warehouse_address_id', p_args->>'warehouse_address_id');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'settings_override' THEN
    UPDATE public.senders SET settings_override = p_args->'settings_override', updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('settings_override', p_args->'settings_override');
    v_no_op := FALSE;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_client_org, 'senders.update', 'sender', v_resource_id,
    'sender_update_v1', CASE WHEN v_no_op THEN 'no_op' ELSE 'updated' END,
    v_changed, 'sender_update_v1', v_correlation_id::uuid
  );

  IF NOT v_no_op THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_client_org, 'sender.updated', 'sender', v_resource_id,
      v_changed, v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sender_id', v_resource_id,
    'idempotent_no_op', v_no_op,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sender_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sender_update_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sender_update_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.sender_update_v1(jsonb)
  IS 'Canonical write RPC: update editable public.senders fields + decision_log + domain_event. Capability: senders.write. Status owned by suspend/reactivate.';

SELECT pg_advisory_unlock(hashtext('202604301030_sender_update_v1'));
COMMIT;
