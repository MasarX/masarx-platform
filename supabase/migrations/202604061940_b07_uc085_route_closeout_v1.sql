-- Plan: B07 FieldOps route closeout / UC085
-- Migration: Route closeout command + helper v1
-- Purpose:
-- - Add a route-closeout command on the existing task command surface so FieldOps can
--   persist end-of-day checklist state without inventing a second execution path.
-- - Keep route-run completion canonical in shipment/finalize workflows by recording
--   closeout metadata only; this helper never forces route_runs.status to completed.
-- - Derive the route run from the selected route_stop_execute task and persist leftover
--   counts plus unresolved follow-up task visibility on route_runs.metadata.route_closeout.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061940_b07_uc085_route_closeout_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH canonical_commands AS (
  SELECT
    1000003::bigint AS ord,
    jsonb_build_object(
      'key', 'tasks.close_route',
      'label', 'Close route',
      'description', 'Persist route closeout checklist, leftovers, and unresolved exception visibility.',
      'capability', 'tasks.complete',
      'schema_category', 'resource:tasks',
      'selection', jsonb_build_object('mode', 'single', 'id_param', 'id'),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'payload_key', 'payload',
        'confirm', jsonb_build_object(
          'title', 'Queue route closeout',
          'description', 'Persist the route closeout checklist and leftover counts for the selected route.',
          'confirm_label', 'Queue closeout'
        ),
        'params', jsonb_build_object(
          'handler', 'route_closeout',
          'route_closeout', jsonb_build_object(
            'confirmation_token', 'confirmed',
            'required_confirmations', jsonb_build_array(
              'vehicle_secured_ack',
              'proofs_synced_ack',
              'exceptions_reviewed_ack'
            ),
            'leftover_count_key', 'leftover_stop_count',
            'leftover_notes_key', 'leftover_notes',
            'closeout_notes_key', 'closeout_notes'
          ),
          'payload', jsonb_build_object()
        ),
        'input_schema', jsonb_build_object(
          'version', 1,
          'fields', jsonb_build_array(
            jsonb_build_object(
              'key', 'vehicle_secured_ack',
              'label', 'Vehicle secured',
              'type', 'text',
              'required', true,
              'default_value', 'confirmed',
              'placeholder', 'confirmed'
            ),
            jsonb_build_object(
              'key', 'proofs_synced_ack',
              'label', 'Proofs synced',
              'type', 'text',
              'required', true,
              'default_value', 'confirmed',
              'placeholder', 'confirmed'
            ),
            jsonb_build_object(
              'key', 'exceptions_reviewed_ack',
              'label', 'Exceptions reviewed',
              'type', 'text',
              'required', true,
              'default_value', 'confirmed',
              'placeholder', 'confirmed'
            ),
            jsonb_build_object(
              'key', 'leftover_stop_count',
              'label', 'Leftover stop count',
              'type', 'number',
              'required', true,
              'placeholder', '0'
            ),
            jsonb_build_object(
              'key', 'leftover_notes',
              'label', 'Leftover notes',
              'type', 'textarea',
              'required', false,
              'placeholder', 'List leftover parcels, branch handoff notes, or return reasons.'
            ),
            jsonb_build_object(
              'key', 'closeout_notes',
              'label', 'Closeout notes',
              'type', 'textarea',
              'required', true,
              'placeholder', 'Summarize route-end findings, blockers, and handoff context.'
            )
          )
        )
      )
    ) AS command
),
target_rows AS (
  SELECT
    s.id AS settings_id,
    s.settings_version_id,
    sv.version,
    sv.value
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
  WHERE s.category = 'ui_command_registry'
),
rewritten AS (
  SELECT
    tr.settings_id,
    tr.settings_version_id,
    tr.version,
    tr.value,
    jsonb_set(
      tr.value,
      '{commands}',
      COALESCE(
        (
          SELECT jsonb_agg(next_item.command ORDER BY next_item.ord)
          FROM (
            SELECT
              existing.ord::bigint AS ord,
              existing.item AS command
            FROM jsonb_array_elements(COALESCE(tr.value->'commands', '[]'::jsonb))
              WITH ORDINALITY AS existing(item, ord)
            WHERE existing.item->>'key' <> 'tasks.close_route'

            UNION ALL

            SELECT cc.ord, cc.command
            FROM canonical_commands cc
          ) AS next_item
        ),
        '[]'::jsonb
      ),
      true
    ) AS next_value
  FROM target_rows tr
),
changed AS (
  SELECT
    r.settings_id,
    r.settings_version_id,
    r.version,
    r.next_value
  FROM rewritten r
  WHERE r.next_value IS DISTINCT FROM r.value
),
applied AS (
  UPDATE public.settings_versions sv
     SET value = c.next_value,
         version = COALESCE(c.version, 0) + 1,
         change_reason = 'Add route closeout task command for FieldOps UC085',
         approved_at = now(),
         effective_from = now()
    FROM changed c
   WHERE sv.id = c.settings_version_id
  RETURNING sv.id, sv.value, c.settings_id
)
UPDATE public.settings s
   SET cached_value = a.value,
       last_updated = now()
  FROM applied a
 WHERE s.id = a.settings_id;

