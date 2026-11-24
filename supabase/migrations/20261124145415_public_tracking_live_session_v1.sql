BEGIN;

CREATE TABLE public.public_tracking_live_cells (
  client_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  route_run_id uuid NOT NULL REFERENCES public.route_runs(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  captured_at timestamptz NOT NULL,
  sampled_at timestamptz NOT NULL,
  bounds jsonb NOT NULL,
  PRIMARY KEY (client_id, shipment_id),
  FOREIGN KEY (shipment_id, client_id) REFERENCES public.shipments (id, client_id) ON DELETE CASCADE
);

CREATE INDEX idx_public_tracking_live_cells_run ON public.public_tracking_live_cells (route_run_id);
CREATE INDEX idx_public_tracking_live_cells_shipment ON public.public_tracking_live_cells (shipment_id, client_id);

ALTER TABLE public.public_tracking_live_cells ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.public_tracking_live_cells FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.public_tracking_live_cells TO service_role;
CREATE POLICY public_tracking_live_cells_service
  ON public.public_tracking_live_cells FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.table_contracts (
  table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes
)
VALUES (
  'public', 'public_tracking_live_cells', false, false, false,
  'Service-only tracking cell cache with explicit capture and sample timestamps.'
);

UPDATE public.schema_registry
SET schema = jsonb_set(schema, '{properties,live_delivery}', '{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "eta_enabled": {"type": "boolean"},
    "area_enabled": {"type": "boolean"},
    "partner_area_enabled": {"type": "boolean"},
    "minutes_per_stop": {"type": "integer", "minimum": 1, "maximum": 60},
    "max_stops_ahead": {"type": "integer", "minimum": 0, "maximum": 20},
    "grid_m": {"type": "integer", "minimum": 300, "maximum": 2000},
    "stale_after_seconds": {"type": "integer", "minimum": 60, "maximum": 300},
    "eta_window_minutes": {"type": "integer", "minimum": 1, "maximum": 60}
  }
}'::jsonb)
WHERE category = 'public_tracking_policy' AND version = 1;

