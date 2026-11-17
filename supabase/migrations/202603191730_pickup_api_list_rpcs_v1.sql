-- Plan: B02 Pickup & first-mile handoff
-- Migration: pickup api list rpcs v1
-- Date: 2026-03-19
--
-- Purpose:
--   - Make pickup list RPCs the canonical scoped read contract for Console and
--     Portal without relying on raw server-side DB reads.
--   - Keep pickup request/wave/failure reads fail-closed for sender/client
--     scopes even when the underlying projections join tables that are not
--     directly readable through base-table RLS for those scopes.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191730_pickup_api_list_rpcs_v1'));
SET search_path TO api, public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

DROP FUNCTION IF EXISTS api.pickup_read_scope_v1();
CREATE FUNCTION api.pickup_read_scope_v1()
RETURNS TABLE (
  request_role TEXT,
  is_service_request BOOLEAN,
  is_platform BOOLEAN,
  scope_type TEXT,
  organization_id UUID,
  client_id UUID,
  sender_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  WITH request_context AS (
    SELECT COALESCE(
      NULLIF(auth.jwt() ->> 'role', ''),
      NULLIF(current_setting('request.jwt.claim.role', true), ''),
      NULLIF((NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), ''),
      'authenticated'
    ) AS request_role
  )
  SELECT
    request_context.request_role,
    request_context.request_role = 'service_role' AS is_service_request,
    public.is_platform_user() AS is_platform,
    public.current_user_scope_type() AS scope_type,
    public.current_user_org_id() AS organization_id,
    public.current_user_client_id() AS client_id,
    public.current_user_sender_id() AS sender_id
  FROM request_context;
$$;

DROP FUNCTION IF EXISTS api.pickup_requests_list_v1(UUID, UUID, TEXT, INT);
CREATE FUNCTION api.pickup_requests_list_v1(
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25
)
RETURNS TABLE (
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  shipment_id UUID,
  tracking_number TEXT,
  client_reference_number TEXT,
  carrier_reference_number TEXT,
  status TEXT,
  box_count INT,
  requested_window_start_at TIMESTAMPTZ,
  requested_window_end_at TIMESTAMPTZ,
  origin_address_id UUID,
  origin_line1 TEXT,
  origin_line2 TEXT,
  origin_city TEXT,
  origin_province TEXT,
  origin_country TEXT,
  origin_additional_directions TEXT,
  route_stop_id UUID,
  route_run_id UUID,
  sequence_order INT,
  route_run_status TEXT,
  planned_date DATE,
  planned_start_at TIMESTAMPTZ,
  planned_end_at TIMESTAMPTZ,
  driver_user_id UUID,
  vehicle_id UUID,
  pickup_assignment JSONB,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  failure_action_data JSONB,
  pickup_request JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  WITH scope_context AS (
    SELECT * FROM api.pickup_read_scope_v1()
  ),
  latest_pickup_stop AS (
    SELECT DISTINCT ON (rs.shipment_id, rs.client_id)
      rs.shipment_id,
      rs.client_id,
      rs.id AS route_stop_id,
      rs.route_run_id,
      rs.sequence_order,
      rr.status AS route_run_status,
      rr.planned_date,
      rr.planned_start_at,
      rr.planned_end_at,
      rr.driver_user_id,
      rr.vehicle_id,
      rr.metadata -> 'pickup_assignment' AS pickup_assignment
    FROM public.route_stops rs
    JOIN public.route_runs rr
      ON rr.id = rs.route_run_id
     AND rr.organization_id = rs.organization_id
    WHERE lower(rs.stop_kind) = 'pickup'
    ORDER BY rs.shipment_id, rs.client_id, COALESCE(rr.planned_start_at, rr.created_at) DESC, rs.sequence_order
  ),
  latest_exception AS (
    SELECT DISTINCT ON (sa.shipment_id)
      sa.shipment_id,
      sa.timestamp AS failed_at,
      COALESCE(sa.action_data #>> '{task_event_payload,status_reason}', sa.action_data->>'status_reason') AS failure_reason,
      sa.action_data AS failure_action_data
    FROM public.shipment_actions sa
    WHERE lower(COALESCE(sa.action_category, '')) = 'exception'
    ORDER BY sa.shipment_id, sa.timestamp DESC, sa.created_at DESC
  ),
  scoped_shipments AS (
    SELECT s.*
    FROM public.shipments s
    CROSS JOIN scope_context ctx
    WHERE lower(COALESCE(s.service_type, '')) = 'pickup'
      AND (
        ctx.is_service_request
        OR ctx.is_platform
        OR (
          ctx.scope_type = 'tenant'
          AND ctx.organization_id IS NOT NULL
          AND s.organization_id = ctx.organization_id
        )
        OR (
          ctx.scope_type = 'client'
          AND ctx.client_id IS NOT NULL
          AND s.client_id = ctx.client_id
        )
        OR (
          ctx.scope_type = 'sender'
          AND ctx.sender_id IS NOT NULL
          AND s.sender_id = ctx.sender_id
        )
      )
      AND (p_client_id IS NULL OR s.client_id = p_client_id)
      AND (p_sender_id IS NULL OR s.sender_id = p_sender_id)
      AND (
        NULLIF(btrim(COALESCE(p_status, '')), '') IS NULL
        OR lower(COALESCE(s.status, '')) = lower(p_status)
      )
  )
  SELECT
    ss.organization_id,
    ss.client_id,
    ss.sender_id,
    ss.id AS shipment_id,
    ss.tracking_number,
    ss.client_reference_number,
    ss.carrier_reference_number,
    ss.status,
    ss.box_count,
    ss.promised_window_start_at AS requested_window_start_at,
    ss.promised_window_end_at AS requested_window_end_at,
    ss.origin_address_id,
    a.normalized_line1 AS origin_line1,
    a.normalized_line2 AS origin_line2,
    a.city AS origin_city,
    a.province AS origin_province,
    a.country AS origin_country,
    a.additional_directions AS origin_additional_directions,
    lps.route_stop_id,
    lps.route_run_id,
    lps.sequence_order,
    lps.route_run_status,
    lps.planned_date,
    lps.planned_start_at,
    lps.planned_end_at,
    lps.driver_user_id,
    lps.vehicle_id,
    lps.pickup_assignment,
    le.failed_at,
    le.failure_reason,
    le.failure_action_data,
    ss.metadata -> 'pickup_request' AS pickup_request
  FROM scoped_shipments ss
  LEFT JOIN public.addresses a
    ON a.id = ss.origin_address_id
   AND a.client_id = ss.client_id
  LEFT JOIN latest_pickup_stop lps
    ON lps.shipment_id = ss.id
   AND lps.client_id = ss.client_id
  LEFT JOIN latest_exception le
    ON le.shipment_id = ss.id
  ORDER BY ss.promised_window_start_at DESC NULLS LAST, ss.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
$$;

DROP FUNCTION IF EXISTS api.pickup_waves_list_v1(UUID[], TEXT, INT);
CREATE FUNCTION api.pickup_waves_list_v1(
  p_route_run_ids UUID[] DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25
)
RETURNS TABLE (
  organization_id UUID,
  branch_id UUID,
  route_run_id UUID,
  status TEXT,
  planned_date DATE,
  planned_start_at TIMESTAMPTZ,
  planned_end_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  driver_user_id UUID,
  vehicle_id UUID,
  pickup_wave JSONB,
  pickup_assignment JSONB,
  pickup_stop_count BIGINT,
  total_box_count BIGINT,
  shipments JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  WITH scope_context AS (
    SELECT * FROM api.pickup_read_scope_v1()
  ),
  scoped_wave_rows AS (
    SELECT
      rr.organization_id,
      rr.branch_id,
      rr.id AS route_run_id,
      rr.status,
      rr.planned_date,
      rr.planned_start_at,
      rr.planned_end_at,
      rr.started_at,
      rr.ended_at,
      rr.driver_user_id,
      rr.vehicle_id,
      rr.metadata -> 'pickup_wave' AS pickup_wave,
      rr.metadata -> 'pickup_assignment' AS pickup_assignment,
      rs.sequence_order,
      s.id AS shipment_id,
      s.client_id,
      s.tracking_number,
      s.status AS shipment_status,
      s.box_count
    FROM public.route_runs rr
    JOIN public.route_stops rs
      ON rs.route_run_id = rr.id
     AND rs.organization_id = rr.organization_id
    JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    CROSS JOIN scope_context ctx
    WHERE lower(rs.stop_kind) = 'pickup'
      AND (
        ctx.is_service_request
        OR ctx.is_platform
        OR (
          ctx.scope_type = 'tenant'
          AND ctx.organization_id IS NOT NULL
          AND s.organization_id = ctx.organization_id
        )
        OR (
          ctx.scope_type = 'client'
          AND ctx.client_id IS NOT NULL
          AND s.client_id = ctx.client_id
        )
        OR (
          ctx.scope_type = 'sender'
          AND ctx.sender_id IS NOT NULL
          AND s.sender_id = ctx.sender_id
        )
      )
      AND (
        COALESCE(array_length(p_route_run_ids, 1), 0) = 0
        OR rr.id = ANY(p_route_run_ids)
      )
      AND (
        NULLIF(btrim(COALESCE(p_status, '')), '') IS NULL
        OR lower(COALESCE(rr.status, '')) = lower(p_status)
      )
  )
  SELECT
    swr.organization_id,
    swr.branch_id,
    swr.route_run_id,
    swr.status,
    swr.planned_date,
    swr.planned_start_at,
    swr.planned_end_at,
    swr.started_at,
    swr.ended_at,
    swr.driver_user_id,
    swr.vehicle_id,
    swr.pickup_wave,
    swr.pickup_assignment,
    COUNT(*)::bigint AS pickup_stop_count,
    COALESCE(SUM(swr.box_count), 0)::bigint AS total_box_count,
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', swr.shipment_id,
        'client_id', swr.client_id,
        'tracking_number', swr.tracking_number,
        'status', swr.shipment_status,
        'sequence_order', swr.sequence_order
      ))
      ORDER BY swr.sequence_order
    ) AS shipments
  FROM scoped_wave_rows swr
  GROUP BY
    swr.organization_id,
    swr.branch_id,
    swr.route_run_id,
    swr.status,
    swr.planned_date,
    swr.planned_start_at,
    swr.planned_end_at,
    swr.started_at,
    swr.ended_at,
    swr.driver_user_id,
    swr.vehicle_id,
    swr.pickup_wave,
    swr.pickup_assignment
  ORDER BY swr.planned_start_at DESC NULLS LAST, swr.route_run_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
$$;

DROP FUNCTION IF EXISTS api.pickup_failures_list_v1(UUID[], UUID, UUID, TEXT, INT);
CREATE FUNCTION api.pickup_failures_list_v1(
  p_shipment_ids UUID[] DEFAULT NULL,
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25
)
RETURNS TABLE (
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  shipment_id UUID,
  tracking_number TEXT,
  status TEXT,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  failure_action_data JSONB,
  followup_tasks JSONB,
  pickup_request JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  WITH scope_context AS (
    SELECT * FROM api.pickup_read_scope_v1()
  ),
  scoped_shipments AS (
    SELECT
      s.organization_id,
      s.client_id,
      s.sender_id,
      s.id AS shipment_id,
      s.tracking_number,
      s.status,
      s.metadata
    FROM public.shipments s
    CROSS JOIN scope_context ctx
    WHERE lower(COALESCE(s.service_type, '')) = 'pickup'
      AND (
        ctx.is_service_request
        OR ctx.is_platform
        OR (
          ctx.scope_type = 'tenant'
          AND ctx.organization_id IS NOT NULL
          AND s.organization_id = ctx.organization_id
        )
        OR (
          ctx.scope_type = 'client'
          AND ctx.client_id IS NOT NULL
          AND s.client_id = ctx.client_id
        )
        OR (
          ctx.scope_type = 'sender'
          AND ctx.sender_id IS NOT NULL
          AND s.sender_id = ctx.sender_id
        )
      )
      AND (
        COALESCE(array_length(p_shipment_ids, 1), 0) = 0
        OR s.id = ANY(p_shipment_ids)
      )
      AND (p_client_id IS NULL OR s.client_id = p_client_id)
      AND (p_sender_id IS NULL OR s.sender_id = p_sender_id)
      AND (
        NULLIF(btrim(COALESCE(p_status, '')), '') IS NULL
        OR lower(COALESCE(s.status, '')) = lower(p_status)
      )
  ),
  followup_tasks AS (
    SELECT
      t.organization_id,
      t.resource_id AS shipment_id,
      jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'task_id', t.id,
          'task_type_key', tt.key,
          'status', t.status,
          'queue_key', t.queue_key,
          'priority', t.priority,
          'created_at', t.created_at
        ))
        ORDER BY t.created_at DESC
      ) AS tasks
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
    JOIN scoped_shipments ss
      ON ss.shipment_id = t.resource_id
     AND ss.organization_id = t.organization_id
    WHERE lower(COALESCE(t.resource_type, '')) = 'shipment'
      AND lower(COALESCE(tt.key, '')) IN ('dispatch_reschedule_pickup', 'dispatch_pickup_escalation_review')
    GROUP BY t.organization_id, t.resource_id
  ),
  latest_exception AS (
    SELECT DISTINCT ON (sa.shipment_id)
      sa.shipment_id,
      sa.timestamp AS failed_at,
      COALESCE(sa.action_data #>> '{task_event_payload,status_reason}', sa.action_data->>'status_reason') AS failure_reason,
      sa.action_data AS failure_action_data
    FROM public.shipment_actions sa
    JOIN scoped_shipments ss
      ON ss.shipment_id = sa.shipment_id
    WHERE lower(COALESCE(sa.action_category, '')) = 'exception'
    ORDER BY sa.shipment_id, sa.timestamp DESC, sa.created_at DESC
  )
  SELECT
    ss.organization_id,
    ss.client_id,
    ss.sender_id,
    ss.shipment_id,
    ss.tracking_number,
    ss.status,
    le.failed_at,
    le.failure_reason,
    le.failure_action_data,
    ft.tasks AS followup_tasks,
    ss.metadata -> 'pickup_request' AS pickup_request
  FROM scoped_shipments ss
  LEFT JOIN latest_exception le
    ON le.shipment_id = ss.shipment_id
  LEFT JOIN followup_tasks ft
    ON ft.organization_id = ss.organization_id
   AND ft.shipment_id = ss.shipment_id
  WHERE lower(COALESCE(ss.status, '')) = 'pickup_failed'
     OR ft.tasks IS NOT NULL
  ORDER BY le.failed_at DESC NULLS LAST, ss.shipment_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
$$;

REVOKE ALL ON FUNCTION api.pickup_read_scope_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION api.pickup_requests_list_v1(UUID, UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.pickup_waves_list_v1(UUID[], TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.pickup_failures_list_v1(UUID[], UUID, UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION api.pickup_requests_list_v1(UUID, UUID, TEXT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.pickup_waves_list_v1(UUID[], TEXT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.pickup_failures_list_v1(UUID[], UUID, UUID, TEXT, INT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603191730_pickup_api_list_rpcs_v1'));
COMMIT;
