-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S95
-- pgTAP: SaaS usage metering (usage_events) + entitlements policy (RLS + RBAC + RPC)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

CREATE OR REPLACE FUNCTION test_saas_usage_metering_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := gen_random_uuid();
  v_org2 UUID := gen_random_uuid();
  v_user1 UUID := gen_random_uuid();
  v_user2 UUID := gen_random_uuid();

  v_usage_id UUID;
  v_usage_id2 UUID;
  v_created1 BOOLEAN;
  v_created2 BOOLEAN;

  v_perm_usage_read UUID;
  v_role_usage1 UUID;
BEGIN
  -- Schema objects exist
  RETURN NEXT has_table('public', 'usage_events', 'usage_events table exists');
  RETURN NEXT has_table('public', 'usage_event_dedupe', 'usage_event_dedupe table exists');

  -- Partitioned ledgers are service-only; authenticated read is via RPC.
  RETURN NEXT ok(to_regclass('api.usage_events') IS NULL, 'api.usage_events view is not present (service-only ledger)');
  RETURN NEXT ok(NOT has_table_privilege('authenticated', 'public.usage_events', 'select'), 'authenticated has no SELECT on usage_events (service-only)');
  RETURN NEXT ok(NOT has_table_privilege('anon', 'public.usage_events', 'select'), 'anon has no SELECT on usage_events (service-only)');

  -- RLS enabled + policies exist
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'usage_events'), 'RLS enabled on usage_events');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'usage_event_dedupe'), 'RLS enabled on usage_event_dedupe');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'usage_events'), 'usage_events has policies');

  -- Contracts/config
  RETURN NEXT ok(
    EXISTS(
      SELECT 1 FROM public.table_contracts
      WHERE table_schema = 'public' AND table_name = 'usage_events' AND audit_enabled = FALSE AND updated_at_required = FALSE
    ),
    'table_contracts: usage_events disables audit + updated_at'
  );

  RETURN NEXT ok(
    EXISTS(
      SELECT 1 FROM public.partitioning_config
      WHERE table_name = 'usage_events' AND partition_strategy = 'HASH+RANGE'
    ),
    'partitioning_config: usage_events is registered'
  );

  RETURN NEXT ok(
    EXISTS(
      SELECT 1 FROM public.lookup_column_contracts
      WHERE table_schema = 'public' AND table_name = 'usage_events' AND column_name = 'metric_key' AND lookup_category = 'usage_metric'
    ),
    'lookup_column_contracts: usage_events.metric_key enforced via usage_metric'
  );

  RETURN NEXT ok(
    EXISTS(
      SELECT 1 FROM public.settings_category_registry
      WHERE category = 'saas_entitlements_policy' AND requires_global_default IS TRUE
    ),
    'settings_category_registry: saas_entitlements_policy registered (requires global default)'
  );

  RETURN NEXT ok(
    EXISTS(
      SELECT 1 FROM public.schema_registry
      WHERE category = 'saas_entitlements_policy' AND is_active IS TRUE
    ),
    'schema_registry: saas_entitlements_policy schema is active'
  );

  RETURN NEXT ok(
    has_function_privilege('service_role', 'public.record_usage_event_v1(jsonb)', 'execute'),
    'service_role can EXECUTE record_usage_event_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege('authenticated', 'public.record_usage_event_v1(jsonb)', 'execute'),
    'authenticated cannot EXECUTE record_usage_event_v1'
  );
  RETURN NEXT ok(
    to_regprocedure('public.list_usage_events_v1(uuid,text,timestamptz,timestamptz,int,int)') IS NOT NULL,
    'list_usage_events_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'public.list_usage_events_v1(uuid,text,timestamptz,timestamptz,int,int)', 'execute'),
    'authenticated can EXECUTE list_usage_events_v1'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  -- Orgs + users (tenant scope)
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org1, 'Usage Org 1', 'usage-org-' || left(v_org1::text, 8)),
    (v_org2, 'Usage Org 2', 'usage-org-' || left(v_org2::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name)
  VALUES
    (v_user1, v_org1, 'usage-u1-' || left(v_user1::text, 8) || '@example.com', 'Usage User 1'),
    (v_user2, v_org2, 'usage-u2-' || left(v_user2::text, 8) || '@example.com', 'Usage User 2');

  -- Record usage (service-only RPC is the write path)
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT usage_event_id, created
    INTO v_usage_id, v_created1
  FROM public.record_usage_event_v1(
    jsonb_build_object(
      'organization_id', v_org1,
      'metric_key', 'shipments.created',
      'quantity', 1,
      'unit', 'count',
      'subject_type', 'shipment',
      'subject_id', gen_random_uuid(),
      'idempotency_key', 'pgtap-usage-1'
    )
  );

  RETURN NEXT ok(v_usage_id IS NOT NULL, 'record_usage_event_v1 returns an id');

  SELECT usage_event_id, created
    INTO v_usage_id2, v_created2
  FROM public.record_usage_event_v1(
    jsonb_build_object(
      'organization_id', v_org1,
      'metric_key', 'shipments.created',
      'quantity', 1,
      'unit', 'count',
      'subject_type', 'shipment',
      'subject_id', gen_random_uuid(),
      'idempotency_key', 'pgtap-usage-1'
    )
  );

  RETURN NEXT is(v_usage_id2, v_usage_id, 'idempotency returns same usage_event_id');
  RETURN NEXT is(v_created2, FALSE, 'idempotency returns created=FALSE');
  RETURN NEXT is((SELECT COUNT(*)::int FROM public.usage_events WHERE id = v_usage_id), 1, 'only one usage_events row exists for idempotency key');

  -- user1: authenticated without usage.read => cannot see usage
  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format($$ SELECT count(*) FROM public.list_usage_events_v1('%s'::uuid) $$, v_org1::text),
    '42501',
    'list_usage_events_v1 requires usage.read'
  );

  -- Grant usage.read to user1 via RBAC role
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT lv.id
    INTO v_perm_usage_read
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value = 'usage.read'
   LIMIT 1;

  INSERT INTO public.rbac_roles (organization_id, key, name, metadata)
  VALUES (v_org1, 'usage', 'Usage', jsonb_build_object('source', 'pgtap'))
  RETURNING id INTO v_role_usage1;

  INSERT INTO public.rbac_role_permissions (organization_id, role_id, permission_id, metadata)
  VALUES (v_org1, v_role_usage1, v_perm_usage_read, jsonb_build_object('source', 'pgtap'));

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, metadata)
  VALUES (v_org1, v_user1, v_role_usage1, jsonb_build_object('source', 'pgtap'));

  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is((SELECT COUNT(*)::INT FROM public.list_usage_events_v1(v_org1)), 1, 'user1 with usage.read sees usage events');

  -- user2 cannot see org1 data
  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format($$ SELECT count(*) FROM public.list_usage_events_v1('%s'::uuid) $$, v_org1::text),
    '42501',
    'list_usage_events_v1 organization mismatch'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_saas_usage_metering_v1();

SELECT * FROM finish();

ROLLBACK;