CREATE OR REPLACE FUNCTION public.close_route_run_v1(
  p_input JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_payload JSONB := '{}'::jsonb;
  v_effective_input JSONB := '{}'::jsonb;
  v_config JSONB := '{}'::jsonb;

  v_task_id UUID := NULL;
  v_confirmation_token TEXT := 'confirmed';
  v_required_confirmations TEXT[] := ARRAY['vehicle_secured_ack', 'proofs_synced_ack', 'exceptions_reviewed_ack'];
  v_leftover_count_key TEXT := 'leftover_stop_count';
  v_leftover_notes_key TEXT := 'leftover_notes';
  v_closeout_notes_key TEXT := 'closeout_notes';
  v_requested_leftover_count INT := 0;
  v_leftover_notes TEXT := NULL;
  v_closeout_notes TEXT := NULL;

  v_confirmation_key TEXT;
  v_confirmation_value TEXT;
  v_checklist JSONB := '{}'::jsonb;

  v_task RECORD;
  v_total_stop_count INT := 0;
  v_completed_stop_count INT := 0;
  v_remaining_stop_count INT := 0;
  v_unresolved_exception_count INT := 0;
  v_unresolved_exception_task_ids JSONB := '[]'::jsonb;
  v_remaining_stop_ids JSONB := '[]'::jsonb;
  v_remaining_shipment_ids JSONB := '[]'::jsonb;

  v_existing_route_closeout JSONB := '{}'::jsonb;
  v_route_closeout JSONB := '{}'::jsonb;
  v_route_status TEXT := NULL;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'close_route_run_v1 requires object input' USING ERRCODE = '22023';
  END IF;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'close_route_run_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'close_route_run_v1 requires organization scope' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('tasks.complete', v_scope_type, v_scope_id);

  IF jsonb_typeof(v_input->'payload') = 'object' THEN
    v_payload := v_input->'payload';
  END IF;
  v_effective_input := (v_input - 'payload') || v_payload;

  IF jsonb_typeof(v_input->'route_closeout') = 'object' THEN
    v_config := v_input->'route_closeout';
  END IF;

  v_confirmation_token := lower(COALESCE(NULLIF(v_config->>'confirmation_token', ''), v_confirmation_token));

  IF jsonb_typeof(v_config->'required_confirmations') = 'array' THEN
    SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
      INTO v_required_confirmations
      FROM jsonb_array_elements_text(v_config->'required_confirmations') AS value;
    IF COALESCE(array_length(v_required_confirmations, 1), 0) = 0 THEN
      v_required_confirmations := ARRAY['vehicle_secured_ack', 'proofs_synced_ack', 'exceptions_reviewed_ack'];
    END IF;
  END IF;

  v_leftover_count_key := COALESCE(NULLIF(v_config->>'leftover_count_key', ''), v_leftover_count_key);
  v_leftover_notes_key := COALESCE(NULLIF(v_config->>'leftover_notes_key', ''), v_leftover_notes_key);
  v_closeout_notes_key := COALESCE(NULLIF(v_config->>'closeout_notes_key', ''), v_closeout_notes_key);

  BEGIN
    v_task_id := NULLIF(v_effective_input->>'task_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'close_route_run_v1 invalid task_id' USING ERRCODE = '22P02';
  END;

  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'close_route_run_v1 requires task_id' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_requested_leftover_count := COALESCE(NULLIF(v_effective_input->>v_leftover_count_key, '')::INT, 0);
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'close_route_run_v1 % must be an integer', v_leftover_count_key USING ERRCODE = '22P02';
  END;

  IF v_requested_leftover_count < 0 THEN
    RAISE EXCEPTION 'close_route_run_v1 % cannot be negative', v_leftover_count_key USING ERRCODE = '23514';
  END IF;

  v_leftover_notes := NULLIF(btrim(COALESCE(v_effective_input->>v_leftover_notes_key, '')), '');
  v_closeout_notes := NULLIF(btrim(COALESCE(v_effective_input->>v_closeout_notes_key, '')), '');

  IF v_closeout_notes IS NULL THEN
    RAISE EXCEPTION 'close_route_run_v1 % is required', v_closeout_notes_key USING ERRCODE = '23514';
  END IF;

  FOREACH v_confirmation_key IN ARRAY v_required_confirmations LOOP
    v_confirmation_value := lower(NULLIF(btrim(COALESCE(v_effective_input->>v_confirmation_key, '')), ''));
    IF v_confirmation_value IS DISTINCT FROM v_confirmation_token THEN
      RAISE EXCEPTION
        'close_route_run_v1 % must equal %',
        v_confirmation_key,
        v_confirmation_token
        USING ERRCODE = '23514';
    END IF;

    v_checklist := v_checklist || jsonb_build_object(
      v_confirmation_key,
      jsonb_build_object(
        'status', v_confirmation_value,
        'confirmed', TRUE
      )
    );
  END LOOP;

  SELECT
    t.id,
    t.organization_id,
    t.assigned_to,
    lower(NULLIF(btrim(COALESCE(tt.key, '')), '')) AS task_type_key,
    rs.id AS route_stop_id,
    rs.shipment_id,
    rr.id AS route_run_id,
    rr.driver_user_id,
    rr.status AS route_run_status,
    rr.metadata AS route_run_metadata
  INTO v_task
  FROM public.tasks t
  LEFT JOIN public.task_types tt
    ON tt.id = t.task_type_id
  JOIN public.route_stops rs
    ON t.resource_type = 'route_stop'
   AND rs.id = t.resource_id
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
  WHERE t.id = v_task_id
    AND t.organization_id = v_org_id
  LIMIT 1;

  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'close_route_run_v1 task not found: %', v_task_id USING ERRCODE = '23503';
  END IF;

  IF COALESCE(v_task.task_type_key, '') <> 'route_stop_execute' THEN
    RAISE EXCEPTION 'close_route_run_v1 supports route_stop_execute tasks only' USING ERRCODE = '23514';
  END IF;

  IF COALESCE(lower(v_task.route_run_status), '') = 'canceled' THEN
    RAISE EXCEPTION 'close_route_run_v1 does not allow canceled routes' USING ERRCODE = '23514';
  END IF;

  IF v_scope_type = 'tenant'
     AND v_task.driver_user_id IS NOT NULL
     AND v_task.driver_user_id <> v_actor_id
     AND (v_task.assigned_to IS NULL OR v_task.assigned_to <> v_actor_id) THEN
    RAISE EXCEPTION 'close_route_run_v1 requires route ownership' USING ERRCODE = '42501';
  END IF;

  SELECT
    COUNT(*)::INT AS total_stop_count,
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM public.shipment_actions sa
        WHERE sa.organization_id = v_org_id
          AND (sa.action_data->>'route_run_id') = v_task.route_run_id::text
          AND (sa.action_data->>'route_stop_id') = rs.id::text
      )
    )::INT AS completed_stop_count,
    COALESCE(
      jsonb_agg(rs.id ORDER BY rs.sequence_order, rs.created_at) FILTER (
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.shipment_actions sa
          WHERE sa.organization_id = v_org_id
            AND (sa.action_data->>'route_run_id') = v_task.route_run_id::text
            AND (sa.action_data->>'route_stop_id') = rs.id::text
        )
      ),
      '[]'::jsonb
    ) AS remaining_stop_ids,
    COALESCE(
      jsonb_agg(rs.shipment_id ORDER BY rs.sequence_order, rs.created_at) FILTER (
        WHERE rs.shipment_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.shipment_actions sa
            WHERE sa.organization_id = v_org_id
              AND (sa.action_data->>'route_run_id') = v_task.route_run_id::text
              AND (sa.action_data->>'route_stop_id') = rs.id::text
          )
      ),
      '[]'::jsonb
    ) AS remaining_shipment_ids
  INTO
    v_total_stop_count,
    v_completed_stop_count,
    v_remaining_stop_ids,
    v_remaining_shipment_ids
  FROM public.route_stops rs
  WHERE rs.route_run_id = v_task.route_run_id;

  v_remaining_stop_count := GREATEST(v_total_stop_count - v_completed_stop_count, 0);

  IF v_requested_leftover_count <> v_remaining_stop_count THEN
    RAISE EXCEPTION
      'close_route_run_v1 % mismatch: expected %, got %',
      v_leftover_count_key,
      v_remaining_stop_count,
      v_requested_leftover_count
      USING ERRCODE = '23514';
  END IF;

  IF v_remaining_stop_count > 0 AND v_leftover_notes IS NULL THEN
    RAISE EXCEPTION 'close_route_run_v1 % is required when leftovers remain', v_leftover_notes_key USING ERRCODE = '23514';
  END IF;

  SELECT
    COUNT(*)::INT,
    COALESCE(jsonb_agg(t.id ORDER BY t.created_at), '[]'::jsonb)
  INTO
    v_unresolved_exception_count,
    v_unresolved_exception_task_ids
  FROM public.tasks t
  LEFT JOIN public.task_types tt
    ON tt.id = t.task_type_id
  WHERE t.organization_id = v_org_id
    AND t.id <> v_task_id
    AND COALESCE(t.completed_at, t.canceled_at) IS NULL
    AND lower(COALESCE(t.status, '')) NOT IN ('completed', 'canceled')
    AND lower(COALESCE(tt.key, '')) <> 'route_stop_execute'
    AND (
      (
        t.resource_type = 'route_stop'
        AND EXISTS (
          SELECT 1
          FROM public.route_stops rs
          WHERE rs.route_run_id = v_task.route_run_id
            AND rs.id = t.resource_id
        )
      )
      OR (
        t.resource_type = 'shipment'
        AND EXISTS (
          SELECT 1
          FROM public.route_stops rs
          WHERE rs.route_run_id = v_task.route_run_id
            AND rs.shipment_id = t.resource_id
        )
      )
    );

  v_existing_route_closeout := COALESCE(v_task.route_run_metadata->'route_closeout', '{}'::jsonb);

  v_route_closeout := jsonb_strip_nulls(
    COALESCE(v_existing_route_closeout, '{}'::jsonb)
    || jsonb_build_object(
      'checklist', v_checklist,
      'closeout_requested_at', now(),
      'closeout_requested_by', v_actor_id,
      'closeout_task_id', v_task_id,
      'route_stop_id', v_task.route_stop_id,
      'leftover_stop_count', v_requested_leftover_count,
      'leftover_notes', v_leftover_notes,
      'closeout_notes', v_closeout_notes,
      'total_stop_count', v_total_stop_count,
      'completed_stop_count', v_completed_stop_count,
      'remaining_stop_count', v_remaining_stop_count,
      'remaining_stop_ids', v_remaining_stop_ids,
      'remaining_shipment_ids', v_remaining_shipment_ids,
      'unresolved_exception_count', v_unresolved_exception_count,
      'unresolved_exception_task_ids', v_unresolved_exception_task_ids
    )
  );

  UPDATE public.route_runs rr
     SET metadata = jsonb_set(
           COALESCE(rr.metadata, '{}'::jsonb),
           '{route_closeout}',
           v_route_closeout,
           TRUE
         ),
         updated_at = now()
   WHERE rr.id = v_task.route_run_id;

  SELECT rr.status
    INTO v_route_status
    FROM public.route_runs rr
   WHERE rr.id = v_task.route_run_id
   LIMIT 1;

  RETURN jsonb_build_object(
    'task_id', v_task_id,
    'route_run_id', v_task.route_run_id,
    'route_stop_id', v_task.route_stop_id,
    'route_run_status', v_route_status,
    'leftover_stop_count', v_requested_leftover_count,
    'remaining_stop_count', v_remaining_stop_count,
    'completed_stop_count', v_completed_stop_count,
    'total_stop_count', v_total_stop_count,
    'unresolved_exception_count', v_unresolved_exception_count,
    'route_closeout', v_route_closeout
  );
