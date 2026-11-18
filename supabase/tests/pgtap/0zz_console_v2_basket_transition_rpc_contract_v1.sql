-- pgTAP: Console V2 basket transition RPC contract
-- Ensures basket lifecycle state changes stay behind the canonical RPC.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(32);

SELECT has_function('public', 'ui_update_basket_state_v1', ARRAY['jsonb'], 'public.ui_update_basket_state_v1 is registered');
SELECT has_function('api', 'ui_update_basket_state_v1', ARRAY['jsonb'], 'api.ui_update_basket_state_v1 is registered');

SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.ui_update_basket_state_v1(jsonb)')), true, 'public.ui_update_basket_state_v1 is SECURITY DEFINER');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('api.ui_update_basket_state_v1(jsonb)')), true, 'api.ui_update_basket_state_v1 is SECURITY DEFINER');

SELECT ok(has_function_privilege('authenticated', 'api.ui_update_basket_state_v1(jsonb)', 'EXECUTE'), 'authenticated can execute api.ui_update_basket_state_v1');
SELECT ok(has_function_privilege('service_role', 'api.ui_update_basket_state_v1(jsonb)', 'EXECUTE'), 'service_role can execute api.ui_update_basket_state_v1');
SELECT ok(NOT has_function_privilege('anon', 'api.ui_update_basket_state_v1(jsonb)', 'EXECUTE'), 'anon cannot execute api.ui_update_basket_state_v1');

SELECT ok(pg_get_functiondef(to_regprocedure('api.ui_update_basket_state_v1(jsonb)')) LIKE '%public.ui_update_basket_state_v1%', 'api.ui_update_basket_state_v1 delegates to public.ui_update_basket_state_v1');
SELECT ok(pg_get_functiondef(to_regprocedure('public.ui_update_basket_state_v1(jsonb)')) LIKE '%assert_capability_v1(''baskets.write''%', 'ui_update_basket_state_v1 enforces baskets.write');
SELECT ok(pg_get_functiondef(to_regprocedure('public.ui_update_basket_state_v1(jsonb)')) LIKE '%lookup_definitions%', 'ui_update_basket_state_v1 validates state through lookup_definitions');
SELECT ok(pg_get_functiondef(to_regprocedure('public.ui_update_basket_state_v1(jsonb)')) LIKE '%lookup_values%', 'ui_update_basket_state_v1 validates state through lookup_values');
SELECT ok(pg_get_functiondef(to_regprocedure('public.ui_update_basket_state_v1(jsonb)')) LIKE '%UPDATE public.baskets%', 'ui_update_basket_state_v1 updates public.baskets state');
SELECT ok(pg_get_functiondef(to_regprocedure('public.ui_update_basket_state_v1(jsonb)')) LIKE '%public.basket_transitions%', 'ui_update_basket_state_v1 resolves transition ledger rows');
SELECT ok(pg_get_functiondef(to_regprocedure('public.ui_update_basket_state_v1(jsonb)')) LIKE '%is not visible to current tenant%', 'ui_update_basket_state_v1 fails closed on cross-tenant baskets');

SELECT ok(NOT has_table_privilege('authenticated', 'api.baskets', 'INSERT'), 'authenticated cannot INSERT api.baskets directly');
SELECT ok(NOT has_table_privilege('authenticated', 'api.baskets', 'UPDATE'), 'authenticated cannot UPDATE api.baskets directly');
SELECT ok(NOT has_table_privilege('authenticated', 'api.baskets', 'DELETE'), 'authenticated cannot DELETE api.baskets directly');

SELECT is(
  (SELECT (lv.metadata->>'is_open')::boolean
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'basket_state'
      AND lv.value = 'forming'),
  true,
  'basket_state.forming metadata marks the state open'
);
SELECT is(
  (SELECT (lv.metadata->>'is_ready')::boolean
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'basket_state'
      AND lv.value = 'ready'),
  true,
  'basket_state.ready metadata drives Ready KPI counts'
);
SELECT is(
  (SELECT (lv.metadata->>'is_open')::boolean
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'basket_state'
      AND lv.value = 'reserved'),
  false,
  'basket_state.reserved metadata removes the state from open counts'
);
SELECT is(
  (SELECT (lv.metadata->>'is_exception')::boolean
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'basket_state'
      AND lv.value = 'expired'),
  true,
  'basket_state.expired metadata marks the exception bucket'
);
SELECT ok(
  (SELECT lv.metadata->'next_states' ? 'reserved'
     FROM public.lookup_values lv
     JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'basket_state'
      AND lv.value = 'ready'),
  'basket_state.ready metadata exposes reserved as a row-driven next state'
);

