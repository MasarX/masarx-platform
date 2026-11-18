-- Console V2 network projection gap closure.
--
-- Branches: append booked_today to public.v_branch_summary so Console V2 reads
-- branch load through the canonical summary projection, not from the branches
-- base row.
--
-- Zones: append geometry to public.v_zone_summary so the zone map reads an
-- API-backed polygon projection derived from zone_districts ->
-- canonical_districts centroids, not frontend-synthetic zone metadata.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041650_console_v2_network_branch_zone_projection_gaps_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_branch_summary
WITH (security_invoker = true)
AS
WITH cap AS (
  SELECT
    bcw.branch_id,
    COALESCE(SUM(COALESCE((bcw.capacity->>'max_stops')::NUMERIC, 0)), 0)::NUMERIC AS capacity_per_day
  FROM public.branch_capacity_windows bcw
  WHERE bcw.is_active = TRUE
    AND (bcw.effective_to IS NULL OR bcw.effective_to > now())
  GROUP BY bcw.branch_id
),
veh AS (
  SELECT
    v.branch_id,
    COUNT(*)::INT AS active_vehicles
  FROM public.vehicles v
  WHERE v.branch_id IS NOT NULL
    AND v.is_active = TRUE
    AND v.status = 'active'
  GROUP BY v.branch_id
),
runs AS (
  SELECT
    rr.branch_id,
    COUNT(*)::INT AS active_routes
  FROM public.route_runs rr
  WHERE rr.branch_id IS NOT NULL
    AND rr.status IN ('planned', 'in_progress')
  GROUP BY rr.branch_id
),
mgr AS (
  SELECT
    bm.branch_id,
    MIN(bm.user_id::TEXT)::UUID AS manager_user_id
  FROM public.branch_memberships bm
  WHERE bm.is_active = TRUE
    AND bm.role_key = 'manager'
    AND (bm.effective_to IS NULL OR bm.effective_to > now())
  GROUP BY bm.branch_id
),
load AS (
  SELECT
    s.branch_id,
    COUNT(*)::INT AS booked_today
  FROM public.shipments s
  JOIN public.branches b ON b.id = s.branch_id
  WHERE s.branch_id IS NOT NULL
    AND s.promised_delivery_date = ((now() AT TIME ZONE COALESCE(NULLIF(b.timezone, ''), 'Asia/Riyadh'))::DATE)
  GROUP BY s.branch_id
)
SELECT
  b.id              AS branch_id,
  b.organization_id,
  b.code,
  b.name,
  b.branch_type,
  b.is_active,
  b.timezone,
  COALESCE(cap.capacity_per_day, 0)::NUMERIC AS capacity_per_day,
  COALESCE(veh.active_vehicles, 0)::INT      AS active_vehicles,
  COALESCE(runs.active_routes, 0)::INT       AS active_routes,
  mgr.manager_user_id,
  NULLIF(btrim(COALESCE(b.operating_hours->>'cutoff_time_local', '')), '') AS cutoff_time,
  b.updated_at,
  COALESCE(load.booked_today, 0)::INT AS booked_today
FROM public.branches b
LEFT JOIN cap  ON cap.branch_id = b.id
LEFT JOIN veh  ON veh.branch_id = b.id
LEFT JOIN runs ON runs.branch_id = b.id
LEFT JOIN mgr  ON mgr.branch_id = b.id
LEFT JOIN load ON load.branch_id = b.id;

COMMENT ON VIEW public.v_branch_summary IS
  'FE-friendly projection of branches with derived counters (capacity_per_day, active_vehicles, active_routes, manager_user_id, cutoff_time, booked_today). Sources: branches + branch_capacity_windows + vehicles + route_runs + branch_memberships + shipments. Read-only; SSOT remains branches and shipment promise projections; mutations go through branch_create_v1 / branch_update_v1 / mark_branch_oos_v1.';

REVOKE ALL ON public.v_branch_summary FROM PUBLIC;
REVOKE ALL ON public.v_branch_summary FROM anon;
REVOKE ALL ON public.v_branch_summary FROM authenticated;
GRANT SELECT ON public.v_branch_summary TO authenticated;
GRANT SELECT ON public.v_branch_summary TO service_role;

