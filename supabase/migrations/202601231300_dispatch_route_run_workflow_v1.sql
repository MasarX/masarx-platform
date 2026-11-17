-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Dispatch route run workflow v1 (route_run_create + task fanout)
-- Date: 2026-01-23
--
-- Goals:
--   - Keep dispatch execution workflow-driven + row-driven (no bespoke branching).
--   - Create route_runs + route_stops via a canonical, idempotent service RPC.
--   - Fan out stop execution into Tasks SSOT (generic handler; reusable for other domains).
--   - Preserve SSOT boundaries: route_runs/stops are planning data; execution state is tasks/workflows.
--   - Least-privilege: service-only write paths; tenant users read via existing RLS.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601231300_dispatch_route_run_workflow_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Idempotency columns for route_runs (workflow retries safe)
-------------------------------------------------------------------------------

ALTER TABLE public.route_runs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_hash TEXT;

ALTER TABLE public.route_runs
  DROP CONSTRAINT IF EXISTS route_runs_idempotency_key_ck;
ALTER TABLE public.route_runs
  ADD CONSTRAINT route_runs_idempotency_key_ck
  CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> '');

ALTER TABLE public.route_runs
  DROP CONSTRAINT IF EXISTS route_runs_idempotency_hash_ck;
ALTER TABLE public.route_runs
  ADD CONSTRAINT route_runs_idempotency_hash_ck
  CHECK (idempotency_hash IS NULL OR btrim(idempotency_hash) <> '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_runs_org_idempotency
  ON public.route_runs (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

-------------------------------------------------------------------------------
-- 2) Canonical service RPC: create_route_run_v1 (idempotent, inserts stops)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_route_run_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_run_id UUID,
  stop_ids UUID[],
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_created BOOLEAN := TRUE;

  v_org_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;

  v_status TEXT := NULL;
  v_planned_date DATE := NULL;
  v_planned_start_at TIMESTAMPTZ := NULL;
  v_planned_end_at TIMESTAMPTZ := NULL;

  v_idempotency_key TEXT := NULL;
  v_idempotency_hash TEXT := NULL;
  v_existing_hash TEXT := NULL;

  v_metadata JSONB := '{}'::jsonb;
  v_stops JSONB := '[]'::jsonb;

  v_run_id UUID := NULL;
  v_stop_ids UUID[] := '{}'::uuid[];

  v_item JSONB;
  v_seq INT := 0;

  v_client_id UUID := NULL;
  v_shipment_id UUID := NULL;
  v_stop_kind TEXT := NULL;
  v_sequence_order INT := NULL;
  v_win_start TIMESTAMPTZ := NULL;
  v_win_end TIMESTAMPTZ := NULL;
  v_stop_metadata JSONB := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'create_route_run_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_input->>'branch_id', '')::UUID; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_driver_user_id := NULLIF(v_input->>'driver_user_id', '')::UUID; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(v_input->>'vehicle_id', '')::UUID; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;

  v_status := lower(NULLIF(btrim(COALESCE(v_input->>'status', '')), ''));
  BEGIN v_planned_date := NULLIF(v_input->>'planned_date', '')::date; EXCEPTION WHEN others THEN v_planned_date := NULL; END;
  BEGIN v_planned_start_at := NULLIF(v_input->>'planned_start_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_start_at := NULL; END;
  BEGIN v_planned_end_at := NULLIF(v_input->>'planned_end_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_end_at := NULL; END;

  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;
  v_stops := COALESCE(v_input->'stops', '[]'::jsonb);

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_route_run_v1 missing organization_id' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(v_stops) <> 'array' THEN
    RAISE EXCEPTION 'create_route_run_v1 expects stops as JSON array' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(v_stops) < 1 THEN
    RAISE EXCEPTION 'create_route_run_v1 requires at least one stop' USING ERRCODE = '23514';
  END IF;

  -- Stable idempotency hash for mismatch detection on retries.
  v_idempotency_hash := encode(digest(v_input::text, 'sha256'), 'hex');

  IF v_idempotency_key IS NOT NULL THEN
    INSERT INTO public.route_runs (
      organization_id,
      branch_id,
      driver_user_id,
      vehicle_id,
      status,
      planned_date,
      planned_start_at,
      planned_end_at,
      metadata,
      idempotency_key,
      idempotency_hash
    )
    VALUES (
      v_org_id,
      v_branch_id,
      v_driver_user_id,
      v_vehicle_id,
      COALESCE(v_status, 'planned'),
      v_planned_date,
      v_planned_start_at,
      v_planned_end_at,
      v_metadata,
      v_idempotency_key,
      v_idempotency_hash
    )
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_run_id;

    IF v_run_id IS NULL THEN
      SELECT rr.id, rr.idempotency_hash
        INTO v_run_id, v_existing_hash
        FROM public.route_runs rr
       WHERE rr.organization_id = v_org_id
         AND rr.idempotency_key = v_idempotency_key
       LIMIT 1;

      IF v_run_id IS NULL THEN
        RAISE EXCEPTION 'create_route_run_v1 idempotency_key collision but row missing (org %, key %)', v_org_id, v_idempotency_key
          USING ERRCODE = '23514';
      END IF;

      IF v_existing_hash IS DISTINCT FROM v_idempotency_hash THEN
        RAISE EXCEPTION 'create_route_run_v1 idempotency_key reuse with different payload (org %, key %)', v_org_id, v_idempotency_key
          USING ERRCODE = '23514';
      END IF;

      v_created := FALSE;
    END IF;
  ELSE
    INSERT INTO public.route_runs (
      organization_id,
      branch_id,
      driver_user_id,
      vehicle_id,
      status,
      planned_date,
      planned_start_at,
      planned_end_at,
      metadata
    )
    VALUES (
      v_org_id,
      v_branch_id,
      v_driver_user_id,
      v_vehicle_id,
      COALESCE(v_status, 'planned'),
      v_planned_date,
      v_planned_start_at,
      v_planned_end_at,
      v_metadata
    )
    RETURNING id INTO v_run_id;
  END IF;

  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'create_route_run_v1 failed to create route_run' USING ERRCODE = '23514';
  END IF;

  -- Insert stops (idempotent via route_stops unique constraints).
  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(v_stops) AS t(value)
  LOOP
    v_seq := v_seq + 1;
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'create_route_run_v1 stop at index % must be JSON object', v_seq USING ERRCODE = '23514';
    END IF;

    BEGIN v_client_id := NULLIF(v_item->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
    BEGIN v_shipment_id := NULLIF(v_item->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
    v_stop_kind := lower(NULLIF(btrim(COALESCE(v_item->>'stop_kind', '')), ''));
    BEGIN v_sequence_order := NULLIF(v_item->>'sequence_order', '')::int; EXCEPTION WHEN others THEN v_sequence_order := NULL; END;
    BEGIN v_win_start := NULLIF(v_item->>'planned_window_start_at', '')::timestamptz; EXCEPTION WHEN others THEN v_win_start := NULL; END;
    BEGIN v_win_end := NULLIF(v_item->>'planned_window_end_at', '')::timestamptz; EXCEPTION WHEN others THEN v_win_end := NULL; END;
    v_stop_metadata := COALESCE(v_item->'metadata', '{}'::jsonb);
    IF jsonb_typeof(v_stop_metadata) <> 'object' THEN
      v_stop_metadata := '{}'::jsonb;
    END IF;

    IF v_client_id IS NULL THEN
      RAISE EXCEPTION 'create_route_run_v1 stop % missing client_id', v_seq USING ERRCODE = '23514';
    END IF;
    IF v_shipment_id IS NULL THEN
      RAISE EXCEPTION 'create_route_run_v1 stop % missing shipment_id', v_seq USING ERRCODE = '23514';
    END IF;
    IF v_stop_kind IS NULL THEN
      v_stop_kind := 'delivery';
    END IF;
    IF v_sequence_order IS NULL OR v_sequence_order < 1 THEN
      v_sequence_order := v_seq;
    END IF;

    INSERT INTO public.route_stops (
      organization_id,
      route_run_id,
      client_id,
      shipment_id,
      stop_kind,
      sequence_order,
      planned_window_start_at,
      planned_window_end_at,
      metadata
    ) VALUES (
      v_org_id,
      v_run_id,
      v_client_id,
      v_shipment_id,
      v_stop_kind,
      v_sequence_order,
      v_win_start,
      v_win_end,
      v_stop_metadata
    )
    ON CONFLICT DO NOTHING;
  END LOOP;

  SELECT COALESCE(array_agg(rs.id ORDER BY rs.sequence_order), '{}'::uuid[])
    INTO v_stop_ids
    FROM public.route_stops rs
   WHERE rs.route_run_id = v_run_id;

  route_run_id := v_run_id;
  stop_ids := v_stop_ids;
  created := v_created;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.create_route_run_v1(JSONB) IS
  'Service write-path: create a route_run and its route_stops (idempotent by organization_id + idempotency_key).';

REVOKE ALL ON FUNCTION public.create_route_run_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_route_run_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_route_run_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_route_run_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 3) Workflow handler: route_run_create (calls create_route_run_v1)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_run_create_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'dispatch');
  v_stops_path TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'stops_jsonpath', '')), ''), '$.stops');

  v_org_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;

  v_planned_date DATE := NULL;
  v_planned_start_at TIMESTAMPTZ := NULL;
  v_planned_end_at TIMESTAMPTZ := NULL;

  v_status TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'status', '')), ''));
  v_idempotency_key TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'idempotency_key', '')), ''),
    format('workflow_run:%s:step:%s', p_run.id, p_step.id)
  );

  v_stops JSONB := NULL;
  v_created RECORD;
  v_resp public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  BEGIN v_org_id := NULLIF(v_ctx->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_ctx->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_driver_user_id := NULLIF(v_ctx->>'driver_user_id', '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(v_ctx->>'vehicle_id', '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;

  BEGIN v_planned_date := NULLIF(v_ctx->>'planned_date', '')::date; EXCEPTION WHEN others THEN v_planned_date := NULL; END;
  BEGIN v_planned_start_at := NULLIF(v_ctx->>'planned_start_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_start_at := NULL; END;
  BEGIN v_planned_end_at := NULLIF(v_ctx->>'planned_end_at', '')::timestamptz; EXCEPTION WHEN others THEN v_planned_end_at := NULL; END;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'route_run_create: organization_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_stops := public.safe_jsonpath_query_first(v_ctx, v_stops_path);
  IF jsonb_typeof(v_stops) <> 'array' THEN
    RAISE EXCEPTION 'route_run_create: stops_jsonpath did not resolve to array (path=% workflow_run_id=% step_id=%)', v_stops_path, p_run.id, p_step.id;
  END IF;

  SELECT *
    INTO v_created
    FROM public.create_route_run_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'branch_id', v_branch_id,
        'driver_user_id', v_driver_user_id,
        'vehicle_id', v_vehicle_id,
        'status', COALESCE(v_status, 'planned'),
        'planned_date', v_planned_date,
        'planned_start_at', v_planned_start_at,
        'planned_end_at', v_planned_end_at,
        'idempotency_key', v_idempotency_key,
        'stops', v_stops,
        'metadata', COALESCE(v_meta->'route_run_metadata', '{}'::jsonb)
      ))
    )
    LIMIT 1;

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'route_run_id', v_created.route_run_id,
    'stop_ids', to_jsonb(v_created.stop_ids),
    'created', v_created.created
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_created.route_run_id,
      'stop_ids', to_jsonb(v_created.stop_ids),
      'created', v_created.created
    ))
  );

  RETURN v_resp;
