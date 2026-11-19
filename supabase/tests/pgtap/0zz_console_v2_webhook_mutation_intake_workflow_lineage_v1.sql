-- pgTAP: webhook cancel/reschedule intake starts canonical workflow lineage
-- without planning a synthetic shipment resource.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(28);

SET search_path TO public, pgtap, extensions, pg_temp;

CREATE OR REPLACE FUNCTION pg_temp.seed_webhook_mutation_source(
  p_suffix TEXT,
  p_mapping_target TEXT,
  p_token TEXT
)
RETURNS UUID
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := ('f9a10000-0000-0000-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_client UUID := ('f9a10000-0000-0001-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_sender UUID := ('f9a10000-0000-0002-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_mapping UUID := ('f9a10000-0000-0003-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_plugin UUID := ('f9a10000-0000-0004-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_plugin_version UUID := ('f9a10000-0000-0005-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_source UUID := ('f9a10000-0000-0006-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_canonical_intent TEXT := CASE
    WHEN p_mapping_target IN ('shipments.cancel', 'shipments.delete') THEN 'shipment.delete'
    WHEN p_mapping_target = 'shipments.reschedule' THEN 'shipment.reschedule'
    ELSE p_mapping_target
  END;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Webhook Mutation Org ' || p_suffix, 'console-v2-webhook-mutation-' || p_suffix)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Webhook Mutation Client ' || p_suffix, 'console-v2-webhook-mutation-client-' || p_suffix, 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Console V2 Webhook Mutation Sender ' || p_suffix, 'active')
  ON CONFLICT (id) DO NOTHING;

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
  VALUES (
    v_mapping,
    v_org,
    'webhook_inbound',
    'console-v2-webhook-mutation-map-' || p_suffix,
    jsonb_build_object('target', p_mapping_target),
    1,
    'integration_plugin',
    jsonb_build_object('plugin_id', v_plugin, 'plugin_version_id', v_plugin_version)
  )
  ON CONFLICT (id) DO UPDATE
     SET mapping_config = EXCLUDED.mapping_config;

  INSERT INTO public.integration_plugins (
    id,
    organization_id,
    plugin_key,
    name,
    plugin_kind,
    status
  )
  VALUES (
    v_plugin,
    v_org,
    'console-v2-webhook-mutation-' || p_suffix,
    'Console V2 Webhook Mutation ' || p_suffix,
    'webhook',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.integration_plugin_versions (
    id,
    plugin_id,
    organization_id,
    version_no,
    status,
    mapping_config,
    workflow_binding
  )
  VALUES (
    v_plugin_version,
    v_plugin,
    v_org,
    1,
    'active',
    jsonb_build_object('target', p_mapping_target),
    jsonb_build_object('template_name', 'async_provider_dispatch_v1', 'intent', p_mapping_target)
  )
  ON CONFLICT (id) DO UPDATE
     SET mapping_config = EXCLUDED.mapping_config,
         workflow_binding = EXCLUDED.workflow_binding;

  UPDATE public.integration_plugins
     SET active_version_id = v_plugin_version
   WHERE id = v_plugin;

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
  VALUES (
    v_source,
    v_org,
    'console-v2-webhook-mutation-source-' || p_suffix,
    'Console V2 Webhook Mutation Source ' || p_suffix,
    'generic',
    NULL,
    extensions.crypt(p_token, extensions.gen_salt('bf')),
    v_mapping,
    v_sender,
    TRUE,
    'integration_plugin',
    jsonb_build_object('plugin_id', v_plugin, 'plugin_version_id', v_plugin_version)
  )
  ON CONFLICT (id) DO UPDATE
     SET auth_token_hash = EXCLUDED.auth_token_hash,
         mapping_config_id = EXCLUDED.mapping_config_id,
         sender_id = EXCLUDED.sender_id,
         enabled = TRUE;

  INSERT INTO public.integration_plugin_bindings (
    plugin_version_id,
    organization_id,
    scope_type,
    scope_id,
    binding_type,
    runtime_resource_type,
    runtime_resource_id,
    enabled
  )
  VALUES (
    v_plugin_version,
    v_org,
    'tenant',
    v_org,
    'webhook_source',
    'webhook_sources',
    v_source,
    TRUE
  )
  ON CONFLICT DO NOTHING;

  PERFORM public.upsert_webhook_ingest_policy(
    'source',
    v_source,
    jsonb_build_object(
      'version', 1,
      'ack', jsonb_build_object(
        'mode', 'accepted_async',
        'status_code', 202,
        'default_headers', jsonb_build_object('content-type', 'application/json')
      ),
      'workflow', jsonb_build_object(
        'template_name', 'async_provider_dispatch_v1',
        'intent', v_canonical_intent,
        'templates_by_intent', jsonb_build_object(
          'shipment.delete', jsonb_build_object('template_name', 'shipment_delete_v1'),
          'shipment.reschedule', jsonb_build_object('template_name', 'shipment_reschedule_v1')
        )
      ),
      'validation', jsonb_build_object(
        'idempotency', jsonb_build_object(
          'header', 'Idempotency-Key',
          'body_path', 'event.id',
          'dedupe_window_seconds', 86400
        )
      )
    )
  );

  RETURN v_source;
END;
$function$;

SELECT ok(
  pg_temp.seed_webhook_mutation_source('000000000601', 'shipments.cancel', 'console-v2-webhook-cancel-token') IS NOT NULL,
  'cancel webhook mutation source seeded'
);

SELECT ok(
  pg_temp.seed_webhook_mutation_source('000000000602', 'shipments.reschedule', 'console-v2-webhook-reschedule-token') IS NOT NULL,
  'reschedule webhook mutation source seeded'
);

CREATE TEMP TABLE _webhook_cancel_result AS
SELECT public.workflow_intake_webhook_core_v1(
  'console-v2-webhook-cancel-token',
  jsonb_build_object(
    'idempotency-key', 'console-v2-webhook-cancel-lineage',
    'x-correlation-id', 'console-v2-webhook-cancel-lineage'
  ),
  jsonb_build_object(
    'event', jsonb_build_object('id', 'console-v2-webhook-cancel-lineage', 'type', 'shipment.canceled'),
    'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-CANCEL-LINEAGE', 'cancel_reason', 'customer request')
  )::text,
  jsonb_build_object(
    'event', jsonb_build_object('id', 'console-v2-webhook-cancel-lineage', 'type', 'shipment.canceled'),
    'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-CANCEL-LINEAGE', 'cancel_reason', 'customer request')
  )
) AS result;

CREATE TEMP TABLE _webhook_reschedule_result AS
SELECT public.workflow_intake_webhook_core_v1(
  'console-v2-webhook-reschedule-token',
  jsonb_build_object(
    'idempotency-key', 'console-v2-webhook-reschedule-lineage',
    'x-correlation-id', 'console-v2-webhook-reschedule-lineage'
  ),
  jsonb_build_object(
    'event', jsonb_build_object('id', 'console-v2-webhook-reschedule-lineage', 'type', 'shipment.rescheduled'),
    'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-RESCHEDULE-LINEAGE'),
    'delivery', jsonb_build_object('slot_date', '2026-05-18')
  )::text,
  jsonb_build_object(
    'event', jsonb_build_object('id', 'console-v2-webhook-reschedule-lineage', 'type', 'shipment.rescheduled'),
    'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-RESCHEDULE-LINEAGE'),
    'delivery', jsonb_build_object('slot_date', '2026-05-18')
  )
) AS result;

CREATE TEMP TABLE _webhook_cancel_replay_result AS
SELECT public.workflow_intake_webhook_core_v1(
  'console-v2-webhook-cancel-token',
  jsonb_build_object(
    'idempotency-key', 'console-v2-webhook-cancel-lineage',
    'x-correlation-id', 'console-v2-webhook-cancel-lineage-replay'
  ),
  jsonb_build_object(
    'event', jsonb_build_object('id', 'console-v2-webhook-cancel-lineage', 'type', 'shipment.canceled'),
    'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-CANCEL-LINEAGE', 'cancel_reason', 'customer request')
  )::text,
  jsonb_build_object(
    'event', jsonb_build_object('id', 'console-v2-webhook-cancel-lineage', 'type', 'shipment.canceled'),
    'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-CANCEL-LINEAGE', 'cancel_reason', 'customer request')
  )
) AS result;

