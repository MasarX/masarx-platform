-- Run only against the admitted disposable backend. All fixtures are transaction-owned.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT no_plan();
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);

CREATE TEMP TABLE identity_sources AS
SELECT key, gen_random_uuid() AS org_id, gen_random_uuid() AS source_id,
       gen_random_uuid() AS mapping_id, gen_random_uuid()::TEXT AS token
FROM (VALUES ('primary'), ('sibling'), ('disabled')) AS names(key);
INSERT INTO public.organizations(id, name, slug)
SELECT org_id, 'Webhook identity fixture', 'webhook-identity-' || org_id FROM identity_sources;
INSERT INTO public.mapping_configs(id, mapping_type, mapping_key, mapping_config, mapping_version, organization_id)
SELECT mapping_id, 'webhook_inbound', 'identity-' || mapping_id, '{}'::JSONB, 1, org_id
FROM identity_sources;
INSERT INTO public.webhook_sources(id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled)
SELECT source_id, org_id, 'identity-' || source_id, 'Webhook identity fixture', 'provider', token, mapping_id, key <> 'disabled'
FROM identity_sources;
SELECT public.upsert_webhook_ingest_policy('source', source_id,
  '{"version":1,"ack":{"mode":"accepted_async"},"validation":{"idempotency":{"header":"Idempotency-Key","body_path":"event.id"},"hmac":{"enabled":false}},"workflow":{"intent":"comms_reply"}}'::JSONB)
FROM identity_sources;

SELECT ok(
  has_function_privilege('edge_webhook_role', 'api.workflow_intake_webhook(text,jsonb,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.workflow_intake_webhook(text,jsonb,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'api.workflow_intake_webhook(text,jsonb,text,jsonb)', 'EXECUTE'),
  'API ingress keeps the existing narrow role grants'
);

CREATE TEMP TABLE identity_responses(label TEXT PRIMARY KEY, response JSONB NOT NULL);
GRANT SELECT ON identity_sources TO edge_webhook_role;
GRANT INSERT ON identity_responses TO edge_webhook_role;
SET LOCAL ROLE edge_webhook_role;
SELECT set_config('request.jwt.claims', '{"role":"edge_webhook_role"}', TRUE);
INSERT INTO identity_responses
SELECT key || '-async', api.workflow_intake_webhook(token,
  '{"x-correlation-id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830","authorization":"Bearer fixture-secret"}',
  '{"event":{"id":"shared-event","type":"comms_reply"}}',
  '{"event":{"id":"shared-event","type":"comms_reply"}}')
FROM identity_sources WHERE key <> 'disabled';
INSERT INTO identity_responses
SELECT 'async-replay', api.workflow_intake_webhook(token,
  '{"x-correlation-id":"22222222-2222-4222-8222-222222222222"}',
  '{"event":{"id":"shared-event","type":"comms_reply"}}',
  '{"event":{"id":"shared-event","type":"comms_reply"}}')
FROM identity_sources WHERE key = 'primary';
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);

SELECT is(
  (SELECT response->>'correlation_id' FROM identity_responses WHERE label = 'async-replay'),
  (SELECT response->>'correlation_id' FROM identity_responses WHERE label = 'primary-async'),
  'replay ignores the new request correlation and adopts the original inbox identity'
);
SELECT is(
  (SELECT response->'body' FROM identity_responses WHERE label = 'async-replay'),
  (SELECT response->'body' FROM identity_responses WHERE label = 'primary-async'),
  'replay preserves the original ACK body'
);
SELECT isnt(
  (SELECT response->>'correlation_id' FROM identity_responses WHERE label = 'primary-async'),
  (SELECT response->>'correlation_id' FROM identity_responses WHERE label = 'sibling-async'),
  'same idempotency key in a different source/organization cannot reuse correlation'
);
SELECT is((SELECT response->>'ack_outcome' FROM identity_responses WHERE label = 'async-replay'),
  'ack_replayed', 'replay remains explicit');
SELECT is((SELECT COUNT(*) FROM public.webhook_inbox WHERE webhook_source_id IN (SELECT source_id FROM identity_sources)),
  2::BIGINT, 'replay does not insert another inbox');

