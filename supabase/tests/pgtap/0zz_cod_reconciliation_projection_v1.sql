-- F808 draft native proof: UNEXECUTED. No fixture changes survive the rollback.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(30);
SELECT has_view('api', 'cod_reconciliation', 'COD API projection exists');
SELECT ok((SELECT COALESCE(reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  FROM pg_class WHERE oid = 'api.cod_reconciliation'::regclass), 'view uses invoker security');
SELECT ok(has_table_privilege('authenticated', 'api.cod_reconciliation', 'SELECT'),
  'authenticated can reach the governed projection');
SELECT ok(NOT has_table_privilege('anon', 'api.cod_reconciliation', 'SELECT'),
  'anonymous has no COD projection grant');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.shipments'::regclass),
  'shipment source retains RLS');

SELECT is((SELECT count(*)::int FROM public.settings s
 JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  AND sv.scope_hash = s.scope_hash AND sv.category = s.category
  AND sv.scope_type = s.scope_type AND sv.scope_id IS NOT DISTINCT FROM s.scope_id
 JOIN public.schema_registry sr ON sr.category = sv.category AND sr.version = sv.schema_version
 WHERE s.category = 'ui_read_registry' AND s.scope_type = public.get_root_scope_type_key_v1()
  AND s.scope_id IS NULL AND sv.effective_until IS NULL AND sv.effective_from <= now()
  AND sv.approved_at IS NOT NULL AND s.cached_value = sv.value), 1,
 'registry current full pointer/cache/schema pair is valid');
SELECT is((SELECT count(*)::int FROM jsonb_array_elements(
 public.resolve_settings_merged('ui_read_registry', public.get_root_scope_type_key_v1(), NULL)->'resources') r
 WHERE r->>'key' = 'cod_reconciliation' AND r->>'relation' = 'api.cod_reconciliation'
 AND r->>'capability_read' = 'shipments.read'
 AND r->'scope_columns' = '{"tenant":"organization_id","client":"client_id","sender":"sender_id"}'::jsonb), 1,
 'unique root COD binding retains canonical capability and all scope columns');

CREATE OR REPLACE FUNCTION pg_temp.test_cod_order_projection()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_other_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_other_sender UUID := gen_random_uuid();
  v_reader UUID := gen_random_uuid();
  v_denied UUID := gen_random_uuid();
  v_pending UUID := gen_random_uuid();
  v_recorded UUID := gen_random_uuid();
  v_null UUID := gen_random_uuid();
  v_scalar UUID := gen_random_uuid();
  v_ordinary UUID := gen_random_uuid();
  v_foreign UUID := gen_random_uuid();
  v_snapshot JSONB := '{"expected_amount":100,"collected_amount":90,"variance_amount":10,"currency":"USD","outcome":"collected","discrepancy_kind":"shortfall"}'::jsonb;
  v_list JSONB;
  v_page2 JSONB;
  v_ids UUID[];
  v_client_reader UUID := gen_random_uuid();
  v_sender_reader UUID := gen_random_uuid();
  v_sibling_client UUID := gen_random_uuid();
  v_sibling_sender UUID := gen_random_uuid();
  v_second_sender UUID := gen_random_uuid();
  v_sibling UUID := gen_random_uuid();
  v_second UUID := gen_random_uuid();
  v_refused UUID := gen_random_uuid();
  v_over UUID := gen_random_uuid();
  v_policy_version INTEGER;
