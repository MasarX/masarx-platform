-- pgTAP: target-only webhook mutation mappings must repair a source-scoped
-- policy and must not depend on inherited/global webhook policy shape.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SET search_path TO public, pgtap, extensions, pg_temp;

DO $seed$
DECLARE
  v_org UUID := 'f9b20000-0000-0000-0000-000000000701'::UUID;
  v_mapping UUID := 'f9b20000-0000-0001-0000-000000000701'::UUID;
  v_source UUID := 'f9b20000-0000-0002-0000-000000000701'::UUID;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Target Policy Repair Org', 'console-v2-target-policy-repair-org')
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
    'console-v2-target-only-cancel-map',
    jsonb_build_object('target', 'shipments.cancel'),
    1,
    'platform',
    '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
     SET mapping_config = EXCLUDED.mapping_config,
         managed_by = EXCLUDED.managed_by,
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
    enabled,
    managed_by,
    managed_metadata
  )
  VALUES (
    v_source,
    v_org,
    'console-v2-target-only-cancel-source',
    'Console V2 Target Only Cancel Source',
    'generic',
    NULL,
    extensions.crypt('console-v2-target-only-cancel-token', extensions.gen_salt('bf')),
    v_mapping,
    TRUE,
    'platform',
    '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
     SET auth_token_hash = EXCLUDED.auth_token_hash,
         mapping_config_id = EXCLUDED.mapping_config_id,
         enabled = TRUE,
         managed_by = EXCLUDED.managed_by,
         managed_metadata = EXCLUDED.managed_metadata;
END;
$seed$;

CREATE TEMP TABLE _repair_result AS
SELECT public.ensure_webhook_source_plugin_binding_v1('f9b20000-0000-0002-0000-000000000701'::UUID) AS result;

SELECT ok(
  COALESCE((SELECT (result->>'ok')::BOOLEAN FROM _repair_result), FALSE),
  'target-only cancel source repair succeeds'
);

SELECT is(
  (SELECT result#>>'{policy_repair,canonical_intent}' FROM _repair_result),
  'shipment.delete',
  'target-only cancel repair records canonical shipment.delete intent'
);

SELECT is(
  (
    SELECT jsonb_typeof(s.cached_value->'workflow')
      FROM public.settings s
     WHERE s.category = 'webhook_ingest_policy'
       AND s.scope_type = 'source'
       AND s.scope_id = 'f9b20000-0000-0002-0000-000000000701'::UUID
  ),
  'object',
  'source-scoped policy workflow is stored as an object'
);

SELECT is(
  (
    SELECT s.cached_value#>>'{workflow,intent}'
      FROM public.settings s
     WHERE s.category = 'webhook_ingest_policy'
       AND s.scope_type = 'source'
       AND s.scope_id = 'f9b20000-0000-0002-0000-000000000701'::UUID
  ),
  'shipment.delete',
  'source-scoped policy stores cancel canonical intent'
);

SELECT is(
  (
    SELECT s.cached_value#>>'{workflow,templates_by_intent,shipment.delete,template_name}'
      FROM public.settings s
     WHERE s.category = 'webhook_ingest_policy'
       AND s.scope_type = 'source'
       AND s.scope_id = 'f9b20000-0000-0002-0000-000000000701'::UUID
  ),
  'shipment_delete_v1',
  'source-scoped policy points cancel follow-up at shipment_delete_v1'
);

CREATE TEMP TABLE _target_only_cancel_result AS
SELECT public.workflow_intake_webhook_core_v1(
  'console-v2-target-only-cancel-token',
  jsonb_build_object(
    'idempotency-key', 'console-v2-target-only-cancel-policy',
    'x-correlation-id', 'console-v2-target-only-cancel-policy'
  ),
  jsonb_build_object(
    'event', jsonb_build_object('id', 'console-v2-target-only-cancel-policy', 'type', 'shipment.canceled'),
    'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-TARGET-ONLY-CANCEL', 'cancel_reason', 'operator proof')
  )::TEXT,
  jsonb_build_object(
    'event', jsonb_build_object('id', 'console-v2-target-only-cancel-policy', 'type', 'shipment.canceled'),
    'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-TARGET-ONLY-CANCEL', 'cancel_reason', 'operator proof')
  )
) AS result;

SELECT is(
  (SELECT result->>'ack_outcome' FROM _target_only_cancel_result),
  'ack_sent',
  'target-only cancel source is accepted by receiver'
);

SELECT is(
  (SELECT (result->>'status')::INT FROM _target_only_cancel_result),
  202,
  'target-only cancel source returns accepted async status'
);

SELECT is(
  (SELECT result->>'canonical_intent' FROM _target_only_cancel_result),
  'shipment.delete',
  'target-only cancel source resolves canonical intent from repaired policy'
);

SELECT is(
  (
    SELECT wt.name
      FROM _target_only_cancel_result r
      JOIN public.workflow_runs wr
        ON wr.id = (r.result->>'followup_workflow_run_id')::UUID
      JOIN public.workflow_templates wt
        ON wt.id = wr.workflow_template_id
  ),
  'shipment_delete_v1',
  'target-only cancel source starts shipment_delete_v1 follow-up workflow'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.shipments
     WHERE tracking_number = 'P0-WEBHOOK-TARGET-ONLY-CANCEL'
  ),
  'target-only cancel intake does not materialize a synthetic shipment at ack time'
);

SELECT * FROM finish();

ROLLBACK;
