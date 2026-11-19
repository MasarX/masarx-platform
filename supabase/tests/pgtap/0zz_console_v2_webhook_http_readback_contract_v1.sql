-- pgTAP: Console V2 webhook HTTP readback and mapping context contract.

BEGIN;

SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SELECT ok(
  position(
    'FROM public.webhook_inbox wi'
    IN pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure)
  ) > 0,
  'workflow_intake_webhook reads persisted webhook_inbox state before returning HTTP readback'
);

SELECT ok(
  position(
    'v_response_correlation_id'
    IN pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure)
  ) > 0
  AND position(
    '{body,correlation_id}'
    IN pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure)
  ) > 0,
  'workflow_intake_webhook writes persisted correlation_id into the returned body'
);

-- Migration 20260910003000 resolves canonical intent without injecting a source
-- mapping ID into follow-up context. HTTP readback coverage continues below.

SELECT ok(
  position(
    'v_materialized_payload#>''{shipment,recipient}'''
    IN pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
  ) > 0,
  'webhook shipment creation accepts provider shipment.recipient as recipient input'
);

SELECT ok(
  position(
    'v_materialized_payload#>''{shipment,recipient,address}'''
    IN pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
  ) > 0,
  'webhook shipment creation accepts provider shipment.recipient.address as destination address input'
);

SELECT ok(
  position(
    'v_existing_policy#>>''{ack,response_mapping_id}'''
    IN pg_get_functiondef('public.repair_integration_plugin_webhook_policy_v1(uuid,uuid)'::regprocedure)
  ) > 0,
  'plugin webhook policy repair preserves inherited ACK response mapping'
);

SELECT ok(
  position(
    'v_existing_policy#>>''{ack,response_mapping_id}'''
    IN pg_get_functiondef('public.ensure_webhook_source_plugin_binding_v1(uuid)'::regprocedure)
  ) > 0,
  'operator mapping policy repair preserves inherited ACK response mapping'
);

