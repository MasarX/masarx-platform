-- pgTAP: product-authored webhook/API shipment mappings preserve Saudi short
-- national address into canonical address/geocode lineage.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(27);

SET search_path TO public, pgtap, extensions, pg_temp;

INSERT INTO public.workflow_templates (
  id, name, description, version, status, scope_type, scope_id, steps_checksum,
  notes, published_at, created_at, updated_at, metadata
)
SELECT
  '77770000-0000-0000-0000-000000780001'::uuid,
  'pgtap_shipment_delete_custom_v1',
  description, version, status, scope_type, scope_id, steps_checksum,
  notes, published_at, created_at, updated_at, metadata
FROM public.workflow_templates
WHERE name = 'shipment_delete_v1' AND status = 'active';

INSERT INTO public.workflow_templates (
  id, name, description, version, status, scope_type, scope_id, steps_checksum,
  notes, published_at, created_at, updated_at, metadata
)
SELECT
  '77770000-0000-0000-0000-000000780002'::uuid,
  'pgtap_shipment_reschedule_custom_v1',
  description, version, status, scope_type, scope_id, steps_checksum,
  notes, published_at, created_at, updated_at, metadata
FROM public.workflow_templates
WHERE name = 'shipment_reschedule_v1' AND status = 'active';

INSERT INTO public.workflow_template_steps (
  id, workflow_template_id, sequence_order, operation_name, operation_settings_category,
  transition_condition, condition_jsonlogic, next_operation_name, next_operation_priority,
  next_operation_delay_seconds, manual_action_required, metadata, enabled, created_at,
  updated_at, handler_key, handler_version
)
SELECT
  '77770000-0000-0000-0000-000000780011'::uuid,
  '77770000-0000-0000-0000-000000780001'::uuid,
  0, operation_name, operation_settings_category, transition_condition, condition_jsonlogic,
  NULL, NULL, NULL, manual_action_required, metadata, TRUE, created_at, updated_at,
  handler_key, handler_version
FROM public.workflow_template_steps
WHERE workflow_template_id = (SELECT id FROM public.workflow_templates WHERE name = 'shipment_delete_v1')
  AND handler_key = 'shipment_delete'
  AND enabled IS TRUE
ORDER BY sequence_order
LIMIT 1;

INSERT INTO public.workflow_template_steps (
  id, workflow_template_id, sequence_order, operation_name, operation_settings_category,
  transition_condition, condition_jsonlogic, next_operation_name, next_operation_priority,
  next_operation_delay_seconds, manual_action_required, metadata, enabled, created_at,
  updated_at, handler_key, handler_version
)
SELECT
  '77770000-0000-0000-0000-000000780012'::uuid,
  '77770000-0000-0000-0000-000000780002'::uuid,
  0, operation_name, operation_settings_category, transition_condition, condition_jsonlogic,
  NULL, NULL, NULL, manual_action_required, metadata, TRUE, created_at, updated_at,
  handler_key, handler_version
FROM public.workflow_template_steps
WHERE workflow_template_id = (SELECT id FROM public.workflow_templates WHERE name = 'shipment_reschedule_v1')
  AND handler_key = 'shipment_reschedule'
  AND enabled IS TRUE
ORDER BY sequence_order
LIMIT 1;

SELECT ok(
  to_regprocedure('public.normalize_shipment_webhook_mapping_config_v1(text,jsonb)') IS NOT NULL,
  'shipment webhook mapping normalizer is installed'
);