-- Exercise successful synchronous and mapped ACKs via the exposed API wrapper.
SELECT public.upsert_webhook_ingest_policy('source', source_id,
  '{"ack":{"mode":"synchronous_success"}}'::JSONB)
FROM identity_sources WHERE key = 'primary';
INSERT INTO identity_responses
SELECT 'sync', api.workflow_intake_webhook(token, '{}', '{"event":{"id":"sync-event","type":"comms_reply"}}',
  '{"event":{"id":"sync-event","type":"comms_reply"}}')
FROM identity_sources WHERE key = 'primary';

CREATE TEMP TABLE identity_ack_mapping AS SELECT gen_random_uuid() AS id;
INSERT INTO public.mapping_configs(id, mapping_type, mapping_key, mapping_config, mapping_version, organization_id)
SELECT m.id, 'webhook_response', 'identity-ack-' || m.id,
  '{"status_code":201,"headers":{"x-provider-receipt":"retained"},"body":{"provider_receipt":"custom-value"}}', 1, s.org_id
FROM identity_ack_mapping m CROSS JOIN identity_sources s WHERE s.key = 'primary';
SELECT public.upsert_webhook_ingest_policy('source', s.source_id,
  jsonb_build_object('ack', jsonb_build_object('response_mapping_id', m.id)))
FROM identity_sources s CROSS JOIN identity_ack_mapping m WHERE s.key = 'primary';
INSERT INTO identity_responses
SELECT 'custom', api.workflow_intake_webhook(token, '{}', '{"event":{"id":"custom-event","type":"comms_reply"}}',
  '{"event":{"id":"custom-event","type":"comms_reply"}}')
FROM identity_sources WHERE key = 'primary';
INSERT INTO identity_responses
SELECT 'custom-replay', api.workflow_intake_webhook(token, '{"x-correlation-id":"22222222-2222-4222-8222-222222222222"}',
  '{"event":{"id":"custom-event","type":"comms_reply"}}', '{"event":{"id":"custom-event","type":"comms_reply"}}')
