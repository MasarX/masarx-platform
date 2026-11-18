-- FieldOps Mobile V2 pickup same-context readback.
-- Keeps pickup handoff/failure writes on submit_fieldops_proof_v1 and exposes
-- the canonical route-stop, quantity, failure reason, task, workflow, and
-- shipment-action lineage through resolve_fieldops_pickups_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605271530_fieldops_mobile_v2_pickup_readback_bridge_v1'));
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

  RETURN QUERY
  SELECT
    ('pickup:' || rs.id::text)                                              AS task_id,
    'pickup'::text                                                          AS type,
    COALESCE(s.tracking_number, 'PU-' || substr(rs.id::text, 1, 6))         AS title,
    CONCAT_WS(' - ',
      NULLIF(s.service_level, ''),
      'box ' || pickup_projection.expected_qty::text,
      NULLIF(rs.metadata->>'area', '')
    )                                                                       AS sub,
    public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now)  AS urgency,
    CASE
      WHEN pickup_projection.pickup_status IN ('completed', 'failed') THEN 'Readback'
      WHEN rs.planned_window_start_at IS NOT NULL
       AND rs.planned_window_start_at <= v_now + INTERVAL '60 minutes' THEN 'Pick up'
      ELSE 'Open'
    END                                                                     AS cta,
    ('/mobile/pickup/' || rs.id::text)                                      AS route,
    rs.planned_window_start_at                                              AS eta_iso,
    public.fieldops_v2_priority_int(s.priority_score)                       AS priority,
    COALESCE(NULLIF(rs.metadata->>'area', ''), NULLIF(origin.district, ''), NULLIF(origin.city, '')) AS area,
    s.tracking_number                                                       AS code,
    'pickup'::text                                                          AS action,
    public.fieldops_v2_resolve_tone(
      public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now),
      public.fieldops_v2_priority_int(s.priority_score),
      rs.planned_window_start_at,
      v_now
    )                                                                       AS tone,
    jsonb_strip_nulls(jsonb_build_object(
      'route_stop_id', rs.id,
      'stop_kind', rs.stop_kind,
      'status', pickup_projection.pickup_status,
      'route_stop_status', pickup_projection.route_stop_status,
      'pickup_status', pickup_projection.pickup_status,
      'expected_qty', pickup_projection.expected_qty,
      'picked', pickup_projection.picked_qty,
      'failure_reason', pickup_projection.failure_reason,
      'failure_note', pickup_projection.failure_note,
      'route_stop_task_id', route_task.task_id,
      'task_event_id', latest_action.task_event_id,
      'workflow_run_id', latest_action.workflow_run_id,
      'shipment_action_id', latest_action.shipment_action_id,
      'route_run_id', rr.id,
      'route_run_status', rr.status,
      'shipment_id', rs.shipment_id,
      'client_id', rs.client_id,
      'sender_id', s.sender_id,
      'sequence_order', rs.sequence_order,
      'service_level', s.service_level,
      'box_count', s.box_count,
      'shipment_status', s.status,
      'service_type', s.service_type,
      'tracking_number', s.tracking_number,
      'merchant', COALESCE(NULLIF(sender.brand_name, ''), NULLIF(sender.name, ''), NULLIF(client.name, '')),
      'address', CONCAT_WS(', ',
        NULLIF(origin.normalized_line1, ''),
        NULLIF(origin.district, ''),
        NULLIF(origin.city, '')
      ),
      'window', CONCAT_WS(' - ',
        CASE WHEN s.promised_window_start_at IS NOT NULL THEN to_char(s.promised_window_start_at, 'HH24:MI') ELSE NULL END,
        CASE WHEN s.promised_window_end_at IS NOT NULL THEN to_char(s.promised_window_end_at, 'HH24:MI') ELSE NULL END
      ),
      'instructions', NULLIF(origin.additional_directions, '')
    ))                                                                      AS meta
  FROM public.route_runs rr
  JOIN public.route_stops rs
    ON rs.route_run_id = rr.id
   AND rs.organization_id = rr.organization_id
  LEFT JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.client_id = rs.client_id
  LEFT JOIN public.clients client
    ON client.id = rs.client_id
   AND client.organization_id = rr.organization_id
  LEFT JOIN public.senders sender
    ON sender.id = s.sender_id
   AND sender.client_id = rs.client_id
  LEFT JOIN public.addresses origin
    ON origin.id = s.origin_address_id
   AND origin.client_id = rs.client_id
  LEFT JOIN LATERAL (
    SELECT
      lower(COALESCE(NULLIF(btrim(rs.metadata->>'status'), ''), 'pending')) AS route_stop_status,
      lower(COALESCE(NULLIF(btrim(s.status), ''), 'pending')) AS shipment_status,
      GREATEST(COALESCE(s.box_count, 0), 0)::int AS expected_qty,
      NULLIF(btrim(COALESCE(
        rs.metadata #>> '{last_proof,evidence,confirmed_quantity}',
        rs.metadata #>> '{last_proof,evidence,pickup,confirmed_quantity}',
        rs.metadata #>> '{last_proof,evidence,picked}',
        ''
      )), '') AS confirmed_quantity_text,
      NULLIF(btrim(COALESCE(
        rs.metadata #>> '{last_proof,evidence,status_reason}',
        rs.metadata #>> '{last_proof,evidence,reason_code}',
        rs.metadata #>> '{last_proof,evidence,exception_reason}',
        rs.metadata #>> '{last_proof,evidence,pickup,failure_reason}',
        ''
      )), '') AS failure_reason,
      NULLIF(btrim(COALESCE(
        rs.metadata #>> '{last_proof,evidence,exception_notes}',
        rs.metadata #>> '{last_proof,evidence,pickup,failure_notes}',
        ''
      )), '') AS failure_note
  ) AS projection_seed ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      projection_seed.route_stop_status,
      CASE
        WHEN projection_seed.route_stop_status IN ('failed')
          OR projection_seed.shipment_status = 'pickup_failed' THEN 'failed'
        WHEN projection_seed.route_stop_status IN ('done', 'completed')
          OR projection_seed.shipment_status IN ('in_transit', 'picked_up') THEN 'completed'
        ELSE 'pending'
      END AS pickup_status,
      projection_seed.expected_qty,
      CASE
        WHEN projection_seed.route_stop_status IN ('done', 'completed')
          OR projection_seed.shipment_status IN ('in_transit', 'picked_up') THEN projection_seed.expected_qty
        WHEN COALESCE(projection_seed.confirmed_quantity_text, '') ~ '^[0-9]+$' THEN
          LEAST(projection_seed.expected_qty, projection_seed.confirmed_quantity_text::int)
        ELSE 0
      END AS picked_qty,
      projection_seed.failure_reason,
      projection_seed.failure_note
  ) AS pickup_projection ON TRUE
  LEFT JOIN LATERAL (
    SELECT t.id::text AS task_id
      FROM public.tasks t
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
       AND tt.organization_id = t.organization_id
     WHERE t.organization_id = rr.organization_id
       AND t.resource_type = 'route_stop'
       AND t.resource_id = rs.id
       AND tt.key = 'route_stop_execute'
     ORDER BY
       CASE WHEN lower(COALESCE(t.status, '')) IN ('completed', 'cancelled', 'canceled') THEN 1 ELSE 0 END,
       t.created_at DESC,
       t.id DESC
     LIMIT 1
  ) AS route_task ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      sa.id::text AS shipment_action_id,
      NULLIF(sa.action_data->>'task_event_id', '') AS task_event_id,
      NULLIF(sa.action_data->>'workflow_run_id', '') AS workflow_run_id
      FROM public.shipment_actions sa
     WHERE sa.organization_id = rr.organization_id
       AND sa.shipment_id = rs.shipment_id
       AND sa.action_data->>'route_stop_id' = rs.id::text
     ORDER BY sa.timestamp DESC, sa.created_at DESC, sa.id DESC
     LIMIT 1
  ) AS latest_action ON TRUE
  WHERE rr.organization_id = v_caller_org
    AND rs.stop_kind = 'pickup'
    AND (
      lower(COALESCE(rr.status, '')) NOT IN ('completed', 'cancelled', 'canceled', 'closed')
      OR (
        lower(COALESCE(rr.status, '')) = 'completed'
        AND pickup_projection.pickup_status IN ('completed', 'failed')
        AND COALESCE(rr.updated_at, rr.ended_at, rr.created_at) >= v_now - INTERVAL '12 hours'
      )
    )
    AND (
      v_active_role NOT IN ('driver', 'rider')
      OR rr.driver_user_id = v_user_id
    )
  ORDER BY
    CASE
      WHEN pickup_projection.pickup_status = 'pending'
       AND public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now) = 'now' THEN 0
      WHEN pickup_projection.pickup_status = 'pending'
       AND public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now) = 'today' THEN 1
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
  'Mobile V2 first-mile pickup aggregator with same-context handoff/failure readback: route-stop id, stop_kind, quantity, failure reason, task, workflow, and shipment-action lineage.';

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

SELECT pg_advisory_unlock(hashtext('202605271530_fieldops_mobile_v2_pickup_readback_bridge_v1'));
COMMIT;
