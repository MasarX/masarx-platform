-- pgTAP: Console V2 label history registry contract.
--
-- The shipment drawer Labels tab must resolve active labels, label jobs, and
-- immutable label-version history through ui_list_resource_v1. This guards the
-- browser-facing registry entries that make the live drawer backend-backed.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(18);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource
     WHERE resource->>'key' = 'label_versions'
       AND resource->>'relation' = 'public.label_versions'
       AND resource->>'id_column' = 'id'
       AND resource->>'capability_read' = 'labels.read'
  ),
  'ui_read_registry exposes label_versions through labels.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource
     WHERE resource->>'key' = 'label_versions'
       AND resource#>>'{scope_columns,tenant}' = 'organization_id'
       AND resource#>>'{scope_columns,client}' = 'client_id'
  ),
  'label_versions registry has tenant and client scope columns'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource,
           jsonb_array_elements(resource->'filters') AS filter
     WHERE resource->>'key' = 'label_versions'
       AND filter->>'key' = 'shipment_id'
       AND filter->>'column' = 'shipment_id'
       AND filter->>'op' = 'eq'
  ),
  'label_versions registry supports shipment_id filtering'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource,
           jsonb_array_elements(resource->'select') AS selected_column
     WHERE resource->>'key' = 'label_versions'
       AND selected_column #>> '{}' = 'file_url'
  ),
  'label_versions registry exposes file_url for artifact actions'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource
     WHERE resource->>'key' = 'label_artifacts'
       AND resource->>'relation' = 'public.label_artifacts'
       AND resource->>'id_column' = 'id'
       AND resource->>'capability_read' = 'labels.read'
  ),
  'ui_read_registry exposes target-neutral label_artifacts through labels.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource,
           jsonb_array_elements(resource->'filters') AS filter
     WHERE resource->>'key' = 'label_artifacts'
       AND filter->>'key' = 'target_id'
       AND filter->>'column' = 'target_id'
       AND filter->>'op' = 'eq'
  ),
  'label_artifacts registry supports target_id filtering'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource
     WHERE resource->>'key' = 'labels'
       AND resource->>'relation' = 'public.labels'
       AND resource->>'id_column' = 'id'
       AND resource->>'capability_read' = 'labels.read'
       AND resource#>>'{scope_columns,tenant}' = 'organization_id'
       AND resource#>>'{scope_columns,client}' = 'client_id'
  ),
  'labels registry is scoped for tenant/client reads'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource
     WHERE resource->>'key' = 'labels'
       AND resource->'select' ? 'active_version_id'
       AND resource->'select' ? 'active_version_number'
  ),
  'labels registry exposes active_version_id and active_version_number for reprint gating'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource
     WHERE resource->>'key' = 'label_jobs'
       AND resource->'select' ? 'target_type'
       AND resource->'select' ? 'target_id'
       AND resource->'select' ? 'target_box_id'
       AND resource->'select' ? 'target_metadata'
       AND resource->'select' ? 'template_id'
       AND resource->'select' ? 'renderer_metadata'
       AND resource->'select' ? 'completed_at'
       AND resource->'select' ? 'reprint_reason'
       AND resource->'select' ? 'source_label_version_id'
  ),
  'label_jobs registry exposes target lineage, template, renderer, completion, and reprint metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource,
           jsonb_array_elements(resource->'filters') AS filter
     WHERE resource->>'key' = 'label_jobs'
       AND filter->>'key' = 'target_id'
       AND filter->>'column' = 'target_id'
       AND filter->>'op' = 'eq'
  ),
  'label_jobs registry supports target_id filtering'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'label_versions'
            AND resource->>'relation' = 'public.label_versions'
       )
  ),
  'all ui_read_registry scopes include label_versions'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'label_artifacts'
            AND resource->>'relation' = 'public.label_artifacts'
       )
  ),
  'all ui_read_registry scopes include label_artifacts'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'labels'
            AND resource->>'relation' = 'public.labels'
            AND resource->'select' ? 'active_version_id'
            AND resource->'select' ? 'active_version_number'
       )
  ),
  'all ui_read_registry scopes expose labels active-version readback'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'label_jobs'
            AND resource->>'relation' = 'public.label_jobs'
            AND resource->'select' ? 'target_type'
            AND resource->'select' ? 'target_id'
            AND resource->'select' ? 'target_box_id'
            AND resource->'select' ? 'target_metadata'
       )
  ),
  'all ui_read_registry scopes expose label_jobs target lineage'
);

SELECT ok(
  (
    SELECT relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'label_versions'
  ),
  'label_versions remains RLS-backed for registry reads'
);

SELECT ok(
  (
    SELECT relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'label_artifacts'
  ),
  'label_artifacts remains RLS-backed for registry reads'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
     WHERE ld.category = 'label_reprint_reason'
       AND ld.owner_role = 'operations'
       AND ld.is_mutable = FALSE
  ),
  'label_reprint_reason lookup definition is registered for operations'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'label_reprint_reason'
       AND lv.value = 'operator_request'
       AND lv.status = 'active'
       AND lv.is_default = TRUE
  ),
  'operator_request is the active default label reprint reason'
);

SELECT * FROM finish();
ROLLBACK;