END;
$$;

COMMENT ON FUNCTION public.close_route_run_v1(JSONB)
  IS 'Persist route closeout checklist, leftovers, and unresolved follow-up visibility for the route resolved from a selected route_stop_execute task. Does not force route_runs.status transitions.';

CREATE OR REPLACE FUNCTION public.ui_execute_command_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[],
  p_selection_id TEXT,
  p_selection_count INTEGER,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB;
  v_execution JSONB;
  v_capability TEXT;
  v_selection JSONB;
  v_mode TEXT;
  v_min INT;
  v_max INT;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_handler TEXT;
  v_static_params JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_patch JSONB;
  v_payload_key TEXT;
  v_selection_key TEXT;
  v_payload JSONB;
  v_context JSONB;
  v_template_id UUID;
  v_run_id UUID;
  v_results JSONB := '[]'::jsonb;
  v_item JSONB;
  v_workflow_start JSONB := '{}'::jsonb;
  v_inline_kick_enabled BOOLEAN := FALSE;
  v_inline_kick_max_attempts INT := 0;
  v_inline_kick_budget_ms INT := 0;
  v_inline_kick_poll_ms INT := 0;
  v_inline_attempts INT := 0;
  v_inline_elapsed_ms INT := 0;
  v_inline_progress JSONB := '{}'::jsonb;
  v_inline_status TEXT := NULL;
  v_inline_error TEXT := NULL;
  v_inline_next_run_at TIMESTAMPTZ := NULL;
  v_inline_enabled_raw TEXT := '';
  v_inline_max_raw TEXT := '';
  v_inline_budget_raw TEXT := '';
  v_inline_poll_raw TEXT := '';

  v_requested_to_status TEXT;
  v_requested_status_reason TEXT;
  v_idempotency_key TEXT;
  v_transition_payload JSONB;
  v_transition_row RECORD;
  v_task RECORD;
  v_policy_row RECORD;
  v_exception_reason TEXT;
  v_reason_required BOOLEAN;
  v_effective_to_status TEXT;
  v_effective_status_reason TEXT;
  v_task_type_key TEXT;
