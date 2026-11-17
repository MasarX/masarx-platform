BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

-- Seed workflow context so outbound_calls inserts satisfy engine guards.
SELECT set_config('app.workflow_run_id', 'dddd0ce0-0000-0000-0000-0000000000ce', true);
INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'bbbb0ce0-0000-0000-0000-0000000000ce',
  'pgtap_comms_reply_queueing',
  'Fixture workflow for comms reply queueing tests',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  enabled
)
VALUES (
  'cccc0ce0-0000-0000-0000-0000000000ce',
  'bbbb0ce0-0000-0000-0000-0000000000ce',
  1,
  'workflow_control',
  'always',
  'workflow_control',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'dddd0ce0-0000-0000-0000-0000000000ce',
  'bbbb0ce0-0000-0000-0000-0000000000ce',
  1,
  'test',
  'pending',
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'eeee0ce0-0000-0000-0000-0000000000ce',
  'dddd0ce0-0000-0000-0000-0000000000ce',
  'cccc0ce0-0000-0000-0000-0000000000ce',
  1,
  'pending',
  'workflow_control',
  'workflow_control',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', 'eeee0ce0-0000-0000-0000-0000000000ce', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', 'eeee0ce0-0000-0000-0000-0000000000ce', true);

-- Ensure dialog360_reply webhook_source exists (avoid relying on fixed seeded client slugs).
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
      organization_id = COALESCE(EXCLUDED.organization_id, webhook_sources.organization_id),
      updated_at = now()
  RETURNING id
)
SELECT ok(
  EXISTS (SELECT 1 FROM source_seed),
  'dialog360_reply webhook source ensured for reply queueing test'
);

