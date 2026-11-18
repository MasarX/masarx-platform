-- Migration: Dispatch route scanout stop readback scope guard v1
-- Purpose:
--   - Keep per-stop route-load scan readback route-run scoped even when the
--     helper is invoked directly with caller-supplied stop/shipment ids.
--   - Preserve canonical route-run reconciliation and manifest readback
--     behavior while failing closed on stops outside the selected route run.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606301650_dispatch_route_scanout_stop_readback_scope_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.route_stop_load_scan_readback_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_route_run_id UUID,
  p_route_stop_id UUID,
  p_shipment_id UUID
)
RETURNS TABLE(load_scan_count INT, last_load_scanned_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
/* objectives:allow RLS_OFF Justification: SECURITY DEFINER readback helper first validates route-run actor visibility, then resolves the route-stop shipment lineage inside that route run before reading scan events. */
SET row_security = off
AS $function$
  WITH route_run_scope AS (
    SELECT rr.id
    FROM public.route_runs rr
    WHERE rr.id = p_route_run_id
      AND rr.organization_id = p_organization_id
      AND public.route_run_actor_can_read_v1(rr.organization_id, rr.id, rr.driver_user_id)
    LIMIT 1
  ),
  route_stop_scope AS (
    SELECT
      rs.id AS route_stop_id,
      rs.shipment_id,
      rs.client_id,
      rs.organization_id
    FROM public.route_stops rs
    JOIN route_run_scope scope
      ON scope.id = rs.route_run_id
    WHERE rs.id = p_route_stop_id
      AND rs.route_run_id = p_route_run_id
      AND rs.organization_id = p_organization_id
      AND rs.client_id = p_client_id
      AND (
        p_shipment_id IS NULL
        OR rs.shipment_id = p_shipment_id
      )
    LIMIT 1
  ),
  expected_shipment AS (
    SELECT
      s.id,
      upper(NULLIF(btrim(COALESCE(s.tracking_number, '')), '')) AS tracking_upper
    FROM route_stop_scope stop
    JOIN public.shipments s
      ON s.id = stop.shipment_id
     AND s.client_id = stop.client_id
     AND s.organization_id = stop.organization_id
    WHERE p_shipment_id IS NOT NULL
      AND s.id = p_shipment_id
    LIMIT 1
  )
  SELECT
    COUNT(*)::INT AS load_scan_count,
    MAX(se.captured_at) AS last_load_scanned_at
  FROM public.scan_events se
  JOIN route_run_scope scope
    ON TRUE
  JOIN route_stop_scope stop
    ON TRUE
  LEFT JOIN expected_shipment expected
    ON TRUE
  WHERE se.organization_id = p_organization_id
    AND se.route_run_id = scope.id
    AND lower(COALESCE(se.scan_type, '')) = 'load'
    AND (
      se.route_stop_id = stop.route_stop_id
      OR (
        se.route_stop_id IS NULL
        AND expected.id IS NOT NULL
        AND se.shipment_id = expected.id
      )
      OR (
        se.route_stop_id IS NULL
        AND se.shipment_id IS NULL
        AND expected.id IS NOT NULL
        AND expected.tracking_upper IS NOT NULL
        AND upper(NULLIF(btrim(COALESCE(se.barcode, '')), '')) = expected.tracking_upper
      )
    );
$function$;

COMMENT ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID)
  IS 'Route-run-scoped per-stop load scan readback helper aligned with route_run_scan_out_reconciliation_v1 and guarded by selected route_stop lineage.';

REVOKE ALL ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_stop_load_scan_readback_v1(UUID, UUID, UUID, UUID, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606301650_dispatch_route_scanout_stop_readback_scope_guard_v1'));

COMMIT;
