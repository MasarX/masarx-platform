-- Test: Zones + baskets primitives (org-scoped)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(31);

-- Zones
SELECT has_table('public', 'zones', 'zones table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'zones'), 'RLS enabled on zones');
SELECT has_trigger('public', 'zones', 'trg_zones_set_updated_at', 'zones updated_at trigger present');

SELECT has_table('public', 'zone_districts', 'zone_districts table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'zone_districts'), 'RLS enabled on zone_districts');
SELECT has_trigger('public', 'zone_districts', 'trg_zone_districts_enforce_org_match', 'zone_districts org-match trigger present');

-- Baskets
SELECT has_table('public', 'baskets', 'baskets table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'baskets'), 'RLS enabled on baskets');
SELECT has_trigger('public', 'baskets', 'trg_baskets_log_state_transition', 'baskets state transition trigger present');

SELECT has_table('public', 'basket_items', 'basket_items table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'basket_items'), 'RLS enabled on basket_items');
SELECT has_index('public', 'basket_items', 'uniq_basket_items_one_active_basket_per_shipment', 'one-active-basket-per-shipment index present');

SELECT has_table('public', 'basket_transitions', 'basket_transitions table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'basket_transitions'), 'RLS enabled on basket_transitions');

-- Shipments integration
SELECT has_column('public', 'shipments', 'zone_id', 'shipments has zone_id');
SELECT has_index('public', 'shipments', 'idx_shipments_zone_id', 'shipments zone_id index present');

-- Helpers + dynamic enums
SELECT ok(
  to_regprocedure('public.resolve_zone_id_for_canonical_district(uuid,uuid)') IS NOT NULL,
  'resolve_zone_id_for_canonical_district(uuid,uuid) exists'
);

SELECT ok(
  to_regprocedure('workflow_handlers.execute_zone_assign_v1(public.workflow_run_steps,public.workflow_runs,jsonb)') IS NOT NULL,
  'workflow_handlers.execute_zone_assign_v1(...) exists'
);

SELECT ok(
  to_regprocedure('workflow_handlers.execute_basket_assign_v1(public.workflow_run_steps,public.workflow_runs,jsonb)') IS NOT NULL,
  'workflow_handlers.execute_basket_assign_v1(...) exists'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'zone_assign' AND is_active = TRUE),
  'operation_handlers has zone_assign'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.operation_handlers WHERE handler_key = 'basket_assign' AND is_active = TRUE),
  'operation_handlers has basket_assign'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    JOIN public.workflow_template_steps wts ON wts.workflow_template_id = wt.id
    WHERE wt.name = 'workflow_geocoding_standard'
      AND wts.operation_name = 'zone_assign'
      AND wts.handler_key = 'zone_assign'
  ),
  'workflow_geocoding_standard includes zone_assign step'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    JOIN public.workflow_template_steps wts ON wts.workflow_template_id = wt.id
    WHERE wt.name = 'workflow_geocoding_standard'
      AND wts.operation_name = 'basket_assign'
      AND wts.handler_key = 'basket_assign'
  ),
  'workflow_geocoding_standard includes basket_assign step'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'basket_state'),
  'basket_state lookup definition seeded'
);

SELECT ok(
  (
    SELECT COUNT(*)
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'basket_state'
      AND v.status = 'active'
  ) >= 5,
  'basket_state values seeded'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'basket_policy' AND version = 1 AND is_active = TRUE),
  'basket_policy schema_registry seeded'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings WHERE category = 'basket_policy' AND scope_type = 'global' AND scope_id IS NULL),
  'basket_policy global settings seeded'
);

DO $$
DECLARE
  v_org UUID := '0e900000-0000-0000-0000-000000000001'::uuid;
  v_user UUID := '0e900000-0000-0000-0000-000000000101'::uuid;

  v_zone_base UUID := '0e900000-0000-0000-0000-000000000201'::uuid;
  v_zone_auth UUID := '0e900000-0000-0000-0000-000000000202'::uuid;

  v_city UUID := '0e900000-0000-0000-0000-000000000301'::uuid;
  v_district UUID := '0e900000-0000-0000-0000-000000000401'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Zones Org', 'zones-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'zones-' || left(v_user::text, 8) || '@example.com', 'Zones User', 'tenant')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.canonical_cities (id, organization_id, name_canonical, source)
  VALUES (v_city, v_org, 'Test City', 'manual_seed')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.canonical_districts (id, organization_id, city_id, name_canonical, source)
  VALUES (v_district, v_org, v_city, 'Test District', 'manual_seed')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone_base, v_org, 'Base Zone', 'base-zone-' || left(v_zone_base::text, 8), TRUE)
  ON CONFLICT (id) DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.zones (id, organization_id, name, slug, is_active)
      VALUES (%L::uuid, %L::uuid, 'Auth Zone', 'auth-zone-%s', TRUE)
    $sql$, v_zone_auth::text, v_org::text, left(v_zone_auth::text, 8)),
    '42501',
    'new row violates row-level security policy for table "zones"'
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.zone_districts (zone_id, canonical_district_id)
      VALUES (%L::uuid, %L::uuid)
    $sql$, v_zone_base::text, v_district::text),
    '42501',
    'new row violates row-level security policy for table "zone_districts"'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['agreements_admin'], v_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'agreements_admin'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone_auth, v_org, 'Auth Zone', 'auth-zone-' || left(v_zone_auth::text, 8), TRUE);
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.zones WHERE organization_id = v_org AND id = v_zone_auth) = 1,
    'RBAC: agreements_admin can write zones'
  );

  INSERT INTO public.zone_districts (zone_id, canonical_district_id)
  VALUES (v_zone_base, v_district);
  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.zone_districts WHERE zone_id = v_zone_base AND canonical_district_id = v_district) = 1,
    'RBAC: agreements_admin can write zone_districts'
  );
END $$;

SELECT * FROM finish();

ROLLBACK;