END;
$function$;

-------------------------------------------------------------------------------
-- 4) Workflow handler: task_enqueue_many (generic fanout; SSOT tasks)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_task_enqueue_many_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'tasks_many');
  v_items_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'items_jsonpath', '')), '');
  v_task_type_key TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'task_type_key', '')), ''));
  v_resource_type TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'resource_type', '')), ''));
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');

  v_org_id UUID := NULL;
  v_items JSONB := NULL;
  v_item JSONB;

  v_i INT := 0;
  v_resource_id UUID := NULL;
  v_idempotency_key TEXT := NULL;

  v_task_metadata_base JSONB := COALESCE(v_meta->'task_metadata', '{}'::jsonb);
  v_task_metadata JSONB := '{}'::jsonb;

  v_created RECORD;

  v_task_ids UUID[] := '{}'::uuid[];
  v_task_event_ids UUID[] := '{}'::uuid[];
  v_task_workflow_run_ids UUID[] := '{}'::uuid[];

  v_resp public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  IF v_items_path IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: missing metadata.items_jsonpath (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: missing metadata.task_type_key (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_resource_type IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: missing metadata.resource_type (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  BEGIN v_org_id := NULLIF(v_ctx->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: organization_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_items := public.safe_jsonpath_query_first(v_ctx, v_items_path);
  IF jsonb_typeof(v_items) <> 'array' THEN
    RAISE EXCEPTION 'task_enqueue_many: items_jsonpath did not resolve to array (path=% workflow_run_id=% step_id=%)', v_items_path, p_run.id, p_step.id;
  END IF;

  IF jsonb_typeof(v_task_metadata_base) <> 'object' THEN
    v_task_metadata_base := '{}'::jsonb;
  END IF;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(v_items) AS t(value)
  LOOP
    v_i := v_i + 1;

    v_resource_id := NULL;
    IF jsonb_typeof(v_item) = 'string' THEN
      BEGIN v_resource_id := NULLIF(trim(both '\"' FROM v_item::text), '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
    ELSIF jsonb_typeof(v_item) = 'object' THEN
      BEGIN v_resource_id := NULLIF(v_item->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
    END IF;

    IF v_resource_id IS NULL THEN
      RAISE EXCEPTION 'task_enqueue_many: item % missing resource_id/uuid', v_i USING ERRCODE = '23514';
    END IF;

    v_idempotency_key := format('workflow_run:%s:step:%s:item:%s', p_run.id, p_step.id, v_resource_id);

    v_task_metadata := public.jsonb_deep_merge(
      v_task_metadata_base,
      jsonb_strip_nulls(jsonb_build_object(
        'parent_workflow_run_id', p_run.id,
        'parent_workflow_step_id', p_step.id,
        'fanout_index', v_i
      ))
    );

    SELECT *
      INTO v_created
      FROM public.create_task_system_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'task_type_key', v_task_type_key,
          'context', jsonb_build_object('organization_id', v_org_id),
          'resource_type', v_resource_type,
          'resource_id', v_resource_id,
          'idempotency_key', v_idempotency_key,
          'metadata', v_task_metadata,
          'actor_system', v_actor_system
        ))
      )
      LIMIT 1;

    IF v_created.task_id IS NULL THEN
      RAISE EXCEPTION 'task_enqueue_many: create_task_system_v1 returned NULL task_id (idx=% resource_id=%)', v_i, v_resource_id
        USING ERRCODE = '23514';
    END IF;

    v_task_ids := array_append(v_task_ids, v_created.task_id);
    v_task_event_ids := array_append(v_task_event_ids, v_created.task_event_id);
    v_task_workflow_run_ids := array_append(v_task_workflow_run_ids, v_created.workflow_run_id);
  END LOOP;

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'count', v_i,
    'task_ids', to_jsonb(v_task_ids),
    'task_event_ids', to_jsonb(v_task_event_ids),
    'task_workflow_run_ids', to_jsonb(v_task_workflow_run_ids)
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'count', v_i,
      'task_ids', to_jsonb(v_task_ids),
      'task_event_ids', to_jsonb(v_task_event_ids),
      'task_workflow_run_ids', to_jsonb(v_task_workflow_run_ids)
    ))
  );

  RETURN v_resp;
