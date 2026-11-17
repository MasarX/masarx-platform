-- Migration: retune shipments.print_labels interactive progression budgets
-- Purpose:
--   - Give the command start enough budget to dispatch/complete small hybrid print runs without long status-path stalls.
--   - Keep status polling responsive by restoring a short poll-managed progress budget after execute wait becomes budget-aware.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063220_shipments_print_labels_interactive_budget_v3'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current jsonb;
  v_commands jsonb := '[]'::jsonb;
  v_updated jsonb := '[]'::jsonb;
  v_item jsonb;
  v_execution jsonb;
  v_params jsonb;
  v_workflow_start jsonb;
  v_found boolean := false;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_command_registry global settings missing';
  END IF;

  v_commands := COALESCE(v_current->'commands', '[]'::jsonb);

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_commands) LOOP
    IF v_item->>'key' = 'shipments.print_labels' THEN
      v_found := true;
      v_execution := COALESCE(v_item->'execution', '{}'::jsonb);
      v_params := COALESCE(v_execution->'params', '{}'::jsonb);
      v_workflow_start := COALESCE(v_params->'workflow_start', '{}'::jsonb);
      IF jsonb_typeof(v_workflow_start) IS DISTINCT FROM 'object' THEN
        v_workflow_start := '{}'::jsonb;
      END IF;

      v_workflow_start := v_workflow_start || jsonb_build_object(
        'inline_kick_enabled', true,
        'inline_kick_max_attempts', 4,
        'inline_kick_budget_ms', 2500,
        'inline_kick_poll_ms', 40
      );

      v_params := v_params || jsonb_build_object(
        'poll_progress_enabled', true,
        'poll_progress_budget_ms', 400,
        'poll_progress_max_steps', 12,
        'workflow_start', v_workflow_start
      );

      v_execution := jsonb_set(v_execution, '{params}', v_params, true);
      v_item := jsonb_set(v_item, '{execution}', v_execution, true);
    END IF;

    v_updated := v_updated || jsonb_build_array(v_item);
  END LOOP;

  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'shipments.print_labels command missing in ui_command_registry';
  END IF;

  v_current := jsonb_set(v_current, '{commands}', v_updated, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Shipments print labels contract: retune interactive command/status budgets for budget-aware execute wait',
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
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202603063220_shipments_print_labels_interactive_budget_v3'));
COMMIT;
