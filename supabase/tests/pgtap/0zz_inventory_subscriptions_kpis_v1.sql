-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S95
-- pgTAP: Inventory + subscriptions + KPI primitives (RLS + RBAC gates + contracts)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(40);

CREATE OR REPLACE FUNCTION test_inventory_subscriptions_kpis_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := gen_random_uuid();
  v_org2 UUID := gen_random_uuid();
  v_user1 UUID := gen_random_uuid();
  v_user2 UUID := gen_random_uuid();

  v_branch1 UUID := gen_random_uuid();
  v_loc1 UUID := gen_random_uuid();

  v_item1 UUID := gen_random_uuid();
  v_move1 UUID := gen_random_uuid();

  v_kpi_key TEXT := 'on_time_rate';
  v_rollup1 UUID := gen_random_uuid();

  v_sub1 UUID := gen_random_uuid();
  v_sub_ev1 UUID := gen_random_uuid();

  v_perm_agreements_read UUID;
  v_role_agreements1 UUID;
BEGIN
  -- Tables exist
  RETURN NEXT has_table('public', 'inventory_items', 'inventory_items table exists');
  RETURN NEXT has_table('public', 'inventory_movements', 'inventory_movements table exists');
  RETURN NEXT has_table('public', 'subscriptions', 'subscriptions table exists');
  RETURN NEXT has_table('public', 'subscription_events', 'subscription_events table exists');
  RETURN NEXT has_table('public', 'kpi_definitions', 'kpi_definitions table exists');
  RETURN NEXT has_table('public', 'kpi_rollups_daily', 'kpi_rollups_daily table exists');
  RETURN NEXT has_table('public', 'kpi_rollup_events', 'kpi_rollup_events table exists');

  -- Views (projections) exist + api surface is readable
  RETURN NEXT has_view('public', 'inventory_balances_v1', 'inventory_balances_v1 view exists');
  RETURN NEXT has_view('api', 'inventory_balances_v1', 'api.inventory_balances_v1 view exists');
  RETURN NEXT ok(has_table_privilege('authenticated', 'api.inventory_balances_v1', 'select'), 'authenticated can SELECT api.inventory_balances_v1');
  RETURN NEXT ok(NOT has_table_privilege('anon', 'api.inventory_balances_v1', 'select'), 'anon cannot SELECT api.inventory_balances_v1');

  -- RLS enabled + policies exist
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'inventory_items'), 'RLS enabled on inventory_items');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'inventory_movements'), 'RLS enabled on inventory_movements');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'subscriptions'), 'RLS enabled on subscriptions');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'subscription_events'), 'RLS enabled on subscription_events');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'kpi_definitions'), 'RLS enabled on kpi_definitions');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'kpi_rollups_daily'), 'RLS enabled on kpi_rollups_daily');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'kpi_rollup_events'), 'RLS enabled on kpi_rollup_events');

  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_items'), 'inventory_items has policies');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_movements'), 'inventory_movements has policies');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'subscriptions'), 'subscriptions has policies');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'subscription_events'), 'subscription_events has policies');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'kpi_definitions'), 'kpi_definitions has policies');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'kpi_rollups_daily'), 'kpi_rollups_daily has policies');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'kpi_rollup_events'), 'kpi_rollup_events has policies');

  -- Contracts (audit + updated_at expectations are row-driven)
  RETURN NEXT ok(
    EXISTS(
      SELECT 1 FROM public.table_contracts
      WHERE table_schema = 'public' AND table_name = 'inventory_movements' AND audit_enabled = FALSE AND updated_at_required = FALSE
    ),
    'table_contracts: inventory_movements disables audit + updated_at'
  );

  RETURN NEXT ok(
    EXISTS(
      SELECT 1 FROM public.table_contracts
      WHERE table_schema = 'public' AND table_name = 'subscription_events' AND audit_enabled = FALSE AND updated_at_required = FALSE
    ),
    'table_contracts: subscription_events disables audit + updated_at'
  );

  RETURN NEXT ok(
    EXISTS(
      SELECT 1 FROM public.table_contracts
      WHERE table_schema = 'public' AND table_name = 'kpi_rollups_daily' AND audit_enabled = FALSE
    ),
    'table_contracts: kpi_rollups_daily disables audit'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  -- Orgs + users (tenant scope)
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'Inv Org 1', 'inv-org-' || left(v_org1::text, 8)),
    (v_org2, 'Inv Org 2', 'inv-org-' || left(v_org2::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name)
  VALUES
    (v_user1, v_org1, 'inv-u1-' || left(v_user1::text, 8) || '@example.com', 'Inv User 1'),
    (v_user2, v_org2, 'inv-u2-' || left(v_user2::text, 8) || '@example.com', 'Inv User 2');

  -- Branch/location (required for inventory movement links)
  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch1, v_org1, 'b-' || left(v_branch1::text, 8), 'Branch 1');

  INSERT INTO public.warehouse_locations (id, organization_id, branch_id, code, name)
  VALUES (v_loc1, v_org1, v_branch1, 'loc-' || left(v_loc1::text, 8), 'Location 1');

  -- Inventory item + movement
  INSERT INTO public.inventory_items (id, organization_id, key, name)
  VALUES (v_item1, v_org1, 'box', 'Box');

  INSERT INTO public.inventory_movements (
    id, organization_id, item_id, to_location_id, movement_type, quantity, occurred_at, actor_user_id
  )
  VALUES (
    v_move1, v_org1, v_item1, v_loc1, 'receive', 5, now(), v_user1
  );

  -- KPI definition + rollup
  INSERT INTO public.kpi_definitions (organization_id, key, name, definition)
  VALUES (v_org1, v_kpi_key, 'On-time Rate', jsonb_build_object('source', 'derived'));

  INSERT INTO public.kpi_rollups_daily (id, organization_id, kpi_key, day, dimensions, numerator, denominator)
  VALUES (v_rollup1, v_org1, v_kpi_key, current_date, '{}'::jsonb, 9, 10);

  -- Subscription + events (RBAC-gated reads)
  INSERT INTO public.subscriptions (id, organization_id, plan_key, status, created_by_user_id)
  VALUES (v_sub1, v_org1, 'standard', 'active', v_user1);

  INSERT INTO public.subscription_events (id, subscription_id, organization_id, event_type, from_status, to_status, subscription_version)
  VALUES (v_sub_ev1, v_sub1, v_org1, 'created', NULL, 'active', 1);

  -- user1: authenticated without agreements.read
  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.inventory_items WHERE id = v_item1), 1, 'user1 sees own org inventory_items');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.inventory_movements WHERE id = v_move1), 1, 'user1 sees own org inventory_movements');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.kpi_definitions WHERE organization_id = v_org1 AND key = v_kpi_key), 1, 'user1 sees own org kpi_definitions');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.kpi_rollups_daily WHERE id = v_rollup1), 1, 'user1 sees own org kpi_rollups_daily');
  RETURN NEXT is(
    (SELECT COALESCE(MAX(quantity), 0)::INT FROM api.inventory_balances_v1 WHERE organization_id = v_org1 AND item_id = v_item1 AND location_id = v_loc1),
    5,
    'api.inventory_balances_v1 returns current balance for org1/item/location'
  );

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.subscriptions WHERE id = v_sub1), 0, 'user1 without agreements.read cannot see own subscription');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.subscription_events WHERE id = v_sub_ev1), 0, 'user1 without agreements.read cannot see subscription_events');

  -- Grant agreements.read to user1 via RBAC role
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT lv.id
    INTO v_perm_agreements_read
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value = 'agreements.read'
   LIMIT 1;

  INSERT INTO public.rbac_roles (organization_id, key, name, metadata)
  VALUES (v_org1, 'agreements', 'Agreements', jsonb_build_object('source', 'pgtap'))
  RETURNING id INTO v_role_agreements1;

  INSERT INTO public.rbac_role_permissions (organization_id, role_id, permission_id, metadata)
  VALUES (v_org1, v_role_agreements1, v_perm_agreements_read, jsonb_build_object('source', 'pgtap'));

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, metadata)
  VALUES (v_org1, v_user1, v_role_agreements1, jsonb_build_object('source', 'pgtap'));

  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.subscriptions WHERE id = v_sub1), 1, 'user1 with agreements.read sees own subscription');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.subscription_events WHERE id = v_sub_ev1), 1, 'user1 with agreements.read sees subscription_events');

  -- user2 cannot see org1 data
  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.inventory_items WHERE id = v_item1), 0, 'user2 cannot see org1 inventory_items');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.kpi_rollups_daily WHERE id = v_rollup1), 0, 'user2 cannot see org1 kpi_rollups_daily');
  RETURN NEXT is((SELECT COUNT(*)::INT FROM api.inventory_balances_v1 WHERE organization_id = v_org1 AND item_id = v_item1 AND location_id = v_loc1), 0, 'user2 cannot see org1 inventory balances');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN;
END;
$function$;

SELECT * FROM test_inventory_subscriptions_kpis_v1();

SELECT * FROM finish();

ROLLBACK;
