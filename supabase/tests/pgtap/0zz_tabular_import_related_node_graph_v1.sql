BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

SELECT has_function(
  'public',
  'tabular_import_parse_target_field_v1',
  ARRAY['text'],
  'public.tabular_import_parse_target_field_v1(text) exists'
);

SELECT has_function(
  'public',
  'tabular_import_resolve_inline_node_contract_v1',
  ARRAY['jsonb', 'text'],
  'public.tabular_import_resolve_inline_node_contract_v1(jsonb, text) exists'
);

SELECT has_function(
  'public',
  'tabular_import_resolve_inline_node_contracts_v1',
  ARRAY['jsonb', 'jsonb'],
  'public.tabular_import_resolve_inline_node_contracts_v1(jsonb, jsonb) exists'
);

SELECT has_function(
  'public',
  'tabular_import_apply_inherited_scope_defaults_v1',
  ARRAY['jsonb', 'jsonb', 'jsonb', 'uuid', 'uuid', 'uuid'],
  'public.tabular_import_apply_inherited_scope_defaults_v1(jsonb, jsonb, jsonb, uuid, uuid, uuid) exists'
);

SELECT has_function(
  'public',
  'tabular_import_stage_related_nodes_v1',
  ARRAY['uuid', 'jsonb', 'jsonb'],
  'public.tabular_import_stage_related_nodes_v1(uuid, jsonb, jsonb) exists'
);

SELECT has_function(
  'public',
  'tabular_import_get_run_system_v1',
  ARRAY['uuid'],
  'public.tabular_import_get_run_system_v1(uuid) exists'
);

SELECT has_function(
  'public',
  'tabular_import_execute_row_graph_v1',
  ARRAY['uuid', 'uuid'],
  'public.tabular_import_execute_row_graph_v1(uuid, uuid) exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS resource(value)
      JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_value(value) ON TRUE
     WHERE resource.value->>'key' = 'shipments'
       AND column_value.value->>'key' = 'recipient_id'
       AND COALESCE(column_value.value#>>'{import,reference,resource}', '') = 'recipients'
       AND COALESCE(column_value.value#>>'{import,reference,allow_inline_node}', '') = 'true'
  ),
  'ui_read_registry_v1 exposes shipments.recipient_id as an inline recipient node reference'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS resource(value)
      JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_value(value) ON TRUE
     WHERE resource.value->>'key' = 'shipments'
       AND column_value.value->>'key' = 'destination_address_id'
       AND COALESCE(column_value.value#>>'{import,reference,resource}', '') = 'addresses'
       AND COALESCE(column_value.value#>>'{import,reference,allow_inline_node}', '') = 'true'
  ),
  'ui_read_registry_v1 exposes shipments.destination_address_id as an inline address node reference'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.tabular_import_resolve_inline_node_contracts_v1(
          (
            SELECT value
              FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
             WHERE value->>'key' = 'shipments'
             LIMIT 1
          ),
          public.ui_read_registry_v1()
        )
      ) AS contract(value)
     WHERE contract.value->>'node_key' = 'recipient'
       AND contract.value->>'target_resource' = 'recipients'
       AND contract.value->>'reference_field' = 'recipient_id'
  ),
  'tabular_import_resolve_inline_node_contracts_v1 returns a recipient node contract for shipments'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.tabular_import_resolve_inline_node_contracts_v1(
          (
            SELECT value
              FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
             WHERE value->>'key' = 'shipments'
             LIMIT 1
          ),
          public.ui_read_registry_v1()
        )
      ) AS contract(value)
     WHERE contract.value->>'node_key' = 'destination_address'
       AND contract.value->>'target_resource' = 'addresses'
       AND contract.value->>'reference_field' = 'destination_address_id'
  ),
  'tabular_import_resolve_inline_node_contracts_v1 returns a destination address node contract for shipments'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS resource(value)
      JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_value(value) ON TRUE
     WHERE resource.value->>'key' = 'addresses'
       AND column_value.value->>'key' = 'raw_input'
       AND COALESCE(column_value.value#>>'{import,required}', '') = 'true'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(COALESCE(column_value.value#>'{import,aliases}', '[]'::jsonb)) AS alias(value)
          WHERE alias.value = 'address_line_1'
       )
  ),
  'ui_read_registry_v1 marks addresses.raw_input as required and reusable from address-line aliases'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS resource(value)
      JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_value(value) ON TRUE
     WHERE resource.value->>'key' = 'addresses'
       AND column_value.value->>'key' = 'province'
       AND COALESCE(column_value.value#>>'{import,required}', '') = 'true'
  ),
  'ui_read_registry_v1 marks addresses.province as required from the live relation contract'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        public.tabular_import_resolve_inline_node_contracts_v1(
          (
            SELECT value
              FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
             WHERE value->>'key' = 'shipments'
             LIMIT 1
          ),
          public.ui_read_registry_v1()
        )
      ) AS contract(value)
     WHERE contract.value->>'node_key' = 'destination_address'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(COALESCE(contract.value->'required_targets', '[]'::jsonb)) AS required(value)
          WHERE required.value = 'raw_input'
       )
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(COALESCE(contract.value->'required_targets', '[]'::jsonb)) AS required(value)
          WHERE required.value = 'province'
       )
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(COALESCE(contract.value->'required_targets', '[]'::jsonb)) AS required(value)
          WHERE required.value = 'validation_status'
       )
  ),
  'inline destination_address contracts include live required targets for preview blocking'
);

SELECT is(
  public.tabular_import_resolve_resource_v1('recipients'),
  (
    SELECT value
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
     WHERE value->>'key' = 'recipients'
     LIMIT 1
  ),
  'targeted recipient resolution matches the canonical full registry resource'
);

SELECT is(
  public.tabular_import_resolve_resource_v1('shipments'),
  (
    SELECT value
      FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS value
     WHERE value->>'key' = 'shipments'
     LIMIT 1
  ),
  'targeted shipment resolution preserves canonical import and runtime reference patches'
);

SELECT is(
  public.tabular_import_apply_inherited_scope_defaults_v1(
    '{}'::jsonb,
    jsonb_build_object(
      'tenant', 'organization_id',
      'client', 'client_id',
      'sender', 'sender_id'
    ),
    jsonb_build_object(
      'organization_id', '11111111-1111-1111-1111-111111111111',
      'client_id', '22222222-2222-2222-2222-222222222222',
      'sender_id', '33333333-3333-3333-3333-333333333333'
    ),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    NULL,
    NULL
  ),
  jsonb_build_object(
    'organization_id', '11111111-1111-1111-1111-111111111111',
    'client_id', '22222222-2222-2222-2222-222222222222',
    'sender_id', '33333333-3333-3333-3333-333333333333'
  ),
  'related-node scope helper prefers resolved primary payload values before broad run scope defaults'
);

SELECT * FROM finish();

ROLLBACK;
