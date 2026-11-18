-- pgTAP: Console V2 user-device summary registry contract.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource(value)
     WHERE resource.value->>'key' = 'user_device_summary'
       AND resource.value->>'relation' = 'public.v_user_device_summary'
       AND resource.value->>'capability_read' = 'user_devices.read'
       AND resource.value->>'capability_write' = 'user_devices.write'
       AND (resource.value->>'allow_view_relation')::boolean IS TRUE
  ),
  'global ui_read_registry exposes user_device_summary with canonical projection and capabilities'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources', '[]'::jsonb)) AS resource(value)
     WHERE resource.value->>'key' = 'user_device_summary'
       AND resource.value->>'relation' = 'public.v_user_device_summary'
  ),
  'platform ui_read_registry resolves user_device_summary'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
     WHERE resource.value->>'key' = 'user_device_summary'
       AND filter.value->>'key' = 'user_id'
       AND filter.value->>'column' = 'user_id'
       AND filter.value->>'op' = 'eq'
  ),
  'user_device_summary supports user_id filtering for the Users drawer'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
     WHERE resource.value->>'key' = 'user_device_summary'
       AND filter.value->>'key' = 'attestation_status'
       AND filter.value->>'column' = 'attestation_status'
       AND filter.value->>'op' = 'eq'
  ),
  'user_device_summary supports attestation_status filtering for operator review'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
     WHERE resource.value->>'key' = 'user_device_summary'
       AND filter.value->>'key' = 'is_revoked'
       AND filter.value->>'column' = 'is_revoked'
       AND filter.value->>'op' = 'eq'
  ),
  'user_device_summary supports is_revoked filtering for device governance'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_def(value)
     WHERE resource.value->>'key' = 'user_device_summary'
       AND column_def.value->>'key' = 'revoked_at'
       AND column_def.value->>'label' = 'Revoked at'
  ),
  'user_device_summary registry exposes revoked_at as operator-visible domain data'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource(value)
     WHERE resource.value->>'key' = 'user_device_summary'
       AND resource.value#>>'{default_sort,column}' = 'last_seen_at'
       AND resource.value#>>'{default_sort,direction}' = 'desc'
  ),
  'user_device_summary defaults to latest device activity first'
);

SELECT * FROM finish();
ROLLBACK;
