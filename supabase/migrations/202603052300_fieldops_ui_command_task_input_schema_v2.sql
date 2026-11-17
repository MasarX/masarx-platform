-- Plan: PLAN-202603-fieldops-driver-production-readiness-v1 / Step: S03
-- Migration: FieldOps task command input schema refresh (v2)
-- Purpose:
-- - Keep tasks.complete/tasks.exception schema aligned with the driver shell.
-- - Propagate recipient confirmation + richer guidance to every scoped ui_command_registry row.
-- - Preserve execution.payload_key=payload as the stable mobile command contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603052300_fieldops_ui_command_task_input_schema_v2'));
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
                    'version', 'v2',
                    'title', 'Complete stop',
                    'description', 'Capture recipient confirmation and handoff notes. Proof photos are collected by the mobile shell.',
                    'fields', jsonb_build_array(
                      jsonb_build_object(
                        'key', 'recipient_name',
                        'label', 'Recipient name',
                        'type', 'text',
                        'required', false,
                        'placeholder', 'Who received the shipment?'
                      ),
                      jsonb_build_object(
                        'key', 'completion_notes',
                        'label', 'Completion notes',
                        'type', 'textarea',
                        'required', false,
                        'placeholder', 'Add handoff notes or drop-off details.'
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
                    'version', 'v2',
                    'title', 'Raise exception',
                    'description', 'Pick a reason and add dispatch follow-up notes. Evidence photos are collected by the mobile shell.',
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
                        'placeholder', 'Describe the failed attempt, refusal, or address issue.'
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
         change_reason = 'FieldOps task command schema refresh for driver production readiness',
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

SELECT pg_advisory_unlock(hashtext('202603052300_fieldops_ui_command_task_input_schema_v2'));
COMMIT;
