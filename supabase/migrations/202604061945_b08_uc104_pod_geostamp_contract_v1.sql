-- Plan: Batch 8 proof-of-delivery geostamp contract / Step: E04
-- Migration: POD geolocation + captured-at normalization and UI visibility
-- Purpose:
-- - Normalize POD captured_at/geostamp at the canonical delivery task_event write path.
-- - Persist proof anchors into delivery_completion so shipment/route projections stay canonical.
-- - Expose POD capture time/location through shipment_actions UI reads for Console/Portal/Tracking.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061945_b08_uc104_pod_geostamp_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Canonical task_event normalization for delivery POD capture anchors
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.normalize_delivery_pod_task_event_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_payload JSONB := COALESCE(NEW.payload, '{}'::jsonb);
  v_resource_type TEXT := NULL;
  v_resource_id UUID := NULL;
  v_task_org UUID := NULL;
  v_stop_kind TEXT := NULL;
  v_pod_payload JSONB := '{}'::jsonb;
  v_geostamp JSONB := NULL;
  v_pod_captured_at TIMESTAMPTZ := NULL;
  v_latitude NUMERIC := NULL;
  v_longitude NUMERIC := NULL;
  v_accuracy_m NUMERIC := NULL;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF lower(COALESCE(NEW.to_status, '')) <> 'completed' THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  SELECT
    t.resource_type,
    t.resource_id,
    t.organization_id
    INTO v_resource_type, v_resource_id, v_task_org
  FROM public.tasks t
  WHERE t.id = NEW.task_id
  LIMIT 1;

  IF v_resource_type IS DISTINCT FROM 'route_stop' OR v_resource_id IS NULL OR v_task_org IS NULL THEN
    NEW.payload := v_payload;
    RETURN NEW;
  END IF;

  SELECT lower(rs.stop_kind)
    INTO v_stop_kind
  FROM public.route_stops rs
  WHERE rs.id = v_resource_id
    AND rs.organization_id = v_task_org
  LIMIT 1;

  IF v_stop_kind IS DISTINCT FROM 'delivery' THEN
    NEW.payload := v_payload;
    RETURN NEW;
  END IF;

  IF jsonb_typeof(v_payload->'pod') = 'object' THEN
    v_pod_payload := v_payload->'pod';
  END IF;

  BEGIN
    v_pod_captured_at := NULLIF(
      btrim(
        COALESCE(
          v_payload->>'captured_at',
          v_pod_payload->>'captured_at',
          ''
        )
      ),
      ''
    )::timestamptz;
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'delivery pod captured_at must be a valid timestamptz'
        USING ERRCODE = '23514';
  END;

  v_pod_captured_at := COALESCE(v_pod_captured_at, NEW.created_at, now());
  v_payload := jsonb_set(v_payload, '{captured_at}', to_jsonb(v_pod_captured_at), TRUE);
  v_payload := jsonb_set(v_payload, '{pod,captured_at}', to_jsonb(v_pod_captured_at), TRUE);

  v_geostamp := CASE
    WHEN jsonb_typeof(v_payload->'geostamp') = 'object' THEN v_payload->'geostamp'
    WHEN jsonb_typeof(v_pod_payload->'geostamp') = 'object' THEN v_pod_payload->'geostamp'
    ELSE NULL
  END;

  IF v_geostamp IS NOT NULL THEN
    BEGIN
      v_latitude := NULLIF(
        btrim(COALESCE(v_geostamp->>'latitude', v_geostamp->>'lat', '')),
        ''
      )::numeric;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'delivery pod geostamp.latitude must be numeric'
          USING ERRCODE = '23514';
    END;

    BEGIN
      v_longitude := NULLIF(
        btrim(COALESCE(v_geostamp->>'longitude', v_geostamp->>'lng', '')),
        ''
      )::numeric;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'delivery pod geostamp.longitude must be numeric'
          USING ERRCODE = '23514';
    END;

    BEGIN
      v_accuracy_m := NULLIF(
        btrim(COALESCE(v_geostamp->>'accuracy_m', '')),
        ''
      )::numeric;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'delivery pod geostamp.accuracy_m must be numeric'
          USING ERRCODE = '23514';
    END;

    IF v_latitude IS NULL OR v_longitude IS NULL THEN
      RAISE EXCEPTION 'delivery pod geostamp requires latitude and longitude'
        USING ERRCODE = '23514';
    END IF;

    IF v_latitude < -90 OR v_latitude > 90 THEN
      RAISE EXCEPTION 'delivery pod geostamp.latitude out of range'
        USING ERRCODE = '23514';
    END IF;

    IF v_longitude < -180 OR v_longitude > 180 THEN
      RAISE EXCEPTION 'delivery pod geostamp.longitude out of range'
        USING ERRCODE = '23514';
    END IF;

    IF v_accuracy_m IS NOT NULL AND v_accuracy_m < 0 THEN
      RAISE EXCEPTION 'delivery pod geostamp.accuracy_m must be non-negative'
        USING ERRCODE = '23514';
    END IF;

    v_geostamp := jsonb_strip_nulls(jsonb_build_object(
      'latitude', v_latitude,
      'longitude', v_longitude,
      'accuracy_m', v_accuracy_m
    ));

    v_payload := jsonb_set(v_payload, '{geostamp}', v_geostamp, TRUE);
    v_payload := jsonb_set(v_payload, '{pod,geostamp}', v_geostamp, TRUE);
  END IF;

  NEW.payload := v_payload;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.normalize_delivery_pod_task_event_v1()
  IS 'Before-insert task_events guard for delivery completions: normalize POD captured_at/geostamp and fail closed on invalid coordinates.';

