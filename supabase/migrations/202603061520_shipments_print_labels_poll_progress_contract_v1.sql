-- Migration: Extend shipments.print_labels contract with row-driven poll progression knobs
-- Purpose:
--  - Make in-page workflow progression explicit in the command-row contract.
--  - Keep poll progression row-driven and fail-closed for print actions.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061520_shipments_print_labels_poll_progress_contract_v1'));
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

      v_params := v_params || jsonb_build_object(
        'auto_download', true,
        'fallback_mode', 'none',
        'poll_progress_enabled', true,
        'poll_progress_budget_ms', 350,
        'poll_progress_max_steps', 8,
        'output_url_paths', jsonb_build_array(
          'context.generated_labels[0].download_url',
          'context.generated_labels[0].url',
          'context.outputs[0].download_url',
          'context.outputs[0].url',
          'context.output.url',
          'context.label_print.bundle_response.signed_url',
          'context.label_print.bundle_response.file_url',
          'metadata.generated_labels[0].download_url',
          'metadata.generated_labels[0].url',
          'metadata.outputs[0].download_url',
          'metadata.outputs[0].url',
          'metadata.output.url',
          'metadata.label_print.bundle_response.signed_url',
          'metadata.label_print.bundle_response.file_url',
          'step_result.signed_url',
          'step_result.output_url',
          'step_result.file_url',
          'step_result.bundle.signed_url',
          'step_result.bundle.output_url',
          'step_result.bundle.file_url',
          'step_result.bundle.output_file_url',
          'async_body.bundle.signed_url',
          'async_body.bundle.output_url',
          'async_body.bundle.file_url',
          'async_body.bundle.output_file_url',
          'async_body.signed_url',
          'async_body.output_url',
          'async_response.body.bundle.signed_url',
          'async_response.body.bundle.output_url',
          'async_response.body.bundle.file_url',
          'async_response.body.bundle.output_file_url',
          'async_response.body.signed_url',
          'async_response.body.output_url'
        )
      );

      v_execution := jsonb_set(v_execution, '{type}', '"print"', true);
      v_execution := jsonb_set(v_execution, '{rpc}', '"ui_execute_command_v1"', true);
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
           change_reason = 'Shipments print labels contract: row-driven poll progression + async output paths',
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

SELECT pg_advisory_unlock(hashtext('202603061520_shipments_print_labels_poll_progress_contract_v1'));
COMMIT;