BEGIN
  INSERT INTO public.organizations(id, name, slug) VALUES
    (v_org, 'COD projection fixture', 'cod-projection-' || v_org),
    (v_other_org, 'COD foreign fixture', 'cod-projection-' || v_other_org);
  INSERT INTO public.clients(id, organization_id, name, slug, status) VALUES
    (v_client, v_org, 'COD client', 'cod-' || v_client, 'active'),
    (v_other_client, v_other_org, 'Foreign client', 'cod-' || v_other_client, 'active'),
    (v_sibling_client, v_org, 'Sibling client', 'cod-' || v_sibling_client, 'active');
  INSERT INTO public.senders(id, client_id, name, status) VALUES
    (v_sender, v_client, 'COD sender', 'active'),
    (v_other_sender, v_other_client, 'Foreign sender', 'active'),
    (v_sibling_sender, v_sibling_client, 'Sibling sender', 'active'),
    (v_second_sender, v_client, 'Second sender', 'active');
  INSERT INTO public.users(id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id) VALUES
    (v_reader, v_org, 'cod-' || v_reader || '@example.com', 'COD reader', 'ops_admin', 'tenant', NULL),
    (v_denied, v_other_org, 'cod-' || v_denied || '@example.com', 'COD denied reader', 'ops_admin', 'tenant', NULL),
    (v_client_reader, v_org, 'cod-' || v_client_reader || '@example.com', 'Client reader', 'client_admin', 'client', v_client),
    (v_sender_reader, v_org, 'cod-' || v_sender_reader || '@example.com', 'Sender reader', 'sender_user', 'sender', v_sender);
  SELECT version INTO STRICT v_policy_version FROM public.schema_registry
   WHERE category = 'access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_other_org,
    jsonb_build_object('denies', jsonb_build_array(jsonb_build_object(
      'capability_key', 'shipments.read', 'scope_type', 'tenant', 'scope_id', v_other_org,
      'reason', 'transaction-only COD deny fixture'))), v_policy_version, 'COD native deny fixture');
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'access_control_policy:%';
  INSERT INTO public.shipments(id, organization_id, client_id, sender_id, service_type,
    tracking_number, client_reference_number, status, box_count, cod_amount, cod_currency, metadata)
  VALUES
    (v_pending, v_org, v_client, v_sender, 'delivery', 'COD-' || v_pending, 'CUSTOMER-ORDER', 'pending', 1, 100, 'SAR', '{}'),
    (v_recorded, v_org, v_client, v_sender, 'delivery', 'COD-' || v_recorded, NULL, 'pending', 1, 0, 'SAR',
      jsonb_build_object('delivery_completion', jsonb_build_object('payment_collection', v_snapshot))),
    (v_null, v_org, v_client, v_sender, 'delivery', 'COD-' || v_null, NULL, 'pending', 1, 0, 'SAR',
      '{"delivery_completion":{"payment_collection":null}}'),
    (v_scalar, v_org, v_client, v_sender, 'delivery', 'COD-' || v_scalar, NULL, 'pending', 1, 0, 'SAR',
      '{"delivery_completion":{"payment_collection":false}}'),
    (v_refused, v_org, v_client, v_sender, 'delivery', 'COD-' || v_refused, NULL, 'pending', 1, 100, 'SAR',
      '{"delivery_completion":{"payment_collection":{"expected_amount":100,"collected_amount":0,"variance_amount":100,"currency":"SAR","outcome":"refused"}}}'),
    (v_over, v_org, v_client, v_sender, 'delivery', 'COD-' || v_over, NULL, 'pending', 1, 100, 'SAR',
      '{"delivery_completion":{"payment_collection":{"expected_amount":100,"collected_amount":120,"variance_amount":-20,"currency":"SAR","outcome":"collected"}}}'),
    (v_sibling, v_org, v_sibling_client, v_sibling_sender, 'delivery', 'COD-' || v_sibling, NULL, 'pending', 1, 10, 'EUR', '{}'),
    (v_second, v_org, v_client, v_second_sender, 'delivery', 'COD-' || v_second, NULL, 'pending', 1, 10, 'SAR', '{}'),
    (v_ordinary, v_org, v_client, v_sender, 'delivery', 'COD-' || v_ordinary, NULL, 'pending', 1, 0, 'SAR', '{}'),
    (v_foreign, v_other_org, v_other_client, v_other_sender, 'delivery', 'COD-' || v_foreign, NULL, 'pending', 1, 25, 'EUR', '{}');
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is((SELECT count(*)::int FROM api.cod_reconciliation WHERE organization_id = v_org), 8,
    'positive COD and present snapshots survive, including amended-zero/malformed records');
  RETURN NEXT ok((SELECT NOT payment_collection_present AND payment_collection IS NULL
    FROM api.cod_reconciliation WHERE id = v_pending), 'pending COD has no fabricated collection');
  RETURN NEXT is((SELECT payment_collection FROM api.cod_reconciliation WHERE id = v_recorded),
    v_snapshot, 'recorded tuple is byte-semantic JSON intact despite different current amount/currency');
  RETURN NEXT ok((SELECT payment_collection_present AND payment_collection = 'null'::jsonb
    FROM api.cod_reconciliation WHERE id = v_null), 'explicit JSON null remains distinguishable from absent');
  RETURN NEXT ok((SELECT payment_collection_present AND payment_collection = 'false'::jsonb
    FROM api.cod_reconciliation WHERE id = v_scalar), 'malformed scalar is not hidden or coerced');
  RETURN NEXT is((SELECT order_reference FROM api.cod_reconciliation WHERE id = v_pending),
    'CUSTOMER-ORDER', 'customer reference precedes tracking and UUID');
  RETURN NEXT is((SELECT payment_collection FROM api.cod_reconciliation WHERE id = v_refused),
    '{"expected_amount":100,"collected_amount":0,"variance_amount":100,"currency":"SAR","outcome":"refused"}'::jsonb,
    'refused collection retains explicit zero and positive shortfall');
  RETURN NEXT is((SELECT payment_collection FROM api.cod_reconciliation WHERE id = v_over),
    '{"expected_amount":100,"collected_amount":120,"variance_amount":-20,"currency":"SAR","outcome":"collected"}'::jsonb,
    'overcollection retains negative canonical variance');
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  RETURN NEXT is((SELECT count(*)::int FROM api.cod_reconciliation WHERE id = v_ordinary), 0,
    'ordinary non-COD shipment without snapshot is excluded');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_reader::text, TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_reader)::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.user_has_resource_capability_v1('shipments', 'read'),
    'fixture reader has canonical shipment read capability');
  RETURN NEXT is((SELECT count(*)::int FROM api.cod_reconciliation WHERE id IN
    (v_pending,v_recorded,v_null,v_scalar,v_refused,v_over,v_sibling,v_second,v_ordinary,v_foreign)), 8,
    'authenticated projection isolates foreign tenant');
  v_list := api.ui_list_resource_v1('cod_reconciliation', '{}'::jsonb, 2, 0, NULL);
  RETURN NEXT ok((v_list->>'total')::int = 8 AND jsonb_array_length(v_list->'items') = 2,
    'real API registry list paginates after COD and tenant filtering with full row count');
  v_page2 := api.ui_list_resource_v1('cod_reconciliation', '{}'::jsonb, 2, 2, NULL);
  SELECT array_agg(id ORDER BY id) INTO v_ids
    FROM (SELECT id FROM api.cod_reconciliation ORDER BY id ASC LIMIT 2 OFFSET 2) expected;
  RETURN NEXT is((SELECT array_agg((value->>'id')::uuid ORDER BY ordinality)
    FROM jsonb_array_elements(v_page2->'items') WITH ORDINALITY), v_ids,
    'second page contains exact ordered next identities');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_list->'items') a
    JOIN jsonb_array_elements(v_page2->'items') b ON a->>'id' = b->>'id'),
    'pages do not overlap');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_client_reader::text, TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_client_reader)::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.user_has_resource_capability_v1('shipments', 'read'), 'client fixture has read capability');
  RETURN NEXT is((SELECT count(*)::int FROM api.cod_reconciliation WHERE organization_id = v_org), 7,
    'client reader excludes sibling client but includes both own senders');
  v_list := api.ui_list_resource_v1('cod_reconciliation', '{}'::jsonb, 2, 0, NULL);
  RETURN NEXT is((v_list->>'total')::int, 7, 'real API list applies client scope');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_sender_reader::text, TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_sender_reader)::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.user_has_resource_capability_v1('shipments', 'read'), 'sender fixture has read capability');
  RETURN NEXT is((SELECT count(*)::int FROM api.cod_reconciliation WHERE organization_id = v_org), 6,
    'sender reader excludes sibling sender and sibling client');
  v_list := api.ui_list_resource_v1('cod_reconciliation', '{}'::jsonb, 2, 0, NULL);
  RETURN NEXT is((v_list->>'total')::int, 6, 'real API list applies sender scope');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_denied::text, TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_denied)::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(NOT public.user_has_resource_capability_v1('shipments', 'read'),
    'explicit scoped deny overrides otherwise readable user type');
  RETURN NEXT is((SELECT count(*)::int FROM api.cod_reconciliation WHERE id = v_foreign), 0,
    'missing capability cannot read even own-tenant COD through direct API view');
  RETURN NEXT throws_ok(
    $sql$ SELECT api.ui_list_resource_v1('cod_reconciliation', '{}'::jsonb, 2, 0, NULL) $sql$,
    '42501', NULL, 'denied capability also fails closed through API registry RPC');
  EXECUTE 'SET LOCAL ROLE postgres';
END;
$test$;
SELECT * FROM pg_temp.test_cod_order_projection();
SELECT * FROM finish();
ROLLBACK;
