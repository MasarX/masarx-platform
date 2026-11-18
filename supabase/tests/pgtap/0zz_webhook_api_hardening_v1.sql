BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(24);

SELECT is(
  public.jsonb_resolve_path('{"request":{"id":"request-1"}}'::jsonb, '$.request.id'),
  '"request-1"'::jsonb,
  'jsonb_resolve_path accepts the configured JSONPath root marker'
);

SELECT ok(
  to_regprocedure('public.normalize_shipment_intent_v1(text, text)') IS NOT NULL,
  'normalize_shipment_intent_v1 exists'
);

SELECT is(
  public.normalize_shipment_intent_v1('shipment_create', NULL),
  'shipment.create',
  'shipment_create normalizes to canonical dotted intent'
);

SELECT is(
  public.normalize_shipment_intent_v1(NULL, 'shipment.updated'),
  'shipment.updated',
  'provider event shipment.updated remains generic until payload classification resolves it'
);

SELECT ok(
  to_regprocedure('public.resolve_webhook_shipment_intent_v1(jsonb,text,text)') IS NOT NULL,
  'resolve_webhook_shipment_intent_v1 exists'
);

SELECT ok(
  public.should_reserve_identifiers_for_shipment_intent_v1('shipment.create', '{}'::jsonb),
  'shipment.create reserves identifiers by default'
);

SELECT ok(
  public.should_reserve_identifiers_for_shipment_intent_v1('shipment.return', '{}'::jsonb),
  'shipment.return reserves identifiers by default'
);

SELECT ok(
  NOT public.should_reserve_identifiers_for_shipment_intent_v1('shipment.swap', '{}'::jsonb),
  'shipment.swap does not reserve identifiers by default'
);

SELECT ok(
  public.should_reserve_identifiers_for_shipment_intent_v1(
    'shipment.swap',
    '{"workflow":{"reserve_new_tracking":true}}'::jsonb
  ),
  'shipment.swap can opt into new tracking reservation'
);

SELECT ok(
  pg_get_functiondef('public.resolve_api_route_v1(text,text,uuid,uuid,uuid,uuid)'::regprocedure) NOT LIKE '%WHEN ''source'' THEN 50%',
  'resolve_api_route_v1 no longer hardcodes fixed scope ranks'
);

SELECT ok(
  pg_get_functiondef('public.resolve_api_route_v1(text,text,uuid,uuid,uuid,uuid)'::regprocedure) LIKE '%resolve_scope_path_v1%',
  'resolve_api_route_v1 delegates precedence to registry-driven scope path resolution'
);

