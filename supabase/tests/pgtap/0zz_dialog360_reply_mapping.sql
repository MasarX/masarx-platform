-- Plan: PLAN-202511-comms-prod-ready / S03-S04
-- Purpose: Validate Dialog360 reply mapping extracts communication identifiers via JSONPath.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

CREATE TEMP TABLE dialog360_sample AS
WITH mapping AS (
  INSERT INTO mapping_configs (
    id,
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    notes
  )
  VALUES (
    gen_random_uuid(),
    'webhook_inbound',
    'pgtap::dialog360_reply_mapping::' || replace(gen_random_uuid()::text, '-', ''),
    jsonb_build_object(
      'description', 'pgTAP Dialog360 reply mapping fixture',
      'transforms', jsonb_build_object(
        'communication', jsonb_build_object(
          'recipient', 'entry.0.changes.0.value.contacts.0.wa_id',
          'message_id', 'entry.0.changes.0.value.messages.0.id',
          'reply_text', 'entry.0.changes.0.value.messages.0.text.body',
          'correlation_id', 'entry.0.changes.0.value.messages.0.context.id'
        )
      )
    ),
    1,
    'pgTAP fixture for Dialog360 reply mapping extraction'
  )
  RETURNING id
)
SELECT
  '{
    "object": "whatsapp_business_account",
    "entry": [
      {
        "id": "180400265161288",
        "changes": [
          {
            "field": "messages",
            "value": {
              "contacts": [
                { "wa_id": "12025550123", "profile": { "name": "Tester" } }
              ],
              "messages": [
                {
                  "id": "wamid.TEST123",
                  "from": "12025550123",
                  "text": { "body": "Hello world" },
                  "type": "text",
                  "timestamp": "1763995382",
                  "context": { "id": "corr-abc" }
                }
              ],
              "messaging_product": "whatsapp"
            }
          }
        ]
      }
    ]
  }'::jsonb AS payload,
  mapping.id AS mapping_config_id
FROM mapping;

CREATE TEMP TABLE dialog360_sample_array AS
WITH mapping AS (
  INSERT INTO mapping_configs (
    id,
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    notes
  )
  VALUES (
    gen_random_uuid(),
    'webhook_inbound',
    'pgtap::dialog360_reply_mapping_array::' || replace(gen_random_uuid()::text, '-', ''),
    jsonb_build_object(
      'description', 'pgTAP Dialog360 reply mapping fixture (array-path parity)',
      'transforms', jsonb_build_object(
        'communication', jsonb_build_object(
          'recipient', jsonb_build_array(
            'entry.0.changes.0.value.contacts.0.unknown',
            'entry.0.changes.0.value.contacts.0.wa_id'
          ),
          'message_id', jsonb_build_array(
            'entry.0.changes.0.value.messages.0.unknown',
            'entry.0.changes.0.value.messages.0.id'
          ),
          'reply_text', jsonb_build_array(
            'entry.0.changes.0.value.messages.0.text.missing',
            'entry.0.changes.0.value.messages.0.text.body'
          ),
          'correlation_id', jsonb_build_array(
            'entry.0.changes.0.value.messages.0.context.missing',
            'entry.0.changes.0.value.messages.0.context.id'
          )
        )
      )
    ),
    1,
    'pgTAP fixture for Dialog360 reply mapping extraction array-path parity'
  )
  RETURNING id
)
SELECT
  payload,
  mapping.id AS mapping_config_id
FROM dialog360_sample, mapping;

SELECT is(
  (SELECT apply_mapping_config(payload, mapping_config_id)->'communication'->>'recipient' FROM dialog360_sample),
  '12025550123',
  'Dialog360 mapping extracts recipient via JSONPath'
);

SELECT is(
  (SELECT apply_mapping_config(payload, mapping_config_id)->'communication'->>'message_id' FROM dialog360_sample),
  'wamid.TEST123',
  'Dialog360 mapping extracts message_id'
);

SELECT is(
  (SELECT apply_mapping_config(payload, mapping_config_id)->'communication'->>'reply_text' FROM dialog360_sample),
  'Hello world',
  'Dialog360 mapping extracts reply_text'
);

SELECT is(
  (SELECT apply_mapping_config(payload, mapping_config_id)->'communication'->>'correlation_id' FROM dialog360_sample),
  'corr-abc',
  'Dialog360 mapping extracts correlation_id'
);

SELECT is(
  (SELECT apply_mapping_config(payload, mapping_config_id)->'communication'->>'recipient' FROM dialog360_sample_array),
  '12025550123',
  'Dialog360 mapping extracts recipient via array-path fallback'
);

SELECT is(
  (SELECT apply_mapping_config(payload, mapping_config_id)->'communication'->>'message_id' FROM dialog360_sample_array),
  'wamid.TEST123',
  'Dialog360 mapping extracts message_id via array-path fallback'
);

SELECT is(
  (SELECT apply_mapping_config(payload, mapping_config_id)->'communication'->>'reply_text' FROM dialog360_sample_array),
  'Hello world',
  'Dialog360 mapping extracts reply_text via array-path fallback'
);

SELECT is(
  (SELECT apply_mapping_config(payload, mapping_config_id)->'communication'->>'correlation_id' FROM dialog360_sample_array),
  'corr-abc',
  'Dialog360 mapping extracts correlation_id via array-path fallback'
);

SELECT * FROM finish();

ROLLBACK;
