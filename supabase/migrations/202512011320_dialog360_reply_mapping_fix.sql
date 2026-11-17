-- Migration: Align Dialog360 reply webhook mapping with Facebook-style payload wrapper
-- Purpose: Ensure reply intents parse recipient/message_id/reply_text from entry[0].changes[0].value.messages[0]
-- Date: 2025-12-01

BEGIN;

-- Update mapping_config to match actual inbound payload shape from Dialog360 sandbox/WhatsApp.
UPDATE mapping_configs
SET mapping_config = jsonb_build_object(
    'description', 'Dialog360 WhatsApp reply mapping (FB webhook payload)',
    'external_id_path', 'entry.0.changes.0.value.messages.0.id',
    'event_type_path', 'entry.0.changes.0.value.messages.0.type',
    'transforms', jsonb_build_object(
        'communication', jsonb_build_object(
            'recipient', 'entry.0.changes.0.value.contacts.0.wa_id',
            'correlation_id', 'entry.0.changes.0.value.messages.0.context.id',
            'message_id', 'entry.0.changes.0.value.messages.0.id',
            'reply_payload', 'entry.0.changes.0.value.messages.0.button.payload',
            'reply_text', 'entry.0.changes.0.value.messages.0.text.body',
            'timestamp', 'entry.0.changes.0.value.messages.0.timestamp'
        )
    )
)
WHERE mapping_key = 'dialog360_reply::communication.reply';

-- Ensure the webhook source remains enabled.
UPDATE webhook_sources
SET enabled = TRUE
WHERE source_identifier = 'dialog360_reply';

COMMIT;
