BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(42);

SELECT has_function(
  'public',
  'normalize_shipment_intent_v1',
  ARRAY['text', 'text'],
  'canonical shipment intent normalizer exists'
);
SELECT has_function(
  'public',
  'resolve_webhook_shipment_intent_v1',
  ARRAY['jsonb', 'text', 'text'],
  'payload-aware webhook shipment intent resolver exists'
);
SELECT has_function(
  'public',
  'resolve_webhook_followup_template_id_v1',
  ARRAY['jsonb', 'text'],
  'row-driven follow-up template resolver exists'
);
SELECT has_function(
  'public',
  'normalize_webhook_ingest_policy_workflow_bindings_v1',
  ARRAY['jsonb'],
  'canonical webhook policy workflow-binding normalizer exists'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.normalize_webhook_ingest_policy_workflow_bindings_v1(jsonb)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.normalize_webhook_ingest_policy_workflow_bindings_v1(jsonb)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.normalize_webhook_ingest_policy_workflow_bindings_v1(jsonb)',
    'EXECUTE'
  ),
  'webhook policy workflow-binding normalizer is service-only'
);
SELECT matches(
  pg_get_functiondef('public.normalize_settings_value_v1(text,jsonb)'::regprocedure),
  'normalize_webhook_ingest_policy_workflow_bindings_v1',
  'shared settings write normalization routes webhook policies through the canonical binding normalizer'
);

SELECT is(
  public.normalize_webhook_ingest_policy_workflow_bindings_v1('{}'::jsonb)
    #>'{workflow,templates_by_intent}',
  jsonb_build_object(
    'shipment.create', jsonb_build_object(
      'template_id', (SELECT id FROM public.workflow_templates WHERE name = 'webhook_shipment_create_v1'),
      'template_name', 'webhook_shipment_create_v1'
    ),
    'shipment.delete', jsonb_build_object(
      'template_id', (SELECT id FROM public.workflow_templates WHERE name = 'shipment_delete_v1'),
      'template_name', 'shipment_delete_v1'
    ),
    'shipment.reschedule', jsonb_build_object(
      'template_id', (SELECT id FROM public.workflow_templates WHERE name = 'shipment_reschedule_v1'),
      'template_name', 'shipment_reschedule_v1'
    )
  ),
  'generic shipment webhook policy materializes all three canonical intent bindings'
);
SELECT is(
  public.normalize_webhook_ingest_policy_workflow_bindings_v1(
    jsonb_build_object(
      'workflow', jsonb_build_object(
        'intent', 'comms_reply',
        'templates_by_intent', jsonb_build_object(
          'shipment.delete', jsonb_build_object('template_name', 'async_provider_dispatch_v1')
        )
      )
    )
  )->'workflow',
  jsonb_build_object(
    'intent', 'comms_reply',
    'templates_by_intent', jsonb_build_object(
      'shipment.delete', jsonb_build_object(
        'template_id', (SELECT id FROM public.workflow_templates WHERE name = 'shipment_delete_v1'),
        'template_name', 'shipment_delete_v1'
      )
    )
  ),
  'explicit non-shipment policy preserves its intent and normalizes only its explicit shipment binding'
);
SELECT is(
  public.normalize_webhook_ingest_policy_workflow_bindings_v1(
    jsonb_build_object(
      'workflow', jsonb_build_object(
        'intent', 'comms_reply',
        'templates_by_intent', jsonb_build_object(
          'shipment.create', jsonb_build_object('template_name', 'shipment_manual_create_v1')
        )
      )
    )
  )#>>'{workflow,templates_by_intent,shipment.create,template_name}',
  'shipment_manual_create_v1',
  'compatible custom shipment-create materializer remains selected'
);
WITH normalized AS (
  SELECT public.normalize_webhook_ingest_policy_workflow_bindings_v1('{}'::jsonb) AS value
)
SELECT is(
  public.normalize_webhook_ingest_policy_workflow_bindings_v1(normalized.value),
  normalized.value,
  'webhook policy workflow-binding normalization is idempotent'
)
FROM normalized;