-- Seed a provider_auth_config for dialog360 and a source-scoped comms_reply_policy with dry_run=false.
WITH sender_ctx AS (
  SELECT s.id AS sender_id, c.organization_id
  FROM senders s
  JOIN clients c ON c.id = s.client_id
  ORDER BY s.created_at ASC
  LIMIT 1
), src AS (
  SELECT ws.id, ws.organization_id
  FROM webhook_sources ws
  WHERE ws.source_identifier = 'dialog360_reply'
    AND ws.organization_id = (SELECT organization_id FROM sender_ctx)
  ORDER BY ws.created_at DESC
  LIMIT 1
), prov AS (
  INSERT INTO providers (id, organization_id, name, provider_type, enabled, metadata)
  SELECT
    gen_random_uuid(),
    src.organization_id,
    'dialog360_whatsapp',
    'comms',
    TRUE,
    jsonb_build_object('base_url', 'https://example.test')
  FROM src
  ON CONFLICT (organization_id, name, provider_type) DO UPDATE
  SET enabled = EXCLUDED.enabled,
      metadata = EXCLUDED.metadata,
      updated_at = now()
  RETURNING id
), auth AS (
  WITH auth_row AS (
    SELECT gen_random_uuid() AS id, prov.id AS provider_id
    FROM prov
  ),
  secret AS (
    SELECT
      auth_row.id AS auth_config_id,
      auth_row.provider_id,
      vault.create_secret(
        '{"api_key":"EXAMPLE_PASSWORD"}',
        'provider_auth_configs/' || auth_row.id::text,
        'pgtap comms_reply_queueing dialog360 api_key',
        NULL
      ) AS vault_id
    FROM auth_row
  )
  INSERT INTO provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
  SELECT auth_config_id, provider_id, 'api_key', vault_id, NULL, NULL
  FROM secret
  RETURNING id
), payload AS (
  SELECT jsonb_build_object(
           'auth_config_id', (SELECT id FROM auth),
           'dry_run', false,
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
SELECT ok(TRUE, 'comms_reply_policy seeded with auth_config_id for queueing test');

CREATE TEMP TABLE pgtap_comms_reply_queue_ids AS
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

-- Insert recipient + shipment under the same org/client as the dialog360 reply source.
WITH r AS (
  INSERT INTO recipients (id, organization_id, client_id, name, phone_number, created_at, updated_at)
  SELECT gen_random_uuid(), organization_id, client_id, 'pgtap-reply-queue', recipient_phone, now(), now()
  FROM pgtap_comms_reply_queue_ids
  ON CONFLICT (client_id, phone_number_normalized) WHERE phone_number_normalized IS NOT NULL
  DO UPDATE SET updated_at = now()
  RETURNING id, client_id, organization_id
), s AS (
  INSERT INTO shipments (id, organization_id, client_id, sender_id, recipient_id, status, tracking_number, created_at, updated_at, status_updated_at, service_type, box_count)
  SELECT gen_random_uuid(), r.organization_id, r.client_id, (SELECT sender_id FROM pgtap_comms_reply_queue_ids LIMIT 1), r.id, 'in_transit', (SELECT tracking_number FROM pgtap_comms_reply_queue_ids LIMIT 1), now(), now(), now(), 'delivery', 1
  FROM r
  RETURNING id
)
SELECT ok(TRUE, 'recipient and shipment inserted for reply queueing test');

-- WhatsApp compliance: ensure there is an active session for this recipient so
-- enqueue_comms_whatsapp can send freeform text without requiring templates.
DO $$
DECLARE
  v_recipient_id UUID;
BEGIN
  SELECT r.id
    INTO v_recipient_id
    FROM public.recipients r
   WHERE r.client_id = (SELECT client_id FROM pgtap_comms_reply_queue_ids LIMIT 1)
     AND r.phone_number_normalized = public.normalize_phone_number((SELECT recipient_phone FROM pgtap_comms_reply_queue_ids LIMIT 1))
   ORDER BY r.created_at DESC
   LIMIT 1;

  IF v_recipient_id IS NOT NULL THEN
    PERFORM public.touch_recipient_channel_session(v_recipient_id, 'whatsapp', now());
  END IF;
END $$;

-- Prove enqueue is row-driven: seed provider_defaults (required WhatsApp keys) and assert outbound_calls does not persist API-key headers.
WITH src AS (
  SELECT organization_id FROM pgtap_comms_reply_queue_ids LIMIT 1
), prov AS (
  SELECT p.id
  FROM providers p, src
  WHERE p.organization_id = src.organization_id
    AND p.name = 'dialog360_whatsapp'
    AND p.provider_type = 'comms'
  LIMIT 1
), payload AS (
  SELECT jsonb_build_object(
    'messaging_product', 'whatsapp',
    'whatsapp', jsonb_build_object(
      'messages_path', 'messages',
      'api_key_header', 'X-PGTAP-API-KEY',
      'headers_template', jsonb_build_object(
        'Content-Type', 'application/json'
      ),
      'text_body_template', jsonb_build_object(
        'messaging_product', '{{messaging_product}}',
        'to', '{{recipient}}',
        'type', 'text',
        'text', jsonb_build_object(
          'body', '{{message_text}}'
        )
      )
    )
  ) AS value
), updated_versions AS (
  UPDATE settings_versions sv
     SET value = payload.value,
         version = 1,
         created_at = now()
    FROM prov, payload
   WHERE sv.category = 'provider_defaults'
     AND sv.scope_type = 'resource'
     AND sv.scope_id = prov.id
  RETURNING sv.id, sv.scope_id
), inserted_versions AS (
  INSERT INTO settings_versions (id, category, scope_type, scope_id, version, value, created_at)
  SELECT gen_random_uuid(),
         'provider_defaults',
         'resource',
         prov.id,
         1,
         payload.value,
         now()
  FROM prov, payload
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
    FROM prov, payload
   WHERE s.category = 'provider_defaults'
     AND s.scope_type = 'resource'
     AND s.scope_id = prov.id
  RETURNING s.id
), inserted_settings AS (
  INSERT INTO settings (id, category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  SELECT gen_random_uuid(),
         'provider_defaults',
         'resource',
         prov.id,
         (SELECT id FROM version_row),
         payload.value,
         now()
  FROM prov, payload
  WHERE NOT EXISTS (SELECT 1 FROM updated_settings)
)
SELECT 1 FROM version_row;

-- Execute send_comms_reply once and persist results for assertions.
CREATE TEMP TABLE pgtap_comms_reply_queue_ctx (
  queued BOOLEAN,
  outbound_call_id UUID,
  message TEXT
);

INSERT INTO pgtap_comms_reply_queue_ctx (queued, outbound_call_id, message)
SELECT
  (r->>'queued')::BOOLEAN AS queued,
  NULLIF(r->>'outbound_call_id', '')::UUID AS outbound_call_id,
  r->>'message' AS message
FROM (
  SELECT send_comms_reply(
    gen_random_uuid(),
    (SELECT source_id FROM pgtap_comms_reply_queue_ids LIMIT 1),
    jsonb_build_object(
      'recipient', (SELECT recipient_phone FROM pgtap_comms_reply_queue_ids LIMIT 1),
      'reply_text', 'status please',
      'message_id', 'wamid.pgtap.queue'
    ),
    (SELECT organization_id FROM pgtap_comms_reply_queue_ids LIMIT 1)
  ) AS r
) s;

SELECT ok(
  (SELECT queued FROM pgtap_comms_reply_queue_ctx LIMIT 1) IS TRUE
  AND (SELECT outbound_call_id FROM pgtap_comms_reply_queue_ctx LIMIT 1) IS NOT NULL,
  'send_comms_reply enqueues outbound_call_id when dry_run=false'
);

SELECT is(
  (
    SELECT call_type
    FROM outbound_calls
    WHERE id = (SELECT outbound_call_id FROM pgtap_comms_reply_queue_ctx LIMIT 1)
  ),
  'comms_whatsapp',
  'queued outbound_calls row uses comms_whatsapp call_type'
);

SELECT is(
  (
    SELECT body->'text'->>'body'
    FROM outbound_calls
    WHERE id = (SELECT outbound_call_id FROM pgtap_comms_reply_queue_ctx LIMIT 1)
  ),
  ('Shipment ' || (SELECT tracking_number FROM pgtap_comms_reply_queue_ids LIMIT 1) || ': status in_transit.'),
  'queued outbound_calls body uses rendered policy template'
);

SELECT ok(
  NOT (
    SELECT COALESCE(headers, '{}'::jsonb) ? 'X-PGTAP-API-KEY'
    FROM outbound_calls
    WHERE id = (SELECT outbound_call_id FROM pgtap_comms_reply_queue_ctx LIMIT 1)
  ),
  'queued outbound_calls does not persist API key headers (secrets injected at dispatch)'
);

SELECT is(
  (
    SELECT CASE
      WHEN (SELECT outbound_call_id FROM pgtap_comms_reply_queue_ctx LIMIT 1) IS NULL THEN NULL
      ELSE (
        public.get_job_call_spec((SELECT outbound_call_id FROM pgtap_comms_reply_queue_ctx LIMIT 1))
        -> 'headers'
        ->> 'X-PGTAP-API-KEY'
      )
    END
  ),
  'EXAMPLE_PASSWORD',
  'get_job_call_spec injects provider_defaults.whatsapp.api_key_header at dispatch (row-driven)'
);

SELECT finish();

ROLLBACK;