FROM identity_sources WHERE key = 'primary';
SELECT is((SELECT response->>'status' FROM identity_responses WHERE label = 'sync'), '200', 'sync status retained');
SELECT is((SELECT response->>'status' FROM identity_responses WHERE label = 'custom'), '201', 'mapped status retained');
SELECT is((SELECT response#>>'{body,provider_receipt}' FROM identity_responses WHERE label = 'custom'),
  'custom-value', 'mapped body retained');
SELECT is((SELECT response#>>'{headers,x-provider-receipt}' FROM identity_responses WHERE label = 'custom'),
  'retained', 'mapped headers retained');
SELECT is((SELECT response->'body' FROM identity_responses WHERE label = 'custom-replay'),
  (SELECT response->'body' FROM identity_responses WHERE label = 'custom'), 'custom replay body unchanged');

-- Pre-inbox failures still return a correlation, without fabricated inbox IDs.
INSERT INTO identity_responses VALUES
('missing-token', api.workflow_intake_webhook(NULL, '{}', '{}', '{}')),
('unknown-token', api.workflow_intake_webhook('unknown-fixture-token', '{}', '{}', '{}'));
INSERT INTO identity_responses
SELECT 'disabled', api.workflow_intake_webhook(token, '{}', '{}', '{}')
FROM identity_sources WHERE key = 'disabled';
INSERT INTO identity_responses
SELECT 'missing-key', api.workflow_intake_webhook(token, '{}', '{}', '{}')
FROM identity_sources WHERE key = 'primary';
SELECT public.upsert_webhook_ingest_policy('source', source_id,
  '{"workflow":{"intent":"shipment.updated"}}'::JSONB)
FROM identity_sources WHERE key = 'primary';
INSERT INTO identity_responses
SELECT 'ambiguous', api.workflow_intake_webhook(token, '{}',
  '{"event":{"id":"ambiguous-event","type":"shipment.updated"},"shipment":{"destination_address":{"city":"Riyadh"},"driver":{"id":"driver-1"}}}',
  '{"event":{"id":"ambiguous-event","type":"shipment.updated"},"shipment":{"destination_address":{"city":"Riyadh"},"driver":{"id":"driver-1"}}}')
FROM identity_sources WHERE key = 'primary';
SELECT ok((response->>'status')::INT >= 400 AND NOT (response ? 'webhook_id'),
  label || ' preserves pre-inbox rejection')
FROM identity_responses WHERE label IN ('missing-token','unknown-token','disabled','missing-key','ambiguous');

-- HMAC failure/replay must share inbox identity without another rejection event.
SELECT public.upsert_webhook_ingest_policy('source', source_id,
  '{"workflow":{"intent":"comms_reply"},"validation":{"hmac":{"enabled":true,"header":"x-identity-signature","algorithm":"HMAC-SHA256","signature_encoding":"hex"}}}'::JSONB)
FROM identity_sources WHERE key = 'primary';
INSERT INTO identity_responses
SELECT 'hmac', api.workflow_intake_webhook(token, '{}', '{"event":{"id":"hmac-event","type":"comms_reply"}}',
  '{"event":{"id":"hmac-event","type":"comms_reply"}}')
FROM identity_sources WHERE key = 'primary';
INSERT INTO identity_responses
SELECT 'hmac-replay', api.workflow_intake_webhook(token, '{"x-correlation-id":"22222222-2222-4222-8222-222222222222"}',
  '{"event":{"id":"hmac-event","type":"comms_reply"}}', '{"event":{"id":"hmac-event","type":"comms_reply"}}')
FROM identity_sources WHERE key = 'primary';
SELECT is((SELECT response->>'status' FROM identity_responses WHERE label = 'hmac'), '400', 'HMAC rejection retained');
SELECT is((SELECT response->>'correlation_id' FROM identity_responses WHERE label = 'hmac-replay'),
  (SELECT response->>'correlation_id' FROM identity_responses WHERE label = 'hmac'), 'failed replay shares canonical correlation');
SELECT is((SELECT COUNT(*) FROM public.intake_auth_rejections
  WHERE metadata->>'webhook_inbox_id' = (SELECT response->>'webhook_id' FROM identity_responses WHERE label = 'hmac')),
  1::BIGINT, 'failed replay does not mirror a second HMAC rejection');

-- An explicit replay with stale failed-HMAC validation must also be ignored.
-- Natural core replay has no HMAC validation, so it alone cannot test this guard.
CREATE TEMP TABLE identity_stale_replay AS
SELECT public.log_decision(
  p_organization_id := dl.organization_id,
  p_decision_category := 'http_response_emitted',
  p_resource_type := 'webhook_inbox',
  p_resource_id := dl.resource_id,
  p_decision_point := dl.decision_point,
  p_decision_outcome := 'response_failed',
  p_performed_by_system := 'workflow_intake_webhook',
  p_correlation_id := dl.correlation_id,
  p_decision_inputs := dl.decision_inputs || jsonb_build_object('replayed', TRUE),
  p_decision_reason := dl.decision_reason
) AS decision_id
FROM public.decision_log dl
WHERE dl.resource_id::TEXT = (SELECT response->>'webhook_id' FROM identity_responses WHERE label = 'hmac')
  AND dl.decision_category = 'http_response_emitted'
  AND dl.decision_inputs#>>'{validation_results,hmac,status}' = 'failed'
  AND COALESCE(dl.decision_inputs->>'replayed', 'false') = 'false'
LIMIT 1;
SELECT ok(
  (SELECT COUNT(*) FROM identity_stale_replay) = 1
  AND EXISTS (
    SELECT 1 FROM identity_stale_replay captured
    JOIN public.decision_log dl ON dl.id = captured.decision_id
    WHERE dl.resource_id::TEXT = (SELECT response->>'webhook_id' FROM identity_responses WHERE label = 'hmac')
      AND dl.decision_category = 'http_response_emitted'
      AND dl.decision_outcome = 'response_failed'
      AND dl.decision_inputs->>'replayed' = 'true'
      AND dl.decision_inputs#>>'{validation_results,hmac,status}' = 'failed'
  ),
  'explicit stale HMAC replay decision is actually persisted'
);
SELECT is((SELECT COUNT(*) FROM public.intake_auth_rejections
  WHERE metadata->>'webhook_inbox_id' = (SELECT response->>'webhook_id' FROM identity_responses WHERE label = 'hmac')),
  1::BIGINT, 'explicit stale HMAC replay marker prevents a second rejection event');

SELECT is(
  (SELECT array_agg(label ORDER BY label) FROM identity_responses),
  ARRAY['ambiguous','async-replay','custom','custom-replay','disabled','hmac','hmac-replay','missing-key','missing-token','primary-async','sibling-async','sync','unknown-token']::TEXT[],
  'all thirteen intended response scenarios were exercised'
);
SELECT ok(NULLIF(response->>'correlation_id', '')::UUID IS NOT NULL,
  label || ' exposes top-level correlation') FROM identity_responses;
CREATE TEMP TABLE identity_inbox_labels AS
SELECT label FROM (VALUES
  ('primary-async'),('sibling-async'),('async-replay'),('sync'),
  ('custom'),('custom-replay'),('hmac'),('hmac-replay')
) AS expected(label);
SELECT ok(wi.id IS NOT NULL, expected.label || ' has its persisted inbox')
FROM identity_inbox_labels expected
LEFT JOIN identity_responses r ON r.label = expected.label
LEFT JOIN public.webhook_inbox wi ON wi.id::TEXT = r.response->>'webhook_id';
SELECT is(r.response->>'correlation_id', wi.correlation_id::TEXT,
  expected.label || ' response equals persisted correlation')
FROM identity_inbox_labels expected
LEFT JOIN identity_responses r ON r.label = expected.label
LEFT JOIN public.webhook_inbox wi ON wi.id::TEXT = r.response->>'webhook_id';
SELECT ok(NOT EXISTS (
  SELECT 1 FROM public.decision_log dl JOIN public.webhook_inbox wi ON wi.id = dl.resource_id
  WHERE wi.webhook_source_id IN (SELECT source_id FROM identity_sources)
    AND dl.decision_category = 'http_response_emitted'
    AND dl.correlation_id IS DISTINCT FROM wi.correlation_id
), 'all original and replay terminal decisions equal the source-scoped inbox correlation');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM public.webhook_inbox wi WHERE wi.webhook_source_id IN (SELECT source_id FROM identity_sources)
    AND wi.headers::TEXT LIKE '%fixture-secret%'
), 'persisted headers still exclude bearer secret');
SELECT is(current_setting('request.correlation_id'),
  (SELECT response->>'correlation_id' FROM identity_responses WHERE label = 'hmac'),
  'replay reseeds request audit context with canonical correlation');

