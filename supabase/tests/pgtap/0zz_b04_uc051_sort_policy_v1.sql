-- Plan: B04 UC051 sort policy closeout / Step: T01
-- pgTAP: branch/route/service/priority-aware basket sorting primitives

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SELECT has_column('public', 'baskets', 'sort_branch_id', 'baskets has sort_branch_id');
SELECT has_column('public', 'baskets', 'sort_service_key', 'baskets has sort_service_key');
SELECT has_column('public', 'baskets', 'sort_route_key', 'baskets has sort_route_key');
SELECT has_column('public', 'baskets', 'sort_priority_key', 'baskets has sort_priority_key');

SELECT has_index(
  'public',
  'baskets',
  'idx_baskets_org_zone_sort_dims_state',
  'baskets sort-dimension index present'
);

SELECT has_trigger(
  'public',
  'baskets',
  'trg_baskets_enforce_sort_branch_org_match',
  'baskets sort-branch org trigger present'
);

SELECT ok(
  to_regprocedure('public.baskets_enforce_sort_branch_org_match_v1()') IS NOT NULL,
  'baskets_enforce_sort_branch_org_match_v1() exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry sr
    WHERE sr.category = 'basket_policy'
      AND sr.version = 1
      AND sr.is_active = TRUE
      AND sr.schema->'properties' ? 'group_by_branch'
      AND sr.schema->'properties' ? 'group_by_service'
      AND sr.schema->'properties' ? 'group_by_route'
      AND sr.schema->'properties' ? 'group_by_priority'
      AND sr.schema->'properties' ? 'route_key_paths'
      AND sr.schema->'properties' ? 'priority_bands'
  ),
  'basket_policy schema_registry includes sort grouping keys'
);

DO $$
DECLARE
  v_org1 UUID := '0c510000-0000-0000-0000-000000000001'::uuid;
  v_org2 UUID := '0c510000-0000-0000-0000-000000000002'::uuid;
  v_client1 UUID := '0c510000-0000-0000-0000-000000000401'::uuid;
  v_client2 UUID := '0c510000-0000-0000-0000-000000000402'::uuid;
  v_sender1 UUID := '0c510000-0000-0000-0000-000000000501'::uuid;
  v_sender2 UUID := '0c510000-0000-0000-0000-000000000502'::uuid;
  v_zone1 UUID := '0c510000-0000-0000-0000-000000000101'::uuid;
  v_branch1 UUID := '0c510000-0000-0000-0000-000000000201'::uuid;
  v_branch2 UUID := '0c510000-0000-0000-0000-000000000202'::uuid;
  v_basket_ok UUID := '0c510000-0000-0000-0000-000000000301'::uuid;
  v_basket_bad UUID := '0c510000-0000-0000-0000-000000000302'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'B04 Sort Org 1', 'b04-sort-org-1'),
    (v_org2, 'B04 Sort Org 2', 'b04-sort-org-2')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client1, v_org1, 'B04 Sort Client 1', 'b04-sort-client-1', 'active'),
    (v_client2, v_org2, 'B04 Sort Client 2', 'b04-sort-client-2', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES
    (v_sender1, v_client1, 'B04 Sort Sender 1', 'B04 Sort Sender 1', TRUE, 'active'),
    (v_sender2, v_client2, 'B04 Sort Sender 2', 'B04 Sort Sender 2', TRUE, 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.bootstrap_tenant_onboarding_v1(v_org1, 'pgtap:b04-sort-org1-fixture-bootstrap');
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org2, 'pgtap:b04-sort-org2-fixture-bootstrap');

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone1, v_org1, 'Sort Zone 1', 'sort-zone-1', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES
    (v_branch1, v_org1, 'b04a', 'B04 Branch A', TRUE),
    (v_branch2, v_org2, 'b04b', 'B04 Branch B', TRUE)
  ON CONFLICT (id) DO NOTHING;

  PERFORM lives_ok(
    format($sql$
      INSERT INTO public.baskets (
        id,
        organization_id,
        zone_id,
        basket_type,
        state,
        sort_branch_id
      )
      VALUES (
        %L::uuid,
        %L::uuid,
        %L::uuid,
        'zone_based',
        'forming',
        %L::uuid
      )
    $sql$, v_basket_ok::text, v_org1::text, v_zone1::text, v_branch1::text),
    'baskets accepts same-organization sort_branch_id'
  );

  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.baskets (
        id,
        organization_id,
        zone_id,
        basket_type,
        state,
        sort_branch_id
      )
      VALUES (
        %L::uuid,
        %L::uuid,
        %L::uuid,
        'zone_based',
        'forming',
        %L::uuid
      )
    $sql$, v_basket_bad::text, v_org1::text, v_zone1::text, v_branch2::text),
    '23514',
    format(
      'baskets: organization mismatch (basket org %s, branch org %s)',
      v_org1::text,
      v_org2::text
    )
  );
END $$;

SELECT * FROM finish();

ROLLBACK;
