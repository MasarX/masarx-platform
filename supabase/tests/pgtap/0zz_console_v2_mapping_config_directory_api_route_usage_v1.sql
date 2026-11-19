-- pgTAP: Console V2 mapping_config_directory counts API Gateway route-bound
-- request mappings as live mapping usage.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SET search_path TO public, pgtap, extensions, pg_temp;

SELECT has_column(
  'public',
  'v_mapping_config_directory',
  'api_route_count',
  'mapping config directory exposes active API Gateway route usage'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'd45cc13a-ecf9-43e7-b0e2-21e66f289201'::uuid,
  'Console V2 Mapping API Route Usage Org',
  'console-v2-mapping-api-route-usage-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.api_route_packs (id, name, description, enabled)
VALUES
(
  'd45cc13a-ecf9-43e7-b0e2-21e66f289220'::uuid,
  'Console V2 Mapping Directory API Route Usage Pack',
  'pgTAP route usage pack for mapping_config_directory',
  TRUE
),
(
  'd45cc13a-ecf9-43e7-b0e2-21e66f289221'::uuid,
  'Console V2 Mapping Directory Disabled API Route Usage Pack',
  'pgTAP disabled route usage pack for mapping_config_directory',
  FALSE
)
ON CONFLICT (id) DO UPDATE
SET enabled = EXCLUDED.enabled,
    updated_at = now();

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes,
  managed_by,
  managed_metadata
)
VALUES (
  'd45cc13a-ecf9-43e7-b0e2-21e66f289240'::uuid,
  'd45cc13a-ecf9-43e7-b0e2-21e66f289201'::uuid,
  'api_gateway_inbound',
  'console-v2-api-route-usage-mapping',
  '{"target":"shipments.create","rules":[]}'::jsonb,
  1,
  'Console V2 mapping directory API route usage pgTAP row',
  'integration_plugin',
  '{"plugin_version_id":"d45cc13a-ecf9-43e7-b0e2-21e66f289242"}'::jsonb
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    mapping_config = EXCLUDED.mapping_config,
    managed_by = EXCLUDED.managed_by,
    managed_metadata = EXCLUDED.managed_metadata,
    updated_at = now();

INSERT INTO public.api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  policy
)
VALUES
(
  'd45cc13a-ecf9-43e7-b0e2-21e66f289250'::uuid,
  'd45cc13a-ecf9-43e7-b0e2-21e66f289220'::uuid,
  'Console V2 mapping directory active API route',
  TRUE,
  'POST',
  '/v1/console-v2/mapping-api-route-usage',
  'tenant',
  'd45cc13a-ecf9-43e7-b0e2-21e66f289201'::uuid,
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_config_id', 'd45cc13a-ecf9-43e7-b0e2-21e66f289240',
      'mapping_key', 'console-v2-api-route-usage-mapping',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.create'
    ),
    'postprocess', jsonb_build_object('enabled', true, 'mode', 'shipment_create_v1')
  )
),
(
  'd45cc13a-ecf9-43e7-b0e2-21e66f289252'::uuid,
  'd45cc13a-ecf9-43e7-b0e2-21e66f289220'::uuid,
  'Console V2 mapping directory key-only API route',
  TRUE,
  'POST',
  '/v1/console-v2/mapping-api-route-usage-key-only',
  'tenant',
  'd45cc13a-ecf9-43e7-b0e2-21e66f289201'::uuid,
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_key', 'console-v2-api-route-usage-mapping',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.create'
    ),
    'postprocess', jsonb_build_object('enabled', true, 'mode', 'shipment_create_v1')
  )
),
(
  'd45cc13a-ecf9-43e7-b0e2-21e66f289253'::uuid,
  'd45cc13a-ecf9-43e7-b0e2-21e66f289220'::uuid,
  'Console V2 mapping directory nested mapping studio API route',
  TRUE,
  'POST',
  '/v1/console-v2/mapping-api-route-usage-nested',
  'tenant',
  'd45cc13a-ecf9-43e7-b0e2-21e66f289201'::uuid,
  jsonb_build_object(
    'mapping_studio', jsonb_build_object(
      'request_config', jsonb_build_object(
        'request_mapping', jsonb_build_object(
          'mapping_key', 'console-v2-api-route-usage-mapping',
          'mapping_type', 'api_gateway_inbound',
          'target', 'shipments.create'
        )
      )
    ),
    'postprocess', jsonb_build_object('enabled', true, 'mode', 'shipment_create_v1')
  )
),
(
  'd45cc13a-ecf9-43e7-b0e2-21e66f289251'::uuid,
  'd45cc13a-ecf9-43e7-b0e2-21e66f289220'::uuid,
  'Console V2 mapping directory disabled API route',
  FALSE,
  'POST',
  '/v1/console-v2/mapping-api-route-usage-disabled',
  'tenant',
  'd45cc13a-ecf9-43e7-b0e2-21e66f289201'::uuid,
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_config_id', 'd45cc13a-ecf9-43e7-b0e2-21e66f289240',
      'mapping_key', 'console-v2-api-route-usage-mapping',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.create'
    ),
    'postprocess', jsonb_build_object('enabled', true, 'mode', 'shipment_create_v1')
  )
),
(
  'd45cc13a-ecf9-43e7-b0e2-21e66f289254'::uuid,
  'd45cc13a-ecf9-43e7-b0e2-21e66f289221'::uuid,
  'Console V2 mapping directory disabled pack API route',
  TRUE,
  'POST',
  '/v1/console-v2/mapping-api-route-usage-disabled-pack',
  'tenant',
  'd45cc13a-ecf9-43e7-b0e2-21e66f289201'::uuid,
  jsonb_build_object(
    'request_mapping', jsonb_build_object(
      'mapping_config_id', 'd45cc13a-ecf9-43e7-b0e2-21e66f289240',
      'mapping_key', 'console-v2-api-route-usage-mapping',
      'mapping_type', 'api_gateway_inbound',
      'target', 'shipments.create'
    ),
    'postprocess', jsonb_build_object('enabled', true, 'mode', 'shipment_create_v1')
  )
)
ON CONFLICT (id) DO UPDATE
SET enabled = EXCLUDED.enabled,
    policy = EXCLUDED.policy,
    updated_at = now();

