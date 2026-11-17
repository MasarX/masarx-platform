-- Migration: Communications inbound auto-reply (WhatsApp via 360dialog)
-- Purpose: Add an auto-reply step to communications_inbound_v1 and required operation template
-- Date: 2025-11-23 14:10 UTC

BEGIN;

SET search_path TO public;

WITH dialog_provider AS (
  SELECT id,
         COALESCE(metadata->>'base_url', 'https://waba-sandbox.360dialog.io') AS base_url
  FROM providers
  WHERE name = 'dialog360_whatsapp'
  LIMIT 1
),
dialog_auth AS (
  SELECT credentials->>'api_key' AS api_key
  FROM provider_auth_configs
  WHERE provider_id = (SELECT id FROM dialog_provider)
  ORDER BY created_at DESC
  LIMIT 1
),
dialog_text_mapping AS (
  INSERT INTO mapping_configs (
    id,
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    notes
  )
  VALUES (
    '99990000-0000-0000-0000-000000210003',
    'provider_response',
    'dialog360::send_whatsapp_text::v1',
    $${
      "success_path": "$.messages[0].id",
      "field_mappings": {
        "message_id": "$.messages[0].id"
      }
    }$$::jsonb,
    1,
    '360dialog WhatsApp send text response mapping'
  )
  ON CONFLICT (id) DO UPDATE
    SET mapping_config = EXCLUDED.mapping_config,
        mapping_version = EXCLUDED.mapping_version,
        notes = EXCLUDED.notes,
        updated_at = now()
  RETURNING id
),
dialog_text_operation AS (
  INSERT INTO operation_templates (
    id,
    provider_id,
    operation_name,
    method,
    url_template,
    headers_template,
    body_template,
    request_mappings,
    mapping_config_id,
    timeout_seconds,
    idempotency_key_template,
    call_type,
    handler_key,
    handler_version
  )
  SELECT
    '99990000-0000-0000-0000-000000220003',
    dp.id,
    'dialog360_send_whatsapp_text_v1',
    'POST',
    dp.base_url || '/v1/messages',
    jsonb_strip_nulls(jsonb_build_object(
      'content-type', 'application/json',
      'D360-API-KEY', (SELECT api_key FROM dialog_auth)
    )),
    -- Base body: type=text; content filled via request mappings
    $${
      "messaging_product": "whatsapp",
      "type": "text",
      "text": { "body": "" }
    }$$::jsonb,
    -- Request mappings: extract recipient and echo original text body from payload
    $${
      "body": {
        "to": "$.payload.entry[0].changes[0].value.contacts[0].wa_id",
        "text.body": "$.payload.entry[0].changes[0].value.messages[0].text.body"
      }
    }$$::jsonb,
    (SELECT id FROM dialog_text_mapping),
    30,
    NULL,
    'comms_whatsapp',
    'outbound_http',
    'v1'
  FROM dialog_provider dp
  ON CONFLICT (id) DO UPDATE
    SET url_template = EXCLUDED.url_template,
        headers_template = EXCLUDED.headers_template,
        body_template = EXCLUDED.body_template,
        request_mappings = EXCLUDED.request_mappings,
        mapping_config_id = EXCLUDED.mapping_config_id,
        timeout_seconds = EXCLUDED.timeout_seconds,
        call_type = EXCLUDED.call_type,
        handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
        updated_at = now()
  RETURNING id
)
INSERT INTO workflow_template_steps (
  workflow_template_id,
  sequence_order,
  operation_name,
  operation_settings_category,
  transition_condition,
  condition_jsonlogic,
  next_operation_name,
  next_operation_priority,
  next_operation_delay_seconds,
  manual_action_required,
  metadata,
  enabled,
  handler_key,
  handler_version
)
SELECT
  wt.id,
  1,
  'send_auto_reply',
  NULL,
  'always',
  NULL,
  NULL,
  NULL,
  NULL,
  FALSE,
  jsonb_build_object('operation_template_id', (SELECT id FROM dialog_text_operation)),
  TRUE,
  'outbound_http',
  'v1'
FROM workflow_templates wt
WHERE wt.name = 'communications_inbound_v1'
  AND NOT EXISTS (
    SELECT 1 FROM workflow_template_steps s
    WHERE s.workflow_template_id = wt.id
      AND s.sequence_order = 1
  );

COMMIT;

