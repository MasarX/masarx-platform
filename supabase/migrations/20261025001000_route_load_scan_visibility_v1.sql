-- Keep route-stop scan-out readback available through caller-scoped invoker views.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('20261025001000_route_load_scan_visibility_v1'));

CREATE FUNCTION public.route_stop_load_scan_summary_v1(p_route_stop_id UUID)
RETURNS TABLE(load_scan_count INT, last_load_scanned_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT COUNT(se.route_run_id)::INT, MAX(se.captured_at)
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id AND rr.organization_id = rs.organization_id
  LEFT JOIN public.scan_events se
    ON se.organization_id = rs.organization_id AND se.route_run_id = rs.route_run_id
    AND lower(COALESCE(se.scan_type, '')) = 'load'
    AND (
      se.route_stop_id = rs.id
      OR (se.route_stop_id IS NULL AND rs.shipment_id IS NOT NULL AND se.shipment_id = rs.shipment_id)
    )
  WHERE rs.id = p_route_stop_id
    AND public.route_run_actor_can_read_v1(rs.organization_id, rs.route_run_id, rr.driver_user_id)
  GROUP BY rs.id;
$function$;

REVOKE ALL ON FUNCTION public.route_stop_load_scan_summary_v1(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.route_stop_load_scan_summary_v1(UUID) TO authenticated;

-- Replace only the scan aggregate so newer route-stop projection columns survive.
DO $repair$
DECLARE
  v_view TEXT := pg_get_viewdef('public.route_stops_visible_v1'::regclass, TRUE);
  v_pattern TEXT := $pattern$(LEFT JOIN LATERAL\s+\(\s*SELECT\s+\(*count\(\*\)\)*::integer\s+AS\s+load_scan_count,\s*max\(se\.captured_at\)\s+AS\s+last_load_scanned_at\s+FROM\s+(public\.)?scan_events\s+se\s+WHERE\s+.*?\)\s+load_scan\s+ON\s+true)$pattern$;
  v_matches TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO v_matches
  FROM regexp_matches(v_view, v_pattern, 'gis') AS m;
  IF COALESCE(cardinality(v_matches), 0) <> 1 THEN
    RAISE EXCEPTION 'Unexpected route-stop load-scan aggregate definition';
  END IF;
  v_view := replace(v_view, v_matches[1],
    'LEFT JOIN LATERAL public.route_stop_load_scan_summary_v1(rs.id) load_scan ON true');
  IF v_view ~ '\mscan_events\M' THEN
    RAISE EXCEPTION 'Unexpected remaining route-stop scan-events dependency';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.route_stops_visible_v1 WITH (security_invoker = true) AS ' || v_view;
END;
$repair$;

REVOKE SELECT ON public.route_stops_visible_v1, api.route_stops FROM service_role;

COMMENT ON FUNCTION public.route_stop_load_scan_summary_v1(UUID)
  IS 'Shared route-authorized load-scan count/time summary; raw telemetry remains service-only.';
COMMIT;
