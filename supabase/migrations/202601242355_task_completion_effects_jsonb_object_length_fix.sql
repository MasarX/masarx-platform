-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Fix task_completion_effects handler (avoid jsonb_object_length)
-- Date: 2026-01-24
--
-- Note:
--   In this Postgres build, jsonb_object_length(jsonb) is not available.
--   Treat empty objects via jsonb_strip_nulls(v) = '{}'::jsonb instead.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601242355_task_completion_effects_jsonb_object_length_fix'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_task_completion_effects_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'task_effects');

  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);

  v_domain_event_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_task_id UUID := NULL;
  v_task_type_key TEXT := lower(NULLIF(btrim(COALESCE(v_payload->>'task_type_key', '')), ''));

  v_org_id UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;

  v_resource_type TEXT := lower(NULLIF(btrim(COALESCE(v_payload->>'resource_type', '')), ''));
  v_resource_id UUID := NULL;

  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(v_payload->>'actor_system', '')), '');
  v_task_event_payload JSONB := COALESCE(v_payload->'task_event_payload', '{}'::jsonb);
  v_task_event_created_at TIMESTAMPTZ := NULL;

  v_task public.tasks%ROWTYPE;
  v_ship RECORD;

  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_defaults JSONB := '{}'::jsonb;
  v_effect JSONB := '{}'::jsonb;

  v_settings_resolution_id UUID := NULL;

  v_new_status TEXT := NULL;
  v_action_type TEXT := NULL;
  v_action_category TEXT := NULL;

  v_existing BOOLEAN := FALSE;
  v_action_id UUID := NULL;

  v_resp public.workflow_handler_response;