SELECT is(
  (
    SELECT api_route_count::INT
    FROM public.v_mapping_config_directory
    WHERE id = 'd45cc13a-ecf9-43e7-b0e2-21e66f289240'::uuid
  ),
  3,
  'directory counts active ID-bound, key-only, and nested mapping-studio API Gateway request mappings'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.api_routes
    WHERE path_template = '/v1/console-v2/mapping-api-route-usage-key-only'
      AND policy #>> '{request_mapping,mapping_config_id}' IS NULL
      AND policy #>> '{request_mapping,mapping_key}' = 'console-v2-api-route-usage-mapping'
      AND policy #>> '{request_mapping,mapping_type}' = 'api_gateway_inbound'
  ),
  1,
  'test fixture includes canonical key-only API Gateway mapping reference'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.api_routes
    WHERE path_template = '/v1/console-v2/mapping-api-route-usage-nested'
      AND policy #>> '{mapping_studio,request_config,request_mapping,mapping_key}' = 'console-v2-api-route-usage-mapping'
      AND policy #>> '{mapping_studio,request_config,request_mapping,mapping_type}' = 'api_gateway_inbound'
  ),
  1,
  'test fixture includes nested Mapping Studio request-config mapping reference'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.api_routes ar
    JOIN public.api_route_packs arp ON arp.id = ar.pack_id
    WHERE ar.path_template = '/v1/console-v2/mapping-api-route-usage-disabled-pack'
      AND ar.enabled IS TRUE
      AND arp.enabled IS FALSE
  ),
  1,
  'test fixture includes active route under disabled API Gateway pack'
);

SELECT is(
  (
    SELECT is_in_use::TEXT
    FROM public.v_mapping_config_directory
    WHERE id = 'd45cc13a-ecf9-43e7-b0e2-21e66f289240'::uuid
  ),
  'true',
  'API Gateway route-bound mapping is marked in use even without webhook source/rule usage'
);

SELECT is(
  (
    SELECT source_count::INT + rule_usage_count::INT
    FROM public.v_mapping_config_directory
    WHERE id = 'd45cc13a-ecf9-43e7-b0e2-21e66f289240'::uuid
  ),
  0,
  'test fixture proves route usage is independent from webhook source/rule usage'
);

SELECT is(
  (
    SELECT target
    FROM public.v_mapping_config_directory
    WHERE id = 'd45cc13a-ecf9-43e7-b0e2-21e66f289240'::uuid
  ),
  'shipments.create',
  'directory still preserves derived mapping target'
);

WITH registry AS (
  SELECT resource
  FROM jsonb_array_elements(
    COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)
  ) AS resource
  WHERE resource->>'key' = 'mapping_config_directory'
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM registry
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource->'columns', '[]'::jsonb)) AS column_config
    WHERE column_config->>'key' = 'api_route_count'
      AND column_config->>'label' = 'API routes'
  ),
  'mapping_config_directory registry exposes API route usage column'
);

WITH registry AS (
  SELECT resource
  FROM jsonb_array_elements(
    COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)
  ) AS resource
  WHERE resource->>'key' = 'mapping_config_directory'
)
SELECT is(
  (SELECT resource#>>'{scope_columns,tenant}' FROM registry LIMIT 1),
  'organization_id',
  'mapping_config_directory remains tenant-scoped after API route usage projection'
);

SELECT * FROM finish();

ROLLBACK;