DO $seed$
DECLARE
  v_plugin_org UUID := 'b7ac5200-0000-4000-8000-000000000001'::UUID;
  v_plugin_mapping UUID := 'b7ac5200-0000-4000-8000-000000000002'::UUID;
  v_plugin_source UUID := 'b7ac5200-0000-4000-8000-000000000003'::UUID;
  v_plugin_id UUID := 'b7ac5200-0000-4000-8000-000000000004'::UUID;
  v_plugin_version UUID := 'b7ac5200-0000-4000-8000-000000000005'::UUID;
  v_operator_org UUID := 'b7ac5200-0000-4000-8000-000000000011'::UUID;
  v_operator_mapping UUID := 'b7ac5200-0000-4000-8000-000000000012'::UUID;
  v_operator_source UUID := 'b7ac5200-0000-4000-8000-000000000013'::UUID;
  v_operator_client UUID := 'b7ac5200-0000-4000-8000-000000000014'::UUID;
  v_operator_sender UUID := 'b7ac5200-0000-4000-8000-000000000015'::UUID;
  v_ack_mapping TEXT := '88880000-0000-0000-0000-000000000002';
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_plugin_org, 'Console V2 Webhook ACK Plugin Repair Org', 'console-v2-webhook-ack-plugin-repair-org'),
    (v_operator_org, 'Console V2 Webhook ACK Operator Repair Org', 'console-v2-webhook-ack-operator-repair-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_operator_client,
    v_operator_org,
    'Console V2 Webhook ACK Operator Repair Client',
    'console-v2-webhook-ack-operator-repair-client',
    'active'
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         status = EXCLUDED.status;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
  VALUES (
    v_operator_sender,
    v_operator_client,
    'Console V2 Webhook ACK Operator Repair Sender',
    'Console V2 Webhook ACK Operator Repair',
    false,
    true,
    'active'
  )
  ON CONFLICT (id) DO UPDATE
     SET client_id = EXCLUDED.client_id,
         name = EXCLUDED.name,
         status = EXCLUDED.status;

  INSERT INTO public.mapping_configs (
    id,
    organization_id,
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    managed_by,
    managed_metadata
  )
  VALUES
    (
      v_plugin_mapping,
      v_plugin_org,
      'webhook_inbound',
      'console-v2-webhook-ack-plugin-repair-map',
      '{"target":"shipments.create","enabled":true}'::jsonb,
      1,
      'platform',
      '{}'::jsonb
    ),
    (
      v_operator_mapping,
      v_operator_org,
      'webhook_inbound',
      'console-v2-webhook-ack-operator-repair-map',
      '{"target":"shipments.create","enabled":true}'::jsonb,
      1,
      'platform',
      '{}'::jsonb
    )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         mapping_config = EXCLUDED.mapping_config,
         managed_metadata = EXCLUDED.managed_metadata;

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    auth_token_hash,
    mapping_config_id,
    sender_id,
    enabled,
    managed_by,
    managed_metadata
  )
  VALUES
    (
      v_plugin_source,
      v_plugin_org,
      'console-v2-webhook-ack-plugin-repair',
      'Console V2 Webhook ACK Plugin Repair',
      'generic',
      NULL,
      extensions.crypt('console-v2-webhook-ack-plugin-token', extensions.gen_salt('bf')),
      v_plugin_mapping,
      NULL,
      TRUE,
      'platform',
      '{}'::jsonb
    ),
    (
      v_operator_source,
      v_operator_org,
      'console-v2-webhook-ack-operator-repair',
      'Console V2 Webhook ACK Operator Repair',
      'generic',
      NULL,
      extensions.crypt('console-v2-webhook-ack-operator-token', extensions.gen_salt('bf')),
      v_operator_mapping,
      v_operator_sender,
      TRUE,
      'platform',
      '{}'::jsonb
    )
  ON CONFLICT (id) DO UPDATE
     SET auth_token_hash = EXCLUDED.auth_token_hash,
         mapping_config_id = EXCLUDED.mapping_config_id,
         sender_id = EXCLUDED.sender_id,
         enabled = TRUE,
         managed_metadata = EXCLUDED.managed_metadata;

  INSERT INTO public.integration_plugins (
    id,
    organization_id,
    plugin_key,
    name,
    plugin_kind,
    status,
    rollout_tier,
    reusable_within_tenant,
    managed_by
  )
  VALUES (
    v_plugin_id,
    v_plugin_org,
    'console-v2-webhook-ack-plugin-repair',
    'Console V2 Webhook ACK Plugin Repair',
    'webhook',
    'approved',
    'tenant',
    TRUE,
    'integration_plugin'
  )
  ON CONFLICT (id) DO UPDATE
     SET status = EXCLUDED.status,
         plugin_kind = EXCLUDED.plugin_kind;

  INSERT INTO public.integration_plugin_versions (
    id,
    plugin_id,
    organization_id,
    version_no,
    status,
    source_type,
    source_payload,
    normalized_contract,
    inbound_config,
    mapping_config,
    workflow_binding,
    outbound_operations,
    auth_bindings,
    validation_summary,
    metadata
  )
  VALUES (
    v_plugin_version,
    v_plugin_id,
    v_plugin_org,
    1,
    'approved',
    'webhook_sample',
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    '{"target":"shipments.create","enabled":true}'::jsonb,
    '{"mode":"attach_existing","template_name":"webhook_shipment_create_v1","intent":"shipment.create"}'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
     SET status = EXCLUDED.status,
         mapping_config = EXCLUDED.mapping_config,
         workflow_binding = EXCLUDED.workflow_binding;

  PERFORM public.upsert_webhook_ingest_policy(
    'source',
    v_plugin_source,
    jsonb_build_object(
      'version', 1,
      'ack', jsonb_build_object(
        'mode', 'accepted_async',
        'status_code', 202,
        'response_mapping_id', v_ack_mapping,
        'default_headers', jsonb_build_object('content-type', 'application/json')
      ),
      'workflow', jsonb_build_object('template_name', 'webhook_shipment_create_v1', 'intent', 'shipment.create')
    )
  );

  PERFORM public.upsert_webhook_ingest_policy(
    'source',
    v_operator_source,
    jsonb_build_object(
      'version', 1,
      'ack', jsonb_build_object(
        'mode', 'accepted_async',
        'status_code', 202,
        'response_mapping_id', v_ack_mapping,
        'default_headers', jsonb_build_object('content-type', 'application/json')
      ),
      'workflow', jsonb_build_object('template_name', 'webhook_shipment_create_v1', 'intent', 'shipment.create')
    )
  );
END;
$seed$;

CREATE TEMP TABLE _webhook_ack_plugin_repair AS
SELECT public.repair_integration_plugin_webhook_policy_v1(
  'b7ac5200-0000-4000-8000-000000000003'::UUID,
  'b7ac5200-0000-4000-8000-000000000005'::UUID
) AS result;

SELECT ok(
  COALESCE((SELECT (result->>'ok')::BOOLEAN FROM _webhook_ack_plugin_repair), FALSE),
  'plugin webhook policy repair succeeds with inherited ACK mapping'
);

SELECT is(
  (
    SELECT p.policy#>>'{ack,response_mapping_id}'
      FROM public.resolve_webhook_ingest_policy('b7ac5200-0000-4000-8000-000000000003'::UUID) AS p
      LIMIT 1
  ),
  '88880000-0000-0000-0000-000000000002',
  'plugin webhook policy repair keeps inherited ACK response mapping in runtime readback'
);

CREATE TEMP TABLE _webhook_ack_operator_repair AS
SELECT public.ensure_webhook_source_plugin_binding_v1(
  'b7ac5200-0000-4000-8000-000000000013'::UUID
) AS result;

SELECT ok(
  COALESCE((SELECT (result->>'ok')::BOOLEAN FROM _webhook_ack_operator_repair), FALSE),
  'operator mapping policy repair succeeds with inherited ACK mapping'
);

SELECT is(
  (
    SELECT p.policy#>>'{ack,response_mapping_id}'
      FROM public.resolve_webhook_ingest_policy('b7ac5200-0000-4000-8000-000000000013'::UUID) AS p
      LIMIT 1
  ),
  '88880000-0000-0000-0000-000000000002',
  'operator mapping policy repair keeps inherited ACK response mapping in runtime readback'
);

SELECT ok(
  position(
    'followup_already_started'
    IN pg_get_functiondef('workflow_handlers.dispatch_followup_workflow_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
  ) > 0
  AND position(
    'p_decision_reason := ''followup_already_started'''
    IN pg_get_functiondef('workflow_handlers.dispatch_followup_workflow_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
  ) > 0,
  'dispatch follow-up logs decision lineage when the follow-up run was already started by intake'
);

SELECT ok(
  position(
    'workflow_intake_webhook_wrapper'
    IN pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure)
  ) > 0
  AND position(
    'workflow_enqueued'
    IN pg_get_functiondef('public.workflow_intake_webhook(text,jsonb,text,jsonb)'::regprocedure)
  ) > 0,
  'webhook wrapper records follow-up workflow decision lineage when core starts the follow-up'
);

SELECT * FROM finish();

ROLLBACK;
