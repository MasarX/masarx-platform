-- Migration: B08 partial-delivery transition prevalidation
-- Date: 2026-04-07
--
-- Purpose:
-- - Reject invalid partial-delivery box selections at the canonical task-transition boundary.
-- - Keep FieldOps `tasks.complete` and direct `transition_task_v1` callers aligned.
-- - Preserve the downstream workflow validation as fail-closed defense in depth.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604071230_b08_partial_delivery_transition_validation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.assert_route_stop_completion_payload_v1(
  p_route_stop_id UUID,
  p_completion_reason TEXT DEFAULT NULL,
  p_task_event_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_stop public.route_stops%ROWTYPE;
  v_ship public.shipments%ROWTYPE;
  v_completion_reason TEXT := lower(NULLIF(btrim(COALESCE(p_completion_reason, '')), ''));
  v_completion_kind TEXT := NULL;
  v_box_source JSONB := '[]'::jsonb;
  v_box_number_source JSONB := '[]'::jsonb;
  v_box_id_text TEXT;
  v_box_number_text TEXT;
  v_uuid UUID;
  v_box_number INT;
  v_exception_meta JSONB := NULL;
  v_shipment_box_ids UUID[] := NULL;
  v_delivered_box_ids UUID[] := ARRAY[]::UUID[];
  v_delivered_box_numbers INT[] := ARRAY[]::INT[];
  v_total_box_count INT := 0;
  v_delivered_box_count INT := 0;
BEGIN
  IF p_route_stop_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: route_stop_id is required' USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(p_task_event_payload) IS DISTINCT FROM 'object' THEN
    p_task_event_payload := '{}'::jsonb;
  END IF;

  SELECT *
    INTO v_stop
    FROM public.route_stops
   WHERE id = p_route_stop_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_stop_finalize: route_stop not found: %', p_route_stop_id
      USING ERRCODE = '23503';
  END IF;

  SELECT *
    INTO v_ship
    FROM public.shipments
   WHERE id = v_stop.shipment_id
     AND organization_id = v_stop.organization_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_stop_finalize: shipment not found for route_stop %', p_route_stop_id
      USING ERRCODE = '23503';
  END IF;

  v_completion_kind := lower(NULLIF(btrim(COALESCE(
    NULLIF(p_task_event_payload->'delivery_completion'->>'completion_kind', ''),
    NULLIF(p_task_event_payload->'pod'->>'completion_kind', ''),
    NULLIF(p_task_event_payload->>'completion_kind', ''),
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
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'dispatch_exception_reason'
       AND lv.value = v_completion_reason
       AND lv.status = 'active'
     LIMIT 1;

    IF jsonb_typeof(v_exception_meta) = 'object' THEN
      v_completion_kind := lower(NULLIF(btrim(COALESCE(v_exception_meta->>'delivery_progress_kind', '')), ''));
    END IF;
  END IF;

  IF v_completion_kind IS DISTINCT FROM 'partial' THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'completion_kind', v_completion_kind
      )
    );
  END IF;

  v_box_source := COALESCE(
    p_task_event_payload->'delivered_box_ids',
    p_task_event_payload->'box_ids',
    p_task_event_payload->'pod'->'delivered_box_ids',
    p_task_event_payload->'pod'->'box_ids',
    '[]'::jsonb
  );
  v_box_number_source := COALESCE(
    p_task_event_payload->'delivery_completion'->'delivered_box_numbers',
    p_task_event_payload->'delivered_box_numbers',
    p_task_event_payload->'pod'->'delivered_box_numbers',
    '[]'::jsonb
  );

  IF jsonb_typeof(v_box_source) <> 'array' THEN
    v_box_source := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(v_box_number_source) NOT IN ('array', 'string') THEN
    v_box_number_source := '[]'::jsonb;
  END IF;

  PERFORM public.ensure_shipment_boxes(v_ship.id, COALESCE(NULLIF(v_ship.box_count, 0), 1));

  SELECT array_agg(sb.id ORDER BY sb.box_number)
    INTO v_shipment_box_ids
    FROM public.shipment_boxes sb
   WHERE sb.shipment_id = v_ship.id;

  v_total_box_count := COALESCE(array_length(v_shipment_box_ids, 1), 0);

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

  v_delivered_box_numbers := ARRAY[]::INT[];
  IF jsonb_typeof(v_box_number_source) = 'array' THEN
    FOR v_box_number_text IN
      SELECT value
        FROM jsonb_array_elements_text(v_box_number_source) AS box_numbers(value)
    LOOP
      BEGIN
        v_box_number := NULLIF(btrim(COALESCE(v_box_number_text, '')), '')::INT;
      EXCEPTION
        WHEN others THEN
          v_box_number := NULL;
      END;

      IF v_box_number IS NULL OR v_box_number <= 0 THEN
        RAISE EXCEPTION 'route_stop_finalize: delivered_box_numbers must contain positive integers' USING ERRCODE = '23514';
      END IF;

      IF NOT (v_box_number = ANY (v_delivered_box_numbers)) THEN
        v_delivered_box_numbers := array_append(v_delivered_box_numbers, v_box_number);
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(v_box_number_source) = 'string' THEN
    FOR v_box_number_text IN
      SELECT token
        FROM regexp_split_to_table(COALESCE(v_box_number_source #>> '{}', ''), '[,\s]+') AS token
       WHERE NULLIF(btrim(token), '') IS NOT NULL
    LOOP
      BEGIN
        v_box_number := NULLIF(btrim(COALESCE(v_box_number_text, '')), '')::INT;
      EXCEPTION
        WHEN others THEN
          v_box_number := NULL;
      END;

      IF v_box_number IS NULL OR v_box_number <= 0 THEN
        RAISE EXCEPTION 'route_stop_finalize: delivered_box_numbers must contain positive integers' USING ERRCODE = '23514';
      END IF;

      IF NOT (v_box_number = ANY (v_delivered_box_numbers)) THEN
        v_delivered_box_numbers := array_append(v_delivered_box_numbers, v_box_number);
      END IF;
    END LOOP;
  END IF;

  IF array_length(v_delivered_box_numbers, 1) IS NULL THEN
    v_delivered_box_numbers := NULL;
  END IF;

  IF array_length(v_delivered_box_ids, 1) IS NULL AND array_length(v_delivered_box_numbers, 1) IS NOT NULL THEN
    SELECT array_agg(sb.id ORDER BY sb.box_number)
      INTO v_delivered_box_ids
      FROM public.shipment_boxes sb
     WHERE sb.shipment_id = v_ship.id
       AND sb.box_number = ANY (v_delivered_box_numbers);

    IF COALESCE(array_length(v_delivered_box_ids, 1), 0) <> array_length(v_delivered_box_numbers, 1) THEN
      RAISE EXCEPTION 'route_stop_finalize: delivered_box_numbers must belong to shipment %', v_ship.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF array_length(v_delivered_box_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: partial_delivery requires delivered_box_ids or delivered_box_numbers'
      USING ERRCODE = '23514';
  END IF;

  v_delivered_box_count := array_length(v_delivered_box_ids, 1);
  IF v_total_box_count < 2 OR v_delivered_box_count >= v_total_box_count THEN
    RAISE EXCEPTION 'route_stop_finalize: partial_delivery requires a strict subset of shipment boxes (shipment box_count=% delivered=%)',
      v_total_box_count,
      v_delivered_box_count
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'completion_kind', v_completion_kind,
    'delivered_box_ids', to_jsonb(v_delivered_box_ids),
    'delivered_box_numbers', to_jsonb(v_delivered_box_numbers),
    'delivered_box_count', v_delivered_box_count,
    'total_box_count', v_total_box_count,
    'remaining_box_count', GREATEST(v_total_box_count - v_delivered_box_count, 0)
  );
END;
$$;

COMMENT ON FUNCTION public.assert_route_stop_completion_payload_v1(UUID, TEXT, JSONB)
  IS 'Validates route-stop completion payloads at the task-transition boundary and rejects invalid partial-delivery box selections synchronously.';

REVOKE ALL ON FUNCTION public.assert_route_stop_completion_payload_v1(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_route_stop_completion_payload_v1(UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.assert_route_stop_completion_payload_v1(UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assert_route_stop_completion_payload_v1(UUID, TEXT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.transition_task_v1(
  p_task_id UUID,
  p_to_status TEXT,
  p_status_reason TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_is_platform BOOLEAN := public.is_platform_user();
  v_task public.tasks%ROWTYPE;
  v_task_type_key TEXT := NULL;
  v_branch_id UUID := NULL;

  v_org_id UUID;
  v_from_status TEXT;
  v_to_status TEXT := lower(COALESCE(NULLIF(p_to_status, ''), ''));
  v_idempotency TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_decision_id UUID;
  v_next_version INT;

  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);

  -- Policy: task_ops_session_policy (ladder-resolved)
  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_task_policy JSONB := '{}'::jsonb;
  v_required_session_type TEXT := NULL;
  v_required_on_statuses JSONB := '["completed"]'::jsonb;
  v_require_branch_match BOOLEAN := FALSE;
  v_requires_session BOOLEAN := FALSE;

  -- Session linkage (optional unless policy requires)
  v_ops_session_id UUID := NULL;
  v_ops_session_org UUID := NULL;
  v_ops_session_actor UUID := NULL;
  v_ops_session_status TEXT := NULL;
  v_ops_session_type TEXT := NULL;
  v_ops_session_branch UUID := NULL;
  v_ops_session_is_final BOOLEAN := FALSE;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 requires an authenticated user';
  END IF;
  IF NOT v_is_platform AND public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
    RAISE EXCEPTION 'transition_task_v1 requires tenant/platform write scope' USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 requires task_id';
  END IF;
  IF v_to_status = '' THEN
    RAISE EXCEPTION 'transition_task_v1 requires to_status';
  END IF;

  SELECT * INTO v_task
  FROM public.tasks t
  WHERE t.id = p_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_task_v1 task not found: %', p_task_id;
  END IF;

  v_org_id := v_task.organization_id;
  IF NOT v_is_platform AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'transition_task_v1 task % is outside current tenant scope', p_task_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_permission_v1('tasks.complete', v_org_id) THEN
    RAISE EXCEPTION 'transition_task_v1 requires tasks.complete permission' USING ERRCODE = '42501';
  END IF;

  -- Idempotency short-circuit (must happen after locking the task row).
  IF v_idempotency IS NOT NULL THEN
    SELECT te.id INTO task_event_id
    FROM public.task_events te
    WHERE te.task_id = v_task.id
      AND te.idempotency_key = v_idempotency
    LIMIT 1;
    IF FOUND THEN
      task_id := v_task.id;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  -- Task type key (needed to resolve task_ops_session_policy).
  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = v_task.task_type_id
   LIMIT 1;

  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 task_type missing for task %', v_task.id
      USING ERRCODE = '23503';
  END IF;

  -- Derive branch_id for resource-scoped (branch) policy overrides.
  IF v_task.resource_type = 'settlement_batch' AND v_task.resource_id IS NOT NULL THEN
    SELECT sb.branch_id
      INTO v_branch_id
      FROM public.settlement_batches sb
     WHERE sb.id = v_task.resource_id
       AND sb.organization_id = v_org_id
     LIMIT 1;
  ELSIF v_task.resource_type = 'route_stop' AND v_task.resource_id IS NOT NULL THEN
    SELECT rr.branch_id
      INTO v_branch_id
      FROM public.route_stops rs
      JOIN public.route_runs rr
        ON rr.id = rs.route_run_id
     WHERE rs.id = v_task.resource_id
       AND rs.organization_id = v_org_id
       AND rr.organization_id = v_org_id
     LIMIT 1;
  END IF;

  -- Resolve policy (ladder). Missing/misconfigured rows are handled by category registry safe_missing_behavior.
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_task.client_id,
    'sender_id', v_task.sender_id,
    'resource_id', v_branch_id
  ));

  SELECT * INTO v_policy_row
    FROM public.resolve_settings_row_from_policy_context_v1('task_ops_session_policy', v_policy_ctx)
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_policy) IS DISTINCT FROM 'object' THEN
    v_policy := '{}'::jsonb;
  END IF;

  v_task_policy := COALESCE(v_policy #> ARRAY['task_type_map', v_task_type_key], '{}'::jsonb);
  IF jsonb_typeof(v_task_policy) IS DISTINCT FROM 'object' THEN
    v_task_policy := '{}'::jsonb;
  END IF;

  -- Apply policy.defaults first (row-driven), then per-task overrides.
  v_required_on_statuses := COALESCE(v_policy #> ARRAY['defaults', 'required_on_statuses'], v_required_on_statuses);
  BEGIN
    v_require_branch_match := COALESCE((v_policy #>> ARRAY['defaults', 'require_branch_match'])::boolean, v_require_branch_match);
  EXCEPTION WHEN others THEN
    v_require_branch_match := v_require_branch_match;
  END;

  -- Per-task overrides.
  v_required_session_type := NULLIF(btrim(COALESCE(v_task_policy->>'required_session_type', '')), '');
  v_required_on_statuses := COALESCE(v_task_policy->'required_on_statuses', v_required_on_statuses);
  BEGIN
    v_require_branch_match := COALESCE((v_task_policy->>'require_branch_match')::boolean, v_require_branch_match);
  EXCEPTION WHEN others THEN
    v_require_branch_match := v_require_branch_match;
  END;

  -- Session is required only when the task type declares required_session_type.
  v_requires_session := (
    v_required_session_type IS NOT NULL
    AND COALESCE(
      jsonb_typeof(v_required_on_statuses) = 'array'
      AND v_to_status IN (SELECT jsonb_array_elements_text(v_required_on_statuses)),
      FALSE
    )
  );

  -- Extract ops_session_id from payload (support multiple keys for backwards compatibility).
  v_ops_session_id := COALESCE(
    NULLIF((v_payload->>'ops_session_id')::uuid, NULL),
    NULLIF((v_payload->>'session_id')::uuid, NULL),
    NULL
  );

  IF v_requires_session IS TRUE THEN
    IF v_ops_session_id IS NULL THEN
      RAISE EXCEPTION 'transition_task_v1 requires ops_session_id'
        USING ERRCODE = '23514',
              DETAIL = jsonb_build_object(
                'task_type_key', v_task_type_key,
                'required_session_type', v_required_session_type,
                'required_on_statuses', v_required_on_statuses,
                'require_branch_match', v_require_branch_match
              )::text;
    END IF;

    SELECT
      s.organization_id,
      s.actor_user_id,
      s.status,
      s.session_type,
      s.branch_id,
      (s.closed_at IS NOT NULL) AS is_final
    INTO
      v_ops_session_org,
      v_ops_session_actor,
      v_ops_session_status,
      v_ops_session_type,
      v_ops_session_branch,
      v_ops_session_is_final
    FROM public.ops_sessions s
    WHERE s.id = v_ops_session_id
    LIMIT 1;

    IF v_ops_session_org IS NULL THEN
      RAISE EXCEPTION 'transition_task_v1 invalid ops_session_id: %', v_ops_session_id
        USING ERRCODE = '23503';
    END IF;

    IF NOT v_is_platform AND v_ops_session_org <> v_org_id THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session is outside current tenant scope' USING ERRCODE = '42501';
    END IF;

    -- Tenant actors can only use their own sessions (platform bypass).
    IF NOT v_is_platform AND v_ops_session_actor IS DISTINCT FROM v_user_id THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session actor mismatch' USING ERRCODE = '42501';
    END IF;

    IF COALESCE(v_ops_session_is_final, FALSE) IS TRUE THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session is final' USING ERRCODE = '23514';
    END IF;

    -- Enforce expected session_type when policy declares it.
    IF v_required_session_type IS NOT NULL AND lower(COALESCE(v_ops_session_type, '')) IS DISTINCT FROM v_required_session_type THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session type mismatch (required %, got %)', v_required_session_type, v_ops_session_type
        USING ERRCODE = '23514';
    END IF;

    -- Enforce branch match when configured.
    IF COALESCE(v_require_branch_match, FALSE) IS TRUE AND v_branch_id IS NOT NULL THEN
      IF v_ops_session_branch IS DISTINCT FROM v_branch_id THEN
        RAISE EXCEPTION 'transition_task_v1 ops_session branch mismatch (required %, got %)', v_branch_id, v_ops_session_branch
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- Avoid redundant storage: keep session link in the dedicated column.
  v_payload := (v_payload - 'ops_session_id' - 'session_id');

  IF v_to_status = 'completed'
     AND v_task_type_key = 'route_stop_execute'
     AND v_task.resource_type = 'route_stop'
     AND v_task.resource_id IS NOT NULL THEN
    PERFORM public.assert_route_stop_completion_payload_v1(
      v_task.resource_id,
      p_status_reason,
      v_payload
    );
  END IF;

  v_from_status := v_task.status;
  v_next_version := v_task.version + 1;

  UPDATE public.tasks
     SET status = v_to_status,
         status_reason = p_status_reason,
         version = v_next_version,
         started_at = CASE WHEN started_at IS NULL THEN now() ELSE started_at END,
         completed_at = CASE WHEN v_to_status = 'completed' THEN now() ELSE completed_at END,
         canceled_at = CASE WHEN v_to_status = 'canceled' THEN now() ELSE canceled_at END
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'task',
    p_resource_type := 'task',
    p_resource_id := v_task.id,
    p_decision_point := 'transition',
    p_decision_outcome := 'status_changed',
    p_performed_by_system := 'transition_task_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'from_status', v_from_status,
      'to_status', v_to_status,
      'status_reason', p_status_reason,
      'ops_session_id', v_ops_session_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.task_events (
    task_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    task_version,
    decision_log_id,
    settings_resolution_id,
    ops_session_id
  )
  VALUES (
    v_task.id,
    v_org_id,
    'status_changed',
    v_from_status,
    v_to_status,
    v_user_id,
    NULL,
    jsonb_strip_nulls(v_payload || jsonb_build_object(
      'status_reason', p_status_reason,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency,
    v_next_version,
    v_decision_id,
    NULL,
    v_ops_session_id
  )
  RETURNING id INTO task_event_id;

  task_id := v_task.id;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT)
  IS 'Transition a task status (projection update + ledger event). Supports optional ops_session_id linkage, row-driven task_ops_session_policy, and synchronous route-stop partial-delivery payload validation.';

REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604071230_b08_partial_delivery_transition_validation_v1'));
COMMIT;
