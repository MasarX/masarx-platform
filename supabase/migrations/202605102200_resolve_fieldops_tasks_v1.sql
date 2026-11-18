-- Migration: resolve_fieldops_tasks_v1 — server-side aggregator for the
--            Mobile V2 Tasks unified home.
-- Date: 2026-05-10
-- Spec: FieldOps V2 production-readiness. AGENTS.md Mobile Field Ops Policy
--       Contract: "Tasks unified home: /mobile/tasks is the post-login
--       default for every role ... Tasks is a server-aggregated view from
--       resolve_fieldops_tasks_v1(active_role, ctx) with optimistic outbox
--       overlay on the client. Offline mode reads from the same shape via
--       cached react-query data."
--
-- This RPC unions per-role task sources into one typed envelope so the
-- frontend renders a single list/board/map regardless of underlying domain
-- (deliveries, pickups, RTOs, sortation queues, supervisor approvals,
-- cash drops, EOR). Callers pass the active role + an optional context
-- JSONB; the function filters to the caller's organization, applies role-
-- specific source selection, and orders smartly by urgency × priority × eta.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605102200_resolve_fieldops_tasks_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Helper: classify a planned window into urgency bucket.
--    now    -- starts within the next 60 minutes (or already started)
--    today  -- starts later today
--    later  -- tomorrow or beyond / no window
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fieldops_v2_classify_urgency(
  p_window_start TIMESTAMPTZ,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_window_start IS NULL THEN 'later'
    WHEN p_window_start <= p_now + INTERVAL '60 minutes' THEN 'now'
    WHEN date_trunc('day', p_window_start) <= date_trunc('day', p_now) THEN 'today'
    ELSE 'later'
  END;
$$;

REVOKE ALL ON FUNCTION public.fieldops_v2_classify_urgency(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fieldops_v2_classify_urgency(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Helper: priority-score normalisation (shipments.priority_score is a
--    numeric; we map it to an integer ladder 0..100 for stable sorting and
--    UI badges. NULL collapses to 50 — neither low nor flagged urgent).
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fieldops_v2_priority_int(
  p_score NUMERIC
)
RETURNS INT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_score IS NULL THEN 50
    WHEN p_score < 0 THEN 0
    WHEN p_score > 100 THEN 100
    ELSE LEAST(100, GREATEST(0, ROUND(p_score)::INT))
  END;
$$;

REVOKE ALL ON FUNCTION public.fieldops_v2_priority_int(NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fieldops_v2_priority_int(NUMERIC) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 3) Helper: tone resolution from urgency + priority.
--    danger  -- SLA missed (window already past + still active)
--    warning -- SLA risk (now + high priority)
--    accent  -- current focus (now + medium priority)
--    neutral -- everything else
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fieldops_v2_resolve_tone(
  p_urgency TEXT,
  p_priority INT,
  p_window_start TIMESTAMPTZ,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_window_start IS NOT NULL AND p_window_start < p_now - INTERVAL '15 minutes'
      THEN 'danger'
    WHEN p_urgency = 'now' AND COALESCE(p_priority, 50) >= 75 THEN 'warning'
    WHEN p_urgency = 'now' THEN 'accent'
    WHEN p_urgency = 'today' THEN 'info'
    ELSE 'neutral'
  END;
$$;

REVOKE ALL ON FUNCTION public.fieldops_v2_resolve_tone(TEXT, INT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fieldops_v2_resolve_tone(TEXT, INT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) resolve_fieldops_tasks_v1 — main aggregator
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_fieldops_tasks_v1(
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
    RAISE EXCEPTION 'resolve_fieldops_tasks_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_caller_org := public.current_user_org_id();
  IF v_caller_org IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_tasks_v1: caller has no organization context'
      USING ERRCODE = '42501';
  END IF;

  -- Driver: route_stops on active route_runs assigned to the caller, joined
  -- to shipments for tracking_number / customer / priority. Status filter:
  -- only stops on route_runs that are not in a terminal state.
  IF v_active_role IN ('driver', 'rider') THEN
    RETURN QUERY
    SELECT
      ('stop:' || rs.id::text)                                   AS task_id,
      COALESCE(rs.stop_kind, 'delivery')                         AS type,
      COALESCE(s.tracking_number, 'STOP-' || substr(rs.id::text, 1, 6)) AS title,
      CONCAT_WS(
        ' · ',
        NULLIF(s.service_level, ''),
        CASE WHEN s.cod_amount IS NOT NULL AND s.cod_amount > 0
             THEN 'COD ' || s.cod_amount::text || ' ' || COALESCE(s.cod_currency, 'SAR')
             ELSE NULL END,
        NULLIF(rs.metadata->>'area', '')
      )                                                          AS sub,
      public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now) AS urgency,
      CASE
        WHEN rs.planned_window_start_at IS NOT NULL
         AND rs.planned_window_start_at <= v_now + INTERVAL '60 minutes' THEN 'Start'
        ELSE 'Open'
      END                                                        AS cta,
      ('/mobile/stop/' || rs.id::text)                           AS route,
      rs.planned_window_start_at                                 AS eta_iso,
      public.fieldops_v2_priority_int(s.priority_score)          AS priority,
      NULLIF(rs.metadata->>'area', '')                           AS area,
      s.tracking_number                                          AS code,
      lower(rs.stop_kind)                                        AS action,
      public.fieldops_v2_resolve_tone(
        public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now),
        public.fieldops_v2_priority_int(s.priority_score),
        rs.planned_window_start_at,
        v_now
      )                                                          AS tone,
      jsonb_strip_nulls(jsonb_build_object(
        'route_run_id', rr.id,
        'route_run_status', rr.status,
        'shipment_id', rs.shipment_id,
        'client_id', rs.client_id,
        'sequence_order', rs.sequence_order,
        'service_level', s.service_level,
        'cod_amount', s.cod_amount,
        'cod_currency', s.cod_currency,
        'box_count', s.box_count,
        'shipment_status', s.status
      ))                                                         AS meta
    FROM public.route_runs rr
    JOIN public.route_stops rs
      ON rs.route_run_id = rr.id
     AND rs.organization_id = rr.organization_id
    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    WHERE rr.organization_id = v_caller_org
      AND rr.driver_user_id = v_user_id
      AND rr.status NOT IN ('completed', 'cancelled', 'closed')
    ORDER BY
      CASE public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now)
        WHEN 'now'   THEN 0
        WHEN 'today' THEN 1
        ELSE 2
      END,
      public.fieldops_v2_priority_int(s.priority_score) DESC,
      rs.planned_window_start_at NULLS LAST,
      rs.sequence_order;

  -- Loader: warehouse manifest stops (route_runs not assigned to current
  -- driver but org-scoped, using stop_kind to filter pickup/load events).
  -- For now we mirror the driver query but without the driver_user_id
  -- constraint — extensible when warehouse manifest tables land.
  ELSIF v_active_role = 'loader' THEN
    RETURN QUERY
    SELECT
      ('stop:' || rs.id::text)                                   AS task_id,
      COALESCE(rs.stop_kind, 'pickup')                           AS type,
      COALESCE(s.tracking_number, 'STOP-' || substr(rs.id::text, 1, 6)) AS title,
      CONCAT_WS(' · ',
        NULLIF(s.service_level, ''),
        'box ' || s.box_count::text
      )                                                          AS sub,
      public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now) AS urgency,
      'Scan'                                                     AS cta,
      ('/mobile/loader-scan?stop=' || rs.id::text)               AS route,
      rs.planned_window_start_at                                 AS eta_iso,
      public.fieldops_v2_priority_int(s.priority_score)          AS priority,
      NULLIF(rs.metadata->>'area', '')                           AS area,
      s.tracking_number                                          AS code,
      'load_scan'                                                AS action,
      public.fieldops_v2_resolve_tone(
        public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now),
        public.fieldops_v2_priority_int(s.priority_score),
        rs.planned_window_start_at,
        v_now
      )                                                          AS tone,
      jsonb_build_object(
        'route_run_id', rr.id,
        'shipment_id', rs.shipment_id,
        'client_id', rs.client_id,
        'box_count', s.box_count,
        'shipment_status', s.status
      )                                                          AS meta
    FROM public.route_runs rr
    JOIN public.route_stops rs
      ON rs.route_run_id = rr.id
     AND rs.organization_id = rr.organization_id
    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    WHERE rr.organization_id = v_caller_org
      AND rr.status IN ('planned', 'loading', 'in_progress', 'started')
      AND rs.stop_kind IN ('pickup', 'load', 'transfer')
    ORDER BY
      CASE public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now)
        WHEN 'now'   THEN 0
        WHEN 'today' THEN 1
        ELSE 2
      END,
      public.fieldops_v2_priority_int(s.priority_score) DESC,
      rs.sequence_order;

  -- Supervisor: hub-pickup desk + hold queue + cash-drop variance + RTO desk.
  -- Until those domain tables ship we surface route_runs awaiting a
  -- supervisor decision (status = 'pending_review') so the supervisor inbox
  -- is non-empty as soon as workflows route runs there.
  ELSIF v_active_role = 'supervisor' THEN
    RETURN QUERY
    SELECT
      ('run:' || rr.id::text)                                    AS task_id,
      'route_review'                                             AS type,
      COALESCE('Run ' || substr(rr.id::text, 1, 8), 'Run')       AS title,
      CONCAT_WS(' · ',
        rr.status,
        rr.planned_date::text
      )                                                          AS sub,
      public.fieldops_v2_classify_urgency(rr.planned_start_at, v_now) AS urgency,
      'Review'                                                   AS cta,
      ('/mobile/supervisor-today?run=' || rr.id::text)           AS route,
      rr.planned_start_at                                        AS eta_iso,
      75                                                         AS priority,
      NULLIF(rr.metadata->>'area', '')                           AS area,
      ('RUN-' || substr(rr.id::text, 1, 6))                      AS code,
      'review'                                                   AS action,
      'warning'                                                  AS tone,
      jsonb_build_object(
        'route_run_id', rr.id,
        'route_run_status', rr.status,
        'driver_user_id', rr.driver_user_id,
        'branch_id', rr.branch_id
      )                                                          AS meta
    FROM public.route_runs rr
    WHERE rr.organization_id = v_caller_org
      AND rr.status IN ('pending_review', 'requires_review', 'awaiting_approval')
    ORDER BY
      CASE public.fieldops_v2_classify_urgency(rr.planned_start_at, v_now)
        WHEN 'now'   THEN 0
        WHEN 'today' THEN 1
        ELSE 2
      END,
      rr.planned_start_at NULLS LAST;

  ELSE
    -- Unknown role — return nothing rather than raise. Frontend renders
    -- empty state.
    RETURN;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) IS
  'Mobile V2 Tasks unified home aggregator. Returns a typed envelope of tasks for the caller. Driver/Rider see route_stops on their assigned active runs; Loader sees pickup/load/transfer stops org-wide; Supervisor sees route_runs awaiting review. Sorted by urgency x priority x eta.';

-------------------------------------------------------------------------------
-- 5) api wrapper for FE contract surface
-------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_tasks_v1(
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
  SELECT * FROM public.resolve_fieldops_tasks_v1(p_active_role, p_context);
$function$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_tasks_v1(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605102200_resolve_fieldops_tasks_v1'));
COMMIT;