SELECT is(
  public.normalize_shipment_intent_v1(NULL, 'shipment.updated'),
  'shipment.updated',
  'generic shipment.updated remains a compatibility envelope'
);
SELECT is(
  public.normalize_shipment_intent_v1('shipments.cancel', 'shipment.updated'),
  'shipment.delete',
  'plural cancel target normalizes to shipment.delete'
);
SELECT is(
  public.normalize_shipment_intent_v1('shipments.delete', 'shipment.updated'),
  'shipment.delete',
  'plural delete target normalizes to shipment.delete'
);
SELECT is(
  public.normalize_shipment_intent_v1('shipment.cancelled', 'shipment.updated'),
  'shipment.delete',
  'British-spelled cancel alias normalizes to shipment.delete'
);
SELECT is(
  public.normalize_shipment_intent_v1('shipments_canceled', 'shipment.updated'),
  'shipment.delete',
  'underscored plural cancel alias normalizes to shipment.delete'
);
SELECT is(
  public.normalize_shipment_intent_v1('shipments.reschedule', 'shipment.updated'),
  'shipment.reschedule',
  'plural reschedule target normalizes to shipment.reschedule'
);
SELECT is(
  public.normalize_shipment_intent_v1(NULL, 'shipments.rescheduled'),
  'shipment.reschedule',
  'plural rescheduled event normalizes to shipment.reschedule'
);
SELECT is(
  public.normalize_shipment_intent_v1(NULL, 'shipments.reschedule'),
  'shipment.reschedule',
  'plural dotted reschedule event normalizes to shipment.reschedule'
);
SELECT is(
  public.normalize_shipment_intent_v1('update.status', 'shipment.updated'),
  'update.status',
  'explicit typed update intent is preserved'
);

SELECT is(
  public.resolve_webhook_shipment_intent_v1(
    '{"event":{"type":"shipment.updated"},"shipment":{"status":"delivered"}}'::jsonb,
    NULL,
    'shipment.updated'
  )->>'canonical_intent',
  'update.status',
  'generic shipment.updated status payload derives update.status'
);
SELECT is(
  public.resolve_webhook_shipment_intent_v1(
    '{"event":{"type":"shipment.updated"},"shipment":{"status":"pending","destination_address":{"city":"Riyadh"}}}'::jsonb,
    NULL,
    'shipment.updated'
  )->>'canonical_intent',
  'update.address',
  'one specific address segment wins over the generic status signal'
);
SELECT is(
  public.resolve_webhook_shipment_intent_v1(
    '{"event":{"type":"shipment.updated"},"shipment":{"destination_address":{"city":"Riyadh"},"driver":{"id":"driver-1"}}}'::jsonb,
    NULL,
    'shipment.updated'
  )->>'status',
  'ambiguous',
  'multiple specific segments fail closed'
);
SELECT is(
  public.resolve_webhook_shipment_intent_v1(
    '{"event":{"type":"shipment.updated"},"shipment":{"destination_address":{"city":"Riyadh"},"driver":{"id":"driver-1"}}}'::jsonb,
    NULL,
    'shipment.updated'
  )->>'canonical_intent',
  NULL::TEXT,
  'ambiguous generic update has no canonical intent'
);
SELECT is(
  public.resolve_webhook_shipment_intent_v1(
    '{"event":{"type":"shipment.updated"},"shipment":{"reference":"unchanged"}}'::jsonb,
    NULL,
    'shipment.updated'
  )->>'reason',
  'missing_update_segment',
  'unclassified generic update fails closed'
);
SELECT is(
  public.resolve_webhook_shipment_intent_v1(
    '{"event":{"type":"shipment.updated"},"shipment":{"status":"delivered"}}'::jsonb,
    NULL,
    'shipment.updated'
  )#>>'{transformed_payload,event,type}',
  'update.status',
  'derived typed intent is written into the normalized payload copy'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'webhook_ingest_policy'
       AND sv.value#>>'{workflow,templates_by_intent,shipment.delete,template_name}' = 'shipment_delete_v1'
  ),
  'at least one webhook policy scope exists with the delete workflow default'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'webhook_ingest_policy'
       AND public.webhook_policy_applies_to_shipment_intent_v1(
         COALESCE(s.cached_value, sv.value, '{}'::jsonb),
         'shipment.delete'
       )
       AND COALESCE(s.cached_value, sv.value, '{}'::jsonb)
             #>>'{workflow,templates_by_intent,shipment.delete,template_name}'
             IS DISTINCT FROM 'shipment_delete_v1'
  ),
  'every shipment-delete-applicable webhook policy has the effective delete workflow default'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'webhook_ingest_policy'
       AND public.webhook_policy_applies_to_shipment_intent_v1(
         COALESCE(s.cached_value, sv.value, '{}'::jsonb),
         'shipment.reschedule'
       )
       AND COALESCE(s.cached_value, sv.value, '{}'::jsonb)
             #>>'{workflow,templates_by_intent,shipment.reschedule,template_name}'
             IS DISTINCT FROM 'shipment_reschedule_v1'
  ),
  'every shipment-reschedule-applicable webhook policy has the effective reschedule workflow default'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.cancel'
       AND lv.status = 'active'
       AND lv.metadata->>'canonical_intent' = 'shipment.delete'
       AND lv.metadata->>'workflow_template_name' = 'shipment_delete_v1'
  ),
  'cancel mapping target resolves to the delete workflow intent'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.cancel'
       AND lv.metadata->'allowed_mapping_types' = '["webhook_inbound"]'::jsonb
       AND lv.metadata->>'ingress_mode' = 'async_third_party_event'
       AND NOT (lv.metadata->'allowed_mapping_types' ? 'api_gateway_inbound')
  ),
  'cancel mapping target remains async webhook-only'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.reschedule'
       AND lv.status = 'active'
       AND lv.metadata->>'canonical_intent' = 'shipment.reschedule'
       AND lv.metadata->>'workflow_template_name' = 'shipment_reschedule_v1'
  ),
  'reschedule mapping target resolves to the reschedule workflow intent'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.reschedule'
       AND lv.metadata->'allowed_mapping_types' = '["webhook_inbound"]'::jsonb
       AND lv.metadata->>'ingress_mode' = 'async_third_party_event'
       AND NOT (lv.metadata->'allowed_mapping_types' ? 'api_gateway_inbound')
  ),
  'reschedule mapping target remains async webhook-only'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates
     WHERE name = 'shipment_delete_v1'
       AND status = 'active'
  ),
  'active shipment delete workflow template exists'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates
     WHERE name = 'shipment_reschedule_v1'
       AND status = 'active'
  ),
  'active shipment reschedule workflow template exists'
);

