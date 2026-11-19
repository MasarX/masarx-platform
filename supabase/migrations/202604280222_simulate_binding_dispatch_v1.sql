-- Spec-Issue: Phase B6 - Workflow RPC contract: simulate_binding_dispatch_v1
-- Step: B6-RPC-22
-- Capability: workflows.write
--
-- Behavior: read-only DRY-RUN of a workflow binding dispatch — resolves
-- workflow_binding_policy via the settings ladder for the requested
-- (binding_key, stage_key, scope_type, scope_id) and returns the resolved
-- workflow_template_id + the merged binding payload, WITHOUT enqueuing a
-- workflow_run. Records a simulation audit row in workflow_binding_simulations.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280222_simulate_binding_dispatch_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.simulate_binding_dispatch_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_resource_id UUID;
  v_binding_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'binding_key', '')), ''));
  v_stage_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'stage_key', '')), ''));
  v_scope_type TEXT := lower(COALESCE(NULLIF(btrim(p_args->>'scope_type'), ''), 'tenant'));
  v_scope_id UUID := COALESCE(NULLIF(p_args->>'scope_id', '')::uuid, v_org_id);
  v_inputs JSONB := COALESCE(p_args->'inputs', '{}'::jsonb);
  v_resolved JSONB;
  v_stage_payload JSONB;
  v_resolved_template_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'simulate_binding_dispatch_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  IF v_binding_key IS NULL OR v_stage_key IS NULL THEN
    RAISE EXCEPTION 'simulate_binding_dispatch_v1 requires binding_key and stage_key'
      USING ERRCODE = '23502';
  END IF;
  IF v_scope_type NOT IN ('global', 'tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'simulate_binding_dispatch_v1 invalid scope_type %', v_scope_type
      USING ERRCODE = '22023';
  END IF;
  IF v_scope_type = 'tenant'
     AND v_org_id IS NOT NULL
     AND v_scope_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'simulate_binding_dispatch_v1 scope_id outside tenant scope'
      USING ERRCODE = '42501';
  END IF;

  -- Resolve workflow_binding_policy across the ladder.
  v_resolved := public.resolve_settings_merged('workflow_binding_policy', v_scope_type, v_scope_id);

  v_stage_payload := v_resolved
    #> ARRAY['bindings', v_binding_key, 'stages', v_stage_key];

  IF v_stage_payload IS NOT NULL THEN
    v_resolved_template_id := NULLIF(v_stage_payload->>'workflow_template_id', '')::uuid;
  END IF;

  INSERT INTO public.workflow_binding_simulations (
    organization_id, binding_key, stage_key, scope_type, scope_id,
    inputs, outputs, resolved_template_id, triggered_by, correlation_id
  ) VALUES (
    v_org_id, v_binding_key, v_stage_key, v_scope_type, v_scope_id,
    v_inputs,
    jsonb_build_object('stage_payload', COALESCE(v_stage_payload, 'null'::jsonb)),
    v_resolved_template_id, v_user_id, v_correlation_id
  )
  RETURNING id INTO v_resource_id;

  RETURN jsonb_build_object(
    'ok', true,
    'workflow_binding_simulation_id', v_resource_id,
    'binding_key', v_binding_key,
    'stage_key', v_stage_key,
    'resolved_template_id', v_resolved_template_id,
    'stage_payload', v_stage_payload,
    'correlation_id', v_correlation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.simulate_binding_dispatch_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.simulate_binding_dispatch_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.simulate_binding_dispatch_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.simulate_binding_dispatch_v1(jsonb)
  IS 'Canonical dry-run RPC: resolves workflow_binding_policy via ladder + records simulation audit (no workflow_run side effects). Capability: workflows.write.';

SELECT pg_advisory_unlock(hashtext('202604280222_simulate_binding_dispatch_v1'));
COMMIT;