-- External identity priority, independently of transport idempotency.
CREATE TEMP TABLE identity_external_cases AS
SELECT label, payload::JSONB, expected, gen_random_uuid() AS id, gen_random_uuid() AS correlation
FROM (VALUES
  ('event-first', '{"event":{"id":"event-first"},"external_id":"ignored","id":"ignored-too"}', 'event-first'),
  ('external-second', '{"external_id":"external-second","id":"ignored"}', 'external-second'),
  ('id-third', '{"id":"id-third"}', 'id-third'),
  ('empty-event', '{"event":{"id":""},"external_id":"empty-event-fallback"}', 'empty-event-fallback'),
  ('empty-external', '{"external_id":"","id":"empty-external-fallback"}', 'empty-external-fallback'),
  ('numeric-event', '{"event":{"id":0},"external_id":"ignored"}', '0'),
  ('absent', '{}', NULL)
) AS cases(label, payload, expected);
SELECT public.insert_webhook_inbox_record(c.id, s.source_id, 'provider', c.payload, '{}', 'pending',
  c.correlation, 'identity-external-' || c.id)
FROM identity_external_cases c CROSS JOIN identity_sources s WHERE s.key = 'primary';
SELECT ok(wi.id IS NOT NULL, c.label || ' external identity fixture has its persisted inbox')
FROM identity_external_cases c LEFT JOIN public.webhook_inbox wi ON wi.id = c.id;
SELECT is(wi.external_id, c.expected, c.label || ' follows event.id -> external_id -> id precedence')
FROM identity_external_cases c LEFT JOIN public.webhook_inbox wi ON wi.id = c.id;
SELECT is(wi.correlation_id, c.correlation, c.label || ' preserves caller-supplied correlation')
FROM identity_external_cases c LEFT JOIN public.webhook_inbox wi ON wi.id = c.id;

