-- Task planned-time reads reuse the canonical scoped route source without
-- computing unused assignment and full execution-manifest API projections.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, extensions, pg_temp;
CREATE OR REPLACE VIEW api.tasks_controls_v1 WITH (security_invoker = true) AS
WITH task_projection AS (
 SELECT t.*,
   COALESCE(rs.planned_window_start_at, rr.planned_start_at) AS planned_at,
   COALESCE(NULLIF(t.metadata->>'area',''), NULLIF(t.metadata#>>'{address,district}',''),
     NULLIF(t.metadata#>>'{address,city}',''), NULLIF(t.metadata->>'city',''), '') AS area,
   COALESCE(NULLIF(t.metadata->>'reference',''), NULLIF(t.metadata#>>'{customer,reference}',''), t.id::text) AS sort_code
 FROM public.tasks t
 LEFT JOIN public.route_stops_visible_v1 rs
   ON t.resource_type = 'route_stop' AND t.resource_id = rs.id
   AND t.organization_id = rs.organization_id
   AND (t.client_id IS NULL OR t.client_id = rs.client_id)
 LEFT JOIN public.route_runs_visible_v1 rr
   ON t.resource_type = 'route_run' AND t.resource_id = rr.id
   AND t.organization_id = rr.organization_id
 WHERE auth.role() = 'service_role'
    OR (public.user_has_capability_v1('tasks.read', public.current_user_scope_type(), public.current_user_scope_id())
      AND (public.is_platform_user()
        OR (public.current_user_scope_type() = 'tenant' AND t.organization_id = public.current_user_org_id())
        OR (public.current_user_scope_type() = 'client' AND t.client_id = public.current_user_client_id())
        OR (public.current_user_scope_type() = 'sender' AND t.sender_id = public.current_user_sender_id())))
), classified AS (
 SELECT task_projection.*, CASE
   WHEN planned_at IS NULL THEN 'later'
   WHEN planned_at <= statement_timestamp() + INTERVAL '60 minutes' THEN 'now'
   WHEN planned_at::date = CURRENT_DATE THEN 'today'
   ELSE 'later' END AS urgency
 FROM task_projection
)
SELECT classified.*,
 CASE urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END AS urgency_order,
 jsonb_build_array(CASE urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END,
   -priority::numeric, CASE WHEN planned_at IS NULL THEN 1 ELSE 0 END,
   COALESCE(extract(epoch FROM planned_at),0), sort_code, id::text) AS smart_order,
 jsonb_build_array(-priority::numeric, sort_code, id::text) AS sort_priority,
 jsonb_build_array(CASE WHEN planned_at IS NULL THEN 1 ELSE 0 END,
   COALESCE(extract(epoch FROM planned_at),0), sort_code, id::text) AS sort_eta,
 jsonb_build_array(area, sort_code, id::text) AS sort_area,
 CASE WHEN urgency = 'now' THEN 1 ELSE 0 END AS urgency_now,
 CASE WHEN urgency = 'today' THEN 1 ELSE 0 END AS urgency_today,
 CASE WHEN urgency = 'later' THEN 1 ELSE 0 END AS urgency_later
FROM classified;
REVOKE ALL ON api.tasks_controls_v1 FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON api.tasks_controls_v1 TO authenticated, service_role;
COMMENT ON VIEW api.tasks_controls_v1 IS
 'Canonical task read projection with explicit caller scope; exact actor-visible route planned time, never SLA or arbitrary metadata IDs. No task mutation authority.';
COMMIT;
