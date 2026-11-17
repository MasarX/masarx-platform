-- Plan: PLAN-202603-webhook-shipment-ingestion-contract-hardening / Step: S04
-- Migration: Sync shipments.print_labels scoped command contract from global SSOT
-- Purpose:
--   - Remove contract drift between the global shipments.print_labels command row and scoped ui_command_registry overrides.
--   - Keep the latest print-label execution contract row-driven by copying the current global execution/workflow settings into every scoped row.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603131110_ui_command_registry_shipments_print_labels_scope_contract_sync_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_global_value JSONB;
  v_global_command JSONB := NULL;
  v_global_execution JSONB := '{}'::jsonb;
  v_global_workflow_key JSONB := NULL;
  v_setting RECORD;
  v_item JSONB;
  v_updated JSONB;
  v_commands JSONB;
  v_current_value JSONB;
  v_next_item JSONB;
  v_found BOOLEAN;
  v_changed BOOLEAN;
  v_total_found INTEGER := 0;
BEGIN
  SELECT sv.value
    INTO v_global_value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   ORDER BY s.last_updated DESC
   LIMIT 1;

  IF v_global_value IS NULL THEN
    RAISE EXCEPTION 'ui_command_registry global settings missing';
  END IF;

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(COALESCE(v_global_value->'commands', '[]'::jsonb))
  LOOP
    IF v_item->>'key' = 'shipments.print_labels' THEN
      v_global_command := v_item;
      EXIT;
    END IF;
  END LOOP;

  IF v_global_command IS NULL THEN
    RAISE EXCEPTION 'shipments.print_labels command missing in global ui_command_registry';
  END IF;

  v_global_execution := COALESCE(v_global_command->'execution', '{}'::jsonb);
  v_global_workflow_key := v_global_command->'workflow_key';

  FOR v_setting IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.value AS current_value,
           sv.version AS current_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_current_value := COALESCE(v_setting.current_value, '{}'::jsonb);
    v_commands := COALESCE(v_current_value->'commands', '[]'::jsonb);
    v_updated := '[]'::jsonb;
    v_found := false;
    v_changed := false;

    FOR v_item IN
      SELECT value
        FROM jsonb_array_elements(v_commands)
    LOOP
      v_next_item := v_item;

      IF v_item->>'key' = 'shipments.print_labels' THEN
        v_found := true;
        v_next_item := jsonb_set(v_next_item, '{execution}', v_global_execution, true);

        IF v_global_workflow_key IS NULL OR v_global_workflow_key = 'null'::jsonb THEN
          v_next_item := v_next_item - 'workflow_key';
        ELSE
          v_next_item := jsonb_set(v_next_item, '{workflow_key}', v_global_workflow_key, true);
        END IF;

        IF v_next_item IS DISTINCT FROM v_item THEN
          v_changed := true;
        END IF;
      END IF;

      v_updated := v_updated || jsonb_build_array(v_next_item);
    END LOOP;

    IF v_found THEN
      v_total_found := v_total_found + 1;
    END IF;

    IF v_found AND v_changed THEN
      v_current_value := jsonb_set(v_current_value, '{commands}', v_updated, true);

      UPDATE public.settings_versions sv
         SET value = v_current_value,
             version = v_setting.current_version + 1,
             change_reason = 'Sync shipments.print_labels scoped command contract from global SSOT',
             approved_at = now(),
             effective_from = now()
       WHERE sv.id = v_setting.settings_version_id;

      UPDATE public.settings s
         SET cached_value = v_current_value,
             last_updated = now()
       WHERE s.id = v_setting.settings_id;
    END IF;
  END LOOP;

  IF v_total_found = 0 THEN
    RAISE EXCEPTION 'shipments.print_labels command missing in all ui_command_registry settings rows';
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202603131110_ui_command_registry_shipments_print_labels_scope_contract_sync_v1'));
COMMIT;