DROP TRIGGER IF EXISTS trg_task_events_delivery_pod_normalize ON public.task_events;
CREATE TRIGGER trg_task_events_delivery_pod_normalize
  BEFORE INSERT ON public.task_events
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_delivery_pod_task_event_v1();

-------------------------------------------------------------------------------
-- 2) POD capture anchor projections on shipment_actions
-------------------------------------------------------------------------------

ALTER TABLE public.shipment_actions
  ADD COLUMN IF NOT EXISTS pod_captured_at TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(COALESCE(action_data #>> ARRAY['delivery_completion', 'captured_at'], '')),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS pod_geostamp_latitude NUMERIC
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(COALESCE(action_data #>> ARRAY['delivery_completion', 'geostamp', 'latitude'], '')),
        ''
      )::numeric
    ) STORED,
  ADD COLUMN IF NOT EXISTS pod_geostamp_longitude NUMERIC
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(COALESCE(action_data #>> ARRAY['delivery_completion', 'geostamp', 'longitude'], '')),
        ''
      )::numeric
    ) STORED,
  ADD COLUMN IF NOT EXISTS pod_geostamp_accuracy_m NUMERIC
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(COALESCE(action_data #>> ARRAY['delivery_completion', 'geostamp', 'accuracy_m'], '')),
        ''
      )::numeric
    ) STORED;

COMMENT ON COLUMN public.shipment_actions.pod_captured_at IS
  'Generated proof-of-delivery capture timestamp derived from canonical action_data.delivery_completion.';
COMMENT ON COLUMN public.shipment_actions.pod_geostamp_latitude IS
  'Generated proof-of-delivery geostamp latitude derived from canonical action_data.delivery_completion.';
COMMENT ON COLUMN public.shipment_actions.pod_geostamp_longitude IS
  'Generated proof-of-delivery geostamp longitude derived from canonical action_data.delivery_completion.';
COMMENT ON COLUMN public.shipment_actions.pod_geostamp_accuracy_m IS
  'Generated proof-of-delivery geostamp accuracy in meters derived from canonical action_data.delivery_completion.';

CREATE INDEX IF NOT EXISTS idx_shipment_actions_pod_captured_at_not_null
  ON public.shipment_actions (pod_captured_at DESC)
  WHERE pod_captured_at IS NOT NULL;

-------------------------------------------------------------------------------
-- 3) Canonical route_stop finalize wrapper now persists POD capture anchors
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v7(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
  v_task_event_payload JSONB := COALESCE(v_payload->'task_event_payload', '{}'::jsonb);

  v_route_stop_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_task_event_created_at TIMESTAMPTZ := NULL;
  v_completion_at TIMESTAMPTZ := NULL;
  v_pod_captured_at TIMESTAMPTZ := NULL;
  v_pod_geostamp JSONB := NULL;
  v_pod_latitude NUMERIC := NULL;
  v_pod_longitude NUMERIC := NULL;
  v_pod_accuracy_m NUMERIC := NULL;

  v_stop RECORD;
  v_ship RECORD;
  v_current_ship_status TEXT := NULL;
  v_exception_meta JSONB := NULL;
  v_completion_kind TEXT := NULL;
  v_completion_reason TEXT := lower(NULLIF(btrim(COALESCE(v_task_event_payload->>'status_reason', '')), ''));

  v_box_source JSONB := '[]'::jsonb;
  v_delivered_box_ids UUID[] := NULL;
  v_box_id_text TEXT;
  v_uuid UUID;
  v_total_box_count INT := 0;
  v_delivered_box_count INT := 0;
  v_remaining_box_count INT := 0;

  v_service_anchor_at TIMESTAMPTZ := NULL;
  v_stop_anchor_at TIMESTAMPTZ := NULL;
  v_service_time_seconds INT := NULL;
  v_stop_duration_seconds INT := NULL;

  v_shipment_action_id UUID := NULL;
  v_action_data JSONB := '{}'::jsonb;
  v_delivery_completion JSONB := '{}'::jsonb;
  v_route_closeout JSONB := '{}'::jsonb;
  v_completed_stop_count INT := 0;
  v_total_stop_count INT := 0;

  v_resp public.workflow_handler_response;
  v_shipment_box_ids UUID[] := NULL;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  IF jsonb_typeof(v_payload) <> 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  BEGIN
    v_route_stop_id := NULLIF(v_ctx->>'resource_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_stop_id := NULL;
  END;
  BEGIN
    v_task_event_id := NULLIF(v_task_event_payload->>'task_event_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_task_event_id := NULL;
  END;
  BEGIN
    v_task_event_created_at := NULLIF(v_task_event_payload->>'task_event_created_at', '')::timestamptz;
  EXCEPTION
    WHEN others THEN
      v_task_event_created_at := NULL;
  END;
  BEGIN
    v_pod_captured_at := NULLIF(
      btrim(
        COALESCE(
          v_task_event_payload->>'captured_at',
          v_task_event_payload #>> '{pod,captured_at}',
          ''
        )
      ),
      ''
    )::timestamptz;
  EXCEPTION
    WHEN others THEN
      v_pod_captured_at := NULL;
  END;

  v_completion_at := COALESCE(v_task_event_created_at, now());
  v_pod_captured_at := COALESCE(v_pod_captured_at, v_task_event_created_at, v_completion_at);

  IF jsonb_typeof(v_task_event_payload->'geostamp') = 'object' THEN
    v_pod_geostamp := v_task_event_payload->'geostamp';
  ELSIF jsonb_typeof(v_task_event_payload #> '{pod,geostamp}') = 'object' THEN
    v_pod_geostamp := v_task_event_payload #> '{pod,geostamp}';
  END IF;

  BEGIN
    v_pod_latitude := NULLIF(
      btrim(COALESCE(v_pod_geostamp->>'latitude', v_pod_geostamp->>'lat', '')),
      ''
    )::numeric;
  EXCEPTION
    WHEN others THEN
      v_pod_latitude := NULL;
  END;
  BEGIN
    v_pod_longitude := NULLIF(
      btrim(COALESCE(v_pod_geostamp->>'longitude', v_pod_geostamp->>'lng', '')),
      ''
    )::numeric;
  EXCEPTION
    WHEN others THEN
      v_pod_longitude := NULL;
  END;
  BEGIN
    v_pod_accuracy_m := NULLIF(
      btrim(COALESCE(v_pod_geostamp->>'accuracy_m', '')),
      ''
    )::numeric;
  EXCEPTION
    WHEN others THEN
      v_pod_accuracy_m := NULL;
  END;

  IF v_pod_latitude IS NOT NULL AND v_pod_longitude IS NOT NULL THEN
    v_pod_geostamp := jsonb_strip_nulls(jsonb_build_object(
      'latitude', v_pod_latitude,
      'longitude', v_pod_longitude,
      'accuracy_m', v_pod_accuracy_m
    ));
  ELSE
    v_pod_geostamp := NULL;
  END IF;

  IF v_route_stop_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: missing resource_id(route_stop_id) (workflow_run_id=% step_id=%)', p_run.id, p_step.id
      USING ERRCODE = '23514';
  END IF;

  SELECT
    rs.id AS route_stop_id,
    rs.organization_id,
    rs.client_id,
    rs.shipment_id,
    rs.stop_kind,
    rs.route_run_id,
    rs.created_at AS route_stop_created_at,
    rs.metadata AS route_stop_metadata,
    rr.branch_id,
    rr.created_at AS route_run_created_at,
    rr.started_at AS route_run_started_at,
    rr.ended_at AS route_run_ended_at,
    rr.status AS route_run_status,
    rr.metadata AS route_run_metadata
  INTO v_stop
  FROM public.route_stops rs
  JOIN public.route_runs rr ON rr.id = rs.route_run_id
  WHERE rs.id = v_route_stop_id
  LIMIT 1;

  IF v_stop.shipment_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: route_stop % not found', v_route_stop_id USING ERRCODE = '23503';
  END IF;

  SELECT
    s.id AS shipment_id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.status AS shipment_status,
    s.box_count,
    s.metadata AS shipment_metadata
  INTO v_ship
  FROM public.shipments s
  WHERE s.id = v_stop.shipment_id
    AND s.client_id = v_stop.client_id
  LIMIT 1;

  IF v_ship.shipment_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: shipment % not found for client %', v_stop.shipment_id, v_stop.client_id
      USING ERRCODE = '23503';
  END IF;

  v_service_anchor_at := COALESCE(v_stop.route_run_started_at, v_stop.route_run_created_at, v_stop.route_stop_created_at, v_completion_at);
  v_stop_anchor_at := COALESCE(v_stop.route_stop_created_at, v_stop.route_run_created_at, v_completion_at);
  v_service_time_seconds := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_completion_at - v_service_anchor_at))))::INT;
  v_stop_duration_seconds := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_completion_at - v_stop_anchor_at))))::INT;

  v_completion_kind := lower(NULLIF(btrim(COALESCE(
    NULLIF(v_task_event_payload->'delivery_completion'->>'completion_kind', ''),
    NULLIF(v_task_event_payload->'pod'->>'completion_kind', ''),
    NULLIF(v_task_event_payload->>'completion_kind', ''),
    NULLIF(
      CASE
        WHEN v_completion_reason = 'partial_delivery' THEN 'partial'
        ELSE ''
      END,
      ''
    )
  )), ''));

  IF v_completion_kind IS NULL THEN
    SELECT lv.metadata
      INTO v_exception_meta
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'dispatch_exception_reason'
       AND lv.value = v_completion_reason
       AND lv.status = 'active'
     LIMIT 1;

    IF jsonb_typeof(v_exception_meta) <> 'object' THEN
      v_exception_meta := NULL;
    END IF;

    v_completion_kind := lower(NULLIF(btrim(COALESCE(v_exception_meta->>'delivery_progress_kind', '')), ''));
  END IF;

  v_resp := workflow_handlers.execute_route_stop_finalize_v5(p_step, p_run, p_operation_result);
  IF COALESCE(v_resp.status, '') <> 'completed' THEN
    RETURN v_resp;
  END IF;

  SELECT s.status
    INTO v_current_ship_status
    FROM public.shipments s
   WHERE s.id = v_ship.shipment_id
     AND s.client_id = v_ship.client_id
   LIMIT 1;

  IF v_current_ship_status = 'delivered' THEN
    v_completion_kind := COALESCE(v_completion_kind, 'full');
  ELSIF v_completion_kind IS DISTINCT FROM 'partial' THEN
    RETURN v_resp;
  END IF;

  v_box_source := COALESCE(
    v_task_event_payload->'delivered_box_ids',
    v_task_event_payload->'box_ids',
    v_task_event_payload->'pod'->'delivered_box_ids',
    v_task_event_payload->'pod'->'box_ids',
    '[]'::jsonb
  );

  IF jsonb_typeof(v_box_source) <> 'array' THEN
    v_box_source := '[]'::jsonb;
  END IF;

  PERFORM 1
    FROM public.ensure_shipment_boxes(v_ship.shipment_id, COALESCE(NULLIF(v_ship.box_count, 0), 1));

  SELECT array_agg(sb.id ORDER BY sb.box_number)
    INTO v_shipment_box_ids
    FROM public.shipment_boxes sb
   WHERE sb.shipment_id = v_ship.shipment_id;

  v_total_box_count := COALESCE(array_length(v_shipment_box_ids, 1), 0);

  v_delivered_box_ids := ARRAY[]::uuid[];
  FOR v_box_id_text IN
    SELECT value
      FROM jsonb_array_elements_text(v_box_source) AS box_ids(value)
  LOOP
    BEGIN
      v_uuid := NULLIF(btrim(COALESCE(v_box_id_text, '')), '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_uuid := NULL;
    END;

    IF v_uuid IS NOT NULL THEN
      v_delivered_box_ids := array_append(v_delivered_box_ids, v_uuid);
    END IF;
  END LOOP;

  IF array_length(v_delivered_box_ids, 1) IS NOT NULL THEN
    SELECT array_agg(DISTINCT x)
      INTO v_delivered_box_ids
      FROM unnest(v_delivered_box_ids) AS x;
  ELSE
    v_delivered_box_ids := NULL;
  END IF;

  IF v_completion_kind = 'partial' THEN
    IF array_length(v_delivered_box_ids, 1) IS NULL THEN
      RAISE EXCEPTION 'route_stop_finalize: partial_delivery requires delivered_box_ids' USING ERRCODE = '23514';
    END IF;

    v_delivered_box_count := array_length(v_delivered_box_ids, 1);
    IF v_total_box_count < 2 OR v_delivered_box_count >= v_total_box_count THEN
      RAISE EXCEPTION 'route_stop_finalize: partial_delivery requires a strict subset of shipment boxes (shipment box_count=% delivered=%)', v_total_box_count, v_delivered_box_count
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF array_length(v_delivered_box_ids, 1) IS NULL THEN
      v_delivered_box_ids := v_shipment_box_ids;
    END IF;

    v_delivered_box_count := array_length(v_delivered_box_ids, 1);
    IF v_delivered_box_count IS NULL THEN
      v_delivered_box_ids := v_shipment_box_ids;
      v_delivered_box_count := array_length(v_delivered_box_ids, 1);
    END IF;

    IF v_delivered_box_count < v_total_box_count THEN
      RAISE EXCEPTION 'route_stop_finalize: partial_delivery required for partial box completion (shipment box_count=% delivered=%)', v_total_box_count, v_delivered_box_count
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF array_length(v_delivered_box_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: no delivered_box_ids resolved' USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*)::INT
    INTO v_delivered_box_count
    FROM public.shipment_boxes sb
   WHERE sb.shipment_id = v_ship.shipment_id
     AND sb.id = ANY (v_delivered_box_ids);

  IF v_delivered_box_count <> array_length(v_delivered_box_ids, 1) THEN
    RAISE EXCEPTION 'route_stop_finalize: delivered_box_ids must belong to shipment %', v_ship.shipment_id
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.shipment_boxes sb
     SET status = 'delivered',
         delivered_at = COALESCE(sb.delivered_at, v_completion_at)
   WHERE sb.shipment_id = v_ship.shipment_id
     AND sb.id = ANY (v_delivered_box_ids);

  v_remaining_box_count := GREATEST(v_total_box_count - array_length(v_delivered_box_ids, 1), 0);

  v_delivery_completion := jsonb_strip_nulls(jsonb_build_object(
    'completion_kind', v_completion_kind,
    'completed_at', v_completion_at,
    'captured_at', v_pod_captured_at,
    'geostamp', v_pod_geostamp,
    'delivered_at', CASE WHEN v_current_ship_status = 'delivered' THEN v_completion_at ELSE NULL END,
    'route_run_id', v_stop.route_run_id,
    'route_stop_id', v_route_stop_id,
    'shipment_id', v_ship.shipment_id,
    'box_count', v_total_box_count,
    'delivered_box_count', array_length(v_delivered_box_ids, 1),
    'remaining_box_count', v_remaining_box_count,
    'delivered_box_ids', to_jsonb(v_delivered_box_ids),
    'service_time_seconds', v_service_time_seconds,
    'stop_duration_seconds', v_stop_duration_seconds,
    'shipment_status', v_current_ship_status,
    'status_reason', v_completion_reason
  ));

  SELECT sa.id
    INTO v_shipment_action_id
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_ship.shipment_id
     AND sa.organization_id = v_ship.organization_id
     AND sa.client_id = v_ship.client_id
     AND (
       (v_task_event_id IS NOT NULL AND (sa.action_data->>'task_event_id') = v_task_event_id::text)
       OR (sa.action_data->>'route_stop_id') = v_route_stop_id::text
     )
   ORDER BY
     CASE
       WHEN v_task_event_id IS NOT NULL AND (sa.action_data->>'task_event_id') = v_task_event_id::text THEN 0
       ELSE 1
     END,
     sa.timestamp DESC,
     sa.created_at DESC
   LIMIT 1;

  IF v_shipment_action_id IS NOT NULL THEN
    UPDATE public.shipment_actions sa
       SET action_data = jsonb_set(
             COALESCE(sa.action_data, '{}'::jsonb),
             '{delivery_completion}',
             v_delivery_completion,
             TRUE
           )
     WHERE sa.id = v_shipment_action_id;

    SELECT sa.action_data
      INTO v_action_data
      FROM public.shipment_actions sa
     WHERE sa.id = v_shipment_action_id
     LIMIT 1;
  END IF;

  UPDATE public.shipments s
     SET delivered_at = CASE WHEN v_current_ship_status = 'delivered' THEN COALESCE(s.delivered_at, v_completion_at) ELSE s.delivered_at END,
         metadata = jsonb_set(
           COALESCE(s.metadata, '{}'::jsonb),
           '{delivery_completion}',
           v_delivery_completion,
           TRUE
         ),
         updated_at = now()
   WHERE s.id = v_ship.shipment_id
     AND s.client_id = v_ship.client_id;

  UPDATE public.route_stops rs
     SET metadata = jsonb_set(
           COALESCE(rs.metadata, '{}'::jsonb),
           '{delivery_completion}',
           v_delivery_completion,
           TRUE
         ),
         updated_at = now()
   WHERE rs.id = v_route_stop_id;

  SELECT COUNT(*)::INT
    INTO v_total_stop_count
    FROM public.route_stops rs
   WHERE rs.route_run_id = v_stop.route_run_id;

  SELECT COUNT(DISTINCT (sa.action_data->>'route_stop_id'))::INT
    INTO v_completed_stop_count
    FROM public.shipment_actions sa
   WHERE sa.organization_id = v_ship.organization_id
     AND sa.client_id = v_ship.client_id
     AND (sa.action_data->>'route_run_id') = v_stop.route_run_id::text;

  v_remaining_box_count := GREATEST(v_total_box_count - array_length(v_delivered_box_ids, 1), 0);

  IF v_completed_stop_count >= v_total_stop_count THEN
    v_route_closeout := jsonb_strip_nulls(jsonb_build_object(
      'completed_at', v_completion_at,
      'completed_stop_count', v_completed_stop_count,
      'remaining_stop_count', GREATEST(v_total_stop_count - v_completed_stop_count, 0),
      'total_stop_count', v_total_stop_count,
      'released_capacity', TRUE,
      'route_run_status', 'completed'
    ));

    UPDATE public.route_runs rr
       SET status = 'completed',
           ended_at = COALESCE(rr.ended_at, v_completion_at),
           metadata = jsonb_set(
             COALESCE(rr.metadata, '{}'::jsonb),
             '{route_closeout}',
             v_route_closeout,
             TRUE
           ),
           updated_at = now()
     WHERE rr.id = v_stop.route_run_id;
  END IF;

  v_resp.operation_result := jsonb_strip_nulls(
    COALESCE(v_resp.operation_result, '{}'::jsonb)
    || jsonb_build_object(
      'delivery_completion', v_delivery_completion,
      'route_closeout', CASE WHEN v_route_closeout = '{}'::jsonb THEN NULL ELSE v_route_closeout END
    )
  );

  RETURN v_resp;
END;
$function$;

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'route_stop_finalize',
  'workflow_handlers',
  'execute_route_stop_finalize_v7',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v7',
  TRUE,
  'Finalize a dispatch route_stop execution through v5 while persisting delivery closeout projections for shipment delivered_at, box-level completion, POD captured_at/geostamp, and route_run closeout.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'dispatch_route_stop_finalize_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.workflow_template_steps
     SET handler_version = 'v7',
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'route_stop_finalize';
END;
$do$;

-------------------------------------------------------------------------------
-- 4) UI read registry: expose POD proof anchors on shipment_actions
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_select JSONB := '[]'::jsonb;
  v_columns JSONB := '[]'::jsonb;
  v_existing_column JSONB;
  v_new_column JSONB;
  v_column_def JSONB;
  v_new_select_key TEXT;
  v_found BOOLEAN := FALSE;
  v_column_defs JSONB := jsonb_build_array(
    jsonb_build_object('key', 'handover_mode', 'label', 'Handover mode', 'detail_section', 'Delivery handover'),
    jsonb_build_object('key', 'recipient_name', 'label', 'Recipient', 'detail_section', 'Delivery handover'),
    jsonb_build_object('key', 'recipient_class', 'label', 'Recipient class', 'detail_section', 'Delivery handover'),
    jsonb_build_object('key', 'completion_notes', 'label', 'Completion notes', 'detail_section', 'Delivery handover'),
    jsonb_build_object('key', 'pod_captured_at', 'label', 'Proof captured at', 'render_type', 'datetime', 'detail_section', 'Proof of delivery'),
    jsonb_build_object(
      'key', 'pod_geostamp_latitude',
      'label', 'Proof latitude',
      'render_type', 'number',
      'format_options', jsonb_build_object('maximumFractionDigits', 6),
      'detail_section', 'Proof of delivery'
    ),
    jsonb_build_object(
      'key', 'pod_geostamp_longitude',
      'label', 'Proof longitude',
      'render_type', 'number',
      'format_options', jsonb_build_object('maximumFractionDigits', 6),
      'detail_section', 'Proof of delivery'
    ),
    jsonb_build_object(
      'key', 'pod_geostamp_accuracy_m',
      'label', 'Proof accuracy (m)',
      'render_type', 'number',
      'format_options', jsonb_build_object('maximumFractionDigits', 0),
      'detail_section', 'Proof of delivery'
    )
  );
  v_next_columns JSONB := '[]'::jsonb;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    v_resources := '[]'::jsonb;
  END IF;

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_resource->>'key' = 'shipment_actions' THEN
      v_found := TRUE;

      v_select := COALESCE(v_resource->'select', '[]'::jsonb);
      IF jsonb_typeof(v_select) IS DISTINCT FROM 'array' THEN
        v_select := '[]'::jsonb;
      END IF;

      FOREACH v_new_select_key IN ARRAY ARRAY[
        'handover_mode',
        'recipient_name',
        'recipient_class',
        'completion_notes',
        'pod_captured_at',
        'pod_geostamp_latitude',
        'pod_geostamp_longitude',
        'pod_geostamp_accuracy_m'
      ] LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(v_select) AS item(value)
          WHERE item.value = v_new_select_key
        ) THEN
          v_select := v_select || to_jsonb(v_new_select_key);
        END IF;
      END LOOP;
      v_resource := jsonb_set(v_resource, '{select}', v_select, TRUE);

      v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);
      IF jsonb_typeof(v_columns) IS DISTINCT FROM 'array' THEN
        v_columns := '[]'::jsonb;
      END IF;

      v_next_columns := '[]'::jsonb;
      FOR v_existing_column IN SELECT * FROM jsonb_array_elements(v_columns) LOOP
        v_new_column := v_existing_column;
        FOR v_column_def IN SELECT * FROM jsonb_array_elements(v_column_defs) LOOP
          IF v_new_column->>'key' = v_column_def->>'key' THEN
            v_new_column := jsonb_strip_nulls(v_new_column || v_column_def);
          END IF;
        END LOOP;
        v_next_columns := v_next_columns || jsonb_build_array(v_new_column);
      END LOOP;

      FOR v_new_column IN SELECT * FROM jsonb_array_elements(v_column_defs) LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_next_columns) AS existing(item)
          WHERE existing.item->>'key' = v_new_column->>'key'
        ) THEN
          v_next_columns := v_next_columns || jsonb_build_array(v_new_column);
        END IF;
      END LOOP;

      v_resource := jsonb_set(v_resource, '{columns}', v_next_columns, TRUE);
      v_resource := jsonb_set(
        v_resource,
        '{column_labels}',
        COALESCE(v_resource->'column_labels', '{}'::jsonb) || jsonb_build_object(
          'handover_mode', 'Handover mode',
          'recipient_name', 'Recipient',
          'recipient_class', 'Recipient class',
          'completion_notes', 'Completion notes',
          'pod_captured_at', 'Proof captured at',
          'pod_geostamp_latitude', 'Proof latitude',
          'pod_geostamp_longitude', 'Proof longitude',
          'pod_geostamp_accuracy_m', 'Proof accuracy (m)'
        ),
        TRUE
      );
    END IF;

    v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
  END LOOP;

  IF v_found IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_read_registry missing shipment_actions resource';
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Expose POD capture time/geostamp on shipment_actions UI reads',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604061945_b08_uc104_pod_geostamp_contract_v1'));
COMMIT;
