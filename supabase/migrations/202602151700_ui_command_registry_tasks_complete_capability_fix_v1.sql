-- Plan: PLAN-202602-fieldops-driver-go-live / Step: S16
-- Migration: ui_command_registry tasks capability fix (FieldOps)
-- Purpose:
-- - Ensure FieldOps task transition commands are gated by `tasks.complete` (least privilege),
--   not `tasks.write`, so drivers can complete/exception tasks without broader write permissions.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602151700_ui_command_registry_tasks_complete_capability_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB;
  v_key TEXT;
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
  FOR v_command IN SELECT * FROM jsonb_array_elements(v_commands) LOOP
    v_key := NULLIF(v_command->>'key', '');

    IF v_key IN ('tasks.complete', 'tasks.exception') THEN
      v_command := jsonb_set(v_command, '{capability}', to_jsonb('tasks.complete'::text), true);
    END IF;

    v_next_commands := v_next_commands || jsonb_build_array(v_command);
  END LOOP;

  v_current := jsonb_set(v_current, '{commands}', v_next_commands, true);

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
           change_reason = 'FieldOps: tasks commands require tasks.complete (not tasks.write)',
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

SELECT pg_advisory_unlock(hashtext('202602151700_ui_command_registry_tasks_complete_capability_fix_v1'));
COMMIT;