CREATE OR REPLACE FUNCTION public.test_console_v2_basket_transition_rpc_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 uuid := '0fb07000-0000-0000-0000-000000000101'::uuid;
  v_org2 uuid := '0fb07000-0000-0000-0000-000000000102'::uuid;
  v_admin_user uuid := '0fb07000-0000-0000-0000-000000000201'::uuid;
  v_plain_user uuid := '0fb07000-0000-0000-0000-000000000202'::uuid;
  v_basket1 uuid := '0fb07000-0000-0000-0000-000000000301'::uuid;
  v_basket2 uuid := '0fb07000-0000-0000-0000-000000000302'::uuid;
  v_result jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES
    (v_org1, 'Basket RPC Org 1', 'basket-rpc-org-1', 'active'),
    (v_org2, 'Basket RPC Org 2', 'basket-rpc-org-2', 'active')
  ON CONFLICT (id) DO UPDATE
    SET billing_status = EXCLUDED.billing_status;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (v_admin_user, v_org1, 'basket-rpc-admin@example.test', 'Basket RPC Admin', 'ops_admin', 'active', 'tenant', NULL),
    (v_plain_user, v_org1, 'basket-rpc-plain@example.test', 'Basket RPC Plain', 'account_manager', 'active', 'tenant', NULL)
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        status = EXCLUDED.status,
        access_scope_type = EXCLUDED.access_scope_type,
        access_scope_id = EXCLUDED.access_scope_id;

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org1, ARRAY['ops_admin'], v_admin_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org1, v_admin_user, r.id, v_admin_user,
         jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org1
     AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.baskets (id, organization_id, state, basket_type, current_count, capacity_count)
  VALUES
    (v_basket1, v_org1, 'forming', 'zone_based', 0, 10),
    (v_basket2, v_org2, 'forming', 'zone_based', 0, 10)
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        state = EXCLUDED.state,
        basket_type = EXCLUDED.basket_type,
        current_count = EXCLUDED.current_count,
        capacity_count = EXCLUDED.capacity_count;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_plain_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  RETURN NEXT throws_ok(
    format($sql$
      SELECT api.ui_update_basket_state_v1(jsonb_build_object('basket_id', %L, 'state', 'ready'))
    $sql$, v_basket1::text),
    '42501',
    NULL,
    'unprivileged tenant user cannot transition a basket'
  );

  PERFORM set_config('request.jwt.claim.sub', v_admin_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  RETURN NEXT throws_ok(
    format($sql$
      SELECT api.ui_update_basket_state_v1(jsonb_build_object('basket_id', %L, 'state', 'not_a_state'))
    $sql$, v_basket1::text),
    '23514',
    NULL,
    'invalid basket state is rejected'
  );

  RETURN NEXT throws_ok(
    format($sql$
      SELECT api.ui_update_basket_state_v1(jsonb_build_object('basket_id', %L, 'state', 'ready'))
    $sql$, v_basket2::text),
    '42501',
    NULL,
    'tenant user cannot transition another tenant basket'
  );

  RETURN NEXT throws_ok(
    format($sql$
      SELECT api.ui_update_basket_state_v1(jsonb_build_object('basket_id', %L, 'state', 'dispatched'))
    $sql$, v_basket1::text),
    '23514',
    NULL,
    'transition RPC rejects state changes outside lookup next_states'
  );

  v_result := api.ui_update_basket_state_v1(
    jsonb_build_object('basket_id', v_basket1::text, 'state', 'ready', 'reason', 'pgTAP transition proof')
  );

  RETURN NEXT ok(COALESCE((v_result->>'ok')::boolean, FALSE), 'transition RPC returns ok=true');
  RETURN NEXT is(v_result->>'previous_state', 'forming', 'transition RPC reports previous state');
  RETURN NEXT is(v_result->>'state', 'ready', 'transition RPC reports new state');
  RETURN NEXT ok((v_result->>'changed')::boolean, 'transition RPC reports changed=true');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT state FROM public.baskets WHERE id = v_basket1),
    'ready',
    'basket row state was updated'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.basket_transitions
       WHERE basket_id = v_basket1
         AND previous_state = 'forming'
         AND new_state = 'ready'
         AND notes = 'pgTAP transition proof'
    ),
    'transition ledger records previous state, new state, and reason'
  );

  RETURN;
END;
$function$;

SELECT * FROM public.test_console_v2_basket_transition_rpc_contract_v1();

SELECT * FROM finish();
ROLLBACK;
