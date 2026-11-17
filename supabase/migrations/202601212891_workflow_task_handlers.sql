-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Workflow handlers: task enqueue + wait (generic, row-driven)
-- Date: 2026-01-21

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212891_workflow_task_handlers'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Handler: task_enqueue (creates a task via SSOT RPC)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_task_enqueue_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_task_type_key TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'task_type_key', '')), ''));
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'task');
  v_task_context_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'task_context_path', '')), '');
  v_resource_id_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'resource_id_path', '')), '');

  v_task_context JSONB := '{}'::jsonb;
  v_task_metadata JSONB := COALESCE(v_meta->'task_metadata', '{}'::jsonb);

  v_org_id UUID := NULL;
  v_resource_type TEXT := NULLIF(btrim(COALESCE(v_meta->>'resource_type', '')), '');
  v_resource_id UUID := NULL;

  v_queue_key TEXT := NULLIF(btrim(COALESCE(v_meta->>'queue_key', '')), '');
  v_priority INT := NULL;
  v_sla_minutes INT := NULL;
  v_idempotency_key TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'idempotency_key', '')), ''),
    format('workflow_run:%s:step:%s', p_run.id, p_step.id)
  );
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');

  v_resource_id_json JSONB := NULL;
  v_task_context_json JSONB := NULL;

  v_created RECORD;
  v_resp workflow_handler_response;
BEGIN
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'task_enqueue: missing metadata.task_type_key (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  -- task_context: default to full workflow context; can be overridden by jsonpath.
  v_task_context := v_ctx;
  IF v_task_context_path IS NOT NULL THEN
    v_task_context_json := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_task_context_path
    );
    IF v_task_context_json IS NOT NULL AND jsonb_typeof(v_task_context_json) = 'object' THEN
      v_task_context := v_task_context_json;
    END IF;
  END IF;

  -- organization_id must be present for service-driven calls.
  BEGIN
    v_org_id := NULLIF(COALESCE(v_task_context->>'organization_id', v_ctx->>'organization_id'), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'task_enqueue: organization_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  -- resource_id: optional; resolved from jsonpath when configured.
  IF v_resource_id_path IS NOT NULL THEN
    v_resource_id_json := public.safe_jsonpath_query_first(
      jsonb_build_object('context', v_ctx, 'operation_result', COALESCE(p_operation_result, '{}'::jsonb)),
      v_resource_id_path
    );
    BEGIN
      v_resource_id := NULLIF(btrim(COALESCE(v_resource_id_json #>> '{}', '')), '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_resource_id := NULL;
    END;
  ELSE
    BEGIN
      v_resource_id := NULLIF(btrim(COALESCE(v_meta->>'resource_id', '')), '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_resource_id := NULL;
    END;
  END IF;

  BEGIN v_priority := NULLIF(btrim(COALESCE(v_meta->>'priority', '')), '')::int; EXCEPTION WHEN others THEN v_priority := NULL; END;
  BEGIN v_sla_minutes := NULLIF(btrim(COALESCE(v_meta->>'sla_minutes', '')), '')::int; EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;

  -- Ensure task metadata carries parent workflow linkage (avoid confusion with tasks.workflow_run_id child workflows).
  v_task_metadata := public.jsonb_deep_merge(
    COALESCE(v_task_metadata, '{}'::jsonb),
    jsonb_strip_nulls(jsonb_build_object(
      'parent_workflow_run_id', p_run.id,
      'parent_workflow_step_id', p_step.id
    ))
  );

  SELECT *
    INTO v_created
    FROM public.create_task_system_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type_key,
        'context', public.jsonb_deep_merge(jsonb_build_object('organization_id', v_org_id), v_task_context),
        'resource_type', NULLIF(lower(btrim(v_resource_type)), ''),
        'resource_id', v_resource_id,
        'queue_key', v_queue_key,
        'priority', v_priority,
        'sla_minutes', v_sla_minutes,
        'idempotency_key', v_idempotency_key,
        'metadata', v_task_metadata,
        'actor_system', v_actor_system
      ))
    )
    LIMIT 1;

  IF v_created.task_id IS NULL THEN
    RAISE EXCEPTION 'task_enqueue: create_task_system_v1 returned NULL task_id (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_resp.status := 'completed';
  v_resp.workflow_status := NULL;
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'task_id', v_created.task_id,
    'task_event_id', v_created.task_event_id,
    'task_workflow_run_id', v_created.workflow_run_id,
    'task_type_key', v_task_type_key,
    'resource_type', NULLIF(lower(btrim(v_resource_type)), ''),
    'resource_id', v_resource_id
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'task_id', v_created.task_id,
      'task_event_id', v_created.task_event_id,
      'task_workflow_run_id', v_created.workflow_run_id,
      'task_type_key', v_task_type_key,
      'resource_type', NULLIF(lower(btrim(v_resource_type)), ''),
      'resource_id', v_resource_id
    ))
  );
  RETURN v_resp;
END;
$$;

