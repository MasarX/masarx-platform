-- Plan: PLAN-202604-b05-transfer-manifest-ui-closure / Step: S01
-- pgTAP: Warehouse transfer items UI access closure v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

CREATE OR REPLACE FUNCTION pg_temp.test_warehouse_transfer_items_ui_access_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_access JSONB := NULL;
  v_registry JSONB := NULL;
  v_navigation JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_from_branch UUID := gen_random_uuid();
  v_to_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_transfer UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_item UUID := gen_random_uuid();
  v_list JSONB := NULL;
  v_detail JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_access
    FROM public.settings
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_registry
    FROM public.settings
   WHERE category = 'ui_read_registry'
     AND scope_type = 'global'
   LIMIT 1;

  SELECT cached_value
    INTO v_navigation
    FROM public.settings
   WHERE category = 'ui_navigation'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_view('api', 'warehouse_transfer_items', 'api.warehouse_transfer_items view exists');
  RETURN NEXT ok(
    has_table_privilege('authenticated', 'api.warehouse_transfer_items', 'SELECT'),
    'authenticated can select api.warehouse_transfer_items'
  );
  RETURN NEXT is(
    v_access#>>'{resource_map,warehouse_transfer_items,read}',
    'warehouse_transfers.read',
    'resource_map wires warehouse_transfer_items.read through warehouse_transfers.read'
  );
  RETURN NEXT is(
    v_access#>>'{resource_map,warehouse_transfer_items,write}',
    'warehouse_transfers.write',
    'resource_map wires warehouse_transfer_items.write through warehouse_transfers.write'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfer_items'
        AND item.value->>'relation' = 'public.warehouse_transfer_items'
        AND item.value->>'capability_read' = 'warehouse_transfers.read'
    ),
    'ui_read_registry exposes warehouse_transfer_items against public.warehouse_transfer_items'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,console,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'warehouse_transfer_items'
    ),
    'console operations navigation includes warehouse_transfer_items'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_navigation#>'{apps,portal,sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'warehouse_transfer_items'
    ),
    'portal operations navigation includes warehouse_transfer_items'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Transfer Items UI Org', 'transfer-items-ui-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES
    (v_from_branch, v_org, 'tiui-f-' || lower(left(v_org::text, 4)), 'Transfer Items From Branch'),
    (v_to_branch, v_org, 'tiui-t-' || lower(left(v_org::text, 4)), 'Transfer Items To Branch');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Transfer Items UI Client', 'transfer-items-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (v_user, v_org, 'transfer-items-ui-' || left(v_user::text, 8) || '@example.com', 'Transfer Items UI User', 'ops_admin', 'tenant');

  INSERT INTO public.shipments (
    id, organization_id, client_id, tracking_number, status, service_type, created_at, updated_at
  )
  VALUES (
    v_shipment, v_org, v_client, 'TIUI-' || upper(left(v_shipment::text, 8)), 'pending', 'delivery', now(), now()
  );

  INSERT INTO public.warehouse_transfers (
    id, organization_id, from_branch_id, to_branch_id, status, transfer_code, created_by_user_id
  )
  VALUES (
    v_transfer, v_org, v_from_branch, v_to_branch, 'draft', 'TR-' || upper(left(v_transfer::text, 8)), v_user
  );

  INSERT INTO public.warehouse_transfer_items (
    id, organization_id, transfer_id, client_id, shipment_id, added_by_user_id
  )
  VALUES (
    v_item, v_org, v_transfer, v_client, v_shipment, v_user
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(public.ui_read_registry_v1()->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfer_items'
    ),
    'ui_read_registry_v1 returns warehouse_transfer_items to an authenticated tenant user'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(public.ui_navigation_v1('console')#>'{sections}', '[]'::jsonb)) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
      WHERE section.value->>'id' = 'operations'
        AND item.value->>'resource' = 'warehouse_transfer_items'
    ),
    'ui_navigation_v1(console) returns warehouse_transfer_items to an authenticated tenant user'
  );

  v_list := public.ui_list_resource_v1(
    'warehouse_transfer_items',
    jsonb_build_object('transfer_id', v_transfer::text),
    25,
    0
  );

  RETURN NEXT is(v_list->>'resource', 'warehouse_transfer_items', 'ui_list_resource_v1 returns the transfer items resource key');
  RETURN NEXT is((v_list->>'total')::int, 1, 'ui_list_resource_v1 returns the seeded warehouse_transfer_item');

  v_detail := public.ui_get_resource_v1('warehouse_transfer_items', v_item);
  RETURN NEXT is(v_detail->>'id', v_item::text, 'ui_get_resource_v1 returns the seeded warehouse_transfer_item');
  RETURN NEXT is(v_detail->>'transfer_id', v_transfer::text, 'ui_get_resource_v1 keeps the transfer linkage visible');

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_warehouse_transfer_items_ui_access_v1();

SELECT * FROM finish();

ROLLBACK;
