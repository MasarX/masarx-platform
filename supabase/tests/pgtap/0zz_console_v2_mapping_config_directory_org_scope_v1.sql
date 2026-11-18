-- pgTAP: Console V2 mapping_config_directory exposes organization_id so
-- tenant-scoped browser reads can filter mapping profiles through the backend.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SELECT has_column(
  'public',
  'v_mapping_config_directory',
  'organization_id',
  'mapping config directory exposes organization_id for tenant-scoped Console reads'
);

SELECT has_column(
  'public',
  'v_mapping_config_directory',
  'managed_metadata',
  'mapping config directory exposes managed_metadata for source-bindable option filtering'
);

SELECT has_column(
  'public',
  'v_mapping_config_directory',
  'managed_by',
  'mapping config directory exposes managed_by for source-bindable option context'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'd45cc13a-ecf9-43e7-b0e2-21e66f289101'::uuid,
  'Console V2 Mapping Directory Org',
  'console-v2-mapping-directory-org'
)
ON CONFLICT (id) DO NOTHING;

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
  'd45cc13a-ecf9-43e7-b0e2-21e66f289140'::uuid,
  'd45cc13a-ecf9-43e7-b0e2-21e66f289101'::uuid,
  'webhook_inbound',
  'console-v2-mapping-directory-org-scope',
  '{"target":"shipments.create","rules":[]}'::jsonb,
  1,
  'Console V2 mapping directory org-scope pgTAP row',
  'integration_plugin',
  '{"plugin_version_id":"d45cc13a-ecf9-43e7-b0e2-21e66f289142"}'::jsonb
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    mapping_config = EXCLUDED.mapping_config,
    managed_by = EXCLUDED.managed_by,
    managed_metadata = EXCLUDED.managed_metadata,
    updated_at = now();

SELECT is(
  (
    SELECT organization_id::text
    FROM public.v_mapping_config_directory
    WHERE id = 'd45cc13a-ecf9-43e7-b0e2-21e66f289140'::uuid
  ),
  'd45cc13a-ecf9-43e7-b0e2-21e66f289101',
  'directory projection returns the mapping config organization id'
);

SELECT is(
  (
    SELECT target
    FROM public.v_mapping_config_directory
    WHERE id = 'd45cc13a-ecf9-43e7-b0e2-21e66f289140'::uuid
  ),
  'shipments.create',
  'directory projection preserves the derived target field'
);

SELECT is(
  (
    SELECT managed_metadata->>'plugin_version_id'
    FROM public.v_mapping_config_directory
    WHERE id = 'd45cc13a-ecf9-43e7-b0e2-21e66f289140'::uuid
  ),
  'd45cc13a-ecf9-43e7-b0e2-21e66f289142',
  'directory projection exposes plugin_version_id metadata used by webhook source creation'
);

SELECT is(
  (
    SELECT has_rules::text
    FROM public.v_mapping_config_directory
    WHERE id = 'd45cc13a-ecf9-43e7-b0e2-21e66f289140'::uuid
  ),
  'false',
  'directory projection preserves boolean has_rules behavior'
);

WITH registry AS (
  SELECT resource
  FROM jsonb_array_elements(
    COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)
  ) AS resource
  WHERE resource->>'key' = 'mapping_config_directory'
)
SELECT ok(
  EXISTS (SELECT 1 FROM registry),
  'ui_read_registry exposes mapping_config_directory for live Console reads'
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
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource->'filters', '[]'::jsonb)) AS filter
    WHERE filter->>'key' IN ('id', 'organization_id', 'mapping_type', 'mapping_key', 'target', 'is_in_use')
    GROUP BY resource
    HAVING COUNT(DISTINCT filter->>'key') = 6
  ),
  'mapping_config_directory registry supports tenant and operator mapping filters'
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
  'mapping_config_directory registry is tenant-scoped by organization_id'
);

SELECT * FROM finish();

ROLLBACK;
