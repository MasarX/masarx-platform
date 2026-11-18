-- pgTAP: Verify workflow_intake_webhook intent gating behavior

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);
CREATE TEMP TABLE pgtap_intent_results (ordinal integer PRIMARY KEY, passed boolean, description text);

DO $$
DECLARE
  v_provider_type TEXT;
  v_org_id UUID := gen_random_uuid();
  v_client_id UUID := gen_random_uuid();
  v_sender_id UUID := gen_random_uuid();
  v_mapping_id UUID := gen_random_uuid();
  v_source_id UUID := gen_random_uuid();
  v_token TEXT := 'pgtap-intent-' || replace(gen_random_uuid()::text, '-', '');
  v_create_payload JSONB := jsonb_build_object(
    'event',
    jsonb_build_object('id', 'intent-test-create', 'type', 'shipment.created')
  );
  v_status_payload JSONB := jsonb_build_object(
    'event',
    jsonb_build_object('id', 'intent-test-status', 'type', 'shipment.status_update')
  );
  v_result JSONB;
BEGIN
  SELECT lv.value
    INTO v_provider_type
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv
      ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'integration_type'
     AND COALESCE(lv.status, 'active') = 'active'
   ORDER BY COALESCE(lv.sort_order, 2147483647), lv.value
   LIMIT 1;

  v_provider_type := COALESCE(v_provider_type, 'provider');

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status, default_settings)
  VALUES (
    v_org_id,
    'pgTAP Intent Org',
    'pgtap-intent-org-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
    'Asia/Riyadh',
    'en-US',
    'active',
    '{}'::jsonb
  );

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status, settings_override)
  VALUES (
    v_client_id,
    v_org_id,
    'pgTAP Intent Client',
    'pgtap-intent-client-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
    'standard',
    'active',
    '{}'::jsonb
  );

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override)
  VALUES (
    v_sender_id,
    v_client_id,
    'pgTAP Intent Sender',
    'pgTAP Intent Sender',
    FALSE,
    TRUE,
    'active',
    '{}'::jsonb
  );

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org_id,
    'pgtap:workflow-intake-intent-gating-fixture-bootstrap'
  );

  INSERT INTO public.mapping_configs (
    id,
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    notes,
    organization_id
  )
  VALUES (
    v_mapping_id,
    'webhook_inbound',
    'pgtap::intent-gating::' || left(replace(gen_random_uuid()::text, '-', ''), 8),
    jsonb_build_object(
      'description', 'pgTAP intent gating mapping',
      'external_id_path', 'event.id',
      'event_type_path', 'event.type',
      'transforms', jsonb_build_object(
        'default', jsonb_build_object(
          'event_id', 'event.id',
          'event_type', 'event.type'
        )
      )
    ),
    1,
    'pgTAP intent gating fixture mapping',
    v_org_id
  );

  INSERT INTO public.webhook_sources (
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
  VALUES (
    v_source_id,
    v_org_id,
    'pgtap-intent-source-' || left(replace(gen_random_uuid()::text, '-', ''), 8),
    'pgTAP Intent Source',
    v_provider_type,
    v_token,
    v_mapping_id,
    500,
    TRUE,
    v_sender_id
  );

  PERFORM public.upsert_settings_value_v1(
    'webhook_ingest_policy',
    'sender',
    v_sender_id,
    jsonb_build_object(
      'ack', jsonb_build_object(
        'mode', 'synchronous_success',
        'status_code', 200
      ),
      'workflow', jsonb_build_object('intent', 'shipment_create'),
      'validation', jsonb_build_object(
        'idempotency',
        jsonb_build_object('body_path', 'event.id')
      )
    ),
    1,
    'pgTAP intent gating create-intent fixture (sender scope)'
  );

  v_result := public.workflow_intake_webhook(
    v_token,
    jsonb_build_object('content-type', 'application/json', 'x-webhook-token', v_token),
    v_create_payload::text,
    v_create_payload
  );

  INSERT INTO pgtap_intent_results VALUES (1,
    v_result->'body' ? 'resource',
    'Shipment create intent includes resource in ACK body'
  );

  PERFORM public.upsert_settings_value_v1(
    'webhook_ingest_policy',
    'sender',
    v_sender_id,
    jsonb_build_object(
      'ack', jsonb_build_object(
        'mode', 'synchronous_success',
        'status_code', 200
      ),
      'workflow', jsonb_build_object('intent', 'status_update'),
      'validation', jsonb_build_object(
        'idempotency',
        jsonb_build_object('body_path', 'event.id')
      )
    ),
    1,
    'pgTAP intent gating status-intent fixture (sender scope)'
  );

  v_result := public.workflow_intake_webhook(
    v_token,
    jsonb_build_object('content-type', 'application/json', 'x-webhook-token', v_token),
    v_status_payload::text,
    v_status_payload
  );

  INSERT INTO pgtap_intent_results VALUES (2,
    NOT (v_result->'body' ? 'resource'),
    'Non-creation intent omits resource from ACK body'
  );
END;
$$;

SELECT ok(passed,description) FROM pgtap_intent_results ORDER BY ordinal;
SELECT * FROM finish();

ROLLBACK;