CREATE FUNCTION public.public_tracking_live_payload_v1(p_session_id uuid, p_policy jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_session record;
  v_stop record;
  v_ping record;
  v_cell jsonb;
  v_stops_ahead integer;
  v_at_previous boolean;
  v_grid_m integer;
  v_lat_step numeric;
  v_lng_step numeric;
  v_south numeric;
  v_west numeric;
  v_eta_start timestamptz;
  v_eta_end timestamptz;
  v_status text;
  v_now timestamptz := workflow_now();
  v_stale_before timestamptz := v_now - make_interval(secs =>
    public.public_tracking_int_v1(p_policy, '{live_delivery,stale_after_seconds}', 300, 60, 300)
  );
BEGIN
  IF NOT public.public_tracking_bool_v1(p_policy, '{live_delivery,eta_enabled}', true) THEN
    RETURN NULL;
  END IF;

  SELECT ts.*, s.promised_window_start_at, s.promised_window_end_at
  INTO v_session
  FROM public.tracking_sessions ts
  JOIN public.shipments s ON (s.id, s.client_id, s.organization_id) =
    (ts.shipment_id, ts.client_id, ts.organization_id)
  WHERE ts.id = p_session_id AND ts.status = 'active'
    AND (ts.expires_at IS NULL OR ts.expires_at > v_now)
    AND s.status = 'out_for_delivery';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT rs.*, rr.driver_user_id, rr.started_at,
         COALESCE(assignment.is_partner, false) AS partner_run
  INTO v_stop
  FROM public.route_stops rs
  JOIN public.route_runs rr ON rr.id = rs.route_run_id AND rr.organization_id = rs.organization_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(public.lookup_value_meta_bool(
      'route_assignment_mode', rra.assignment_mode, 'is_partner', true
    ), true) AS is_partner
    FROM public.route_run_assignments rra
    WHERE rra.route_run_id = rr.id AND rra.organization_id = rr.organization_id
      AND rra.assignment_status IN ('assigned', 'acknowledged', 'accepted')
    ORDER BY rra.assignment_version DESC
    LIMIT 1
  ) assignment ON true
  WHERE (rs.shipment_id, rs.client_id, rs.organization_id) =
    (v_session.shipment_id, v_session.client_id, v_session.organization_id)
    AND rs.stop_kind = 'delivery'
    AND rs.metadata->>'shipment_action' IS NULL
    AND rr.status = 'in_progress' AND rr.started_at IS NOT NULL AND rr.ended_at IS NULL
  ORDER BY rs.created_at DESC, rs.id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  WITH open_stops AS (
    SELECT rs.sequence_order, t.status_reason
    FROM public.route_stops rs
    LEFT JOIN LATERAL (
      SELECT tasks.status, tasks.status_reason
      FROM public.tasks
      JOIN public.task_types tt ON tt.id = tasks.task_type_id
      WHERE tasks.organization_id = v_stop.organization_id
        AND tt.organization_id = v_stop.organization_id AND tt.key = 'route_stop_execute'
        AND tasks.resource_type = 'route_stop' AND tasks.resource_id = rs.id
      ORDER BY tasks.created_at DESC, tasks.id DESC
      LIMIT 1
    ) t ON true
    WHERE rs.route_run_id = v_stop.route_run_id AND rs.organization_id = v_stop.organization_id
      AND rs.sequence_order <= v_stop.sequence_order
      AND rs.metadata->>'shipment_action' IS NULL
      AND (t.status IS NULL OR t.status NOT IN ('completed', 'canceled'))
  )
  SELECT count(*) FILTER (WHERE sequence_order < v_stop.sequence_order),
         COALESCE(bool_or(status_reason = 'arrived') FILTER (WHERE sequence_order < v_stop.sequence_order), false)
  INTO v_stops_ahead, v_at_previous
  FROM open_stops
  HAVING bool_or(sequence_order = v_stop.sequence_order);

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT p.actor_user_id, p.captured_at,
         ST_Y(p.coordinates::geometry)::numeric AS latitude,
         ST_X(p.coordinates::geometry)::numeric AS longitude
  INTO v_ping
  FROM public.location_pings p
  WHERE p.organization_id = v_stop.organization_id AND p.route_run_id = v_stop.route_run_id
    AND p.actor_user_id = v_stop.driver_user_id
    AND p.captured_at >= greatest(v_stop.started_at, v_stale_before)
    AND p.captured_at <= v_now
  ORDER BY p.captured_at DESC, p.id DESC
  LIMIT 1;

  IF v_ping.captured_at IS NULL THEN
    v_eta_start := COALESCE(v_stop.planned_window_start_at,
      v_session.promised_window_start_at);
    v_eta_end := COALESCE(v_stop.planned_window_end_at,
      v_session.promised_window_end_at);
    IF v_eta_start IS NULL OR v_eta_end IS NULL OR v_eta_end < v_eta_start THEN
      RETURN NULL;
    END IF;
    v_status := 'paused';
  ELSE
    v_eta_start := date_trunc('minute', v_ping.captured_at) + make_interval(mins =>
      v_stops_ahead * public.public_tracking_int_v1(p_policy, '{live_delivery,minutes_per_stop}', 8, 1, 60)
    );
    v_eta_end := v_eta_start + make_interval(mins =>
      public.public_tracking_int_v1(p_policy, '{live_delivery,eta_window_minutes}', 15, 1, 60)
    );
    v_status := 'hidden';

    IF public.public_tracking_bool_v1(p_policy, '{live_delivery,area_enabled}', false)
       AND (NOT v_stop.partner_run
         OR public.public_tracking_bool_v1(p_policy, '{live_delivery,partner_area_enabled}', false))
       AND NOT v_at_previous THEN
      IF v_stops_ahead > public.public_tracking_int_v1(p_policy, '{live_delivery,max_stops_ahead}', 3, 0, 20) THEN
        v_status := 'too_far';
      ELSIF public.public_tracking_int_v1(p_policy, '{live_delivery,max_stops_ahead}', 3, 0, 20) > 0
            AND abs(v_ping.latitude) < 85 THEN
        v_grid_m := public.public_tracking_int_v1(p_policy, '{live_delivery,grid_m}', 500, 300, 2000);
        -- Use fixed latitude bands and integral thousandths of a degree.
        v_lat_step := ceil(v_grid_m / 110.0) / 1000;
        v_south := floor(v_ping.latitude / v_lat_step) * v_lat_step;
        v_lng_step := ceil(v_grid_m / (110 * cos(radians(greatest(abs(v_south), abs(v_south + v_lat_step))::float8)))) / 1000;
        v_west := floor(v_ping.longitude / v_lng_step) * v_lng_step;

        INSERT INTO public.public_tracking_live_cells AS cell
          (client_id, shipment_id, route_run_id, actor_user_id, captured_at, sampled_at, bounds)
        VALUES (
          v_stop.client_id, v_stop.shipment_id, v_stop.route_run_id, v_ping.actor_user_id,
          v_ping.captured_at, v_now,
          jsonb_build_object(
            'south', round(v_south, 3), 'west', round(v_west, 3),
            'north', round(v_south + v_lat_step, 3), 'east', round(v_west + v_lng_step, 3)
          )
        )
        ON CONFLICT (client_id, shipment_id) DO UPDATE
        SET route_run_id = EXCLUDED.route_run_id, actor_user_id = EXCLUDED.actor_user_id,
            captured_at = EXCLUDED.captured_at, sampled_at = EXCLUDED.sampled_at, bounds = EXCLUDED.bounds
        WHERE cell.sampled_at <= v_now - interval '60 seconds';

        SELECT cell.bounds INTO v_cell
        FROM public.public_tracking_live_cells cell
        WHERE (cell.client_id, cell.shipment_id) = (v_stop.client_id, v_stop.shipment_id)
          AND cell.route_run_id = v_stop.route_run_id AND cell.actor_user_id = v_stop.driver_user_id
          AND cell.captured_at >= v_stale_before;
        IF v_cell IS NOT NULL THEN
          v_status := 'live';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'area', v_cell, 'status', v_status,
    'eta_window_start_at', v_eta_start, 'eta_window_end_at', v_eta_end,
    'stops_ahead', v_stops_ahead,
    'updated_at', date_trunc('minute', COALESCE(v_ping.captured_at, v_stop.updated_at))
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.public_tracking_live_payload_v1(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_tracking_live_payload_v1(uuid, jsonb) TO service_role;

DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.public_tracking_session_v1(jsonb)'::regprocedure);
  v_return constant text := $anchor$  RETURN jsonb_build_object('ok', TRUE, 'tracking', v_payload);$anchor$;
BEGIN
  IF array_length(string_to_array(v_definition, v_return), 1) <> 2 THEN
    RAISE EXCEPTION 'public tracking session return contract changed';
  END IF;
  EXECUTE replace(v_definition, v_return, $replacement$
  v_payload := jsonb_set(v_payload, '{live_delivery}', COALESCE(
    public.public_tracking_live_payload_v1(v_session.id, v_policy), 'null'::jsonb
  ));
  RETURN jsonb_build_object('ok', TRUE, 'tracking', v_payload);
$replacement$);
END;
$migration$;

CREATE FUNCTION api.public_tracking_live_session_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$ SELECT public.public_tracking_session_v1(p_input) $function$;

REVOKE ALL ON FUNCTION api.public_tracking_live_session_v1(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.public_tracking_live_session_v1(jsonb) TO service_role;

COMMIT;
