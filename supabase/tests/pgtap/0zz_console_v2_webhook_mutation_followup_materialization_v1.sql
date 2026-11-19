-- pgTAP: webhook-backed cancel/reschedule mutations must complete the
-- downstream shipment operation workflow when the target shipment exists.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(20);

SET search_path TO extensions, public, pgtap, pg_temp;

CREATE OR REPLACE FUNCTION pg_temp.seed_webhook_mutation_materialization_source(
  p_suffix TEXT,
  p_mapping_target TEXT,
  p_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := ('f9b10000-0000-0000-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_client UUID := ('f9b10000-0000-0001-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_sender UUID := ('f9b10000-0000-0002-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_mapping UUID := ('f9b10000-0000-0003-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_plugin UUID := ('f9b10000-0000-0004-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_plugin_version UUID := ('f9b10000-0000-0005-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_source UUID := ('f9b10000-0000-0006-0000-' || lpad(p_suffix, 12, '0'))::UUID;
  v_canonical_intent TEXT := CASE
    WHEN p_mapping_target IN ('shipments.cancel', 'shipments.delete') THEN 'shipment.delete'
    WHEN p_mapping_target = 'shipments.reschedule' THEN 'shipment.reschedule'
    ELSE p_mapping_target
  END;
BEGIN
  INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (v_org, 'Console V2 Webhook Materialization Org ' || p_suffix, 'console-v2-webhook-materialize-' || p_suffix, 'UTC', 'en-US', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Webhook Materialization Client ' || p_suffix, 'console-v2-webhook-materialize-client-' || p_suffix, 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Console V2 Webhook Materialization Sender ' || p_suffix, 'Console V2 Webhook Materialization Sender', TRUE, 'active')
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
    'console-v2-webhook-materialize-map-' || p_suffix,
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
    'console-v2-webhook-materialize-' || p_suffix,
    'Console V2 Webhook Materialization ' || p_suffix,
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
    'console-v2-webhook-materialize-source-' || p_suffix,
    'Console V2 Webhook Materialization Source ' || p_suffix,
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

  RETURN jsonb_build_object(
    'organization_id', v_org,
    'client_id', v_client,
    'sender_id', v_sender,
    'source_id', v_source
  );
END;
$function$;

CREATE TEMP TABLE _webhook_materialization_results (
  case_key TEXT PRIMARY KEY,
  result JSONB,
  followup_id UUID,
  workflow_status TEXT,
  shipment_status TEXT,
  promised_delivery_date DATE,
  action_count INT,
  action_reason TEXT,
  shipment_cancel_reason TEXT,
  last_error TEXT
) ON COMMIT DROP;

DO $$
DECLARE
  v_cancel_fixture JSONB;
  v_reschedule_fixture JSONB;
  v_cancel_org UUID;
  v_cancel_client UUID;
  v_cancel_sender UUID;
  v_reschedule_org UUID;
  v_reschedule_client UUID;
  v_reschedule_sender UUID;
  v_cancel_shipment UUID := 'f9b10000-0000-0007-0000-000000000701';
  v_reschedule_shipment UUID := 'f9b10000-0000-0007-0000-000000000702';
  v_zone UUID := 'f9b10000-0000-0008-0000-000000000702';
  v_branch UUID := 'f9b10000-0000-0009-0000-000000000702';
  v_window UUID := 'f9b10000-0000-0010-0000-000000000702';
  v_slot_date DATE := current_date + 3;
  v_policy JSONB;
  v_cancel_result JSONB;
  v_reschedule_result JSONB;
  v_cancel_entry UUID;
  v_reschedule_entry UUID;
  v_cancel_followup UUID;
  v_reschedule_followup UUID;
  i INT;
BEGIN
  v_cancel_fixture := pg_temp.seed_webhook_mutation_materialization_source(
    '000000000701',
    'shipments.cancel',
    'console-v2-webhook-materialize-cancel-token'
  );
  v_reschedule_fixture := pg_temp.seed_webhook_mutation_materialization_source(
    '000000000702',
    'shipments.reschedule',
    'console-v2-webhook-materialize-reschedule-token'
  );

  v_cancel_org := (v_cancel_fixture->>'organization_id')::UUID;
  v_cancel_client := (v_cancel_fixture->>'client_id')::UUID;
  v_cancel_sender := (v_cancel_fixture->>'sender_id')::UUID;
  v_reschedule_org := (v_reschedule_fixture->>'organization_id')::UUID;
  v_reschedule_client := (v_reschedule_fixture->>'client_id')::UUID;
  v_reschedule_sender := (v_reschedule_fixture->>'sender_id')::UUID;

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    created_at,
    updated_at
  )
  VALUES (
    v_cancel_shipment,
    v_cancel_org,
    v_cancel_client,
    v_cancel_sender,
    'delivery',
    'P0-WEBHOOK-CANCEL-MATERIALIZE',
    'pending',
    now(),
    now()
  )
  ON CONFLICT (id, client_id) DO UPDATE
     SET status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at;

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone, v_reschedule_org, 'Webhook Materialization Zone', 'webhook-materialization-zone', TRUE)
  ON CONFLICT (id) DO UPDATE SET is_active = TRUE;

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_reschedule_org, 'webhook-materialization-branch', 'Webhook Materialization Branch', 'UTC', TRUE)
  ON CONFLICT (id) DO UPDATE SET is_active = TRUE;

  INSERT INTO public.branch_zones (branch_id, zone_id)
  VALUES (v_branch, v_zone)
  ON CONFLICT DO NOTHING;

  v_policy := jsonb_build_object(
    'version', 3,
    'enabled', true,
    'timezone', 'UTC',
    'use_branch_timezone', true,
    'default_service_level', 'standard',
    'default_transit_days', 1,
    'service_level_transit_days', jsonb_build_object('standard', 1),
    'delivery_window_start', '09:00',
    'delivery_window_end', '18:00',
    'calendar_enabled', false,
    'capacity_enabled', true,
    'capacity_behavior', 'shift',
    'capacity_usage_mode', 'shipments_by_promised_date',
    'capacity_limit_key', 'max_shipments',
    'capacity_demand', 1,
    'capacity_max_shift_days', 7
  );

  PERFORM public.upsert_settings_value_v1(
    'shipment_promise_policy',
    'sender',
    v_reschedule_sender,
    v_policy,
    3,
    'pgTAP webhook mutation materialization promise policy'
  );

  INSERT INTO public.branch_capacity_windows (
    id,
    branch_id,
    zone_id,
    effective_from,
    effective_to,
    window_start_local,
    window_end_local,
    capacity,
    is_active,
    metadata
  )
  VALUES (
    v_window,
    v_branch,
    v_zone,
    (current_date - 30)::timestamptz,
    NULL,
    '09:00'::time,
    '12:00'::time,
    jsonb_build_object('max_shipments', 25),
    TRUE,
    jsonb_build_object('pgtap', TRUE, 'slice', 'webhook_mutation_materialization')
  )
  ON CONFLICT (id) DO UPDATE
     SET capacity = EXCLUDED.capacity,
         is_active = TRUE;

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    zone_id,
    service_level,
    created_at,
    updated_at
  )
  VALUES (
    v_reschedule_shipment,
    v_reschedule_org,
    v_reschedule_client,
    v_reschedule_sender,
    'delivery',
    'P0-WEBHOOK-RESCHEDULE-MATERIALIZE',
    'pending',
    v_zone,
    'standard',
    now(),
    now()
  )
  ON CONFLICT (id, client_id) DO UPDATE
     SET status = EXCLUDED.status,
         promised_delivery_date = NULL,
         promised_delivery_at = NULL,
         promised_window_start_at = NULL,
         promised_window_end_at = NULL,
         zone_id = EXCLUDED.zone_id,
         service_level = EXCLUDED.service_level,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at;

  v_cancel_result := public.workflow_intake_webhook_core_v1(
    'console-v2-webhook-materialize-cancel-token',
    jsonb_build_object(
      'idempotency-key', 'console-v2-webhook-cancel-materialize',
      'x-correlation-id', 'console-v2-webhook-cancel-materialize'
    ),
    jsonb_build_object(
      'event', jsonb_build_object('id', 'console-v2-webhook-cancel-materialize', 'type', 'shipment.canceled'),
      'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-CANCEL-MATERIALIZE', 'cancel_reason', 'customer request')
    )::text,
    jsonb_build_object(
      'event', jsonb_build_object('id', 'console-v2-webhook-cancel-materialize', 'type', 'shipment.canceled'),
      'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-CANCEL-MATERIALIZE', 'cancel_reason', 'customer request')
    )
  );

  v_reschedule_result := public.workflow_intake_webhook_core_v1(
    'console-v2-webhook-materialize-reschedule-token',
    jsonb_build_object(
      'idempotency-key', 'console-v2-webhook-reschedule-materialize',
      'x-correlation-id', 'console-v2-webhook-reschedule-materialize'
    ),
    jsonb_build_object(
      'event', jsonb_build_object('id', 'console-v2-webhook-reschedule-materialize', 'type', 'shipment.rescheduled'),
      'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-RESCHEDULE-MATERIALIZE'),
      'delivery', jsonb_build_object('slot_date', v_slot_date)
    )::text,
    jsonb_build_object(
      'event', jsonb_build_object('id', 'console-v2-webhook-reschedule-materialize', 'type', 'shipment.rescheduled'),
      'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-RESCHEDULE-MATERIALIZE'),
      'delivery', jsonb_build_object('slot_date', v_slot_date)
    )
  );

  v_cancel_entry := NULLIF(v_cancel_result->>'workflow_run_id', '')::UUID;
  v_reschedule_entry := NULLIF(v_reschedule_result->>'workflow_run_id', '')::UUID;
  v_cancel_followup := NULLIF(v_cancel_result->>'followup_workflow_run_id', '')::UUID;
  v_reschedule_followup := NULLIF(v_reschedule_result->>'followup_workflow_run_id', '')::UUID;

  FOR i IN 1..5 LOOP
    PERFORM public.progress_workflow_run(v_cancel_entry);
    EXIT WHEN EXISTS (
      SELECT 1
        FROM public.workflow_runs wr
       WHERE wr.id = v_cancel_entry
         AND wr.workflow_status IN ('completed', 'failed')
    );
  END LOOP;

  FOR i IN 1..5 LOOP
    PERFORM public.progress_workflow_run(v_reschedule_entry);
    EXIT WHEN EXISTS (
      SELECT 1
        FROM public.workflow_runs wr
       WHERE wr.id = v_reschedule_entry
         AND wr.workflow_status IN ('completed', 'failed')
    );
  END LOOP;

  FOR i IN 1..5 LOOP
    PERFORM public.progress_workflow_run(v_cancel_followup);
    EXIT WHEN EXISTS (
      SELECT 1
        FROM public.workflow_runs wr
       WHERE wr.id = v_cancel_followup
         AND wr.workflow_status IN ('completed', 'failed')
    );
  END LOOP;

  FOR i IN 1..5 LOOP
    PERFORM public.progress_workflow_run(v_reschedule_followup);
    EXIT WHEN EXISTS (
      SELECT 1
        FROM public.workflow_runs wr
       WHERE wr.id = v_reschedule_followup
         AND wr.workflow_status IN ('completed', 'failed')
    );
  END LOOP;

  INSERT INTO _webhook_materialization_results (
    case_key,
    result,
    followup_id,
    workflow_status,
    shipment_status,
    promised_delivery_date,
    action_count,
    action_reason,
    shipment_cancel_reason,
    last_error
  )
  SELECT
    'cancel',
    v_cancel_result,
    v_cancel_followup,
    wr.workflow_status,
    s.status,
    s.promised_delivery_date,
    (
      SELECT COUNT(*)::INT
        FROM public.shipment_actions sa
       WHERE sa.shipment_id = v_cancel_shipment
         AND sa.action_type = 'delete'
    ),
    (
      SELECT sa.action_data->>'cancel_reason'
        FROM public.shipment_actions sa
       WHERE sa.shipment_id = v_cancel_shipment
         AND sa.action_type = 'delete'
       ORDER BY sa.created_at DESC
       LIMIT 1
    ),
    s.metadata->>'cancel_reason',
    wr.last_error
  FROM public.workflow_runs wr
  JOIN public.shipments s
    ON s.id = v_cancel_shipment
   AND s.client_id = v_cancel_client
  WHERE wr.id = v_cancel_followup;

  INSERT INTO _webhook_materialization_results (
    case_key,
    result,
    followup_id,
    workflow_status,
    shipment_status,
    promised_delivery_date,
    action_count,
    action_reason,
    shipment_cancel_reason,
    last_error
  )
  SELECT
    'reschedule',
    v_reschedule_result,
    v_reschedule_followup,
    wr.workflow_status,
    s.status,
    s.promised_delivery_date,
    (
      SELECT COUNT(*)::INT
        FROM public.shipment_actions sa
       WHERE sa.shipment_id = v_reschedule_shipment
         AND sa.action_type = 'delivery_slot_reserved'
    ),
    NULL,
    NULL,
    wr.last_error
  FROM public.workflow_runs wr
  JOIN public.shipments s
    ON s.id = v_reschedule_shipment
   AND s.client_id = v_reschedule_client
  WHERE wr.id = v_reschedule_followup;
