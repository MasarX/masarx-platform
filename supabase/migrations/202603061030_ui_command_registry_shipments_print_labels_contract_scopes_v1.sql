-- Plan: PLAN-202603-go-live-readiness-remediation-v4 / Step: S04
-- Purpose:
--   - Enforce the one-click shipments.print_labels execution contract for every
--     ui_command_registry scope row (global + scoped overrides).
--   - Keep behavior row-driven by normalizing existing registry rows in-place.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061030_ui_command_registry_shipments_print_labels_contract_scopes_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_setting RECORD;
  v_item JSONB;
  v_commands JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_execution JSONB;
  v_params JSONB;
  v_new_value JSONB;
  v_found BOOLEAN;
  v_changed BOOLEAN;
  v_total_found INTEGER := 0;
  v_default_output_paths JSONB := jsonb_build_array(
    'context.generated_labels[0].download_url',
    'context.generated_labels[0].url',
    'context.outputs[0].download_url',
    'context.outputs[0].url',
    'context.output.url',
    'metadata.generated_labels[0].download_url',
    'metadata.generated_labels[0].url',
    'metadata.outputs[0].download_url',
    'metadata.outputs[0].url',
    'metadata.output.url'
  );
BEGIN
  FOR v_setting IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.value AS current_value,
           sv.version AS current_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_commands := COALESCE(v_setting.current_value->'commands', '[]'::jsonb);
    v_updated := '[]'::jsonb;
    v_found := false;
    v_changed := false;

    FOR v_item IN
      SELECT value
        FROM jsonb_array_elements(v_commands)
    LOOP
      IF v_item->>'key' = 'shipments.print_labels' THEN
        v_found := true;

        v_execution := COALESCE(v_item->'execution', '{}'::jsonb);
        v_params := COALESCE(v_execution->'params', '{}'::jsonb);

        v_params := v_params || jsonb_build_object(
          'payload_key', COALESCE(NULLIF(v_params->>'payload_key', ''), 'shipments'),
          'selection_id_key', COALESCE(NULLIF(v_params->>'selection_id_key', ''), 'shipment_id'),
          'auto_download', true,
          'output_url_paths',
            CASE
              WHEN jsonb_typeof(v_params->'output_url_paths') = 'array'
                   AND jsonb_array_length(v_params->'output_url_paths') > 0
                THEN v_params->'output_url_paths'
              ELSE v_default_output_paths
            END,
          'poll_interval_ms', 1500,
          'poll_timeout_ms', 45000,
          'fallback_mode', 'open_run_outputs'
        );

        v_execution := jsonb_set(v_execution, '{type}', '"print"', true);
        v_execution := jsonb_set(v_execution, '{rpc}', '"ui_execute_command_v1"', true);
        v_execution := jsonb_set(v_execution, '{params}', v_params, true);

        IF v_execution IS DISTINCT FROM COALESCE(v_item->'execution', '{}'::jsonb) THEN
          v_changed := true;
        END IF;

        v_item := jsonb_set(v_item, '{execution}', v_execution, true);
      END IF;

      v_updated := v_updated || jsonb_build_array(v_item);
    END LOOP;

    IF v_found THEN
      v_total_found := v_total_found + 1;
    END IF;

    IF v_found AND v_changed THEN
      v_new_value := jsonb_set(v_setting.current_value, '{commands}', v_updated, true);

      UPDATE public.settings_versions sv
         SET value = v_new_value,
             version = v_setting.current_version + 1,
             change_reason = 'Enforce shipments.print_labels one-click contract across command-registry scopes',
             approved_at = now(),
             effective_from = now()
       WHERE sv.id = v_setting.settings_version_id;

      UPDATE public.settings s
         SET cached_value = v_new_value,
             last_updated = now()
       WHERE s.id = v_setting.settings_id;
    END IF;
  END LOOP;

  IF v_total_found = 0 THEN
    RAISE EXCEPTION 'shipments.print_labels command missing in all ui_command_registry settings rows';
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202603061030_ui_command_registry_shipments_print_labels_contract_scopes_v1'));
COMMIT;
