-- Migration: shipments.print_labels low-latency contract retune v6
-- Purpose:
--   - Reduce command-start latency by shrinking inline workflow work in the command request.
--   - Shift more progression into poll-managed status checks with an earlier row-driven cadence.
--   - Keep the print contract fail-closed and zero-redirect.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063440_shipments_print_labels_low_latency_contract_v6'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_commands JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_item JSONB;
  v_execution JSONB;
  v_params JSONB;
  v_workflow_start JSONB;
  v_found BOOLEAN := false;
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

      v_workflow_start := v_workflow_start || jsonb_build_object(
        'inline_kick_enabled', true,
        'inline_kick_max_attempts', 1,
        'inline_kick_budget_ms', 200,
        'inline_kick_poll_ms', 20
      );

      v_params := v_params || jsonb_build_object(
        'poll_progress_enabled', true,
        'poll_progress_budget_ms', 1500,
        'poll_progress_max_steps', 16,
        'poll_interval_ms', 1500,
        'poll_schedule_ms', jsonb_build_array(25, 50, 75, 100, 150, 225, 350, 500, 750, 1000, 1500)
      );
      v_params := jsonb_set(v_params, '{workflow_start}', v_workflow_start, true);

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
           change_reason = 'Retune shipments.print_labels for lower-latency command return and earlier status progression',
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

SELECT pg_advisory_unlock(hashtext('202603063440_shipments_print_labels_low_latency_contract_v6'));
COMMIT;