WITH normalized AS (
  SELECT public.normalize_shipment_webhook_mapping_config_v1(
    'webhook_inbound',
    jsonb_build_object('target', 'shipments.create')
  ) AS mapping_config
)
SELECT ok(
  (SELECT mapping_config#>'{transforms,address,sa_short_code}' FROM normalized)
    @> '["shipment.destination.short_national_address","address.sa_short_code","shortCode"]'::jsonb,
  'minimal product shipment mapping gains Saudi short national address fallback paths'
);

WITH normalized AS (
  SELECT public.normalize_shipment_webhook_mapping_config_v1(
    'webhook_inbound',
    jsonb_build_object('target', 'shipments.create')
  ) AS mapping_config
)
SELECT is(
  (SELECT mapping_config#>>'{metadata,short_address_profile}' FROM normalized),
  'sa_short_national_address_v1',
  'minimal product shipment mapping declares the Saudi short address profile'
);

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  '00000000-0000-0000-0000-00000000ad51'::uuid,
  'webhook_inbound',
  'maps-sna-product-created-minimal',
  jsonb_build_object('target', 'shipments.create'),
  1,
  'Maps/SNA pgTAP minimal product-created shipment intake mapping'
)
ON CONFLICT (id) DO UPDATE
   SET mapping_type = EXCLUDED.mapping_type,
       mapping_key = EXCLUDED.mapping_key,
       mapping_config = EXCLUDED.mapping_config,
       mapping_version = EXCLUDED.mapping_version,
       notes = EXCLUDED.notes;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.mapping_configs
     WHERE id = '00000000-0000-0000-0000-00000000ad51'::uuid
       AND mapping_config#>>'{metadata,payload_shape}' = 'external_shipment_envelope_v1'
       AND mapping_config#>>'{metadata,short_address_profile}' = 'sa_short_national_address_v1'
  ),
  'mapping_configs trigger normalizes product-created minimal shipment mappings'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.mapping_configs
     WHERE id = '00000000-0000-0000-0000-00000000ad51'::uuid
       AND mapping_config#>'{transforms,shipment}' IS NOT NULL
       AND mapping_config#>'{transforms,recipient}' IS NOT NULL
       AND mapping_config#>'{transforms,address}' IS NOT NULL
  ),
  'normalized product-created mapping carries shipment, recipient, and address transforms'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object(
      'event', jsonb_build_object('id', 'maps-sna-product-created-pgtap', 'type', 'shipment.created'),
      'shipment', jsonb_build_object(
        'reference', 'MAPS-SNA-PRODUCT-PGTAP',
        'recipient', jsonb_build_object(
          'name', 'Maps SNA Product PGTAP',
          'phone', '+12025550123'
        ),
        'destination', jsonb_build_object(
          'line1', 'King Fahd Road',
          'district', 'Al Olaya',
          'city', 'Riyadh',
          'country', 'SA',
          'short_national_address', 'RNQA7082'
        )
      )
    ),
    '00000000-0000-0000-0000-00000000ad51'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,sa_short_code}' FROM mapped),
  'RNQA7082',
  'normalized product-created mapping maps nested shipment.destination.short_national_address to address.sa_short_code'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object(
      'shortCode', 'RNQA7082',
      'shipment', jsonb_build_object(
        'reference', 'MAPS-SNA-PRODUCT-PGTAP',
        'recipient', jsonb_build_object('name', 'Maps SNA Product PGTAP'),
        'destination', jsonb_build_object('line1', 'King Fahd Road', 'city', 'Riyadh', 'country', 'SA')
      )
    ),
    '00000000-0000-0000-0000-00000000ad51'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,sa_short_code}' FROM mapped),
  'RNQA7082',
  'normalized product-created mapping maps top-level shortCode fallback to address.sa_short_code'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object(
      'shipment', jsonb_build_object(
        'reference', 'MAPS-SNA-PRODUCT-PGTAP',
        'recipient', jsonb_build_object(
          'name', 'Maps SNA Product PGTAP',
          'phone', '+12025550123'
        ),
        'destination', jsonb_build_object(
          'line1', 'King Fahd Road',
          'district', 'Al Olaya',
          'city', 'Riyadh',
          'country', 'SA',
          'short_national_address', 'RNQA7082'
        )
      )
    ),
    '00000000-0000-0000-0000-00000000ad51'::uuid
  ) AS payload
)
SELECT ok(
  (SELECT payload FROM mapped) @> jsonb_build_object(
    'recipient', jsonb_build_object('name', 'Maps SNA Product PGTAP'),
    'address', jsonb_build_object(
      'line1', 'King Fahd Road',
      'city', 'Riyadh',
      'country_code', 'SA',
      'sa_short_code', 'RNQA7082'
    )
  ),
  'normalized product-created mapping preserves canonical recipient and address readback payload'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%v_address_sa_short_code%',
  'shipment_create handler extracts Saudi short national address from canonical address payload'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%sa_short_code,%',
  'shipment_create handler writes Saudi short national address into canonical addresses.sa_short_code'
);

