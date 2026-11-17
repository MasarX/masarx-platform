-- F619 G7: exact actor-bound returned-to-branch scan receipt.
BEGIN;
SELECT pg_advisory_lock(hashtext('20260913101000_fieldops_return_scan_readback_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_get_return_to_branch_scan_readback_v1(
  p_scan_event_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security TO on
AS $function$
DECLARE
  v_actor_id UUID := auth.uid();
  v_organization_id UUID := public.current_user_org_id();
  v_result JSONB;
BEGIN
  IF v_actor_id IS NULL OR v_organization_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_return_to_branch_scan_readback_v1 requires authenticated tenant context'
      USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_strip_nulls(jsonb_build_object(
    'version', 1,
    'scan_event_id', se.id,
    'scan_type', se.scan_type,
    'barcode', se.barcode,
    'captured_at', COALESCE(se.captured_at, se.created_at),
    'shipment_id', se.shipment_id,
    'tracking_number', s.tracking_number,
    'shipment_status', s.status,
    'branch_id', se.branch_id,
    'route_stop_id', se.route_stop_id,
    'inventory_movement_id', im.id,
    'inventory_location_id', im.to_location_id,
    'shipment_action_id', sa.id,
    'dispatch_exception_review_task_id', r.dispatch_exception_review_task_id,
    'next_action', r.next_action,
    'next_action_source', r.next_action_source,
    'updated_at', r.updated_at
  ))
    INTO v_result
    FROM public.scan_events se
    JOIN public.shipments s
      ON s.id = se.shipment_id
     AND s.client_id = se.client_id
     AND s.organization_id = se.organization_id
    JOIN public.inventory_movements im
      ON im.organization_id = se.organization_id
     AND im.related_scan_event_id = se.id
     AND im.actor_user_id = v_actor_id
     AND COALESCE(im.metadata->>'shipment_id', '') = se.shipment_id::text
     AND COALESCE(s.metadata#>>'{return_to_branch,inventory_movement_id}', '') = im.id::text
    JOIN public.shipment_actions sa
      ON sa.shipment_id = se.shipment_id
     AND sa.client_id = se.client_id
     AND sa.organization_id = se.organization_id
     AND sa.action_type = 'scan'
     AND sa.performed_by_user_id = v_actor_id
     AND COALESCE(sa.action_data->>'source_scan_event_id', '') = se.id::text
     AND COALESCE(sa.action_data->>'inventory_movement_id', '') = im.id::text
     AND COALESCE(s.metadata#>>'{return_to_branch,shipment_action_id}', '') = sa.id::text
    JOIN public.return_to_branch_shipments_v1 r
      ON r.shipment_id = se.shipment_id
     AND r.client_id = se.client_id
     AND r.organization_id = se.organization_id
     AND r.intake_scan_event_id = se.id
     AND r.inventory_movement_id = im.id
   WHERE se.id = p_scan_event_id
     AND se.scan_type = 'return_to_branch_intake'
     AND se.organization_id = v_organization_id
     AND se.actor_user_id = v_actor_id
   ORDER BY im.occurred_at DESC, im.id DESC, sa.created_at DESC, sa.id DESC
   LIMIT 1;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_get_return_to_branch_scan_readback_v1(
  p_scan_event_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp
AS $function$
  SELECT public.ui_get_return_to_branch_scan_readback_v1(p_scan_event_id);
$function$;

REVOKE ALL ON FUNCTION public.ui_get_return_to_branch_scan_readback_v1(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.ui_get_return_to_branch_scan_readback_v1(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_get_return_to_branch_scan_readback_v1(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_get_return_to_branch_scan_readback_v1(UUID) TO authenticated;

COMMENT ON FUNCTION public.ui_get_return_to_branch_scan_readback_v1(UUID)
  IS 'Returns an exact accepted returned-to-branch scan receipt only to its authenticated actor after canonical movement and shipment-action projections exist.';

SELECT pg_advisory_unlock(hashtext('20260913101000_fieldops_return_scan_readback_v1'));
COMMIT;