SELECT is(
  public.resolve_webhook_followup_template_id_v1(
    jsonb_build_object(
      'workflow',
      jsonb_build_object(
        'templates_by_intent',
        jsonb_build_object('shipment.delete', jsonb_build_object('template_name', 'shipment_delete_v1'))
      )
    ),
    'shipment.delete'
  ),
  (
    SELECT id
      FROM public.workflow_templates
     WHERE name = 'shipment_delete_v1'
       AND status = 'active'
     ORDER BY version DESC
     LIMIT 1
  ),
  'delete intent resolves its active workflow template row'
);
SELECT is(
  public.resolve_webhook_followup_template_id_v1(
    jsonb_build_object(
      'workflow',
      jsonb_build_object(
        'templates_by_intent',
        jsonb_build_object('shipment.reschedule', jsonb_build_object('template_name', 'shipment_reschedule_v1'))
      )
    ),
    'shipment.reschedule'
  ),
  (
    SELECT id
      FROM public.workflow_templates
     WHERE name = 'shipment_reschedule_v1'
       AND status = 'active'
     ORDER BY version DESC
     LIMIT 1
  ),
  'reschedule intent resolves its active workflow template row'
);

SELECT matches(
  pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure),
  'resolve_webhook_shipment_intent_v1',
  'canonical webhook core routes through payload-aware intent resolution'
);
SELECT matches(
  pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure),
  'webhook_ack_history',
  'canonical webhook core retains replay and idempotency history'
);
SELECT ok(
  strpos(
    lower(pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)),
    'insert into public.shipments'
  ) = 0
  AND strpos(
    lower(pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)),
    'insert into shipments'
  ) = 0,
  'async webhook core never performs a synchronous shipment insert'
);

CREATE TEMP TABLE pgtap_webhook_policy_version_baseline ON COMMIT DROP AS
SELECT COALESCE(MAX(sv.version), 0)::INT AS version
  FROM public.settings_versions sv
 WHERE sv.category = 'webhook_ingest_policy'
   AND sv.scope_type = public.get_root_scope_type_key_v1()
   AND sv.scope_id IS NULL;

SELECT ok(
  public.upsert_webhook_ingest_policy(
    public.get_root_scope_type_key_v1(),
    NULL,
    jsonb_build_object(
      'workflow', jsonb_build_object(
        'templates_by_intent', jsonb_build_object(
          'shipment.delete', jsonb_build_object('template_name', 'async_provider_dispatch_v1')
        )
      )
    )
  ) IS NOT NULL,
  'webhook policy upsert accepts a policy patch through the shared normalization seam'
);
SELECT is(
  (
    SELECT COALESCE(MAX(sv.version), 0)::INT
      FROM public.settings_versions sv
     WHERE sv.category = 'webhook_ingest_policy'
       AND sv.scope_type = public.get_root_scope_type_key_v1()
       AND sv.scope_id IS NULL
  ),
  (SELECT version + 1 FROM pgtap_webhook_policy_version_baseline),
  'one webhook policy upsert appends exactly one settings version'
);
SELECT is(
  (
    SELECT s.cached_value#>>'{workflow,templates_by_intent,shipment.delete,template_name}'
      FROM public.settings s
     WHERE s.category = 'webhook_ingest_policy'
       AND s.scope_type = public.get_root_scope_type_key_v1()
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  'shipment_delete_v1',
  'future webhook policy writes persist the canonical delete workflow binding'
);

SELECT finish();

ROLLBACK;