SELECT is(
  (
    SELECT array_agg(
      concat_ws(':', wts.sequence_order, wts.handler_key, wts.operation_name, COALESCE(wts.next_operation_name, ''))
      ORDER BY wts.sequence_order
    )
      FROM public.workflow_templates wt
      JOIN public.workflow_template_steps wts ON wts.workflow_template_id = wt.id
     WHERE wt.name = 'webhook_shipment_create_v1'
       AND wt.status = 'active'
       AND wts.enabled IS TRUE
  ),
  ARRAY[
    '0:context_extract_from_mapping:context_extract_from_mapping:reserve_identifiers',
    '1:reserve_shipment_identifiers:reserve_identifiers:create_shipment',
    '2:shipment_create:create_shipment:geocode_created_shipment',
    '3:shipment_update_geocode:geocode_created_shipment:record_workflow_completion',
    '4:workflow_control:record_workflow_completion:'
  ]::TEXT[],
  'webhook shipment-create workflow has one exact inbound create-to-geocode chain'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL (
        SELECT public.resolve_webhook_followup_template_id_v1(
          COALESCE(s.cached_value, sv.value, '{}'::jsonb),
          'shipment.create'
        ) AS template_id
      ) resolved
      LEFT JOIN public.workflow_templates wt ON wt.id = resolved.template_id
     WHERE s.category = 'webhook_ingest_policy'
       AND public.webhook_policy_applies_to_shipment_intent_v1(
         COALESCE(s.cached_value, sv.value, '{}'::jsonb),
         'shipment.create'
       )
       AND (
         resolved.template_id IS NULL
         OR wt.id IS NULL
         OR wt.status <> 'active'
         OR wt.name = 'async_provider_dispatch_v1'
       )
  ),
  'every webhook policy scope resolves shipment.create to the dedicated inbound or a proven active custom follow-up'
);

SELECT is(
  public.resolve_webhook_followup_template_id_v1(
    jsonb_build_object(
      'workflow', jsonb_build_object(
        'template_name', 'async_provider_dispatch_v1',
        'templates_by_intent', jsonb_build_object('shipment.create', 'null'::jsonb)
      )
    ),
    'shipment.create'
  ),
  (SELECT id FROM public.workflow_templates WHERE name = 'async_provider_dispatch_v1' AND status = 'active'),
  'JSON null intent overrides fall back to the legacy workflow default and therefore require migration rebinding'
);

SELECT is(
  public.resolve_webhook_followup_template_id_v1(
    jsonb_build_object(
      'workflow', jsonb_build_object(
        'template_name', 'async_provider_dispatch_v1',
        'templates_by_intent', jsonb_build_object('shipment.create', '')
      )
    ),
    'shipment.create'
  ),
  (SELECT id FROM public.workflow_templates WHERE name = 'async_provider_dispatch_v1' AND status = 'active'),
  'empty string intent overrides fall back to the legacy workflow default and therefore require migration rebinding'
);

SELECT is(
  public.resolve_webhook_followup_template_id_v1(
    jsonb_build_object(
      'workflow', jsonb_build_object(
        'template_name', 'async_provider_dispatch_v1',
        'templates_by_intent', jsonb_build_object('shipment.create', '{}'::jsonb)
      )
    ),
    'shipment.create'
  ),
  (SELECT id FROM public.workflow_templates WHERE name = 'async_provider_dispatch_v1' AND status = 'active'),
  'empty object intent overrides fall back to the legacy workflow default and therefore require migration rebinding'
);