END $$;

SET search_path TO extensions, public, pgtap, pg_temp;

SELECT ok(
  workflow_handlers.resolve_reschedule_slot_date_v1(
    jsonb_build_object('transformed_payload', jsonb_build_object('delivery', jsonb_build_object('slot_date', '2026-06-01'))),
    NULL
  )::TEXT IS NOT DISTINCT FROM '2026-06-01'::TEXT,
  'reschedule slot-date resolver accepts transformed_payload.delivery.slot_date'::TEXT
);

SELECT ok(
  workflow_handlers.resolve_reschedule_slot_date_v1(
    jsonb_build_object('payload', jsonb_build_object('delivery', jsonb_build_object('slot_date', '2026-06-02'))),
    NULL
  )::TEXT IS NOT DISTINCT FROM '2026-06-02'::TEXT,
  'reschedule slot-date resolver accepts payload.delivery.slot_date'::TEXT
);

SELECT ok(
  (SELECT result->>'ack_outcome' FROM _webhook_materialization_results WHERE case_key = 'cancel') IS NOT DISTINCT FROM 'ack_sent'::TEXT,
  'cancel webhook mutation is accepted'::TEXT
);

SELECT ok(
  (SELECT result->>'ack_outcome' FROM _webhook_materialization_results WHERE case_key = 'reschedule') IS NOT DISTINCT FROM 'ack_sent'::TEXT,
  'reschedule webhook mutation is accepted'::TEXT
);

