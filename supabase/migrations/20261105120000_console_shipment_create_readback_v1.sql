-- Confirm persisted creation lineage without exposing audit rows to shipment writers.
BEGIN;

CREATE OR REPLACE FUNCTION public.ui_shipment_create_readback_v1(
  p_shipment_id UUID,
  p_workflow_run_id UUID DEFAULT NULL,
  p_correlation_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_shipment JSONB;
  v_organization_id UUID;
  v_run_visible BOOLEAN;
  v_decision_visible BOOLEAN;
  v_audit_visible BOOLEAN;
BEGIN
  IF p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'shipment_id is required' USING ERRCODE = '23514';
  END IF;
  -- This existing read seam enforces the current registry capability and tenant/client/sender scope.
  v_shipment := public.ui_get_resource_v1('shipments', p_shipment_id);
  IF v_shipment IS NULL THEN
    RAISE EXCEPTION 'shipment is not visible' USING ERRCODE = '42501';
  END IF;
  v_organization_id := (v_shipment->>'organization_id')::UUID;

  -- Caller-supplied workflow/correlation ids must belong to this persisted shipment.
  SELECT EXISTS (
    SELECT 1 FROM public.workflow_runs w
    WHERE w.id = p_workflow_run_id AND w.organization_id = v_organization_id
      AND (w.context#>>'{shipment,id}' = p_shipment_id::TEXT
        OR w.context#>>'{workflow,context_patch,shipment,id}' = p_shipment_id::TEXT
        OR EXISTS (SELECT 1 FROM public.workflow_run_steps s WHERE s.workflow_run_id = w.id
          AND s.operation_result->>'shipment_id' = p_shipment_id::TEXT))
      AND (p_correlation_id IS NULL OR p_correlation_id IN (w.id, w.triggered_by_request_id))
  ) INTO v_run_visible;

  SELECT EXISTS (
    SELECT 1 FROM public.decision_log d
    WHERE d.organization_id = v_organization_id
      AND ((d.resource_type = 'shipment' AND d.resource_id = p_shipment_id)
        OR (v_run_visible AND d.resource_type = 'workflow_run' AND d.resource_id = p_workflow_run_id)
        OR (v_run_visible AND p_correlation_id IS NOT NULL AND d.correlation_id = p_correlation_id))
  ) INTO v_decision_visible;
  SELECT EXISTS (
    SELECT 1 FROM public.audit_table_changes a
    WHERE a.organization_id = v_organization_id
      AND a.table_name = 'shipments' AND a.pk @> jsonb_build_object('id', p_shipment_id)
  ) OR EXISTS (
    SELECT 1 FROM public.shipment_actions a
    WHERE a.organization_id = v_organization_id AND a.shipment_id = p_shipment_id
  ) INTO v_audit_visible;

  RETURN jsonb_build_object('visible', v_decision_visible AND v_audit_visible);
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_shipment_create_readback_v1(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_shipment_create_readback_v1(UUID, UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_shipment_create_readback_v1(
  p_shipment_id UUID,
  p_workflow_run_id UUID DEFAULT NULL,
  p_correlation_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
  SELECT public.ui_shipment_create_readback_v1($1, $2, $3);
$function$;

REVOKE ALL ON FUNCTION api.ui_shipment_create_readback_v1(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.ui_shipment_create_readback_v1(UUID, UUID, UUID) TO authenticated, service_role;
COMMIT;
