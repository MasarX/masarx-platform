-- Plan: Batch 8 delivery completion core / Step: E01
-- Migration: Delivery handover mode lookup + FieldOps tasks.complete schema refresh
-- Purpose:
-- - Keep delivery completion variants row-driven via a canonical lookup category.
-- - Expose alternate handover modes and recipient-class metadata through the mobile command contract.
-- - Preserve execution.payload_key=payload as the stable FieldOps command envelope.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604031200_delivery_handover_mode_task_complete_schema_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup category: delivery_handover_mode
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'delivery_handover_mode',
  'Canonical delivery completion handover modes for alternate receipt variants.',
  'dispatch',
  'tier_1',
  TRUE
)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('named_recipient', 'Named Recipient', 'Delivered to the named recipient.', 10, TRUE,  '{}' ),
  ('recipient_class', 'Recipient Class', 'Delivered to a recipient class such as concierge or front desk.', 20, FALSE, '{}' ),
  ('safe_drop',       'Safe Drop',       'Left in a policy-approved safe-drop location.', 30, FALSE, '{}' ),
  ('locker',          'Locker',          'Placed in a locker or parcel bank.', 40, FALSE, '{}' ),
  ('mailroom',        'Mailroom',        'Delivered to a building or campus mailroom.', 50, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'delivery_handover_mode'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) ui_command_registry: tasks.complete schema refresh for delivery variants
-------------------------------------------------------------------------------

WITH target_rows AS (
  SELECT
    s.id AS settings_id,
    s.settings_version_id,
    sv.version,
    sv.value
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
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
                    TRUE
                  ),
                  '{execution,input_schema}',
                  jsonb_build_object(
                    'version', 'v3',
                    'title', 'Complete stop',
                    'description', 'Capture handover mode, recipient confirmation, and delivery notes. Proof photos are collected by the mobile shell.',
                    'fields', jsonb_build_array(
                      jsonb_build_object(
                        'key', 'handover_mode',
                        'label', 'Handover mode',
                        'type', 'lookup',
                        'lookup_category', 'delivery_handover_mode',
                        'required', FALSE,
                        'default_value', 'named_recipient'
                      ),
                      jsonb_build_object(
                        'key', 'recipient_name',
                        'label', 'Recipient name',
                        'type', 'text',
                        'required', FALSE,
                        'placeholder', 'Who received the shipment?'
                      ),
                      jsonb_build_object(
                        'key', 'recipient_class',
                        'label', 'Recipient class',
                        'type', 'text',
                        'required', FALSE,
                        'placeholder', 'Concierge, front desk, mailroom, or similar.'
                      ),
                      jsonb_build_object(
                        'key', 'completion_notes',
                        'label', 'Completion notes',
                        'type', 'textarea',
                        'required', FALSE,
                        'placeholder', 'Add handoff notes, locker details, or drop-off context.'
                      )
                    )
                  ),
                  TRUE
                )
              ELSE item
            END
          )
          FROM jsonb_array_elements(COALESCE(tr.value->'commands', '[]'::jsonb)) AS item
        ),
        '[]'::jsonb
      ),
      TRUE
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
         change_reason = 'FieldOps tasks.complete schema refresh for delivery handover variants',
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

SELECT pg_advisory_unlock(hashtext('202604031200_delivery_handover_mode_task_complete_schema_v1'));
COMMIT;