INSERT INTO public.organizations (id, name, slug)
VALUES ('6aa00000-0000-0000-0000-000000000001', 'pgTAP Webhook API Org', 'pgtap-webhook-api-hardening')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES ('6aa00000-0000-0000-0000-000000000002', '6aa00000-0000-0000-0000-000000000001', 'pgTAP Webhook API Client', 'pgtap-webhook-api-client', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
VALUES ('6aa00000-0000-0000-0000-000000000003', '6aa00000-0000-0000-0000-000000000002', 'pgTAP Sender', 'pgTAP Sender', TRUE, 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
VALUES (
  '6aa00000-0000-0000-0000-000000000004',
  'webhook_inbound',
  'pgtap-webhook-api-hardening::shipment.created',
  '{}'::jsonb,
  1,
  'pgTAP webhook api hardening mapping'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  sender_id,
  rate_limit_per_hour,
  enabled
)
VALUES (
  '6aa00000-0000-0000-0000-000000000005',
  '6aa00000-0000-0000-0000-000000000001',
  'pgtap-webhook-api-hardening-source',
  'pgTAP Webhook Source',
  'provider',
  'token-pgtap-webhook-api-hardening',
  '6aa00000-0000-0000-0000-000000000004',
  '6aa00000-0000-0000-0000-000000000003',
  1000,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

SELECT public.upsert_webhook_ingest_policy(
  'source',
  '6aa00000-0000-0000-0000-000000000005',
  jsonb_build_object(
    'version', 1,
    'validation', jsonb_build_object(
      'idempotency', jsonb_build_object(
        'header', 'Idempotency-Key',
        'body_path', 'event.id',
        'required', TRUE
      )
    ),
    'workflow', jsonb_build_object(
      'intent', 'shipment.create'
    )
  )
);

CREATE TEMP TABLE tmp_webhook_api_hardening_response AS
SELECT public.workflow_intake_webhook(
  'token-pgtap-webhook-api-hardening',
  '{"content-type":"application/json"}'::jsonb,
  '{"event":{"type":"shipment.created"}}',
  '{"event":{"type":"shipment.created"}}'::jsonb
) AS response;

SELECT is(
  (SELECT (response->>'status')::int FROM tmp_webhook_api_hardening_response),
  400,
  'workflow_intake_webhook rejects missing required idempotency key'
);

SELECT is(
  (SELECT count(*)::int FROM public.webhook_inbox WHERE webhook_source_id = '6aa00000-0000-0000-0000-000000000005'),
  0,
  'workflow_intake_webhook does not persist webhook_inbox row when required idempotency key is missing'
);

CREATE TEMP TABLE tmp_webhook_api_hardening_replay_first AS
SELECT public.workflow_intake_webhook(
  'token-pgtap-webhook-api-hardening',
  '{"content-type":"application/json","Idempotency-Key":"evt-pgtap-webhook-api-hardening-replay"}'::jsonb,
  '{"event":{"id":"evt-pgtap-webhook-api-hardening-replay","type":"shipment.created"}}',
  '{"event":{"id":"evt-pgtap-webhook-api-hardening-replay","type":"shipment.created"}}'::jsonb
) AS response;

SELECT is(
  (SELECT response->>'response_outcome' FROM tmp_webhook_api_hardening_replay_first),
  'response_sent',
  'initial replayable webhook stores the first response'
);

CREATE TEMP TABLE tmp_webhook_api_hardening_replay_second AS
SELECT public.workflow_intake_webhook(
  'token-pgtap-webhook-api-hardening',
  '{"content-type":"application/json","Idempotency-Key":"evt-pgtap-webhook-api-hardening-replay"}'::jsonb,
  '{"event":{"id":"evt-pgtap-webhook-api-hardening-replay","type":"shipment.created"}}',
  '{"event":{"id":"evt-pgtap-webhook-api-hardening-replay","type":"shipment.created"}}'::jsonb
) AS response;

SELECT is(
  (SELECT response->>'response_outcome' FROM tmp_webhook_api_hardening_replay_second),
  'response_replayed',
  'duplicate webhook replays the stored response'
);

SELECT has_column(
  'public',
  'v_webhook_inbox_directory',
  'response_outcome',
  'v_webhook_inbox_directory exposes canonical HTTP response outcome readback'
);

SELECT is(
  (
    SELECT response_outcome
    FROM public.v_webhook_inbox_directory
    WHERE id = (
      SELECT (response->>'webhook_id')::uuid
      FROM tmp_webhook_api_hardening_replay_second
    )
  ),
  'response_replayed',
  'webhook inbox directory surfaces duplicate replay outcome from backend readback'
);

SELECT is(
  (
    SELECT response_status_code
    FROM public.v_webhook_inbox_directory
    WHERE id = (
      SELECT (response->>'webhook_id')::uuid
      FROM tmp_webhook_api_hardening_replay_second
    )
  ),
  202,
  'webhook inbox directory surfaces replay HTTP status from backend readback'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.webhook_ack_history
    WHERE webhook_inbox_id = (
      SELECT (response->>'webhook_id')::uuid
      FROM tmp_webhook_api_hardening_replay_first
    )
  ),
  1,
  'duplicate webhook does not create duplicate ack history rows'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log
    WHERE resource_type = 'webhook_inbox'
      AND resource_id = (
        SELECT (response->>'webhook_id')::uuid
        FROM tmp_webhook_api_hardening_replay_second
      )
      AND decision_outcome = 'response_replayed'
  ),
  'duplicate webhook replay is audited as response_replayed'
);

SELECT ok(
  to_regprocedure('public.resolve_effective_outbound_egress_policy_v1(uuid)') IS NOT NULL,
  'resolve_effective_outbound_egress_policy_v1 exists'
);

SELECT is(
  public.resolve_settings('outbound_egress_policy', 'global', NULL)#>>'{policy,enforce_https_only}',
  'true',
  'global outbound_egress_policy default enforces https'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'shipment_modify' AND is_active),
  'shipment_modify handler registered'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'shipment_update_attachment' AND is_active),
  'shipment_update_attachment handler registered'
);

SELECT * FROM finish();

ROLLBACK;