-- Additional owned-source binding cases run after the original identity invariants.
-- No existing source, policy, credential, or shipment row is changed.
-- Native prerequisite: current onboarding/plugin baselines must admit fresh owned
-- clients/senders. Their ordinary trigger-created rows remain in this rollback.
CREATE TEMP TABLE binding_parties AS
SELECT p.key, s.org_id, gen_random_uuid() AS client_id, NULL::UUID AS sender_id
FROM (VALUES ('primary', 'primary'), ('sibling', 'sibling'),
             ('inactive-sender', 'primary'), ('inactive-client', 'primary')) AS p(key, org_key)
JOIN identity_sources s ON s.key = p.org_key;
INSERT INTO public.clients(id, organization_id, name, slug, status)
SELECT client_id, org_id, 'Owned binding client', 'binding-' || client_id, 'active'
FROM binding_parties;
UPDATE binding_parties p SET sender_id = (
  SELECT s.id FROM public.senders s WHERE s.client_id = p.client_id
    AND COALESCE(s.status, 'active') = 'active' ORDER BY s.id LIMIT 1
);
INSERT INTO public.senders(id, client_id, name, brand_name, auto_provisioned, status)
SELECT gen_random_uuid(), client_id, 'Owned binding sender', 'Owned binding sender', TRUE, 'active'
FROM binding_parties WHERE sender_id IS NULL;
UPDATE binding_parties p SET sender_id = (
  SELECT s.id FROM public.senders s WHERE s.client_id = p.client_id
    AND COALESCE(s.status, 'active') = 'active' ORDER BY s.id LIMIT 1
);
SELECT ok((SELECT COUNT(*) FROM binding_parties WHERE sender_id IS NOT NULL) = 4,
  'all four owned client/sender bindings exist after supported onboarding');

CREATE TEMP TABLE binding_cases AS
SELECT label, intent, gen_random_uuid() AS source_id, gen_random_uuid() AS mapping_id,
       gen_random_uuid()::TEXT AS token
FROM (VALUES ('create-missing', 'shipment.create'), ('alias-missing', 'shipments.create'),
             ('payload-spoof', 'shipment.create'), ('auth-priority', 'shipment.create'),
             ('inactive-sender', 'shipment.create'), ('inactive-client', 'shipment.create'),
             ('foreign-org', 'shipment.create'), ('valid', 'shipment.create'))
AS cases(label, intent);
INSERT INTO public.mapping_configs(id, mapping_type, mapping_key, mapping_config, mapping_version, organization_id)
SELECT b.mapping_id, 'webhook_inbound', 'binding-' || b.mapping_id, '{}'::JSONB, 1, s.org_id
FROM binding_cases b CROSS JOIN identity_sources s WHERE s.key = 'primary';
INSERT INTO public.webhook_sources(id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled)
SELECT b.source_id, s.org_id, 'binding-' || b.source_id, 'Owned binding fixture', 'provider', b.token, b.mapping_id, TRUE
FROM binding_cases b CROSS JOIN identity_sources s WHERE s.key = 'primary';
-- The resolver derives client_id through senders.client_id (NOT NULL + FK).
-- A separate source client mismatch or an existing sender with no client cannot
-- be represented through this real token seam; do not invent a source column.
-- Only newly owned fixture rows are updated; all constraints remain enabled.
UPDATE public.webhook_sources ws SET sender_id = p.sender_id
FROM binding_cases b JOIN binding_parties p ON p.key = CASE
  WHEN b.label = 'foreign-org' THEN 'sibling'
  WHEN b.label IN ('inactive-sender', 'inactive-client') THEN b.label
  ELSE 'primary' END
