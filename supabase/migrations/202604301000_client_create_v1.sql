-- Spec-Issue: Phase B6 - Customer RPC contract: client_create_v1
-- Step: B6-RPC-18
-- Capability: clients.write
-- Purpose: insert public.clients row + decision_log + domain_event.
--          Operator-side create path; mirrors lifecycle envelope shape
--          (ok/client_id/correlation_id/settings_resolution_id) used by
--          client_suspend/reactivate (202604280214/15).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301000_client_create_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.client_create_v1(p_args jsonb)
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
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_slug TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'slug', '')), ''));
  v_sla_tier TEXT := NULLIF(btrim(COALESCE(p_args->>'sla_tier', 'standard')), '');
  v_account_manager_id UUID := NULLIF(p_args->>'account_manager_id', '')::uuid;
  v_contract_start DATE := NULLIF(p_args->>'contract_start_date', '')::date;
  v_contract_end DATE := NULLIF(p_args->>'contract_end_date', '')::date;
  v_metadata JSONB := COALESCE(p_args->'settings_override', NULL);
  v_target_org UUID := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_org_id);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'client_create_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('clients.write');

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'client_create_v1 requires name'
      USING ERRCODE = '23502';
  END IF;
  IF v_slug IS NULL THEN
    RAISE EXCEPTION 'client_create_v1 requires slug'
      USING ERRCODE = '23502';
  END IF;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'client_create_v1 requires organization_id (caller has no scope)'
      USING ERRCODE = '23502';
  END IF;

  -- Tenant guard: non-platform users may only create within their org
  IF v_org_id IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'client_create_v1 organization % outside tenant scope', v_target_org
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.clients (
    organization_id, name, slug, sla_tier, account_manager_id,
    contract_start_date, contract_end_date, status, settings_override
  ) VALUES (
    v_target_org, v_name, v_slug, v_sla_tier, v_account_manager_id,
    v_contract_start, v_contract_end, 'active', v_metadata
  ) RETURNING id INTO v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org, 'clients.create', 'client', v_resource_id,
    'client_create_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object(
      'name', v_name,
      'slug', v_slug,
      'sla_tier', v_sla_tier,
      'account_manager_id', v_account_manager_id,
      'contract_start_date', v_contract_start,
      'contract_end_date', v_contract_end
    )),
    'client_create_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'client.created', 'client', v_resource_id,
    jsonb_strip_nulls(jsonb_build_object(
      'name', v_name,
      'slug', v_slug,
      'sla_tier', v_sla_tier
    )),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'client_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.client_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.client_create_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.client_create_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.client_create_v1(jsonb)
  IS 'Canonical write RPC: insert public.clients row + decision_log + domain_event. Capability: clients.write.';

SELECT pg_advisory_unlock(hashtext('202604301000_client_create_v1'));
COMMIT;