END;
$function$;

-------------------------------------------------------------------------------
-- 5) Register handlers (safe dynamic dispatch)
-------------------------------------------------------------------------------

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES
  (
    'route_run_create',
    'workflow_handlers',
    'execute_route_run_create_v1',
    '(workflow_run_steps,workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Create a route_run + route_stops via service RPC (idempotent; dispatch planning SSOT).',
    'docs/product/guides/handlers-cookbook.md'
  ),
  (
    'task_enqueue_many',
    'workflow_handlers',
    'execute_task_enqueue_many_v1',
    '(workflow_run_steps,workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Generic handler to fan out N tasks from an array in workflow context (tasks SSOT).',
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

-------------------------------------------------------------------------------
-- 6) Workflow template: dispatch_route_run_v1 (create run + fanout stop tasks)
-------------------------------------------------------------------------------

INSERT INTO public.workflow_templates (name, description, version, status, scope_type, scope_id, created_by, created_at, updated_at, notes)
VALUES (
  'dispatch_route_run_v1',
  'Dispatch: create route_run + route_stops then enqueue stop execution tasks (row-driven; tasks SSOT).',
  1,
  'active',
  'global',
  NULL,
  NULL,
  now(),
  now(),
  'Workflow context must include organization_id, and stops array (default jsonpath $.stops) with client_id/shipment_id. Optional: branch_id, driver_user_id, vehicle_id, planned_* timestamps.'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    notes = EXCLUDED.notes,
    updated_at = now();

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'dispatch_route_run_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_route_run_v1 template id missing after upsert';
  END IF;

  -- Idempotent upsert: delete and recreate steps for this template.
  DELETE FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id;

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    next_operation_name,
    next_operation_priority,
    next_operation_delay_seconds,
    manual_action_required,
    metadata,
    enabled,
    handler_key,
    handler_version,
    created_at,
    updated_at
  ) VALUES
    (
      v_template_id,
      1,
      'route_run_create',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'dispatch',
        'stops_jsonpath', '$.stops'
      ),
      TRUE,
      'route_run_create',
      'v1',
      now(),
      now()
    ),
    (
      v_template_id,
      2,
      'task_enqueue_many',
      NULL,
      'success',
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'context_key', 'dispatch_tasks',
        'items_jsonpath', '$.dispatch.stop_ids',
        'task_type_key', 'route_stop_execute',
        'resource_type', 'route_stop'
      ),
      TRUE,
      'task_enqueue_many',
      'v1',
      now(),
      now()
    );
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601231300_dispatch_route_run_workflow_v1'));
COMMIT;