WHERE ws.id = b.source_id AND b.label IN ('inactive-sender', 'inactive-client', 'foreign-org', 'valid');
UPDATE public.senders SET status = 'inactive'
WHERE id = (SELECT sender_id FROM binding_parties WHERE key = 'inactive-sender');
UPDATE public.clients SET status = 'suspended'
WHERE id = (SELECT client_id FROM binding_parties WHERE key = 'inactive-client');
SELECT ok((SELECT COUNT(*) FROM binding_cases b
  CROSS JOIN LATERAL public.get_webhook_source_by_token(b.token) resolved
  JOIN binding_parties p ON p.sender_id = resolved.sender_id
  WHERE b.label IN ('inactive-sender', 'inactive-client', 'foreign-org', 'valid')
    AND resolved.id = b.source_id AND resolved.client_id = p.client_id) = 4,
  'real token resolution derives all four fixture clients from their senders');
SELECT public.upsert_webhook_ingest_policy('source', source_id,
  jsonb_build_object('version', 1, 'ack', jsonb_build_object('mode', 'accepted_async'),
    'validation', jsonb_build_object(
      'idempotency', jsonb_build_object('header', 'Idempotency-Key', 'body_path', 'event.id'),
      'hmac', jsonb_build_object('enabled', label = 'auth-priority', 'header', 'x-binding-signature')),
    'workflow', jsonb_build_object('intent', intent)))
FROM binding_cases;
CREATE TEMP TABLE binding_responses(label TEXT PRIMARY KEY, response JSONB NOT NULL);
GRANT SELECT ON binding_cases, binding_parties TO edge_webhook_role;
GRANT INSERT ON binding_responses TO edge_webhook_role;
SET LOCAL ROLE edge_webhook_role;
SELECT set_config('request.jwt.claims', '{"role":"edge_webhook_role"}', TRUE);
INSERT INTO binding_responses
SELECT label, api.workflow_intake_webhook(token,
  jsonb_build_object('idempotency-key', 'binding-' || label, 'authorization', 'Bearer binding-secret'),
  jsonb_build_object('event', jsonb_build_object('id', 'binding-' || label, 'type', intent),
    'sender_id', (SELECT sender_id FROM binding_parties WHERE key = 'primary'),
    'client_id', (SELECT client_id FROM binding_parties WHERE key = 'primary'))::TEXT,
  jsonb_build_object('event', jsonb_build_object('id', 'binding-' || label, 'type', intent),
    'sender_id', (SELECT sender_id FROM binding_parties WHERE key = 'primary'),
    'client_id', (SELECT client_id FROM binding_parties WHERE key = 'primary')))
FROM binding_cases WHERE label <> 'valid';
INSERT INTO binding_responses
SELECT 'create-replay', api.workflow_intake_webhook(token,
  '{"idempotency-key":"binding-create-missing","x-correlation-id":"22222222-2222-4222-8222-222222222222"}',
  '{"event":{"id":"binding-create-missing","type":"shipment.create"}}',
  '{"event":{"id":"binding-create-missing","type":"shipment.create"}}')
FROM binding_cases WHERE label = 'create-missing';
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
-- The valid binding exercises the actual core admission seam, without driving
-- the follow-up engine or pretending this proves shipment materialization.
INSERT INTO binding_responses
SELECT 'valid', public.workflow_intake_webhook_core_v1(token,
  '{"idempotency-key":"binding-valid"}',
  '{"event":{"id":"binding-valid","type":"shipment.create"}}',
  '{"event":{"id":"binding-valid","type":"shipment.create"}}')
FROM binding_cases WHERE label = 'valid';
SELECT public.upsert_webhook_ingest_policy('source', source_id,
  '{"workflow":{"intent":"shipment.create"}}'::JSONB)
FROM identity_sources WHERE key = 'primary';
INSERT INTO binding_responses
SELECT 'historical-replay', api.workflow_intake_webhook(token,
  '{"idempotency-key":"shared-event"}',
  '{"event":{"id":"shared-event","type":"comms_reply"}}',
  '{"event":{"id":"shared-event","type":"comms_reply"}}')