-------------------------------------------------------------------------------
-- 2) Handler: task_wait (poll until a task reaches terminal status)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_task_wait_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'task');

  v_task_id_text TEXT := COALESCE(
    NULLIF(btrim(COALESCE(p_operation_result->>'task_id', '')), ''),
    NULLIF(btrim(COALESCE(p_step.operation_result->>'task_id', '')), ''),
    NULLIF(btrim(COALESCE(v_meta->>'task_id', '')), ''),
    CASE
      WHEN jsonb_typeof(v_ctx->v_context_key) = 'object' THEN NULLIF(btrim(COALESCE((v_ctx->v_context_key)->>'task_id', '')), '')
      ELSE NULL
    END,
    NULLIF(btrim(COALESCE(v_ctx->>'task_id', '')), '')
  );

  v_task_id UUID := NULL;
  v_poll_seconds INT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'poll_interval_seconds', '')), '')::int, 60);

  v_success_statuses TEXT[] := ARRAY['completed'];
  v_failure_statuses TEXT[] := ARRAY['canceled'];

  v_task public.tasks%ROWTYPE;
  v_last_event public.task_events%ROWTYPE;
  v_resp workflow_handler_response;
BEGIN
  BEGIN
    v_task_id := v_task_id_text::uuid;
  EXCEPTION
    WHEN others THEN
      v_task_id := NULL;
  END;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'task_wait: task_id missing (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  IF v_poll_seconds < 0 THEN
    v_poll_seconds := 60;
  END IF;

  IF jsonb_typeof(v_meta->'success_statuses') = 'array' THEN
    SELECT array_agg(lower(btrim(x.value))) INTO v_success_statuses
    FROM jsonb_array_elements_text(v_meta->'success_statuses') AS x(value)
    WHERE lower(btrim(x.value)) <> '';
  END IF;
  IF v_success_statuses IS NULL OR array_length(v_success_statuses, 1) IS NULL THEN
    v_success_statuses := ARRAY['completed'];
  END IF;

  IF jsonb_typeof(v_meta->'failure_statuses') = 'array' THEN
    SELECT array_agg(lower(btrim(x.value))) INTO v_failure_statuses
    FROM jsonb_array_elements_text(v_meta->'failure_statuses') AS x(value)
    WHERE lower(btrim(x.value)) <> '';
  END IF;
  IF v_failure_statuses IS NULL OR array_length(v_failure_statuses, 1) IS NULL THEN
    v_failure_statuses := ARRAY['canceled'];
  END IF;

  SELECT * INTO v_task
  FROM public.tasks t
  WHERE t.id = v_task_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_wait: task_id % not found', v_task_id;
  END IF;

  IF v_task.metadata ? 'parent_workflow_run_id'
     AND NULLIF(v_task.metadata->>'parent_workflow_run_id', '')::uuid IS DISTINCT FROM p_run.id THEN
    RAISE EXCEPTION 'task_wait: task % does not belong to workflow_run_id=%', v_task_id, p_run.id;
  END IF;

  SELECT *
    INTO v_last_event
    FROM public.task_events te
   WHERE te.task_id = v_task_id
   ORDER BY te.task_version DESC
   LIMIT 1;

  IF lower(v_task.status) = ANY (v_success_statuses) THEN
    v_resp.status := 'completed';
    v_resp.workflow_status := NULL;
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'task_id', v_task_id,
      'status', v_task.status,
      'task_event_id', v_last_event.id,
      'event_type', v_last_event.event_type,
      'to_status', v_last_event.to_status,
      'created_at', v_last_event.created_at
    ));
    v_resp.context_patch := jsonb_build_object(
      v_context_key,
      jsonb_strip_nulls(jsonb_build_object(
        'task_id', v_task_id,
        'status', v_task.status,
        'status_reason', v_task.status_reason,
        'completed_at', v_task.completed_at,
        'canceled_at', v_task.canceled_at,
        'last_event', jsonb_strip_nulls(jsonb_build_object(
          'id', v_last_event.id,
          'event_type', v_last_event.event_type,
          'from_status', v_last_event.from_status,
          'to_status', v_last_event.to_status,
          'created_at', v_last_event.created_at
        ))
      ))
    );
    RETURN v_resp;
  END IF;

  IF lower(v_task.status) = ANY (v_failure_statuses) THEN
    v_resp.status := 'failed';
    v_resp.workflow_status := NULL;
    v_resp.last_error := format('task_wait: task reached failure status %s', v_task.status);
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'task_id', v_task_id,
      'status', v_task.status,
      'status_reason', v_task.status_reason,
      'task_event_id', v_last_event.id,
      'event_type', v_last_event.event_type,
      'to_status', v_last_event.to_status,
      'created_at', v_last_event.created_at
    ));
    RETURN v_resp;
  END IF;

  v_resp.status := 'pending';
  v_resp.workflow_status := NULL;
  v_resp.next_run_at := now() + make_interval(secs => v_poll_seconds);
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'task_id', v_task_id,
    'status', v_task.status,
    'status_reason', v_task.status_reason
  ));
  RETURN v_resp;
END;
$$;

-------------------------------------------------------------------------------
-- 3) Register handlers (safe dynamic dispatch)
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
    'task_enqueue',
    'workflow_handlers',
    'execute_task_enqueue_v1',
    '(workflow_run_steps,workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Generic handler to create a task (tasks SSOT) from workflow context/metadata.',
    'docs/product/guides/handlers-cookbook.md'
  ),
  (
    'task_wait',
    'workflow_handlers',
    'execute_task_wait_v1',
    '(workflow_run_steps,workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Generic handler to poll task status until completion/failure.',
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

SELECT pg_advisory_unlock(hashtext('202601212891_workflow_task_handlers'));
COMMIT;

