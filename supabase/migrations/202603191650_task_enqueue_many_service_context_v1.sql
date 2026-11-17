-- Plan: B02 Pickup & first-mile handoff
-- Migration: task_enqueue_many service context v1
-- Date: 2026-03-19
--
-- Purpose:
--   - Keep workflow-engine task fanout system-scoped even when an authenticated
--     UI caller progresses the workflow inline.
--   - Preserve the caller claims payload, but force the role to service_role for
--     the duration of system task creation so create_task_system_v1 can execute
--     without each feature flow re-implementing the same workaround.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191650_task_enqueue_many_service_context_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_idempotency_prefix TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'idempotency_prefix', '')), ''),
    NULLIF(btrim(COALESCE(v_ctx->>'idempotency_key', '')), ''),
    format('workflow_run:%s:step:%s', p_run.id, p_step.id)
  );

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

  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_service_claims JSONB := '{}'::jsonb;

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
  IF v_items IS NULL OR jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'task_enqueue_many: items_jsonpath did not resolve to array (path=% workflow_run_id=% step_id=%)', v_items_path, p_run.id, p_step.id;
  END IF;

  IF jsonb_typeof(v_task_metadata_base) IS DISTINCT FROM 'object' THEN
    v_task_metadata_base := '{}'::jsonb;
  END IF;

  BEGIN
    v_service_claims := NULLIF(v_prev_claims, '')::jsonb;
  EXCEPTION
    WHEN others THEN
      v_service_claims := '{}'::jsonb;
  END;
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := v_service_claims || jsonb_build_object('role', 'service_role');

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(v_items) AS t(value)
  LOOP
    v_i := v_i + 1;

    v_resource_id := NULL;
    IF jsonb_typeof(v_item) = 'string' THEN
      BEGIN v_resource_id := NULLIF(trim(both '"' FROM v_item::text), '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
    ELSIF jsonb_typeof(v_item) = 'object' THEN
      BEGIN v_resource_id := NULLIF(v_item->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
    END IF;

    IF v_resource_id IS NULL THEN
      RAISE EXCEPTION 'task_enqueue_many: item % missing resource_id/uuid', v_i USING ERRCODE = '23514';
    END IF;

    v_idempotency_key := format('%s:item:%s', v_idempotency_prefix, v_resource_id);

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

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);

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
EXCEPTION
  WHEN others THEN
    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
    RAISE;
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202603191650_task_enqueue_many_service_context_v1'));
COMMIT;
