-- Migration: Guard communications inbound auto-reply to user-originated text messages only
-- Purpose: Add a JSONLogic condition to the first step of communications_inbound_v1 so
--          we only auto-reply when the payload contains a user-originated text message
--          and avoid echo loops or status/read receipts.
-- Notes: JSONLogic paths are evaluated against execution context; the engine passes
--        run context under $.context.* when resolving.

BEGIN;

-- Condition:
--   and(
--     exists($.context.payload.entry.0.changes.0.value.messages.0.text.body),
--     ne(
--        $.context.payload.entry.0.changes.0.value.messages.0.from,
--        $.context.payload.entry.0.changes.0.value.metadata.display_phone_number
--     )
--   )

UPDATE workflow_template_steps s
SET condition_jsonlogic = jsonb_build_object(
  'and', jsonb_build_array(
    jsonb_build_object('!!', jsonb_build_object('var', '$.context.payload.entry.0.changes.0.value.messages.0.text.body')),
    jsonb_build_object('!=', jsonb_build_array(
      jsonb_build_object('var', '$.context.payload.entry.0.changes.0.value.messages.0.from'),
      jsonb_build_object('var', '$.context.payload.entry.0.changes.0.value.metadata.display_phone_number')
    ))
  )
)
FROM workflow_templates wt
WHERE s.workflow_template_id = wt.id
  AND wt.name = 'communications_inbound_v1'
  AND s.sequence_order = 1;

COMMIT;

