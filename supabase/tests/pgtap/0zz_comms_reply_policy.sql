BEGIN;

SELECT plan(5);

-- Prep: ensure dialog360_reply webhook_source exists and seed a source-scoped comms_reply_policy.
WITH sender_ctx AS (
  SELECT s.id AS sender_id, c.organization_id
  FROM senders s
  JOIN clients c ON c.id = s.client_id
  ORDER BY s.created_at ASC
  LIMIT 1
), mapping AS (
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
    'dialog360_reply::communication.reply',
    jsonb_build_object(
      'description', 'Dialog360 WhatsApp reply mapping',
      'external_id_path', 'messages.0.id',
      'event_type_path', 'messages.0.type',
      'transforms', jsonb_build_object(
        'communication', jsonb_build_object(
          'recipient', 'contacts.0.wa_id',
          'correlation_id', 'messages.0.context.id',
          'message_id', 'messages.0.id',
          'reply_payload', 'messages.0.button.payload',
          'reply_text', 'messages.0.text.body',
          'timestamp', 'messages.0.timestamp'
        )
      )
    ),
    1,
    'pgTAP upsert for dialog360 reply mapping'
  )
  ON CONFLICT (mapping_type, mapping_key) DO UPDATE
  SET mapping_config = EXCLUDED.mapping_config,
      mapping_version = EXCLUDED.mapping_version,
      notes = EXCLUDED.notes,
      updated_at = now()
  RETURNING id
), source_seed AS (
  INSERT INTO webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    rate_limit_per_hour,
    enabled,
    sender_id
  )
  SELECT
    gen_random_uuid(),
    sender_ctx.organization_id,
    'dialog360_reply',
    'Dialog360 WhatsApp Reply Endpoint',
    'communications',
    'dialog360-reply-token',
    mapping.id,
    2000,
    TRUE,
    sender_ctx.sender_id
  FROM sender_ctx, mapping
  ON CONFLICT (organization_id, source_identifier) DO UPDATE
  SET enabled = TRUE,
      mapping_config_id = EXCLUDED.mapping_config_id,
      sender_id = COALESCE(EXCLUDED.sender_id, webhook_sources.sender_id),
      updated_at = now()
  RETURNING id, organization_id
), src AS (
  SELECT id, organization_id FROM source_seed
), payload AS (
  SELECT jsonb_strip_nulls(
           jsonb_build_object(
             -- dry_run mode should not require auth_config_id; include it only when present
             'auth_config_id', (
               SELECT pac.id
               FROM provider_auth_configs pac
               JOIN providers p ON p.id = pac.provider_id
               WHERE p.organization_id = (SELECT organization_id FROM src)
                 AND p.name = 'dialog360_whatsapp'
               ORDER BY pac.created_at DESC
               LIMIT 1
             ),
             'dry_run', true,
             'dispatch', jsonb_build_object(
               'mode', 'queue',
               'timeout_seconds', 10,
               'poll_max_seconds', 0,
               'poll_interval_ms', 200,
               'lease_seconds', 30,
               'pending_reschedule_seconds', 30
             ),
             'intents', jsonb_build_object(
               'status', jsonb_build_object(
                 'keywords', jsonb_build_array('status'),
                 'template', 'Shipment {tracking_number}: status {status}.',
                 'not_found_template', 'Status not found for {recipient}.'
               ),
               'fallback', jsonb_build_object('template', 'Thanks.')
             )
           )
         ) AS value
), updated_versions AS (
  UPDATE settings_versions sv
     SET value = payload.value,
         version = 1,
         created_at = now()
    FROM src, payload
   WHERE sv.category = 'comms_reply_policy'
     AND sv.scope_type = 'source'
     AND sv.scope_id = src.id
  RETURNING sv.id, sv.scope_id
), inserted_versions AS (
  INSERT INTO settings_versions (id, category, scope_type, scope_id, version, value, created_at)
  SELECT gen_random_uuid(),
         'comms_reply_policy',
         'source',
         src.id,
         1,
         payload.value,
         now()
  FROM src, payload
  WHERE NOT EXISTS (SELECT 1 FROM updated_versions)
  RETURNING id, scope_id
), version_row AS (
  SELECT id, scope_id FROM updated_versions
  UNION ALL
  SELECT id, scope_id FROM inserted_versions
  LIMIT 1
), updated_settings AS (
  UPDATE settings s
     SET cached_value = payload.value,
         settings_version_id = (SELECT id FROM version_row),
         last_updated = now()
    FROM src, payload
   WHERE s.category = 'comms_reply_policy'
     AND s.scope_type = 'source'
     AND s.scope_id = src.id
  RETURNING s.id
), inserted_settings AS (
  INSERT INTO settings (id, category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  SELECT gen_random_uuid(),
         'comms_reply_policy',
         'source',
         src.id,
         (SELECT id FROM version_row),
         payload.value,
         now()
  FROM src, payload
  WHERE NOT EXISTS (SELECT 1 FROM updated_settings)
)
SELECT ok(TRUE, 'comms_reply_policy seeded for test scope');

CREATE TEMP TABLE pgtap_comms_reply_policy_ctx AS
WITH sender_ctx AS (
  SELECT s.id AS sender_id, s.client_id, c.organization_id
  FROM senders s
  JOIN clients c ON c.id = s.client_id
  ORDER BY s.created_at ASC
  LIMIT 1
), src AS (
  SELECT
    ws.id AS source_id,
    sender_ctx.organization_id,
    sender_ctx.client_id,
    sender_ctx.sender_id
  FROM sender_ctx
  JOIN webhook_sources ws
    ON ws.organization_id = sender_ctx.organization_id
   AND ws.source_identifier = 'dialog360_reply'
  ORDER BY ws.created_at DESC
  LIMIT 1
)
SELECT
  ('555' || lpad((floor(random() * 1000000000))::BIGINT::TEXT, 9, '0')) AS recipient_phone,
  ('PGTAP-' || replace(gen_random_uuid()::TEXT, '-', '')) AS tracking_number,
  src.client_id,
  src.organization_id,
  src.sender_id,
  src.source_id
FROM src;

-- Insert recipient + shipment to test status intent.
WITH r AS (
  INSERT INTO recipients (id, organization_id, client_id, name, phone_number, created_at, updated_at)
  SELECT gen_random_uuid(), organization_id, client_id, 'pgtap-reply', recipient_phone, now(), now()
  FROM pgtap_comms_reply_policy_ctx
  ON CONFLICT (client_id, phone_number_normalized) WHERE phone_number_normalized IS NOT NULL
  DO UPDATE SET updated_at = now()
  RETURNING id, client_id, organization_id
), s AS (
  INSERT INTO shipments (id, organization_id, client_id, sender_id, recipient_id, status, tracking_number, created_at, updated_at, status_updated_at, service_type, box_count)
  SELECT gen_random_uuid(), r.organization_id, r.client_id, (SELECT sender_id FROM pgtap_comms_reply_policy_ctx LIMIT 1), r.id, 'in_transit', (SELECT tracking_number FROM pgtap_comms_reply_policy_ctx LIMIT 1), now(), now(), now(), 'delivery', 1
  FROM r
  RETURNING id
)
SELECT ok(TRUE, 'recipient and shipment inserted for reply test');

-- Execute send_comms_reply in dry_run mode.
SELECT ok(
  send_comms_reply(
    gen_random_uuid(),
    (SELECT source_id FROM pgtap_comms_reply_policy_ctx LIMIT 1),
    jsonb_build_object(
      'recipient', (SELECT recipient_phone FROM pgtap_comms_reply_policy_ctx LIMIT 1),
      'reply_text', 'status please',
      'message_id', 'wamid.test'
    ),
    (SELECT organization_id FROM pgtap_comms_reply_policy_ctx LIMIT 1)
  )::text LIKE '%\"intent\": \"status\"%',
  'send_comms_reply selects status intent and returns payload'
);

-- Uses policy template (no hardcoded fallback) and organization-scoped shipment.
SELECT is(
  send_comms_reply(
    gen_random_uuid(),
    (SELECT source_id FROM pgtap_comms_reply_policy_ctx LIMIT 1),
    jsonb_build_object(
      'recipient', (SELECT recipient_phone FROM pgtap_comms_reply_policy_ctx LIMIT 1),
      'reply_text', 'status please'
    ),
    (SELECT organization_id FROM pgtap_comms_reply_policy_ctx LIMIT 1)
  )->>'message',
  ('Shipment ' || (SELECT tracking_number FROM pgtap_comms_reply_policy_ctx LIMIT 1) || ': status in_transit.'),
  'policy template applied to reply content'
);

-- No shipment -> not_found template from policy (still org-scoped).
SELECT is(
  send_comms_reply(
    gen_random_uuid(),
    (SELECT source_id FROM pgtap_comms_reply_policy_ctx LIMIT 1),
    jsonb_build_object(
      'recipient', '000000000000',
      'reply_text', 'status please'
    ),
    (SELECT organization_id FROM pgtap_comms_reply_policy_ctx LIMIT 1)
  )->>'message',
  'Status not found for 000000000000.',
  'not_found_template is policy-driven, not hardcoded'
);

SELECT finish();

ROLLBACK;
