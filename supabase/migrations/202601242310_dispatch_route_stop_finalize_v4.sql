-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Dispatch route stop finalize v4 (exception taxonomy defaults + follow-up inference)
-- Date: 2026-01-24
--
-- Why:
--   - Keep stop finalization fully row-driven.
--   - Allow canonical exception taxonomy (dispatch_exception_reason) to provide default status/action semantics and follow-up tasks,
--     while still allowing dispatch_stop_policy to override via the settings ladder.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601242310_dispatch_route_stop_finalize_v4'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v4(
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
  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'dispatch_stop');

  v_domain_event_id UUID := NULL;
  v_route_stop_id UUID := NULL;
  v_task_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_task_event_payload JSONB := '{}'::jsonb;
  v_event_created_at TIMESTAMPTZ := NULL;
  v_correlation_id UUID := NULL;

  v_stop RECORD;
  v_ship RECORD;

  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_kind_policy JSONB := '{}'::jsonb;
  v_defaults JSONB := '{}'::jsonb;
  v_outcome_policy JSONB := '{}'::jsonb;
  v_exception_meta JSONB := NULL;

  v_stop_kind TEXT := NULL;
  v_outcome_reason TEXT := NULL;
  v_new_status TEXT := NULL;
  v_action_type TEXT := NULL;
  v_action_category TEXT := NULL;

  v_settings_resolution_id UUID := NULL;
  v_existing BOOLEAN := FALSE;

  -- Evidence policy + extracted artifact ids.
  v_evidence_row RECORD;
  v_evidence_settings_resolution_id UUID := NULL;
  v_evidence_policy JSONB := '{}'::jsonb;
  v_evidence_paths JSONB := '[]'::jsonb;
  v_relation_type TEXT := 'evidence';
  v_invalid_behavior TEXT := 'hard_fail';
  v_artifact_ids UUID[] := NULL;

  v_path TEXT;
  v_matches JSONB;
  v_elem JSONB;
  v_uuid UUID;
  v_expected INT := 0;
  v_found INT := 0;

  v_action_id UUID := NULL;

  -- Follow-up tasks
  v_followup_tasks JSONB := '[]'::jsonb;
  v_followup_tasks_explicit BOOLEAN := FALSE;
  v_followup_ids UUID[] := NULL;
  v_followup_spec JSONB;
  v_followup_task_type_key TEXT;
  v_followup_queue_key TEXT;
  v_followup_priority INT;
  v_followup_sla_minutes INT;
  v_followup_resource_type TEXT;
  v_followup_resource_id UUID;
  v_followup_resource_id_source TEXT;
  v_followup_idempotency_key TEXT;
  v_followup_created RECORD;

  v_resp public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  IF jsonb_typeof(v_payload) <> 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  BEGIN v_domain_event_id := NULLIF(v_ctx->>'domain_event_id', '')::uuid; EXCEPTION WHEN others THEN v_domain_event_id := NULL; END;
  BEGIN v_route_stop_id := NULLIF(v_ctx->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_route_stop_id := NULL; END;
  BEGIN v_task_id := NULLIF(v_payload->>'task_id', '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;
  BEGIN v_task_event_id := NULLIF(v_payload->>'task_event_id', '')::uuid; EXCEPTION WHEN others THEN v_task_event_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_payload->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := NULLIF(btrim(COALESCE(v_payload->>'actor_system', '')), '');
  v_task_event_payload := COALESCE(v_payload->'task_event_payload', '{}'::jsonb);
  BEGIN v_event_created_at := NULLIF(v_payload->>'task_event_created_at', '')::timestamptz; EXCEPTION WHEN others THEN v_event_created_at := NULL; END;
  BEGIN v_correlation_id := NULLIF(v_task_event_payload->>'correlation_id', '')::uuid; EXCEPTION WHEN others THEN v_correlation_id := NULL; END;

  v_outcome_reason := lower(NULLIF(btrim(COALESCE(v_task_event_payload->>'status_reason', '')), ''));

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
    rr.branch_id
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
    s.status AS shipment_status
  INTO v_ship
  FROM public.shipments s
  WHERE s.id = v_stop.shipment_id
    AND s.client_id = v_stop.client_id
  LIMIT 1;

  IF v_ship.shipment_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: shipment % not found for client %', v_stop.shipment_id, v_stop.client_id
      USING ERRCODE = '23503';
  END IF;

  v_stop_kind := lower(COALESCE(NULLIF(btrim(COALESCE(v_stop.stop_kind, '')), ''), 'delivery'));

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'resource_id', v_stop.branch_id,
    'organization_id', v_stop.organization_id,
    'client_id', v_stop.client_id,
    'sender_id', v_ship.sender_id
  ));

  -- Stop policy resolution (controls shipment status/action type).
  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_policy_context_v1('dispatch_stop_policy', v_policy_ctx)
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_policy) <> 'object' THEN
    v_policy := '{}'::jsonb;
  END IF;

  v_defaults := COALESCE(v_policy->'defaults', '{}'::jsonb);
  IF jsonb_typeof(v_defaults) <> 'object' THEN
    v_defaults := '{}'::jsonb;
  END IF;

  v_kind_policy := COALESCE(v_policy->'stop_kind_map'->v_stop_kind, '{}'::jsonb);
  IF jsonb_typeof(v_kind_policy) <> 'object' THEN
    v_kind_policy := '{}'::jsonb;
  END IF;

  -- Base behavior from stop_kind_map.<kind>.
  v_new_status := lower(NULLIF(btrim(COALESCE(v_kind_policy->>'shipment_status', '')), ''));
  v_action_type := lower(NULLIF(btrim(COALESCE(v_kind_policy->>'action_type', v_defaults->>'action_type')), ''));
  v_action_category := lower(NULLIF(btrim(COALESCE(v_kind_policy->>'action_category', v_defaults->>'action_category')), ''));

  -- Optional outcome overrides: stop_kind_map.<kind>.outcome_map.<outcome_reason>.
  -- If outcome_policy is missing, fall back to canonical dispatch_exception_reason taxonomy metadata for known reasons.
  IF v_outcome_reason IS NOT NULL THEN
    v_outcome_policy := COALESCE(v_kind_policy->'outcome_map'->v_outcome_reason, '{}'::jsonb);
    IF jsonb_typeof(v_outcome_policy) <> 'object' THEN
      v_outcome_policy := '{}'::jsonb;
    END IF;

    v_exception_meta := NULL;
    SELECT lv.metadata
      INTO v_exception_meta
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'dispatch_exception_reason'
       AND lv.value = v_outcome_reason
       AND lv.status = 'active'
     LIMIT 1;

    IF jsonb_typeof(v_exception_meta) <> 'object' THEN
      v_exception_meta := NULL;
    END IF;

    v_new_status := lower(NULLIF(btrim(COALESCE(
      v_outcome_policy->>'shipment_status',
      v_exception_meta->>'default_shipment_status',
      v_new_status
    )), ''));
    v_action_type := lower(NULLIF(btrim(COALESCE(
      v_outcome_policy->>'action_type',
      v_exception_meta->>'default_action_type',
      v_action_type
    )), ''));
    v_action_category := lower(NULLIF(btrim(COALESCE(
      v_outcome_policy->>'action_category',
      v_exception_meta->>'default_action_category',
      v_action_category
    )), ''));
  END IF;

  IF v_new_status IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: policy missing stop_kind_map.% for shipment_status', v_stop_kind
      USING ERRCODE = '23514';
  END IF;
  IF v_action_type IS NULL OR v_action_category IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: policy missing defaults action_type/action_category' USING ERRCODE = '23514';
  END IF;

  -- Stop policy provenance (settings ladder + scope path) -> settings_resolution_log.
  IF v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_stop.organization_id,
      p_category := 'dispatch_stop_policy',
      p_winning_scope_type := v_policy_row.scope_type,
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := COALESCE(v_policy_row.version, 1),
      p_scope_path := v_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'route_stop_id', v_route_stop_id,
        'route_run_id', v_stop.route_run_id,
        'branch_id', v_stop.branch_id,
        'shipment_id', v_ship.shipment_id,
        'stop_kind', v_stop_kind,
        'outcome_reason', v_outcome_reason,
        'task_event_id', v_task_event_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  -- Evidence policy resolution (controls how to find artifact ids in task payload).
  SELECT *
    INTO v_evidence_row
    FROM public.resolve_settings_row_from_policy_context_v1('dispatch_evidence_policy', v_policy_ctx)
   LIMIT 1;

  v_evidence_policy := COALESCE(v_evidence_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_evidence_policy) <> 'object' THEN
    v_evidence_policy := '{}'::jsonb;
  END IF;

  v_evidence_paths := COALESCE(v_evidence_policy->'artifact_id_paths', '[]'::jsonb);
  IF jsonb_typeof(v_evidence_paths) <> 'array' THEN
    v_evidence_paths := '[]'::jsonb;
  END IF;

  v_relation_type := lower(COALESCE(NULLIF(btrim(COALESCE(v_evidence_policy->>'relation_type', '')), ''), 'evidence'));
  v_invalid_behavior := lower(COALESCE(NULLIF(btrim(COALESCE(v_evidence_policy->>'invalid_artifact_behavior', '')), ''), 'hard_fail'));
  IF v_invalid_behavior NOT IN ('hard_fail','skip') THEN
    v_invalid_behavior := 'hard_fail';
  END IF;

  -- Evidence policy provenance (settings ladder + scope path) -> settings_resolution_log.
  IF v_evidence_row.settings_id IS NOT NULL THEN
    v_evidence_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_stop.organization_id,
      p_category := 'dispatch_evidence_policy',
      p_winning_scope_type := v_evidence_row.scope_type,
      p_winning_scope_id := v_evidence_row.scope_id,
      p_winning_settings_id := v_evidence_row.settings_id,
      p_winning_settings_version_id := v_evidence_row.settings_version_id,
      p_winning_version := COALESCE(v_evidence_row.version, 1),
      p_scope_path := v_evidence_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'route_stop_id', v_route_stop_id,
        'route_run_id', v_stop.route_run_id,
        'branch_id', v_stop.branch_id,
        'shipment_id', v_ship.shipment_id,
        'stop_kind', v_stop_kind,
        'outcome_reason', v_outcome_reason,
        'task_event_id', v_task_event_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  -- Extract artifact ids (strings) using policy jsonpaths.
  v_artifact_ids := ARRAY[]::uuid[];
  FOR v_path IN
    SELECT jsonb_array_elements_text(v_evidence_paths)
  LOOP
    v_path := NULLIF(btrim(COALESCE(v_path, '')), '');
    IF v_path IS NULL THEN
      CONTINUE;
    END IF;

    BEGIN
      v_matches := jsonb_path_query_array(v_task_event_payload, v_path::jsonpath);
    EXCEPTION WHEN others THEN
      v_matches := '[]'::jsonb;
    END;

    IF jsonb_typeof(v_matches) <> 'array' THEN
      CONTINUE;
    END IF;

    FOR v_elem IN
      SELECT jsonb_array_elements(v_matches)
    LOOP
      IF jsonb_typeof(v_elem) IS DISTINCT FROM 'string' THEN
        CONTINUE;
      END IF;

      BEGIN
        v_uuid := NULLIF(btrim(COALESCE(v_elem#>>'{}', '')), '')::uuid;
      EXCEPTION WHEN others THEN
        v_uuid := NULL;
      END;

      IF v_uuid IS NOT NULL THEN
        v_artifact_ids := array_append(v_artifact_ids, v_uuid);
      END IF;
    END LOOP;
  END LOOP;

  -- Dedupe artifact ids.
  IF array_length(v_artifact_ids, 1) IS NULL THEN
    v_artifact_ids := NULL;
  ELSE
    SELECT array_agg(DISTINCT x)
      INTO v_artifact_ids
      FROM unnest(v_artifact_ids) AS x;
  END IF;

  -- Idempotency: if this task_event already emitted a shipment action, do nothing.
  IF v_task_event_id IS NOT NULL THEN
    SELECT TRUE
      INTO v_existing
      FROM public.shipment_actions sa
     WHERE sa.shipment_id = v_ship.shipment_id
       AND sa.organization_id = v_stop.organization_id
       AND sa.client_id = v_stop.client_id
       AND (sa.action_data->>'task_event_id') = v_task_event_id::text
     LIMIT 1;

    IF v_existing THEN
      PERFORM public.log_decision(
        p_organization_id := v_stop.organization_id,
        p_decision_category := 'dispatch',
        p_resource_type := 'shipment',
        p_resource_id := v_ship.shipment_id,
        p_decision_point := 'route_stop_finalize',
        p_decision_outcome := 'duplicate_ignored',
        p_performed_by_system := 'dispatch_route_stop_finalize_v4',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'route_stop_id', v_route_stop_id,
          'stop_kind', v_stop_kind,
          'outcome_reason', v_outcome_reason,
          'task_event_id', v_task_event_id,
          'domain_event_id', v_domain_event_id,
          'evidence_settings_resolution_id', v_evidence_settings_resolution_id,
          'artifact_ids', v_artifact_ids
        )),
        p_decision_reason := 'shipment_action already exists for task_event_id',
        p_settings_resolution_id := v_settings_resolution_id
      );

      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'route_stop_id', v_route_stop_id,
        'shipment_id', v_ship.shipment_id,
        'status', 'skipped',
        'reason', 'duplicate_task_event'
      ));
      v_resp.context_patch := jsonb_build_object(
        v_context_key,
        jsonb_strip_nulls(jsonb_build_object(
          'shipment_id', v_ship.shipment_id,
          'applied', FALSE,
          'reason', 'duplicate_task_event'
        ))
      );
      RETURN v_resp;
    END IF;
  END IF;

  -- Apply status update.
  UPDATE public.shipments
     SET status = v_new_status,
         status_updated_at = COALESCE(v_event_created_at, now()),
         updated_at = now()
   WHERE id = v_ship.shipment_id
     AND client_id = v_stop.client_id;

  -- Insert shipment action and capture id for evidence links.
  INSERT INTO public.shipment_actions (
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    canonical_status,
    performed_by_user_id,
    performed_by_system,
    action_data,
    timestamp
  ) VALUES (
    v_ship.shipment_id,
    v_stop.organization_id,
    v_stop.client_id,
    v_action_type,
    v_action_category,
    v_new_status,
    v_actor_user_id,
    COALESCE(v_actor_system, 'workflow_engine'),
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_stop.route_run_id,
      'route_stop_id', v_route_stop_id,
      'stop_kind', v_stop_kind,
      'outcome_reason', v_outcome_reason,
      'task_id', v_task_id,
      'task_event_id', v_task_event_id,
      'domain_event_id', v_domain_event_id,
      'workflow_run_id', p_run.id,
      'settings_resolution_id', v_settings_resolution_id,
      'evidence_settings_resolution_id', v_evidence_settings_resolution_id,
      'artifact_ids', v_artifact_ids,
      'task_event_payload', v_task_event_payload
    )),
    COALESCE(v_event_created_at, now())
  )
  RETURNING id INTO v_action_id;

  -- Link artifacts to shipment_action (policy-driven, org-safe).
  IF v_artifact_ids IS NOT NULL THEN
    v_expected := array_length(v_artifact_ids, 1);

    SELECT COUNT(*)::int
      INTO v_found
      FROM public.artifacts a
     WHERE a.organization_id = v_stop.organization_id
       AND a.id = ANY (v_artifact_ids);

    IF v_found <> v_expected AND v_invalid_behavior = 'hard_fail' THEN
      RAISE EXCEPTION 'route_stop_finalize: invalid artifact_ids (expected %, found %) for org %', v_expected, v_found, v_stop.organization_id
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.artifact_links (
      organization_id,
      artifact_id,
      resource_type,
      resource_id,
      relation_type,
      metadata
    )
    SELECT
      v_stop.organization_id,
      a.id,
      'shipment_action',
      v_action_id,
      v_relation_type,
      jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_ship.shipment_id,
        'route_stop_id', v_route_stop_id,
        'task_event_id', v_task_event_id,
        'workflow_run_id', p_run.id
      ))
    FROM public.artifacts a
    WHERE a.organization_id = v_stop.organization_id
      AND a.id = ANY (v_artifact_ids)
    ON CONFLICT (organization_id, artifact_id, resource_type, resource_id, relation_type)
    DO NOTHING;
  END IF;

  -- Follow-up tasks (optional): outcome_policy.followup_tasks[] (service-only; idempotent).
  v_followup_tasks_explicit := (jsonb_typeof(v_outcome_policy) = 'object' AND (v_outcome_policy ? 'followup_tasks'));
  v_followup_tasks := COALESCE(v_outcome_policy->'followup_tasks', '[]'::jsonb);
  IF jsonb_typeof(v_followup_tasks) <> 'array' THEN
    v_followup_tasks := '[]'::jsonb;
  END IF;

  IF NOT v_followup_tasks_explicit AND jsonb_array_length(v_followup_tasks) = 0 THEN
    v_followup_task_type_key := lower(NULLIF(btrim(COALESCE(v_exception_meta->>'recommended_followup_task_type_key', '')), ''));
    IF v_followup_task_type_key IS NOT NULL THEN
      v_followup_tasks := jsonb_build_array(
        jsonb_build_object('task_type_key', v_followup_task_type_key, 'resource_id_source', 'shipment')
      );
    END IF;
  END IF;

  v_followup_ids := ARRAY[]::uuid[];
  FOR v_followup_spec IN
    SELECT jsonb_array_elements(v_followup_tasks)
  LOOP
    v_followup_task_type_key := NULL;
    v_followup_queue_key := NULL;
    v_followup_priority := NULL;
    v_followup_sla_minutes := NULL;
    v_followup_resource_type := NULL;
    v_followup_resource_id := NULL;
    v_followup_resource_id_source := NULL;

    IF jsonb_typeof(v_followup_spec) = 'string' THEN
      v_followup_task_type_key := lower(NULLIF(btrim(COALESCE(v_followup_spec#>>'{}', '')), ''));
    ELSIF jsonb_typeof(v_followup_spec) = 'object' THEN
      v_followup_task_type_key := lower(NULLIF(btrim(COALESCE(v_followup_spec->>'task_type_key', '')), ''));
      v_followup_queue_key := NULLIF(btrim(COALESCE(v_followup_spec->>'queue_key', '')), '');
      BEGIN v_followup_priority := NULLIF(v_followup_spec->>'priority', '')::int; EXCEPTION WHEN others THEN v_followup_priority := NULL; END;
      BEGIN v_followup_sla_minutes := NULLIF(v_followup_spec->>'sla_minutes', '')::int; EXCEPTION WHEN others THEN v_followup_sla_minutes := NULL; END;
      v_followup_resource_type := lower(NULLIF(btrim(COALESCE(v_followup_spec->>'resource_type', '')), ''));
      v_followup_resource_id_source := lower(NULLIF(btrim(COALESCE(v_followup_spec->>'resource_id_source', '')), ''));
      BEGIN v_followup_resource_id := NULLIF(v_followup_spec->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_followup_resource_id := NULL; END;
    END IF;

    IF v_followup_task_type_key IS NULL THEN
      CONTINUE;
    END IF;

    IF v_followup_resource_type IS NULL THEN
      v_followup_resource_type := 'shipment';
    END IF;

    IF v_followup_resource_id IS NULL THEN
      v_followup_resource_id_source := COALESCE(v_followup_resource_id_source, 'shipment');
      IF v_followup_resource_id_source = 'shipment' THEN
        v_followup_resource_id := v_ship.shipment_id;
      ELSIF v_followup_resource_id_source = 'route_stop' THEN
        v_followup_resource_id := v_route_stop_id;
      ELSIF v_followup_resource_id_source = 'route_run' THEN
        v_followup_resource_id := v_stop.route_run_id;
      ELSIF v_followup_resource_id_source = 'shipment_action' THEN
        v_followup_resource_id := v_action_id;
      ELSE
        v_followup_resource_id := v_ship.shipment_id;
      END IF;
    END IF;

    v_followup_idempotency_key := NULL;
    IF v_task_event_id IS NOT NULL THEN
      v_followup_idempotency_key := format('dispatch_stop_followup:%s:%s', v_task_event_id, v_followup_task_type_key);
    END IF;

    BEGIN
      SELECT *
        INTO v_followup_created
        FROM public.create_task_system_v1(
          jsonb_strip_nulls(jsonb_build_object(
            'task_type_key', v_followup_task_type_key,
            'context', jsonb_strip_nulls(jsonb_build_object(
              'organization_id', v_stop.organization_id,
              'client_id', v_stop.client_id,
              'sender_id', v_ship.sender_id,
              'branch_id', v_stop.branch_id,
              'shipment_id', v_ship.shipment_id,
              'route_run_id', v_stop.route_run_id,
              'route_stop_id', v_route_stop_id,
              'shipment_action_id', v_action_id,
              'outcome_reason', v_outcome_reason
            )),
            'resource_type', v_followup_resource_type,
            'resource_id', v_followup_resource_id,
            'queue_key', v_followup_queue_key,
            'priority', v_followup_priority,
            'sla_minutes', v_followup_sla_minutes,
            'idempotency_key', v_followup_idempotency_key,
            'metadata', jsonb_strip_nulls(jsonb_build_object(
              'parent_workflow_run_id', p_run.id,
              'parent_workflow_step_id', p_step.id,
              'shipment_action_id', v_action_id
            )),
            'actor_system', 'dispatch_engine'
          ))
        )
       LIMIT 1;

      IF v_followup_created.task_id IS NOT NULL THEN
        v_followup_ids := array_append(v_followup_ids, v_followup_created.task_id);
      END IF;
    EXCEPTION
      WHEN others THEN
        PERFORM public.log_decision(
          p_organization_id := v_stop.organization_id,
          p_decision_category := 'dispatch',
          p_resource_type := 'shipment',
          p_resource_id := v_ship.shipment_id,
          p_decision_point := 'route_stop_followup_task',
          p_decision_outcome := 'exception',
          p_performed_by_system := 'dispatch_route_stop_finalize_v4',
          p_correlation_id := v_correlation_id,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'route_stop_id', v_route_stop_id,
            'stop_kind', v_stop_kind,
            'outcome_reason', v_outcome_reason,
            'task_event_id', v_task_event_id,
            'task_type_key', v_followup_task_type_key,
            'resource_type', v_followup_resource_type,
            'resource_id', v_followup_resource_id
          )),
          p_decision_reason := SQLERRM,
          p_settings_resolution_id := v_settings_resolution_id
        );
    END;
  END LOOP;

  -- Dedupe followup ids.
  IF array_length(v_followup_ids, 1) IS NULL THEN
    v_followup_ids := NULL;
  ELSE
    SELECT array_agg(DISTINCT x)
      INTO v_followup_ids
      FROM unnest(v_followup_ids) AS x;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_stop.organization_id,
    p_decision_category := 'dispatch',
    p_resource_type := 'shipment',
    p_resource_id := v_ship.shipment_id,
    p_decision_point := 'route_stop_finalize',
    p_decision_outcome := 'updated',
    p_performed_by_system := 'dispatch_route_stop_finalize_v4',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_ship.shipment_status,
      'new_status', v_new_status,
      'route_stop_id', v_route_stop_id,
      'stop_kind', v_stop_kind,
      'outcome_reason', v_outcome_reason,
      'task_event_id', v_task_event_id,
      'domain_event_id', v_domain_event_id,
      'shipment_action_id', v_action_id,
      'evidence_settings_resolution_id', v_evidence_settings_resolution_id,
      'artifact_ids', v_artifact_ids,
      'artifact_relation_type', v_relation_type,
      'artifact_invalid_behavior', v_invalid_behavior,
      'followup_task_ids', v_followup_ids
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settings_resolution_id
  );

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'route_stop_id', v_route_stop_id,
    'shipment_id', v_ship.shipment_id,
    'applied', TRUE,
    'shipment_status', v_new_status,
    'shipment_action_id', v_action_id,
    'artifact_ids', v_artifact_ids,
    'followup_task_ids', v_followup_ids
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_ship.shipment_id,
      'applied', TRUE,
      'shipment_status', v_new_status,
      'shipment_action_id', v_action_id,
      'followup_task_ids', v_followup_ids
    ))
  );

  RETURN v_resp;
END;
$function$;

-------------------------------------------------------------------------------
-- 4) Operation handler registry: route_stop_finalize -> v4
-------------------------------------------------------------------------------

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
  'execute_route_stop_finalize_v4',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v4',
  TRUE,
  'Finalize a dispatch route_stop execution: policy-driven outcome_reason overrides + shipment status/actions; link evidence artifacts; optionally enqueue follow-up tasks (idempotent by task_event_id). Includes taxonomy defaults for known exception reasons.',
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
-- 5) Update workflow template step metadata to handler_version=v4 (idempotent)
-------------------------------------------------------------------------------

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
     SET handler_version = 'v4',
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'route_stop_finalize';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601242310_dispatch_route_stop_finalize_v4'));
COMMIT;