SELECT ok(
  (SELECT workflow_status FROM _webhook_materialization_results WHERE case_key = 'cancel') IS NOT DISTINCT FROM 'completed'::TEXT,
  'cancel follow-up workflow completes'::TEXT
);

SELECT ok(
  (SELECT shipment_status FROM _webhook_materialization_results WHERE case_key = 'cancel') IS NOT DISTINCT FROM 'cancelled'::TEXT,
  'cancel follow-up mutates the existing shipment status'::TEXT
);

SELECT ok(
  (SELECT action_count::TEXT FROM _webhook_materialization_results WHERE case_key = 'cancel') IS NOT DISTINCT FROM '1'::TEXT,
  'cancel follow-up records one delete shipment action'::TEXT
);

SELECT ok(
  (SELECT action_reason FROM _webhook_materialization_results WHERE case_key = 'cancel') IS NOT DISTINCT FROM 'customer request'::TEXT,
  'cancel follow-up records provider cancel reason on the shipment action'::TEXT
);

SELECT ok(
  (SELECT shipment_cancel_reason FROM _webhook_materialization_results WHERE case_key = 'cancel') IS NOT DISTINCT FROM 'customer request'::TEXT,
  'cancel follow-up records provider cancel reason on shipment metadata'::TEXT
);

SELECT ok(
  (SELECT workflow_status FROM _webhook_materialization_results WHERE case_key = 'reschedule') IS NOT DISTINCT FROM 'completed'::TEXT,
  'reschedule follow-up workflow completes'::TEXT
);

