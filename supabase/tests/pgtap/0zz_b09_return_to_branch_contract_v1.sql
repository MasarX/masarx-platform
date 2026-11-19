-- Plan: Batch 9 return-to-branch contract / Step: S01
-- pgTAP: return-to-branch intake visibility + registry wiring

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(19);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
     WHERE ld.category = 'scan_type'
  ),
  'scan_type lookup definition exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'scan_type'
       AND lv.value = 'return_to_branch_intake'
  ),
  'scan_type lookup includes return_to_branch_intake'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'scan_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(s.cached_value->'accepted_scan_types', '[]'::jsonb)) AS scan_type
          WHERE scan_type = to_jsonb('return_to_branch_intake'::text)
       )
  ),
  'scan_policy accepted_scan_types includes return_to_branch_intake'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'return_to_branch_shipments'
       )
  ),
  'ui_read_registry includes return_to_branch_shipments'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource->>'key' = 'return_to_branch_shipments'
     LIMIT 1
  ),
  'api.return_to_branch_shipments_v1',
  'return_to_branch_shipments reads from api.return_to_branch_shipments_v1'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,client}'
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource->>'key' = 'return_to_branch_shipments'
     LIMIT 1
  ),
  'client_id',
  'return_to_branch_shipments keeps client scope on client_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,sender}'
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource->>'key' = 'return_to_branch_shipments'
     LIMIT 1
  ),
  'sender_id',
  'return_to_branch_shipments keeps sender scope on sender_id'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource->>'key' = 'return_to_branch_reattempt'
     LIMIT 1
  ),
  'api.return_to_branch_shipments_v1',
  'return_to_branch_reattempt keeps the canonical api.return_to_branch_shipments_v1 relation'
);

SELECT is(
  (
    SELECT resource#>>'{base_filter,rules,0,value}'
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource->>'key' = 'return_to_branch_reattempt'
     LIMIT 1
  ),
  'reattempt',
  'return_to_branch_reattempt filters next_action = reattempt'
);

SELECT is(
  (
    SELECT resource#>>'{base_filter,rules,0,value}'
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource->>'key' = 'return_to_branch_customer_pickup'
     LIMIT 1
  ),
  'customer_pickup',
  'return_to_branch_customer_pickup filters next_action = customer_pickup'
);

SELECT is(
  (
    SELECT resource#>>'{base_filter,rules,0,value}'
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource->>'key' = 'return_to_branch_sender_return'
     LIMIT 1
  ),
  'sender_return',
  'return_to_branch_sender_return filters next_action = sender_return'
);

SELECT is(
  (
    SELECT resource#>>'{base_filter,rules,0,value}'
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource->>'key' = 'return_to_branch_hold'
     LIMIT 1
  ),
  'hold',
  'return_to_branch_hold filters next_action = hold'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) AS section
          WHERE section->>'id' = 'operations'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
               WHERE item->>'id' = 'console-return-to-branch'
                 AND item->>'href' = '/console/resources/return_to_branch_shipments'
            )
       )
  ),
  'ui_navigation includes the Console return-to-branch entry'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(s.cached_value#>'{apps,portal,sections}', '[]'::jsonb)) AS section
          WHERE section->>'id' = 'operations'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
               WHERE item->>'id' = 'portal-return-to-branch'
                 AND item->>'href' = '/portal/resources/return_to_branch_shipments'
            )
       )
  ),
  'ui_navigation includes the Portal return-to-branch entry'
);

SELECT is(
  (
    SELECT s.cached_value#>>'{resource_map,return_to_branch_shipments,read}'
      FROM public.settings s
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  'shipments.read',
  'access_control_policy maps return_to_branch_shipments.read to shipments.read'
);

SELECT is(
  (
    SELECT s.cached_value#>>'{resource_map,return_to_branch_shipments,write}'
      FROM public.settings s
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  'shipments.write',
  'access_control_policy maps return_to_branch_shipments.write to shipments.write'
);

SELECT has_function(
  'public',
  'ensure_branch_return_inventory_location_v1',
  ARRAY['uuid', 'uuid', 'text']::name[],
  'ensure_branch_return_inventory_location_v1 exists'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.branches b
     WHERE COALESCE(b.is_active, TRUE) IS TRUE
       AND lower(COALESCE(b.branch_type, '')) = 'warehouse'
       AND NOT EXISTS (
         SELECT 1
           FROM public.warehouse_locations wl
          WHERE wl.organization_id = b.organization_id
            AND wl.branch_id = b.id
            AND COALESCE(wl.is_active, TRUE) IS TRUE
       )
  ),
  'active warehouse branches have an active default inventory location'
);

SELECT lives_ok(
  $$
    SELECT public.resolve_branch_inventory_location_v1(b.organization_id, b.id)
      FROM public.branches b
     WHERE COALESCE(b.is_active, TRUE) IS TRUE
       AND lower(COALESCE(b.branch_type, '')) = 'warehouse'
     LIMIT 1
  $$,
  'return-to-branch inventory location resolver works for an active warehouse branch'
);

SELECT * FROM finish();

ROLLBACK;
