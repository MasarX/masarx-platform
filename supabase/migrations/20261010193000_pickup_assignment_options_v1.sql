BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20261010193000_pickup_assignment_options_v1'));

CREATE OR REPLACE FUNCTION api.pickup_assignment_options_v1(
  p_organization_id UUID, p_limit INT DEFAULT 100
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope RECORD;
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit,100),1),250);
  v_policy JSONB;
  v_lookup JSONB;
  v_branches JSONB;
  v_drivers JSONB;
  v_vehicles JSONB;
  v_partners JSONB;
BEGIN
  SELECT * INTO v_scope FROM api.pickup_read_scope_v1();
  IF p_organization_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=p_organization_id) THEN
    RAISE EXCEPTION 'Pickup organization is required' USING ERRCODE='23514';
  END IF;
  IF NOT v_scope.is_service_request THEN
    IF auth.uid() IS NULL OR (NOT v_scope.is_platform AND
      (v_scope.scope_type IS DISTINCT FROM 'tenant' OR v_scope.organization_id IS DISTINCT FROM p_organization_id))
      OR public.user_has_permission_v1('fleet.write',p_organization_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'Pickup assignment choices require tenant fleet.write authority' USING ERRCODE='42501';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('value',id,'label',COALESCE(NULLIF(name,''),NULLIF(code,''),id::text))), '[]'::jsonb)
    INTO v_branches FROM (SELECT id,name,code FROM public.branches
      WHERE organization_id=p_organization_id AND is_active ORDER BY name,id LIMIT v_limit) b;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('value',id,'label',COALESCE(NULLIF(full_name,''),'Driver '||left(id::text,8)))), '[]'::jsonb)
    INTO v_drivers FROM (SELECT id,full_name FROM public.users
      WHERE organization_id=p_organization_id AND user_type='driver' AND status='active'
      ORDER BY full_name,id LIMIT v_limit) u;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('value',id,'label',COALESCE(NULLIF(plate_number,''),NULLIF(concat_ws(' ',make,model),''),'Vehicle '||left(id::text,8)))), '[]'::jsonb)
    INTO v_vehicles FROM (SELECT id,plate_number,make,model FROM public.vehicles
      WHERE organization_id=p_organization_id AND status='active' AND is_active
      ORDER BY plate_number,id LIMIT v_limit) v;

  SELECT value INTO v_policy FROM public.resolve_pickup_policy(jsonb_build_object('organization_id',p_organization_id)) LIMIT 1;
  v_lookup := COALESCE(v_policy#>'{assignment,partner_lookup}','{}'::jsonb);
  IF jsonb_typeof(v_lookup) IS DISTINCT FROM 'object'
     OR (v_lookup ? 'request_statuses' AND jsonb_typeof(v_lookup->'request_statuses') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'Invalid pickup partner lookup policy' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('value',id,'label',label)), '[]'::jsonb)
    INTO v_partners FROM (
      SELECT DISTINCT supplier.id,COALESCE(NULLIF(profile.display_name,''),NULLIF(supplier.name,''),supplier.slug) AS label
      FROM public.marketplace_requests request
      JOIN LATERAL jsonb_array_elements_text(request.private_pool) pool(value) ON TRUE
      JOIN public.organizations supplier ON supplier.id::text=pool.value
      LEFT JOIN LATERAL (SELECT id,display_name FROM public.marketplace_participant_profiles
        WHERE organization_id=supplier.id AND status='approved' AND compliance_state='approved'
        ORDER BY id LIMIT 1) profile ON TRUE
      WHERE request.requester_organization_id=p_organization_id
        AND COALESCE(v_lookup->>'source_key','marketplace_private_pool_memberships')='marketplace_private_pool_memberships'
        AND (NOT COALESCE((v_lookup->>'require_approved_participant')::boolean,TRUE) OR profile.id IS NOT NULL)
        AND (COALESCE(v_lookup->'request_statuses','["draft","published","award_pending_acceptance","awarded","in_execution","completed"]'::jsonb)='[]'::jsonb
          OR COALESCE(v_lookup->'request_statuses','["draft","published","award_pending_acceptance","awarded","in_execution","completed"]'::jsonb) ? request.status)
      ORDER BY label,supplier.id LIMIT v_limit
    ) p;
  RETURN jsonb_build_object('branches',v_branches,'drivers',v_drivers,'vehicles',v_vehicles,'partners',v_partners);
END;
$function$;
REVOKE ALL ON FUNCTION api.pickup_assignment_options_v1(UUID,INT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api.pickup_assignment_options_v1(UUID,INT) TO authenticated,service_role;

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
      'branch_label',COALESCE(NULLIF(b.name,''),b.code),'driver_label',u.full_name,
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
    LEFT JOIN public.branches b ON b.id=rr.branch_id AND b.organization_id=s.organization_id
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
REVOKE ALL ON FUNCTION api.pickup_relationship_labels_v1(UUID[],UUID[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api.pickup_relationship_labels_v1(UUID[],UUID[]) TO authenticated,service_role;
COMMIT;