CREATE OR REPLACE VIEW public.v_zone_summary
WITH (security_invoker = true)
AS
WITH br AS (
  SELECT
    bz.zone_id,
    COUNT(DISTINCT bz.branch_id)::INT AS branch_count
  FROM public.branch_zones bz
  GROUP BY bz.zone_id
),
br_pri AS (
  SELECT DISTINCT ON (bz.zone_id)
    bz.zone_id,
    b.code AS hub_code
  FROM public.branch_zones bz
  JOIN public.branches b ON b.id = bz.branch_id
  ORDER BY bz.zone_id,
           bz.priority NULLS LAST,
           bz.branch_id::TEXT
),
dist AS (
  SELECT
    zd.zone_id,
    COUNT(*)::INT AS district_count
  FROM public.zone_districts zd
  GROUP BY zd.zone_id
),
ov AS (
  SELECT
    zone_id,
    COUNT(*) FILTER (WHERE status = 'pending')::INT AS pending_overrides,
    MAX(updated_at)                               AS last_override_at
  FROM (
    SELECT requested_zone_id AS zone_id, status, updated_at
      FROM public.zone_override_requests
     WHERE requested_zone_id IS NOT NULL
    UNION ALL
    SELECT current_zone_id AS zone_id, status, updated_at
      FROM public.zone_override_requests
     WHERE current_zone_id IS NOT NULL
  ) AS u
  GROUP BY zone_id
),
zone_points AS (
  SELECT
    zd.zone_id,
    cd.centroid_lng::NUMERIC AS lng,
    cd.centroid_lat::NUMERIC AS lat
  FROM public.zone_districts zd
  JOIN public.canonical_districts cd ON cd.id = zd.canonical_district_id
  WHERE cd.centroid_lat IS NOT NULL
    AND cd.centroid_lng IS NOT NULL
),
zone_bounds AS (
  SELECT
    zp.zone_id,
    MIN(zp.lng) AS min_lng,
    MAX(zp.lng) AS max_lng,
    MIN(zp.lat) AS min_lat,
    MAX(zp.lat) AS max_lat,
    GREATEST((MAX(zp.lng) - MIN(zp.lng)) * 0.15, 0.014)::NUMERIC AS pad_lng,
    GREATEST((MAX(zp.lat) - MIN(zp.lat)) * 0.15, 0.014)::NUMERIC AS pad_lat
  FROM zone_points zp
  GROUP BY zp.zone_id
),
zone_paths AS (
  SELECT
    zb.zone_id,
    jsonb_build_object(
      'kind', 'polygon',
      'source', 'canonical_district_centroids',
      'paths', jsonb_build_array(
        jsonb_build_array(ROUND(zb.min_lng - zb.pad_lng, 6), ROUND(zb.min_lat - zb.pad_lat, 6)),
        jsonb_build_array(ROUND(zb.max_lng + zb.pad_lng, 6), ROUND(zb.min_lat - zb.pad_lat, 6)),
        jsonb_build_array(ROUND(zb.max_lng + zb.pad_lng, 6), ROUND(zb.max_lat + zb.pad_lat, 6)),
        jsonb_build_array(ROUND(zb.min_lng - zb.pad_lng, 6), ROUND(zb.max_lat + zb.pad_lat, 6)),
        jsonb_build_array(ROUND(zb.min_lng - zb.pad_lng, 6), ROUND(zb.min_lat - zb.pad_lat, 6))
      )
    ) AS geometry
  FROM zone_bounds zb
)
SELECT
  z.id           AS zone_id,
  z.organization_id,
  z.name,
  z.slug,
  z.is_active,
  z.description,
  z.created_at,
  z.updated_at,
  COALESCE(br.branch_count, 0)::INT      AS branch_count,
  COALESCE(dist.district_count, 0)::INT  AS district_count,
  COALESCE(ov.pending_overrides, 0)::INT AS pending_overrides,
  ov.last_override_at,
  br_pri.hub_code,
  NULLIF(btrim(COALESCE(z.metadata->>'color_token', '')), '') AS color_token,
  zone_paths.geometry
FROM public.zones z
LEFT JOIN br         ON br.zone_id         = z.id
LEFT JOIN br_pri     ON br_pri.zone_id     = z.id
LEFT JOIN dist       ON dist.zone_id       = z.id
LEFT JOIN ov         ON ov.zone_id         = z.id
LEFT JOIN zone_paths ON zone_paths.zone_id = z.id;

COMMENT ON VIEW public.v_zone_summary IS
  'FE-friendly projection of zones with derived counters (branch_count, district_count, pending_overrides, last_override_at, hub_code, color_token, geometry). Geometry is read-only and derived from zone_districts joined to canonical_districts centroids. SSOT remains zones and zone_districts; mutations go through zone_create_v1 / zone_district_add_v1 / zone_district_remove_v1 / suspend_zone_v1.';

REVOKE ALL ON public.v_zone_summary FROM PUBLIC;
REVOKE ALL ON public.v_zone_summary FROM anon;
REVOKE ALL ON public.v_zone_summary FROM authenticated;
GRANT SELECT ON public.v_zone_summary TO authenticated;
GRANT SELECT ON public.v_zone_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202605041650_console_v2_network_branch_zone_projection_gaps_v1'));

COMMIT;