CREATE TEMP TABLE _webhook_reschedule_replay_result AS
SELECT public.workflow_intake_webhook_core_v1(
  'console-v2-webhook-reschedule-token',
  jsonb_build_object(
    'idempotency-key', 'console-v2-webhook-reschedule-lineage',
    'x-correlation-id', 'console-v2-webhook-reschedule-lineage-replay'
  ),
  jsonb_build_object(
    'event', jsonb_build_object('id', 'console-v2-webhook-reschedule-lineage', 'type', 'shipment.rescheduled'),
    'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-RESCHEDULE-LINEAGE'),
    'delivery', jsonb_build_object('slot_date', '2026-05-18')
  )::text,
  jsonb_build_object(
    'event', jsonb_build_object('id', 'console-v2-webhook-reschedule-lineage', 'type', 'shipment.rescheduled'),
    'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-RESCHEDULE-LINEAGE'),
    'delivery', jsonb_build_object('slot_date', '2026-05-18')
  )
) AS result;

CREATE TEMP TABLE _mutation_results AS
SELECT 'cancel'::TEXT AS mutation, result FROM _webhook_cancel_result
UNION ALL
SELECT 'reschedule'::TEXT AS mutation, result FROM _webhook_reschedule_result;

SELECT is(
  (SELECT result->>'ack_outcome' FROM _webhook_cancel_result),
  'ack_sent',
  'cancel webhook mutation intake is accepted'
);