SELECT is(
  public.resolve_webhook_followup_template_id_v1(
    jsonb_build_object(
      'workflow', jsonb_build_object(
        'templates_by_intent', jsonb_build_object(
          'shipment.create',
          jsonb_build_object('template_name', 'shipment_manual_create_v1')
        )
      )
    ),
    'shipment.create'
  ),
  (SELECT id FROM public.workflow_templates WHERE name = 'shipment_manual_create_v1' AND status = 'active'),
  'a compatible active custom shipment materializer resolves without shared-dispatch fallback'
);

SELECT is(
  public.resolve_webhook_followup_template_id_v1(
    jsonb_build_object(
      'workflow', jsonb_build_object(
        'templates_by_intent', jsonb_build_object('shipment.create', 'missing-custom-template')
      )
    ),
    'shipment.create'
  ),
  NULL::uuid,
  'an unknown custom intent override resolves fail closed'
);

SELECT is(
  public.resolve_active_workflow_template_ref_v1('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  NULL::uuid,
  'an unknown UUID template reference resolves fail closed before shipment policy migration'
);

SELECT ok(
  NOT public.webhook_policy_applies_to_shipment_intent_v1(
    jsonb_build_object('workflow', jsonb_build_object('intent', 'comms_reply')),
    'shipment.create'
  ),
  'explicit non-shipment policy scopes remain outside shipment default mutation'
);

SELECT ok(
  public.webhook_policy_applies_to_shipment_intent_v1(
    jsonb_build_object('workflow', jsonb_build_object('intent', 'comms_reply', 'templates_by_intent', jsonb_build_object('shipment.create', 'shipment_manual_create_v1'))),
    'shipment.create'
  ),
  'an explicit shipment intent override opts an otherwise non-shipment policy into that intent'
);

SELECT ok(
  public.workflow_template_supports_inbound_shipment_create_v1(
    (SELECT id FROM public.workflow_templates WHERE name = 'shipment_manual_create_v1' AND status = 'active')
  ),
  'shipment_manual_create_v1 satisfies the inbound shipment materializer contract'
);

SELECT ok(
  NOT public.workflow_template_supports_inbound_shipment_create_v1(
    (SELECT id FROM public.workflow_templates WHERE name = 'webhook_intake_v1' AND status = 'active')
  ),
  'webhook_intake_v1 is not accepted as a shipment materializer'
);

SELECT is(
  public.resolve_webhook_followup_template_id_v1(
    jsonb_build_object(
      'workflow', jsonb_build_object(
        'intent', 'shipment.create',
        'template_name', 'shipment_manual_create_v1'
      )
    ),
    'shipment.create'
  ),
  (SELECT id FROM public.workflow_templates WHERE name = 'shipment_manual_create_v1' AND status = 'active'),
  'compatible top-level shipment.create custom binding remains the effective resolver value'
);

SELECT ok(
  public.workflow_template_supports_shipment_intent_v1(
    '77770000-0000-0000-0000-000000780001'::uuid,
    'shipment.delete'
  ),
  'active custom shipment delete template satisfies the typed binding contract'
);

SELECT ok(
  public.workflow_template_supports_shipment_intent_v1(
    '77770000-0000-0000-0000-000000780002'::uuid,
    'shipment.reschedule'
  ),
  'active custom shipment reschedule template satisfies the typed binding contract'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry sr
     WHERE sr.category = 'webhook_ingest_policy'
       AND sr.is_active IS TRUE
       AND sr.schema#>'{properties,workflow,properties,template_name}' IS NOT NULL
       AND sr.schema#>'{properties,workflow,properties,intent}' IS NOT NULL
       AND sr.schema#>'{properties,workflow,properties,templates_by_intent}' IS NOT NULL
  ),
  'active webhook policy schema registry exposes the current workflow binding contract'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%destination_address_id%' AND
  pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%context_patch%',
  'shipment_create handler emits shipment/address context for the following geocode lineage step'
);

SELECT * FROM finish();

ROLLBACK;
