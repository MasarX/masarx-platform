-- Plan: PLAN-202603-fieldops-mobile-ux-connectivity-feature-completion-v1 / Step: S05
-- Migration: FieldOps task command input schema + payload mapping (v1)
-- Purpose:
-- - Keep ui_execute_command_v1 contract stable while enabling schema-driven mobile input collection.
-- - Add execution.payload_key + execution.input_schema for tasks.complete/tasks.exception.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603041320_fieldops_ui_command_task_input_schema_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_commands JSONB;
  v_updated JSONB;
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

  SELECT COALESCE(
           jsonb_agg(
             CASE
               WHEN item->>'key' = 'tasks.complete' THEN
                 jsonb_set(
                   jsonb_set(
                     item,
                     '{execution,payload_key}',
                     to_jsonb('payload'::text),
                     true
                   ),
                   '{execution,input_schema}',
                   jsonb_build_object(
                     'version', 'v1',
                     'fields', jsonb_build_array(
                       jsonb_build_object(
                         'key', 'completion_notes',
                         'label', 'Completion notes',
                         'type', 'textarea',
                         'required', false,
                         'placeholder', 'Add handoff notes (optional).'
                       )
                     )
                   ),
                   true
                 )
               WHEN item->>'key' = 'tasks.exception' THEN
                 jsonb_set(
                   jsonb_set(
                     item,
                     '{execution,payload_key}',
                     to_jsonb('payload'::text),
                     true
                   ),
                   '{execution,input_schema}',
                   jsonb_build_object(
                     'version', 'v1',
                     'fields', jsonb_build_array(
                       jsonb_build_object(
                         'key', 'exception_reason',
                         'label', 'Exception reason',
                         'type', 'lookup',
                         'lookup_category', 'dispatch_exception_reason',
                         'required', true
                       ),
                       jsonb_build_object(
                         'key', 'exception_notes',
                         'label', 'Exception notes',
                         'type', 'textarea',
                         'required', false,
                         'placeholder', 'Add details for dispatch follow-up.'
                       )
                     )
                   ),
                   true
                 )
               ELSE item
             END
           ),
           '[]'::jsonb
         )
    INTO v_commands
    FROM jsonb_array_elements(COALESCE(v_current->'commands', '[]'::jsonb)) AS item;

  v_updated := jsonb_set(v_current, '{commands}', v_commands, true);

  IF v_updated IS NOT DISTINCT FROM v_current THEN
    RETURN;
  END IF;

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_updated,
           version = current.version + 1,
           change_reason = 'FieldOps task command input schemas + payload key',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
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

SELECT pg_advisory_unlock(hashtext('202603041320_fieldops_ui_command_task_input_schema_v1'));
COMMIT;