SELECT is(
  (SELECT (result->>'status')::INT FROM _webhook_cancel_result),
  202,
  'cancel webhook mutation returns accepted async status'
);

SELECT is(
  (SELECT result->>'canonical_intent' FROM _webhook_cancel_result),
  'shipment.delete',
  'cancel webhook mutation resolves to shipment.delete'
);

SELECT is(
  (SELECT result->>'ack_outcome' FROM _webhook_reschedule_result),
  'ack_sent',
  'reschedule webhook mutation intake is accepted'
);

SELECT is(
  (SELECT (result->>'status')::INT FROM _webhook_reschedule_result),
  202,
  'reschedule webhook mutation returns accepted async status'
);

SELECT is(
  (SELECT result->>'canonical_intent' FROM _webhook_reschedule_result),
  'shipment.reschedule',
  'reschedule webhook mutation resolves to shipment.reschedule'
);

SELECT is(
  (SELECT result->>'ack_outcome' FROM _webhook_cancel_replay_result),
  'ack_replayed',
  'duplicate cancel webhook mutation replays the stored ACK'
);

SELECT is(
  (SELECT result->>'ack_outcome' FROM _webhook_reschedule_replay_result),
  'ack_replayed',
  'duplicate reschedule webhook mutation replays the stored ACK'
);

SELECT is(
  (SELECT (result->>'status')::INT FROM _webhook_cancel_replay_result),
  202,
  'duplicate cancel webhook mutation preserves accepted async status'
);

SELECT is(
  (SELECT (result->>'status')::INT FROM _webhook_reschedule_replay_result),
  202,
  'duplicate reschedule webhook mutation preserves accepted async status'
);

SELECT is(
  (SELECT result->>'webhook_id' FROM _webhook_cancel_replay_result),
  (SELECT result->>'webhook_id' FROM _webhook_cancel_result),
  'duplicate cancel webhook mutation points back to the original inbox row'
);

SELECT is(
  (SELECT result->>'webhook_id' FROM _webhook_reschedule_replay_result),
  (SELECT result->>'webhook_id' FROM _webhook_reschedule_result),
  'duplicate reschedule webhook mutation points back to the original inbox row'
);

SELECT is(
  (
    SELECT count(*)::INT
      FROM public.webhook_inbox
     WHERE idempotency_key = 'console-v2-webhook-cancel-lineage'
  ),
  1,
  'duplicate cancel webhook mutation does not create a second inbox row'
);

SELECT is(
  (
    SELECT count(*)::INT
      FROM public.webhook_inbox
     WHERE idempotency_key = 'console-v2-webhook-reschedule-lineage'
  ),
  1,
  'duplicate reschedule webhook mutation does not create a second inbox row'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM _mutation_results
     WHERE result#>>'{body,resource,type}' = 'shipment'
        OR result#>>'{body,resource,tracking_number}' IS NOT NULL
  ),
  'cancel/reschedule webhook mutations do not return planned shipment placeholders'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM _mutation_results
     WHERE NULLIF(result->>'workflow_run_id', '') IS NULL
        OR NULLIF(result->>'followup_workflow_run_id', '') IS NULL
  ),
  'cancel/reschedule webhook mutations return entry and follow-up workflow ids'
);

