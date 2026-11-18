-- Migration: resolve_fieldops_pickups_v1 — first-mile pickup aggregator
-- Date: 2026-05-11
-- Spec: Phase 6 network ops. AGENTS.md Mobile Field Ops Policy Contract
--       requires every list surface to read row-driven from canonical
--       tables; this aggregator returns the calling driver's assigned
--       pickup stops (route_stops.stop_kind = 'pickup' joined to shipments
--       with service_type = 'pickup'), filtered to active route_runs and
--       sorted by smart-default (urgency x priority x eta).
--
-- The envelope mirrors the resolve_fieldops_tasks_v1 contract so the
-- frontend can pass pickup rows through the same MobileV2Task renderer.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605110100_resolve_fieldops_pickups_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_fieldops_pickups_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  task_id TEXT,
  type TEXT,
  title TEXT,
  sub TEXT,
  urgency TEXT,
  cta TEXT,
  route TEXT,
  eta_iso TIMESTAMPTZ,
  priority INT,
  area TEXT,
  code TEXT,
  action TEXT,
  tone TEXT,
  meta JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org UUID;
  v_active_role TEXT := lower(btrim(COALESCE(p_active_role, 'driver')));
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_pickups_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_caller_org := public.current_user_org_id();
  IF v_caller_org IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_pickups_v1: caller has no organization context'
      USING ERRCODE = '42501';
  END IF;

  -- Pickup queue: shipments with service_type='pickup' OR route_stops with
  -- stop_kind='pickup'. Driver sees rows on their assigned active runs;
  -- loader / supervisor see all org-scoped pending pickups.
  RETURN QUERY
  SELECT
    ('pickup:' || rs.id::text)                                              AS task_id,
    'pickup'::text                                                          AS type,
    COALESCE(s.tracking_number, 'PU-' || substr(rs.id::text, 1, 6))         AS title,
    CONCAT_WS(' · ',
      NULLIF(s.service_level, ''),
      'box ' || s.box_count::text,
      NULLIF(rs.metadata->>'area', '')
    )                                                                       AS sub,
    public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now)  AS urgency,
    CASE
      WHEN rs.planned_window_start_at IS NOT NULL
       AND rs.planned_window_start_at <= v_now + INTERVAL '60 minutes' THEN 'Pick up'
      ELSE 'Open'
    END                                                                     AS cta,
    ('/mobile/pickup/' || rs.id::text)                                      AS route,
    rs.planned_window_start_at                                              AS eta_iso,
    public.fieldops_v2_priority_int(s.priority_score)                       AS priority,
    NULLIF(rs.metadata->>'area', '')                                        AS area,
    s.tracking_number                                                       AS code,
    'pickup'::text                                                          AS action,
    public.fieldops_v2_resolve_tone(
      public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now),
      public.fieldops_v2_priority_int(s.priority_score),
      rs.planned_window_start_at,
      v_now
    )                                                                       AS tone,
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', rr.id,
      'route_run_status', rr.status,
      'shipment_id', rs.shipment_id,
      'client_id', rs.client_id,
      'sequence_order', rs.sequence_order,
      'service_level', s.service_level,
      'box_count', s.box_count,
      'shipment_status', s.status,
      'service_type', s.service_type
    ))                                                                      AS meta
  FROM public.route_runs rr
  JOIN public.route_stops rs
    ON rs.route_run_id = rr.id
   AND rs.organization_id = rr.organization_id
  LEFT JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.client_id = rs.client_id
  WHERE rr.organization_id = v_caller_org
    AND rs.stop_kind = 'pickup'
    AND rr.status NOT IN ('completed', 'cancelled', 'closed')
    AND (
      -- Drivers + riders only see their own assignments; loader +
      -- supervisor see org-wide.
      v_active_role NOT IN ('driver', 'rider')
      OR rr.driver_user_id = v_user_id
    )
  ORDER BY
    CASE public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now)
      WHEN 'now'   THEN 0
      WHEN 'today' THEN 1
      ELSE 2
    END,
    public.fieldops_v2_priority_int(s.priority_score) DESC,
    rs.planned_window_start_at NULLS LAST,
    rs.sequence_order;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_pickups_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_fieldops_pickups_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_pickups_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_pickups_v1(TEXT, JSONB) IS
  'Mobile V2 first-mile pickup aggregator. Returns route_stops with stop_kind=pickup on active route_runs, joined to shipments. Drivers/riders see their own assignments; loader/supervisor see org-wide. Sorted by urgency x priority x eta. Envelope mirrors resolve_fieldops_tasks_v1 so frontend can pass rows through MobileV2Task renderer.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_pickups_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  task_id TEXT,
  type TEXT,
  title TEXT,
  sub TEXT,
  urgency TEXT,
  cta TEXT,
  route TEXT,
  eta_iso TIMESTAMPTZ,
  priority INT,
  area TEXT,
  code TEXT,
  action TEXT,
  tone TEXT,
  meta JSONB
)
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT * FROM public.resolve_fieldops_pickups_v1(p_active_role, p_context);
$function$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_pickups_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_fieldops_pickups_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_pickups_v1(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605110100_resolve_fieldops_pickups_v1'));
COMMIT;