SELECT ok(
  (SELECT promised_delivery_date::TEXT FROM _webhook_materialization_results WHERE case_key = 'reschedule') IS NOT DISTINCT FROM (current_date + 3)::TEXT,
  'reschedule follow-up writes the webhook delivery slot date to the target shipment'::TEXT
);

SELECT ok(
  (SELECT action_count::TEXT FROM _webhook_materialization_results WHERE case_key = 'reschedule') IS NOT DISTINCT FROM '1'::TEXT,
  'reschedule follow-up records one delivery_slot_reserved action'::TEXT
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM _webhook_materialization_results
     WHERE last_error IS NOT NULL
  ),
  'mutation follow-up workflows finish without handler errors'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.shipments
     WHERE tracking_number IN ('P0-WEBHOOK-CANCEL-MATERIALIZE', 'P0-WEBHOOK-RESCHEDULE-MATERIALIZE')
     GROUP BY tracking_number
    HAVING COUNT(*) > 1
  ),
  'webhook mutation follow-ups mutate existing shipments without duplicate materialization'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM _webhook_materialization_results r
      JOIN public.workflow_runs wr
        ON wr.id = r.followup_id
     WHERE r.case_key = 'reschedule'
       AND wr.context#>>'{transformed_payload,delivery,slot_date}' IS NOT NULL
  ),
  'reschedule follow-up preserves provider delivery.slot_date in workflow context'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM _webhook_materialization_results r
      JOIN public.workflow_runs wr
        ON wr.id = r.followup_id
     WHERE r.case_key = 'cancel'
       AND wr.context#>>'{shipment,tracking_number}' = 'P0-WEBHOOK-CANCEL-MATERIALIZE'
  ),
  'cancel follow-up keeps target shipment readback in workflow context'
);

