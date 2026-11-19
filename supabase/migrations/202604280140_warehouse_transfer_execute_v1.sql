-- Spec-Issue: Phase B1 - Platform RPC contract: warehouse_transfer_execute_v1
-- Step: B1-RPC-14
-- Capability: warehouse.write
-- Replace synthetic stub: real backend that initiates the canonical workflow
-- template 'warehouse_transfer_execute_v1' for a given warehouse_transfers row.
-- Audit found this as P0 (FE called a key with no backend wire).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280140_warehouse_transfer_execute_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.warehouse_transfer_execute_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_transfer_id UUID := NULLIF(p_args->>'warehouse_transfer_id', '')::uuid;
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_transfer public.warehouse_transfers%ROWTYPE;
  v_template_id UUID;
  v_workflow_run_id UUID;
  v_context JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_execute_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('warehouse.write');

  IF v_transfer_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_execute_v1 requires warehouse_transfer_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_transfer
    FROM public.warehouse_transfers
   WHERE id = v_transfer_id
   FOR UPDATE;

  IF v_transfer.id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_execute_v1 transfer % not found', v_transfer_id
      USING ERRCODE = '23503';
  END IF;

  IF v_org_id IS NOT NULL AND v_transfer.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'warehouse_transfer_execute_v1 transfer % outside tenant scope', v_transfer_id
      USING ERRCODE = '42501';
  END IF;

  IF v_transfer.status NOT IN ('draft','planned') THEN
    RAISE EXCEPTION 'warehouse_transfer_execute_v1 transfer % cannot start from status=%', v_transfer_id, v_transfer.status
      USING ERRCODE = '23514';
  END IF;

  -- Resolve canonical workflow template
  SELECT id INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'warehouse_transfer_execute_v1'
   ORDER BY version DESC
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_execute_v1 canonical workflow template missing'
      USING ERRCODE = '42883';
  END IF;

  v_context := jsonb_build_object(
    'organization_id', v_transfer.organization_id,
    'warehouse_transfer_id', v_transfer.id,
    'from_branch_id', v_transfer.from_branch_id,
    'to_branch_id', v_transfer.to_branch_id,
    'driver_user_id', v_transfer.driver_user_id,
    'vehicle_id', v_transfer.vehicle_id,
    'resource_type', 'warehouse_transfer',
    'resource_id', v_transfer.id,
    'requested_by', v_user_id,
    'correlation_id', v_correlation_id
  );

  v_workflow_run_id := public.start_workflow_run(v_template_id, v_context);

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_transfer.organization_id, 'warehouse.execute',
    'warehouse_transfer', v_transfer.id,
    'warehouse_transfer_execute_v1', 'workflow_started',
    jsonb_build_object('workflow_run_id', v_workflow_run_id, 'template_id', v_template_id),
    'warehouse_transfer_execute_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status, workflow_run_id
  ) VALUES (
    v_transfer.organization_id, 'warehouse_transfer.execute_started',
    'warehouse_transfer', v_transfer.id,
    jsonb_build_object('workflow_run_id', v_workflow_run_id),
    v_correlation_id::uuid, 'pending', v_workflow_run_id
  );

  RETURN jsonb_build_object(
    'ok', true,
    'warehouse_transfer_id', v_transfer.id,
    'workflow_run_id', v_workflow_run_id,
    'workflow_template_id', v_template_id,
    'status', v_transfer.status,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.warehouse_transfer_execute_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.warehouse_transfer_execute_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.warehouse_transfer_execute_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.warehouse_transfer_execute_v1(jsonb)
  IS 'Canonical write RPC: start warehouse_transfer_execute_v1 workflow run for a warehouse_transfers row. Capability: warehouse.write. Replaces synthetic stub.';

SELECT pg_advisory_unlock(hashtext('202604280140_warehouse_transfer_execute_v1'));
COMMIT;