SELECT is(
  (
    SELECT wt.name
      FROM _webhook_cancel_result r
      JOIN public.workflow_runs wr
        ON wr.id = (r.result->>'followup_workflow_run_id')::UUID
      JOIN public.workflow_templates wt
        ON wt.id = wr.workflow_template_id
  ),
  'shipment_delete_v1',
  'cancel webhook mutation starts shipment_delete_v1 follow-up workflow'
);

SELECT is(
  (
    SELECT wt.name
      FROM _webhook_reschedule_result r
      JOIN public.workflow_runs wr
        ON wr.id = (r.result->>'followup_workflow_run_id')::UUID
      JOIN public.workflow_templates wt
        ON wt.id = wr.workflow_template_id
  ),
  'shipment_reschedule_v1',
  'reschedule webhook mutation starts shipment_reschedule_v1 follow-up workflow'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM _mutation_results r
      JOIN public.workflow_runs wr
        ON wr.id = (r.result->>'followup_workflow_run_id')::UUID
     WHERE COALESCE((wr.context->>'reserve_identifiers')::BOOLEAN, FALSE) IS TRUE
        OR NULLIF(wr.context->>'planned_tracking_number', '') IS NOT NULL
        OR NULLIF(wr.context->>'planned_shipment_id', '') IS NOT NULL
  ),
  'cancel/reschedule follow-up workflows do not reserve identifiers or planned shipments'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM _mutation_results r
      JOIN public.workflow_runs entry
        ON entry.id = (r.result->>'workflow_run_id')::UUID
      JOIN public.workflow_runs followup
        ON followup.id = (r.result->>'followup_workflow_run_id')::UUID
     WHERE followup.metadata->>'started_by_run_id' IS DISTINCT FROM entry.id::TEXT
       AND followup.context->>'started_by_run_id' IS DISTINCT FROM entry.id::TEXT
  ),
  'cancel/reschedule follow-up workflows keep entry workflow lineage'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM _mutation_results r
      JOIN public.webhook_inbox wi
        ON wi.id = (r.result->>'webhook_id')::UUID
     WHERE wi.processing_status <> 'in_progress'
        OR wi.workflow_run_id IS DISTINCT FROM (r.result->>'workflow_run_id')::UUID
        OR wi.event_type IS NULL
        OR wi.transformed_payload IS NULL
  ),
  'cancel/reschedule webhook inbox rows keep in-progress workflow readback'
);

SELECT is(
  (
    SELECT wi.event_type
      FROM _webhook_cancel_result r
      JOIN public.webhook_inbox wi
        ON wi.id = (r.result->>'webhook_id')::UUID
  ),
  'shipment.canceled',
  'cancel webhook inbox stores typed cancellation event'
);

SELECT is(
  (
    SELECT wi.event_type
      FROM _webhook_reschedule_result r
      JOIN public.webhook_inbox wi
        ON wi.id = (r.result->>'webhook_id')::UUID
  ),
  'shipment.rescheduled',
  'reschedule webhook inbox stores typed reschedule event'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM _webhook_cancel_result r
      JOIN public.decision_log dl
        ON dl.resource_id = (r.result->>'webhook_id')::UUID
     WHERE dl.decision_category = 'http_response_emitted'
       AND dl.decision_inputs->>'canonical_intent' = 'shipment.delete'
  ),
  'cancel webhook response decision records canonical shipment.delete intent'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM _webhook_reschedule_result r
      JOIN public.decision_log dl
        ON dl.resource_id = (r.result->>'webhook_id')::UUID
     WHERE dl.decision_category = 'http_response_emitted'
       AND dl.decision_inputs->>'canonical_intent' = 'shipment.reschedule'
  ),
  'reschedule webhook response decision records canonical shipment.reschedule intent'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.shipments
     WHERE tracking_number IN ('P0-WEBHOOK-CANCEL-LINEAGE', 'P0-WEBHOOK-RESCHEDULE-LINEAGE')
  ),
  'cancel/reschedule intake does not materialize synthetic shipments at ack time'
);

SELECT * FROM finish();

ROLLBACK;
