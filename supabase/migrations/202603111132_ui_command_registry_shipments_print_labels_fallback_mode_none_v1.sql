-- Plan: PLAN-202603-marketplace-network-dev-convergence-closeout / Step: S03
-- Migration: Reconcile shipments.print_labels fallback_mode to none across ui_command_registry scopes

BEGIN;
SELECT pg_advisory_lock(hashtext('202603111132_ui_command_registry_shipments_print_labels_fallback_mode_none_v1'));
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
        v_params := v_params || jsonb_build_object('fallback_mode', 'none');
        v_execution := jsonb_set(v_execution, '{params}', v_params, true);

        IF v_execution IS DISTINCT FROM COALESCE(v_item->'execution', '{}'::jsonb) THEN
          v_changed := true;
        END IF;

        v_item := jsonb_set(v_item, '{execution}', v_execution, true);
      END IF;

      v_updated := v_updated || jsonb_build_array(v_item);
    END LOOP;

    IF v_found AND v_changed THEN
      v_new_value := jsonb_set(v_setting.current_value, '{commands}', v_updated, true);

      UPDATE public.settings_versions sv
         SET value = v_new_value,
             version = v_setting.current_version + 1,
             change_reason = 'Reconcile shipments.print_labels fallback_mode contract to none',
             approved_at = now(),
             effective_from = now()
       WHERE sv.id = v_setting.settings_version_id;

      UPDATE public.settings s
         SET cached_value = v_new_value,
             last_updated = now()
       WHERE s.id = v_setting.settings_id;
    END IF;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202603111132_ui_command_registry_shipments_print_labels_fallback_mode_none_v1'));
COMMIT;