SELECT ok(
  (
    SELECT processing_status
      FROM public.v_webhook_inbox_directory
     WHERE idempotency_key = 'console-v2-webhook-cancel-materialize'
  ) IS NOT DISTINCT FROM 'succeeded'::TEXT,
  'directory projection marks completed cancel mutation as succeeded'::TEXT
);

SELECT ok(
  (
    SELECT shipment_status
      FROM public.v_webhook_inbox_directory
     WHERE idempotency_key = 'console-v2-webhook-cancel-materialize'
  ) IS NOT DISTINCT FROM 'cancelled'::TEXT,
  'directory projection links cancel mutation to the cancelled shipment'::TEXT
);

SELECT ok(
  (
    SELECT processing_status
      FROM public.v_webhook_inbox_directory
     WHERE idempotency_key = 'console-v2-webhook-reschedule-materialize'
  ) IS NOT DISTINCT FROM 'succeeded'::TEXT,
  'directory projection marks completed reschedule mutation as succeeded'::TEXT
);

SELECT ok(
  (
    SELECT tracking_number
      FROM public.v_webhook_inbox_directory
     WHERE idempotency_key = 'console-v2-webhook-reschedule-materialize'
  ) IS NOT DISTINCT FROM 'P0-WEBHOOK-RESCHEDULE-MATERIALIZE'::TEXT,
  'directory projection links reschedule mutation to the existing shipment'::TEXT
);

SELECT * FROM finish();

ROLLBACK;
