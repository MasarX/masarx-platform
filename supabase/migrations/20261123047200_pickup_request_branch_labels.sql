-- Resolve the requested branch when the visible pickup has no route branch.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION api.pickup_relationship_labels_v1(
  p_shipment_ids UUID[] DEFAULT '{}'::UUID[], p_route_run_ids UUID[] DEFAULT '{}'::UUID[]
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE v_scope RECORD; v_result JSONB;
BEGIN
  SELECT * INTO v_scope FROM api.pickup_read_scope_v1();
  IF NOT v_scope.is_service_request AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Pickup labels require authentication' USING ERRCODE='42501';
  END IF;
  IF COALESCE(cardinality(p_shipment_ids),0)>100 OR COALESCE(cardinality(p_route_run_ids),0)>100 THEN
    RAISE EXCEPTION 'Pickup labels accept at most 100 shipment and route ids' USING ERRCODE='22023';
  END IF;
  WITH visible_shipments AS (
    SELECT s.* FROM public.shipments s
    WHERE lower(COALESCE(s.service_type,''))='pickup'
      AND (v_scope.is_service_request OR v_scope.is_platform
        OR (v_scope.scope_type='tenant' AND s.organization_id=v_scope.organization_id)
        OR (v_scope.scope_type='client' AND s.client_id=v_scope.client_id)
        OR (v_scope.scope_type='sender' AND s.sender_id=v_scope.sender_id))
      AND (s.id=ANY(p_shipment_ids) OR EXISTS (SELECT 1 FROM public.route_stops rs
        WHERE rs.shipment_id=s.id AND rs.client_id=s.client_id AND rs.organization_id=s.organization_id
          AND lower(rs.stop_kind)='pickup' AND rs.route_run_id=ANY(p_route_run_ids)))
  ), label_rows AS (
    SELECT 'shipment:'||s.id::text AS key,jsonb_build_object(
      'organization_label',o.name,'client_label',c.name,'sender_label',COALESCE(NULLIF(sender.name,''),sender.brand_name),
      'branch_id',b.id,'branch_label',COALESCE(NULLIF(b.name,''),b.code),'driver_label',u.full_name,
      'vehicle_label',COALESCE(NULLIF(v.plate_number,''),NULLIF(concat_ws(' ',v.make,v.model),''))) AS labels
    FROM visible_shipments s
    LEFT JOIN public.organizations o ON o.id=s.organization_id
    LEFT JOIN public.clients c ON c.id=s.client_id AND c.organization_id=s.organization_id
    LEFT JOIN public.senders sender ON sender.id=s.sender_id AND sender.client_id=s.client_id
    LEFT JOIN LATERAL (SELECT rr.* FROM public.route_stops rs JOIN public.route_runs rr
      ON rr.id=rs.route_run_id AND rr.organization_id=rs.organization_id
      WHERE rs.shipment_id=s.id AND rs.client_id=s.client_id AND rs.organization_id=s.organization_id
        AND lower(rs.stop_kind)='pickup'
      ORDER BY COALESCE(rr.planned_start_at,rr.created_at) DESC,rs.sequence_order,rr.id LIMIT 1) rr ON TRUE
    LEFT JOIN public.branches b ON b.id=COALESCE(
      rr.branch_id,
      CASE WHEN s.metadata#>>'{pickup_request,branch_id}' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        THEN (s.metadata#>>'{pickup_request,branch_id}')::uuid
      END
    ) AND b.organization_id=s.organization_id
    LEFT JOIN public.users u ON u.id=rr.driver_user_id AND u.organization_id=s.organization_id
    LEFT JOIN public.vehicles v ON v.id=rr.vehicle_id AND v.organization_id=s.organization_id
    WHERE s.id=ANY(p_shipment_ids)
    UNION ALL
    SELECT 'route:'||rr.id::text,jsonb_build_object('branch_label',COALESCE(NULLIF(b.name,''),b.code),
      'driver_label',u.full_name,'vehicle_label',COALESCE(NULLIF(v.plate_number,''),NULLIF(concat_ws(' ',v.make,v.model),'')))
    FROM public.route_runs rr
    LEFT JOIN public.branches b ON b.id=rr.branch_id AND b.organization_id=rr.organization_id
    LEFT JOIN public.users u ON u.id=rr.driver_user_id AND u.organization_id=rr.organization_id
    LEFT JOIN public.vehicles v ON v.id=rr.vehicle_id AND v.organization_id=rr.organization_id
    WHERE rr.id=ANY(p_route_run_ids) AND EXISTS (SELECT 1 FROM public.route_stops rs
      JOIN visible_shipments s ON s.id=rs.shipment_id AND s.client_id=rs.client_id AND s.organization_id=rs.organization_id
      WHERE rs.route_run_id=rr.id AND rs.organization_id=rr.organization_id AND lower(rs.stop_kind)='pickup')
  ) SELECT COALESCE(jsonb_object_agg(key,jsonb_strip_nulls(labels)),'{}'::jsonb) INTO v_result FROM label_rows;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION api.pickup_relationship_labels_v1(UUID[], UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.pickup_relationship_labels_v1(UUID[], UUID[]) TO authenticated, service_role;

COMMIT;