BEGIN
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_command_v1 requires action key';
  END IF;

  SELECT value INTO v_command
    FROM jsonb_array_elements(v_registry->'commands') AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_command_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := v_command->'selection';
  v_mode := lower(COALESCE(v_selection->>'mode', ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_command_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_command_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_static_params := COALESCE(v_execution->'params', '{}'::jsonb);
  v_params := v_static_params || COALESCE(p_params, '{}'::jsonb);
  v_handler := lower(COALESCE(NULLIF(v_params->>'handler', ''), ''));
  v_patch := COALESCE(v_params->'patch', '{}'::jsonb);

  IF COALESCE(v_command->>'workflow_key', '') <> ''
     OR (v_execution->>'type') = 'workflow'
     OR (v_execution->>'type') = 'print' THEN
    IF COALESCE(v_command->>'workflow_key', '') = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow key missing for %', p_action_key;
    END IF;

    SELECT id INTO v_template_id
      FROM public.workflow_templates
     WHERE name = v_command->>'workflow_key'
       AND status = 'active'
     ORDER BY version DESC
     LIMIT 1;

    IF v_template_id IS NULL THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow template not found %', v_command->>'workflow_key';
    END IF;

    v_payload_key := NULLIF(v_params->>'payload_key', '');
    v_selection_key := NULLIF(v_params->>'selection_id_key', '');
    IF v_payload_key IS NULL THEN
      v_payload_key := 'selections';
    END IF;
    IF v_selection_key IS NULL THEN
      v_selection_key := 'id';
    END IF;

    v_payload := jsonb_build_object(
      v_payload_key,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(v_selection_key, value)) FROM unnest(v_ids) AS value),
        '[]'::jsonb
      ),
      'selection_ids', to_jsonb(v_ids),
      'selection_id', v_id,
      'selection_count', v_count,
      'resource_key', p_resource_key,
      'organization_id', public.current_user_org_id()
    );

    v_context := jsonb_build_object(
      'organization_id', public.current_user_org_id(),
      'requested_by', auth.uid(),
      'payload', v_payload,
      'ui_command', jsonb_build_object(
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'params', p_params
      )
    );

    v_run_id := public.start_workflow_run(v_template_id, v_context);

    v_workflow_start := COALESCE(v_params->'workflow_start', '{}'::jsonb);
    IF jsonb_typeof(v_workflow_start) IS DISTINCT FROM 'object' THEN
      v_workflow_start := '{}'::jsonb;
    END IF;

    v_inline_enabled_raw := lower(COALESCE(NULLIF(v_workflow_start->>'inline_kick_enabled', ''), ''));
    v_inline_kick_enabled := v_inline_enabled_raw IN ('1', 't', 'true', 'y', 'yes', 'on');

    IF v_inline_kick_enabled THEN
      v_inline_max_raw := COALESCE(v_workflow_start->>'inline_kick_max_attempts', '');
      v_inline_budget_raw := COALESCE(v_workflow_start->>'inline_kick_budget_ms', '');
      v_inline_poll_raw := COALESCE(v_workflow_start->>'inline_kick_poll_ms', '');

      IF v_inline_max_raw ~ '^\d+$' THEN
        v_inline_kick_max_attempts := LEAST(GREATEST(v_inline_max_raw::INT, 1), 20);
      ELSE
        v_inline_kick_max_attempts := 1;
      END IF;

      IF v_inline_budget_raw ~ '^\d+$' THEN
        v_inline_kick_budget_ms := LEAST(GREATEST(v_inline_budget_raw::INT, 25), 5000);
      ELSE
        v_inline_kick_budget_ms := 150;
      END IF;

      IF v_inline_poll_raw ~ '^\d+$' THEN
        v_inline_kick_poll_ms := LEAST(GREATEST(v_inline_poll_raw::INT, 10), 500);
      ELSE
        v_inline_kick_poll_ms := 40;
      END IF;

      BEGIN
        v_inline_progress := public.progress_workflow_run_until_wait_v1(
          v_run_id,
          jsonb_build_object(
            'source', 'ui_execute_command_inline',
            'action_key', p_action_key
          ),
          v_inline_kick_budget_ms,
          v_inline_kick_max_attempts
        );
        v_inline_attempts := COALESCE(NULLIF(v_inline_progress->>'attempts', '')::INT, 0);
        v_inline_elapsed_ms := COALESCE(NULLIF(v_inline_progress->>'elapsed_ms', '')::INT, 0);
        v_inline_status := NULLIF(v_inline_progress->>'status', '');

        BEGIN
          v_inline_next_run_at := NULLIF(v_inline_progress->>'next_run_at', '')::TIMESTAMPTZ;
        EXCEPTION WHEN OTHERS THEN
          v_inline_next_run_at := NULL;
        END;
      EXCEPTION WHEN OTHERS THEN
        v_inline_error := SQLERRM;
      END;
    END IF;

    RETURN jsonb_build_object(
      'status', 'workflow_started',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'workflow_run_id', v_run_id,
      'workflow_inline_kick', jsonb_strip_nulls(jsonb_build_object(
        'enabled', v_inline_kick_enabled,
        'attempts', CASE WHEN v_inline_kick_enabled THEN v_inline_attempts ELSE NULL END,
        'max_attempts', CASE WHEN v_inline_kick_enabled THEN v_inline_kick_max_attempts ELSE NULL END,
        'budget_ms', CASE WHEN v_inline_kick_enabled THEN v_inline_kick_budget_ms ELSE NULL END,
        'poll_ms', CASE WHEN v_inline_kick_enabled THEN v_inline_kick_poll_ms ELSE NULL END,
        'elapsed_ms', CASE WHEN v_inline_kick_enabled THEN v_inline_elapsed_ms ELSE NULL END,
        'status', CASE WHEN v_inline_kick_enabled THEN v_inline_status ELSE NULL END,
        'next_run_at', CASE WHEN v_inline_kick_enabled THEN v_inline_next_run_at ELSE NULL END,
        'error', CASE WHEN v_inline_kick_enabled THEN v_inline_error ELSE NULL END
      ))
    );
  END IF;

  IF v_handler = 'resource_update' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;
    IF jsonb_typeof(v_patch) <> 'object' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 patch must be object';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.ui_update_resource_v1(p_resource_key, v_id, v_patch);
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;
    RETURN jsonb_build_object(
      'status', 'updated',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'resource_delete' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.ui_delete_resource_v1(p_resource_key, v_id);
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;
    RETURN jsonb_build_object(
      'status', 'deleted',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'task_transition' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;

    v_requested_to_status := lower(COALESCE(NULLIF(v_params->>'to_status', ''), ''));
    IF v_requested_to_status = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 task_transition requires to_status';
    END IF;

    v_requested_status_reason := NULLIF(COALESCE(v_params->>'status_reason', ''), '');
    v_transition_payload := COALESCE(v_params->'payload', '{}'::jsonb);

    FOREACH v_id IN ARRAY v_ids LOOP
      v_effective_to_status := v_requested_to_status;
      v_effective_status_reason := v_requested_status_reason;
      v_task_type_key := NULL;

      IF v_requested_to_status = 'exception' THEN
        SELECT
          t.id,
          t.organization_id,
          t.client_id,
          t.sender_id,
          t.resource_type,
          t.resource_id,
          lower(NULLIF(btrim(COALESCE(tt.key, '')), '')) AS task_type_key
          INTO v_task
          FROM public.tasks t
          LEFT JOIN public.task_types tt
            ON tt.id = t.task_type_id
         WHERE t.id = v_id::uuid
         LIMIT 1;

        IF v_task.id IS NULL THEN
          RAISE EXCEPTION 'ui_execute_command_v1 task_transition task not found: %', v_id USING ERRCODE = '23503';
        END IF;

        v_task_type_key := v_task.task_type_key;

        SELECT *
          INTO v_policy_row
          FROM public.resolve_pod_policy(
            jsonb_strip_nulls(
              jsonb_build_object(
                'organization_id', v_task.organization_id,
                'client_id', v_task.client_id,
                'sender_id', v_task.sender_id,
                'resource_type', v_task.resource_type,
                'resource_id', v_task.resource_id
              )
            )
          )
        LIMIT 1;

        v_reason_required := COALESCE(
          (v_policy_row.value->'requirements'->'exception'->>'exception_reason_required')::boolean,
          TRUE
        );

        v_exception_reason := lower(NULLIF(btrim(COALESCE(v_transition_payload->>'exception_reason', '')), ''));

        IF v_reason_required AND v_exception_reason IS NULL THEN
          RAISE EXCEPTION 'ui_execute_command_v1 exception transition requires payload.exception_reason' USING ERRCODE = '23514';
        END IF;

        IF v_exception_reason IS NOT NULL
           AND public.is_active_lookup_value_v1('dispatch_exception_reason', v_exception_reason, TRUE) IS FALSE THEN
          RAISE EXCEPTION 'ui_execute_command_v1 invalid exception_reason: %', v_exception_reason USING ERRCODE = '23514';
        END IF;

        IF v_exception_reason IS NOT NULL THEN
          v_transition_payload := jsonb_set(v_transition_payload, '{exception_reason}', to_jsonb(v_exception_reason), TRUE);
        END IF;

        IF v_task_type_key = 'route_stop_execute' THEN
          v_effective_to_status := 'completed';
          v_effective_status_reason := COALESCE(v_exception_reason, v_requested_status_reason, 'other');
        END IF;
      END IF;

      v_idempotency_key := encode(
        digest(
          format('%s|%s|%s|%s', p_action_key, v_effective_to_status, v_id, v_transition_payload::text),
          'sha256'
        ),
        'hex'
      );

      SELECT * INTO v_transition_row
      FROM public.transition_task_v1(
        p_task_id := v_id::uuid,
        p_to_status := v_effective_to_status,
        p_status_reason := v_effective_status_reason,
        p_payload := v_transition_payload,
        p_idempotency_key := v_idempotency_key
      )
      LIMIT 1;

      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'task_id', v_transition_row.task_id,
          'task_event_id', v_transition_row.task_event_id,
          'to_status', v_effective_to_status,
          'status_reason', v_effective_status_reason
        )
      );
    END LOOP;

    RETURN jsonb_build_object(
      'status', 'task_transitioned',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'to_status', v_requested_to_status,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'route_closeout' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;

    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.close_route_run_v1(
        jsonb_strip_nulls(
          COALESCE(v_params, '{}'::jsonb)
          || jsonb_build_object('task_id', v_id)
        )
      );
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;

    RETURN jsonb_build_object(
      'status', 'route_closed_out',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  RAISE EXCEPTION 'ui_execute_command_v1 missing handler for %', p_action_key;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202604061940_b07_uc085_route_closeout_v1'));
COMMIT;
