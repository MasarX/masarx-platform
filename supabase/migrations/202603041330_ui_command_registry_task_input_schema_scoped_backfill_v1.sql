-- Plan: PLAN-202603-fieldops-mobile-ux-connectivity-feature-completion-v1 / Step: S05
-- Migration: Backfill FieldOps task input schema/payload key for scoped ui_command_registry rows
-- Purpose:
-- - Ensure resolver-preferred scoped ui_command_registry rows (tenant/client/sender) expose
--   execution.payload_key and execution.input_schema for tasks.complete/tasks.exception.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603041330_ui_command_registry_task_input_schema_scoped_backfill_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH target_rows AS (
  SELECT
    s.id AS settings_id,
    s.settings_version_id,
    sv.version,
    sv.value
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'ui_command_registry'
),
rewritten AS (
  SELECT
    tr.settings_id,
    tr.settings_version_id,
    tr.version,
    tr.value,
    jsonb_set(
      tr.value,
      '{commands}',
      COALESCE(
        (
          SELECT jsonb_agg(
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
          )
          FROM jsonb_array_elements(COALESCE(tr.value->'commands', '[]'::jsonb)) AS item
        ),
        '[]'::jsonb
      ),
      true
    ) AS next_value
  FROM target_rows tr
),
changed AS (
  SELECT
    r.settings_id,
    r.settings_version_id,
    r.version,
    r.next_value
  FROM rewritten r
  WHERE r.next_value IS DISTINCT FROM r.value
),
applied AS (
  UPDATE public.settings_versions sv
     SET value = c.next_value,
         version = COALESCE(c.version, 0) + 1,
         change_reason = 'FieldOps task command input schemas + payload key (scoped backfill)',
         approved_at = now(),
         effective_from = now()
    FROM changed c
   WHERE sv.id = c.settings_version_id
  RETURNING sv.id, sv.value, c.settings_id
)
UPDATE public.settings s
   SET cached_value = a.value,
       last_updated = now()
  FROM applied a
 WHERE s.id = a.settings_id;

SELECT pg_advisory_unlock(hashtext('202603041330_ui_command_registry_task_input_schema_scoped_backfill_v1'));
COMMIT;
