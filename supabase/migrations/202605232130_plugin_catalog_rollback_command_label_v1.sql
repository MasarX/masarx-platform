-- Console V2 plugin catalog rollback command wording.
-- The RPC performs deterministic active-version rollback, not plugin deletion.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605232130_plugin_catalog_rollback_command_label_v1'));

DO $commands$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_commands JSONB;
  v_next_commands JSONB;
  v_command JSONB;
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"commands":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_scope.value, '{"commands":[]}'::jsonb);
    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN SELECT value FROM jsonb_array_elements(v_commands) AS value LOOP
      IF v_command->>'key' = 'integrations.uninstall_plugin'
         AND v_command->>'target' = 'integration_plugin_rollback_v1' THEN
        v_command := jsonb_set(
          v_command,
          '{label}',
          to_jsonb('Rollback integration plugin release'::text),
          true
        );
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    v_current := jsonb_set(v_current, '{commands}', v_next_commands, true);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Clarify plugin catalog rollback command label',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$commands$;

SELECT pg_advisory_unlock(hashtext('202605232130_plugin_catalog_rollback_command_label_v1'));

COMMIT;
