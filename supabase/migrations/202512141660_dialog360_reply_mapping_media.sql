-- Migration: Dialog360 reply mapping - media caption coverage
-- Purpose:
--   - Expand the webhook_inbound mapping for dialog360_reply to extract reply_text from common non-text message types
--     (image/video/document captions, button text, location name/address, reaction emoji) when present.
--   - Keep parsing row-driven via mapping_configs (no provider-specific branching in functions).
-- Date: 2025-12-14

BEGIN;

INSERT INTO public.mapping_configs (
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  'webhook_inbound',
  'dialog360_reply::communication.reply',
  jsonb_build_object(
    'description', 'Dialog360 WhatsApp inbound mapping (messages + status receipts; includes media captions)',
    'external_id_path', 'entry.0.changes.0.value.messages.0.id',
    'event_type_path', 'entry.0.changes.0.value.messages.0.type',
    'transforms', jsonb_build_object(
      'communication', jsonb_build_object(
        'recipient', jsonb_build_array(
          'entry.0.changes.0.value.contacts.0.wa_id',
          'entry.0.changes.0.value.messages.0.from',
          'entry.0.changes.0.value.statuses.0.recipient_id',
          'contacts.0.wa_id',
          'messages.0.from',
          'statuses.0.recipient_id'
        ),
        'correlation_id', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.context.id',
          'messages.0.context.id'
        ),
        'message_id', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.id',
          'entry.0.changes.0.value.statuses.0.id',
          'messages.0.id',
          'statuses.0.id'
        ),
        'reply_payload', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.button.payload',
          'entry.0.changes.0.value.messages.0.interactive.button_reply.id',
          'entry.0.changes.0.value.messages.0.interactive.list_reply.id',
          'messages.0.button.payload',
          'messages.0.interactive.button_reply.id',
          'messages.0.interactive.list_reply.id'
        ),
        'reply_text', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.text.body',
          'entry.0.changes.0.value.messages.0.button.text',
          'entry.0.changes.0.value.messages.0.interactive.button_reply.title',
          'entry.0.changes.0.value.messages.0.interactive.list_reply.title',
          'entry.0.changes.0.value.messages.0.image.caption',
          'entry.0.changes.0.value.messages.0.video.caption',
          'entry.0.changes.0.value.messages.0.document.caption',
          'entry.0.changes.0.value.messages.0.document.filename',
          'entry.0.changes.0.value.messages.0.location.name',
          'entry.0.changes.0.value.messages.0.location.address',
          'entry.0.changes.0.value.messages.0.reaction.emoji',
          'messages.0.text.body',
          'messages.0.button.text',
          'messages.0.interactive.button_reply.title',
          'messages.0.interactive.list_reply.title',
          'messages.0.image.caption',
          'messages.0.video.caption',
          'messages.0.document.caption',
          'messages.0.document.filename',
          'messages.0.location.name',
          'messages.0.location.address',
          'messages.0.reaction.emoji'
        ),
        'timestamp', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.timestamp',
          'entry.0.changes.0.value.statuses.0.timestamp',
          'messages.0.timestamp',
          'statuses.0.timestamp'
        ),
        'message_type', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.type',
          'messages.0.type'
        ),
        -- Delivery receipt fields (present on status callbacks; absent on inbound messages).
        'status', jsonb_build_array(
          'entry.0.changes.0.value.statuses.0.status',
          'statuses.0.status'
        ),
        'status_error_code', jsonb_build_array(
          'entry.0.changes.0.value.statuses.0.errors.0.code',
          'statuses.0.errors.0.code'
        ),
        'status_error_title', jsonb_build_array(
          'entry.0.changes.0.value.statuses.0.errors.0.title',
          'statuses.0.errors.0.title'
        ),
        'status_error_message', jsonb_build_array(
          'entry.0.changes.0.value.statuses.0.errors.0.message',
          'statuses.0.errors.0.message'
        )
      )
    )
  ),
  1,
  'Inbound mapping for dialog360_reply (multi-path; includes media captions, non-text fields, and status receipts)'
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    mapping_version = mapping_configs.mapping_version + 1,
    notes = EXCLUDED.notes,
    updated_at = now();

COMMIT;
