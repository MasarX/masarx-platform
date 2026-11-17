-- Plan: B08 Delivery proof & closeout / Step: E03
-- Migration: Delivery completion closeout v1
-- Purpose:
--   - Keep UC096/UC098/UC099/UC100 canonical through the route_stop finalize workflow.
--   - Record shipment delivered_at, service-time, stop-duration, and box-level completion metadata once.
--   - Release route capacity only when the full route_run has completed all route_stops.
--   - Support explicit partial piece completion for multi-piece shipments through canonical metadata.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061200_b08_delivery_completion_closeout_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def_id UUID;
BEGIN
  SELECT id
    INTO v_def_id
    FROM public.lookup_definitions
   WHERE category = 'dispatch_exception_reason'
   LIMIT 1;

  IF v_def_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_exception_reason lookup_definitions row missing';
  END IF;

  INSERT INTO public.lookup_values AS lv (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default,
    metadata
  )
  VALUES (
    v_def_id,
    'partial_delivery',
    'Partial Delivery',
    'Partially delivered shipment; remaining pieces stay outstanding',
    30,
    FALSE,
    jsonb_build_object(
      'default_shipment_status', 'out_for_delivery',
      'default_action_type', 'status_change',
      'default_action_category', 'operational',
      'delivery_progress_kind', 'partial',
      'route_completion_terminal', FALSE
    )
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order,
      is_default = EXCLUDED.is_default,
      metadata = COALESCE(lv.metadata, '{}'::jsonb) || EXCLUDED.metadata,
      updated_at = now();
END;
$do$;

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v6(
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

  v_completion_at := COALESCE(v_task_event_created_at, now());

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

  IF v_completion_kind = 'partial' THEN
    v_box_source := COALESCE(
      v_task_event_payload->'delivered_box_ids',
      v_task_event_payload->'box_ids',
      v_task_event_payload->'pod'->'delivered_box_ids',
      v_task_event_payload->'pod'->'box_ids',
      '[]'::jsonb
    );
  ELSE
    v_box_source := COALESCE(
      v_task_event_payload->'delivered_box_ids',
      v_task_event_payload->'box_ids',
      v_task_event_payload->'pod'->'delivered_box_ids',
      v_task_event_payload->'pod'->'box_ids',
      '[]'::jsonb
    );
  END IF;

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
  'execute_route_stop_finalize_v6',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v6',
  TRUE,
  'Finalize a dispatch route_stop execution through v5 while persisting delivery closeout projections for shipment delivered_at, box-level completion, and route_run closeout.',
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
     SET handler_version = 'v6',
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'route_stop_finalize';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604061200_b08_delivery_completion_closeout_v1'));
COMMIT;
