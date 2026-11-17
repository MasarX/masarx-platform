-- Plan: PLAN-202604-b05-transfer-execution-surface / Step: S01
-- Migration: UC067 warehouse transfer dispatch UI contract v1
-- Date: 2026-04-06
--
-- Goals:
--   - Expose a browser-safe Portal/Console action to release a draft
--     warehouse_transfer into the canonical warehouse_transfer_execute_v1 workflow.
--   - Keep the movement lifecycle workflow-engine first by starting the
--     existing template and waking it through public.progress_workflow_run.
--   - Avoid widening ui_execute_command_v1 for transfer-specific context.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061130_uc067_warehouse_transfer_dispatch_ui_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Dedicated UI executor for warehouse transfer dispatch
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_warehouse_transfer_dispatch_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_execution JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_selection_id_text TEXT := NULL;
  v_selection_uuid UUID := NULL;
  v_visible_transfer JSONB := NULL;
  v_transfer public.warehouse_transfers%ROWTYPE;
  v_template_id UUID := NULL;
  v_workflow_run_id UUID := NULL;
  v_existing_workflow_status TEXT := NULL;
  v_started BOOLEAN := FALSE;
  v_progress JSONB := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_dispatch_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_dispatch_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_dispatch_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_dispatch_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
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
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_dispatch_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_dispatch_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);

  v_selection_id_text := COALESCE(
    NULLIF(v_id, ''),
    CASE WHEN array_length(v_ids, 1) IS NOT NULL THEN v_ids[1] ELSE NULL END
  );

  BEGIN
    v_selection_uuid := NULLIF(btrim(COALESCE(v_selection_id_text, '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_selection_uuid := NULL;
  END;

  IF v_selection_uuid IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_dispatch_v1 invalid warehouse_transfer id %', v_selection_id_text;
  END IF;

  v_visible_transfer := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
  IF v_visible_transfer IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_dispatch_v1 warehouse_transfer % is not visible in resource %', v_selection_uuid, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_transfer
    FROM public.warehouse_transfers wt
   WHERE wt.id = v_selection_uuid
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_dispatch_v1 warehouse_transfer % not found', v_selection_uuid
      USING ERRCODE = '23503';
  END IF;

  IF lower(COALESCE(v_transfer.status, '')) <> 'draft' THEN
    RAISE EXCEPTION
      'ui_execute_warehouse_transfer_dispatch_v1 only supports draft warehouse_transfers (current status %)',
      v_transfer.status
      USING ERRCODE = '23514';
  END IF;

  SELECT wt.id
    INTO v_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = 'warehouse_transfer_execute_v1'
     AND wt.status = 'active'
   ORDER BY wt.version DESC
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_dispatch_v1 workflow template not found: warehouse_transfer_execute_v1';
  END IF;

  SELECT wr.id, wr.workflow_status
    INTO v_workflow_run_id, v_existing_workflow_status
    FROM public.workflow_runs wr
    JOIN public.workflow_templates wt
      ON wt.id = wr.workflow_template_id
   WHERE wt.name = 'warehouse_transfer_execute_v1'
     AND wr.context->>'warehouse_transfer_id' = v_transfer.id::text
     AND COALESCE(wr.context->>'organization_id', v_transfer.organization_id::text) = v_transfer.organization_id::text
     AND wr.workflow_status IN ('pending', 'in_progress')
   ORDER BY wr.created_at DESC
   LIMIT 1;

  IF v_workflow_run_id IS NULL THEN
    v_workflow_run_id := public.start_workflow_run(
      v_template_id,
      jsonb_strip_nulls(
        jsonb_build_object(
          'organization_id', v_transfer.organization_id,
          'warehouse_transfer_id', v_transfer.id,
          'from_branch_id', v_transfer.from_branch_id,
          'to_branch_id', v_transfer.to_branch_id,
          'vehicle_id', v_transfer.vehicle_id,
          'driver_user_id', v_transfer.driver_user_id,
          'requested_by', v_user_id,
          'resource_key', p_resource_key,
          'action_key', p_action_key,
          'dispatch_request', CASE
            WHEN jsonb_typeof(v_params) = 'object' AND v_params <> '{}'::jsonb THEN v_params
            ELSE NULL
          END
        )
      )
    );
    v_started := TRUE;
    v_existing_workflow_status := 'pending';
  END IF;

  v_progress := COALESCE(
    public.progress_workflow_run(
      v_workflow_run_id,
      jsonb_build_object(
        'source', 'ui_execute_warehouse_transfer_dispatch_v1',
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'requested_by', v_user_id::text,
        'warehouse_transfer_id', v_transfer.id::text
      )
    ),
    '{}'::jsonb
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'status', CASE WHEN v_started THEN 'workflow_started' ELSE 'workflow_existing' END,
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'workflow_run_id', v_workflow_run_id,
      'workflow_template_id', v_template_id,
      'workflow_status', COALESCE(NULLIF(v_progress->>'status', ''), v_existing_workflow_status, 'pending'),
      'warehouse_transfer_id', v_transfer.id,
      'transfer_status', v_transfer.status,
      'started', v_started,
      'count', 1,
      'progress', CASE
        WHEN jsonb_typeof(v_progress) = 'object' AND v_progress <> '{}'::jsonb THEN v_progress
        ELSE NULL
      END,
      'items', jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'warehouse_transfer_id', v_transfer.id,
            'workflow_run_id', v_workflow_run_id,
            'transfer_status', v_transfer.status,
            'started', v_started
          )
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_warehouse_transfer_dispatch_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Release a visible draft warehouse_transfer into the canonical warehouse_transfer_execute_v1 workflow without widening ui_execute_command_v1.';

REVOKE ALL ON FUNCTION public.ui_execute_warehouse_transfer_dispatch_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_warehouse_transfer_dispatch_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_warehouse_transfer_dispatch_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_warehouse_transfer_dispatch_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_execute_warehouse_transfer_dispatch_v1($1, $2, $3, $4, $5, $6);
$fn$;

REVOKE ALL ON FUNCTION api.ui_execute_warehouse_transfer_dispatch_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_warehouse_transfer_dispatch_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_warehouse_transfer_dispatch_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) ui_command_registry: warehouse transfer dispatch command
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_canonical_commands JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['warehouse_transfers.dispatch'],
    jsonb_build_object(
      'key', 'warehouse_transfers.dispatch',
      'label', 'Dispatch transfer',
      'description', 'Release the selected draft transfer manifest into the canonical pack, dispatch, receive, and reconcile workflow.',
      'capability', 'warehouse_transfers.write',
      'schema_category', 'resource:warehouse_transfers',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'workflow',
        'rpc', 'ui_execute_warehouse_transfer_dispatch_v1',
        'params', '{}'::jsonb,
        'confirm', jsonb_build_object(
          'title', 'Dispatch transfer movement?',
          'description', 'This starts the canonical pack, dispatch, receive, and reconcile workflow for the selected draft transfer manifest.',
          'confirm_label', 'Dispatch transfer',
          'cancel_label', 'Cancel',
          'tone', 'default'
        )
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_command_key = 'warehouse_transfers.dispatch' THEN
        v_command := public.deep_merge_jsonb(v_canonical_commands->v_command_key, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers.dispatch'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->'warehouse_transfers.dispatch');
    END IF;

    v_next := jsonb_set(v_current, ARRAY['commands'], v_next_commands, TRUE);
    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose warehouse_transfers.dispatch through ui_command_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604061130_uc067_warehouse_transfer_dispatch_ui_contract_v1'));
COMMIT;