BEGIN
  BEGIN v_domain_event_id := NULLIF(v_ctx->>'domain_event_id', '')::uuid; EXCEPTION WHEN others THEN v_domain_event_id := NULL; END;
  BEGIN v_task_event_id := NULLIF(v_payload->>'task_event_id', '')::uuid; EXCEPTION WHEN others THEN v_task_event_id := NULL; END;
  BEGIN v_task_id := NULLIF(v_payload->>'task_id', '')::uuid; EXCEPTION WHEN others THEN v_task_id := NULL; END;
  BEGIN v_resource_id := NULLIF(v_payload->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_payload->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  BEGIN v_task_event_created_at := NULLIF(v_payload->>'task_event_created_at', '')::timestamptz; EXCEPTION WHEN others THEN v_task_event_created_at := NULL; END;

  BEGIN v_org_id := NULLIF(v_payload->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_payload->>'client_id', '')::uuid; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_sender_id := NULLIF(v_payload->>'sender_id', '')::uuid; EXCEPTION WHEN others THEN v_sender_id := NULL; END;

  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects: missing payload.task_id (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  SELECT * INTO v_task
  FROM public.tasks t
  WHERE t.id = v_task_id
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_completion_effects: task not found: %', v_task_id USING ERRCODE = '23503';
  END IF;

  v_org_id := COALESCE(v_org_id, v_task.organization_id);
  v_client_id := COALESCE(v_client_id, v_task.client_id);
  v_sender_id := COALESCE(v_sender_id, v_task.sender_id);
  v_resource_type := COALESCE(v_resource_type, lower(NULLIF(btrim(COALESCE(v_task.resource_type, '')), '')));
  v_resource_id := COALESCE(v_resource_id, v_task.resource_id);

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects: organization_id missing (task_id=%)', v_task_id;
  END IF;

  IF v_task_type_key IS NULL THEN
    SELECT tt.key INTO v_task_type_key
    FROM public.task_types tt
    WHERE tt.id = v_task.task_type_id
    LIMIT 1;
    v_task_type_key := lower(NULLIF(btrim(COALESCE(v_task_type_key, '')), ''));
  END IF;
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects: task_type_key missing (task_id=%)', v_task_id;
  END IF;

  -- Resolve effects policy via ladder.
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'sender_id', v_sender_id
  ));

  SELECT * INTO v_policy_row
  FROM public.resolve_settings_row_from_policy_context_v1('task_completion_effects_policy', v_policy_ctx)
  LIMIT 1;

  IF FOUND AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  IF v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'task_completion_effects_policy',
      p_winning_scope_type := v_policy_row.scope_type,
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := v_policy_row.version,
      p_scope_path := v_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type_key,
        'resource_type', v_resource_type
      )),
      p_merge_notes := NULL
    );
  END IF;

  v_defaults := jsonb_strip_nulls(COALESCE(v_policy->'defaults', '{}'::jsonb));
  v_effect := COALESCE(v_policy#>ARRAY['task_type_map', v_task_type_key], '{}'::jsonb);
  IF jsonb_typeof(v_effect) IS DISTINCT FROM 'object' THEN
    v_effect := '{}'::jsonb;
  END IF;
  v_effect := jsonb_strip_nulls(v_effect);

  IF v_effect = '{}'::jsonb THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'task',
      p_resource_type := 'task',
      p_resource_id := v_task_id,
      p_decision_point := 'completion_effects',
      p_decision_outcome := 'skipped',
      p_performed_by_system := 'task_completion_effects_v1',
      p_correlation_id := public.current_correlation_id(),
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type_key,
        'resource_type', v_resource_type,
        'resource_id', v_resource_id,
        'task_event_id', v_task_event_id,
        'domain_event_id', v_domain_event_id
      )),
      p_decision_reason := 'no_effect_spec',
      p_settings_resolution_id := v_settings_resolution_id
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'applied', FALSE,
      'reason', 'no_effect_spec'
    ));
    v_resp.context_patch := jsonb_build_object(
      v_context_key,
      jsonb_strip_nulls(jsonb_build_object(
        'applied', FALSE,
        'reason', 'no_effect_spec'
      ))
    );
    RETURN v_resp;
  END IF;

  v_new_status := lower(NULLIF(btrim(COALESCE(v_effect->>'shipment_status', '')), ''));
  v_action_type := lower(NULLIF(btrim(COALESCE(v_effect->>'action_type', v_defaults->>'action_type', '')), ''));
  v_action_category := lower(NULLIF(btrim(COALESCE(v_effect->>'action_category', v_defaults->>'action_category', '')), ''));

  IF v_resource_type IS DISTINCT FROM 'shipment' OR v_resource_id IS NULL THEN
    PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'task',
      p_resource_type := 'task',
      p_resource_id := v_task_id,
      p_decision_point := 'completion_effects',
      p_decision_outcome := 'skipped',
      p_performed_by_system := 'task_completion_effects_v1',
      p_correlation_id := public.current_correlation_id(),
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', v_task_type_key,
        'resource_type', v_resource_type,
        'resource_id', v_resource_id,
        'task_event_id', v_task_event_id,
        'domain_event_id', v_domain_event_id
      )),
      p_decision_reason := 'unsupported_resource',
      p_settings_resolution_id := v_settings_resolution_id
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'applied', FALSE,
      'reason', 'unsupported_resource'
    ));
    v_resp.context_patch := jsonb_build_object(
      v_context_key,
      jsonb_strip_nulls(jsonb_build_object(
        'applied', FALSE,
        'reason', 'unsupported_resource'
      ))
    );
    RETURN v_resp;
  END IF;

  IF v_action_type IS NULL OR v_action_category IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects: missing action_type/action_category for task_type_key=%', v_task_type_key
      USING ERRCODE = '23514';
  END IF;

  -- Load shipment (partition-safe when client_id is present).
  IF v_client_id IS NOT NULL THEN
    SELECT s.id AS shipment_id,
           s.client_id,
           s.organization_id,
           s.status AS shipment_status
      INTO v_ship
      FROM public.shipments s
     WHERE s.id = v_resource_id
       AND s.client_id = v_client_id
     LIMIT 1;
  ELSE
    SELECT s.id AS shipment_id,
           s.client_id,
           s.organization_id,
           s.status AS shipment_status
      INTO v_ship
      FROM public.shipments s
     WHERE s.id = v_resource_id
     LIMIT 1;
  END IF;

  IF v_ship.shipment_id IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects: shipment not found: %', v_resource_id USING ERRCODE = '23503';
  END IF;

  IF v_ship.organization_id IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'task_completion_effects: shipment org mismatch (shipment org %, task org %)', v_ship.organization_id, v_org_id
      USING ERRCODE = '23514';
  END IF;

  -- Idempotency: if this task_event already emitted a shipment action, do nothing.
  IF v_task_event_id IS NOT NULL THEN
    SELECT TRUE
      INTO v_existing
      FROM public.shipment_actions sa
     WHERE sa.shipment_id = v_ship.shipment_id
       AND sa.organization_id = v_org_id
       AND sa.client_id = v_ship.client_id
       AND (sa.action_data->>'task_event_id') = v_task_event_id::text
     LIMIT 1;

    IF v_existing THEN
      PERFORM public.log_decision(
        p_organization_id := v_org_id,
        p_decision_category := 'task',
        p_resource_type := 'shipment',
        p_resource_id := v_ship.shipment_id,
        p_decision_point := 'completion_effects',
        p_decision_outcome := 'duplicate_ignored',
        p_performed_by_system := 'task_completion_effects_v1',
        p_correlation_id := public.current_correlation_id(),
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'task_id', v_task_id,
          'task_type_key', v_task_type_key,
          'task_event_id', v_task_event_id,
          'domain_event_id', v_domain_event_id,
          'workflow_run_id', p_run.id
        )),
        p_decision_reason := 'shipment_action already exists for task_event_id',
        p_settings_resolution_id := v_settings_resolution_id
      );

      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_ship.shipment_id,
        'applied', FALSE,
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

  IF v_new_status IS NOT NULL THEN
    UPDATE public.shipments
       SET status = v_new_status,
           status_updated_at = COALESCE(v_task_event_created_at, now()),
           updated_at = now()
     WHERE id = v_ship.shipment_id
       AND client_id = v_ship.client_id;
  END IF;

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
    v_org_id,
    v_ship.client_id,
    v_action_type,
    v_action_category,
    v_new_status,
    v_actor_user_id,
    COALESCE(v_actor_system, 'workflow_engine'),
    jsonb_strip_nulls(jsonb_build_object(
      'task_id', v_task_id,
      'task_event_id', v_task_event_id,
      'task_type_key', v_task_type_key,
      'domain_event_id', v_domain_event_id,
      'workflow_run_id', p_run.id,
      'settings_resolution_id', v_settings_resolution_id,
      'task_event_payload', v_task_event_payload
    )),
    COALESCE(v_task_event_created_at, now())
  )
  RETURNING id INTO v_action_id;

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'task',
    p_resource_type := 'shipment',
    p_resource_id := v_ship.shipment_id,
    p_decision_point := 'completion_effects',
    p_decision_outcome := 'updated',
    p_performed_by_system := 'task_completion_effects_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_ship.shipment_status,
      'new_status', v_new_status,
      'task_id', v_task_id,
      'task_type_key', v_task_type_key,
      'task_event_id', v_task_event_id,
      'domain_event_id', v_domain_event_id,
      'workflow_run_id', p_run.id,
      'shipment_action_id', v_action_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settings_resolution_id
  );

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_ship.shipment_id,
    'applied', TRUE,
    'shipment_status', v_new_status,
    'shipment_action_id', v_action_id
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_ship.shipment_id,
      'applied', TRUE,
      'shipment_status', v_new_status,
      'shipment_action_id', v_action_id
    ))
  );

  RETURN v_resp;
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202601242355_task_completion_effects_jsonb_object_length_fix'));
COMMIT;

