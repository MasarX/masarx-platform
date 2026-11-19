-- pgTAP: Console V2 shipments registry must expose import metadata and
-- related-domain drawer resources through ui_read_registry, not frontend
-- literals.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
     WHERE r.value->>'key' = 'shipments'
  ),
  'shipments registry resource exists'
);

SELECT is(
  (
    SELECT r.value->>'capability_write'
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
     WHERE r.value->>'key' = 'shipments'
  ),
  'shipments.write',
  'shipments registry resource is write-gated by shipments.write'
);

SELECT ok(
  COALESCE((
    SELECT (r.value#>>'{import,enabled}')::boolean
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
     WHERE r.value->>'key' = 'shipments'
  ), FALSE),
  'shipments import is explicitly enabled in registry metadata'
);

SELECT ok(
  COALESCE((
    SELECT r.value#>'{import,accepted_formats}' @> '["csv","xls","xlsx"]'::jsonb
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
     WHERE r.value->>'key' = 'shipments'
  ), FALSE),
  'shipments import accepts csv/xls/xlsx through registry metadata'
);

SELECT ok(
  COALESCE((
    SELECT r.value#>'{import,identity_columns}' @> '["tracking_number","client_reference_number"]'::jsonb
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
     WHERE r.value->>'key' = 'shipments'
  ), FALSE),
  'shipments import declares stable identity columns'
);

SELECT is(
  (
    SELECT r.value#>>'{import,default_write_mode}'
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
     WHERE r.value->>'key' = 'shipments'
  ),
  'create',
  'shipments import defaults to create-only writes'
);

SELECT ok(
  COALESCE((
    SELECT r.value->'related' @> jsonb_build_array(jsonb_build_object(
      'resource', 'shipment_boxes',
      'filter_key', 'shipment_id',
      'from', 'id'
    ))
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
     WHERE r.value->>'key' = 'shipments'
  ), FALSE),
  'shipments registry exposes shipment_boxes as a related drawer resource'
);

SELECT ok(
  COALESCE((
    SELECT r.value->'related' @> jsonb_build_array(jsonb_build_object(
      'resource', 'labels',
      'filter_key', 'shipment_id',
      'from', 'id'
    ))
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
     WHERE r.value->>'key' = 'shipments'
  ), FALSE),
  'shipments registry exposes labels as a related drawer resource'
);

SELECT ok(
  COALESCE((
    SELECT r.value->'related' @> jsonb_build_array(jsonb_build_object(
      'resource', 'shipment_reference_numbers',
      'filter_key', 'shipment_id',
      'from', 'id'
    ))
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
     WHERE r.value->>'key' = 'shipments'
  ), FALSE),
  'shipments registry exposes shipment_reference_numbers as a related drawer resource'
);

SELECT * FROM finish();

ROLLBACK;