FROM identity_sources WHERE key = 'primary';
SELECT ok((SELECT (response->>'status')::INT < 400
  AND response->>'ack_outcome' = 'ack_sent'
  AND NULLIF(response->>'workflow_run_id', '') IS NOT NULL
  FROM binding_responses WHERE label = 'valid'),
  'valid canonical source binding is admitted by the actual intake core');
SELECT is((SELECT response->'body' FROM binding_responses WHERE label = 'historical-replay'),
  (SELECT response->'body' FROM identity_responses WHERE label = 'primary-async'),
  'historical noncreate ACK replay survives a later create policy on an unbound source');
SELECT is((SELECT response->>'ack_outcome' FROM identity_responses WHERE label = 'primary-async'),
  'ack_sent', 'noncreate intake remains valid without sender/client binding');
SELECT is((SELECT COUNT(*) FROM binding_responses), 10::BIGINT, 'all ten binding admission/rejection/replay fixtures executed');
SELECT ok((response->>'status')::INT >= 400
  AND response->>'ack_outcome' = 'ack_failed'
  AND response->>'response_reason' = 'webhook_source_missing_sender_client'
  AND response->>'canonical_intent' = 'shipment.create'
  AND NOT (response ? 'workflow_run_id') AND NOT (response ? 'followup_workflow_run_id')
  AND NOT (response->'body' ? 'resource'),
  label || ' rejects unbound canonical create without workflow or reserved response identity')
FROM binding_responses WHERE label IN ('create-missing', 'alias-missing', 'payload-spoof', 'inactive-sender', 'inactive-client', 'foreign-org');
SELECT is((SELECT response->>'response_reason' FROM binding_responses WHERE label = 'auth-priority'),
  'Missing signature header x-binding-signature', 'HMAC failure keeps priority over invalid source binding');
SELECT is((SELECT response->>'correlation_id' FROM binding_responses WHERE label = 'create-replay'),
  (SELECT response->>'correlation_id' FROM binding_responses WHERE label = 'create-missing'),
  'binding rejection replay retains original correlation');
SELECT is((SELECT response->'body' FROM binding_responses WHERE label = 'create-replay'),
  (SELECT response->'body' FROM binding_responses WHERE label = 'create-missing'),
  'binding rejection replay retains original response');
SELECT is((SELECT COUNT(*) FROM public.webhook_inbox WHERE webhook_source_id IN (SELECT source_id FROM binding_cases)),
  8::BIGINT, 'binding replay does not duplicate inbox');
SELECT ok(wi.id IS NOT NULL AND wi.processing_status = 'failed' AND wi.workflow_run_id IS NULL
  AND wi.correlation_id::TEXT = r.response->>'correlation_id'
  AND wi.headers::TEXT NOT LIKE '%binding-secret%',
  r.label || ' persists failed sanitized source-bound inbox evidence')
FROM binding_responses r LEFT JOIN public.webhook_inbox wi ON wi.id::TEXT = r.response->>'webhook_id'
WHERE r.label IN ('create-missing', 'alias-missing', 'payload-spoof', 'inactive-sender', 'inactive-client', 'foreign-org');
SELECT ok(EXISTS (
 SELECT 1 FROM public.decision_log dl
 WHERE dl.resource_id::TEXT = r.response->>'webhook_id'
   AND dl.correlation_id::TEXT = r.response->>'correlation_id'
   AND dl.decision_category = 'http_response_emitted' AND dl.decision_outcome = 'response_failed'
   AND dl.decision_inputs#>>'{validation_results,source_binding,status}' = 'failed'
   AND dl.decision_reason = 'webhook_source_missing_sender_client'
), r.label || ' has correlated source-binding rejection decision')
FROM binding_responses r WHERE r.label IN ('create-missing', 'alias-missing', 'payload-spoof', 'inactive-sender', 'inactive-client', 'foreign-org');

SELECT * FROM finish();
ROLLBACK;
