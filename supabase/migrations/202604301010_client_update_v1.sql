-- Spec-Issue: Phase B6 - Customer RPC contract: client_update_v1
-- Step: B6-RPC-19
-- Capability: clients.write
-- Purpose: update editable fields on public.clients row + decision_log +
--          domain_event. Editable fields surfaced today: name, sla_tier,
--          account_manager_id, contract_start_date, contract_end_date,
--          billing_settings, settings_override.
--          Status mutations remain owned by client_suspend/reactivate (202604280214/15);
--          this RPC explicitly forbids status edits to keep lifecycle SSOT clean.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301010_client_update_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.client_update_v1(p_args jsonb)
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
  v_changed JSONB := '{}'::jsonb;
  v_no_op BOOLEAN := TRUE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'client_update_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('clients.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'client_update_v1 requires client_id'
      USING ERRCODE = '23502';
  END IF;

  IF p_args ? 'status' THEN
    RAISE EXCEPTION 'client_update_v1 cannot mutate status — use client_suspend_v1 / client_reactivate_v1'
      USING ERRCODE = '42P01';
  END IF;

  SELECT * INTO v_before FROM public.clients WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'client_update_v1 client % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'client_update_v1 client % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  -- Apply allowed editable fields. Each branch records the change in v_changed
  -- so we can write a precise decision_log + domain_event payload.
  IF p_args ? 'name' THEN
    UPDATE public.clients SET name = btrim(p_args->>'name'), updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('name', p_args->>'name');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'sla_tier' THEN
    UPDATE public.clients SET sla_tier = p_args->>'sla_tier', updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('sla_tier', p_args->>'sla_tier');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'account_manager_id' THEN
    UPDATE public.clients SET
      account_manager_id = NULLIF(p_args->>'account_manager_id', '')::uuid,
      updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('account_manager_id', p_args->>'account_manager_id');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'contract_start_date' THEN
    UPDATE public.clients SET
      contract_start_date = NULLIF(p_args->>'contract_start_date', '')::date,
      updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('contract_start_date', p_args->>'contract_start_date');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'contract_end_date' THEN
    UPDATE public.clients SET
      contract_end_date = NULLIF(p_args->>'contract_end_date', '')::date,
      updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('contract_end_date', p_args->>'contract_end_date');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'billing_settings' THEN
    UPDATE public.clients SET billing_settings = p_args->'billing_settings', updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('billing_settings', p_args->'billing_settings');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'settings_override' THEN
    UPDATE public.clients SET settings_override = p_args->'settings_override', updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('settings_override', p_args->'settings_override');
    v_no_op := FALSE;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id, 'clients.update', 'client', v_resource_id,
    'client_update_v1', CASE WHEN v_no_op THEN 'no_op' ELSE 'updated' END,
    v_changed, 'client_update_v1', v_correlation_id::uuid
  );

  IF NOT v_no_op THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_before.organization_id, 'client.updated', 'client', v_resource_id,
      v_changed, v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'client_id', v_resource_id,
    'idempotent_no_op', v_no_op,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.client_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.client_update_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.client_update_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.client_update_v1(jsonb)
  IS 'Canonical write RPC: update editable public.clients fields + decision_log + domain_event. Capability: clients.write. Status owned by suspend/reactivate.';

SELECT pg_advisory_unlock(hashtext('202604301010_client_update_v1'));
COMMIT;
