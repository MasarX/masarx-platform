-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Bank accounts SSOT + bank statement ingestion RPC (service-only; idempotent)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(27);

CREATE OR REPLACE FUNCTION pg_temp.test_bank_accounts_and_bank_statement_ingest_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_org2 UUID := gen_random_uuid();

  v_user UUID := gen_random_uuid();
  v_user2 UUID := gen_random_uuid();

  v_bank_account_id UUID := gen_random_uuid();
  v_bank_account_id2 UUID := gen_random_uuid();

  v_finance_event_id UUID;
  v_created BOOLEAN;
  v_decision_id UUID;

  v_finance_event_id_2 UUID;
  v_created_2 BOOLEAN;

  v_perm_finance_read UUID;
  v_role_finance UUID;
  v_role_finance2 UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_table('public', 'bank_accounts', 'bank_accounts table exists');
  RETURN NEXT has_column('public', 'bank_accounts', 'organization_id', 'bank_accounts.organization_id exists');
  RETURN NEXT has_column('public', 'bank_accounts', 'key', 'bank_accounts.key exists');
  RETURN NEXT has_column('public', 'bank_accounts', 'currency', 'bank_accounts.currency exists');
  RETURN NEXT has_column('public', 'bank_accounts', 'is_active', 'bank_accounts.is_active exists');
  RETURN NEXT has_column('public', 'bank_accounts', 'metadata', 'bank_accounts.metadata exists');

  RETURN NEXT ok(
    (SELECT c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'bank_accounts'),
    'bank_accounts has RLS enabled'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'bank_accounts'
        AND policyname = 'bank_accounts_authenticated_select'
    ),
    'bank_accounts_authenticated_select policy exists'
  );

  RETURN NEXT ok(
    has_table_privilege('authenticated', 'public.bank_accounts', 'SELECT'),
    'authenticated has SELECT on bank_accounts'
  );
  RETURN NEXT ok(
    has_table_privilege('service_role', 'public.bank_accounts', 'INSERT'),
    'service_role has INSERT on bank_accounts'
  );
  RETURN NEXT ok(
    NOT has_table_privilege('authenticated', 'public.bank_accounts', 'INSERT'),
    'authenticated has no INSERT on bank_accounts (service-only writes)'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
      WHERE ld.category = 'finance_event_type'
        AND lv.value = 'bank_statement'
        AND lv.status = 'active'
    ),
    'lookup has finance_event_type=bank_statement'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
      WHERE ld.category = 'finance_account_type'
        AND lv.value = 'bank_account'
        AND lv.status = 'active'
    ),
    'lookup has finance_account_type=bank_account'
  );

  RETURN NEXT ok(
    has_function_privilege('service_role', 'public.record_bank_statement_event_v1(jsonb)', 'EXECUTE'),
    'service_role can execute record_bank_statement_event_v1'
  );
  RETURN NEXT ok(
    NOT has_function_privilege('authenticated', 'public.record_bank_statement_event_v1(jsonb)', 'EXECUTE'),
    'authenticated cannot execute record_bank_statement_event_v1'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Bank Accounts Org', 'bank-accounts-' || left(v_org::text, 8)),
    (v_org2, 'Bank Accounts Org2', 'bank-accounts-' || left(v_org2::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_user, v_org, 'u-' || left(v_user::text, 8) || '@example.com', 'User ' || left(v_user::text, 8), 'tenant'),
    (v_user2, v_org2, 'u-' || left(v_user2::text, 8) || '@example.com', 'User ' || left(v_user2::text, 8), 'tenant');

  INSERT INTO public.bank_accounts (id, organization_id, key, name, bank_name, currency, is_active, metadata)
  VALUES
    (v_bank_account_id, v_org, 'main', 'Main', 'Test Bank', 'SAR', TRUE, jsonb_build_object('source', 'pgtap')),
    (v_bank_account_id2, v_org2, 'main', 'Main2', 'Test Bank', 'SAR', TRUE, jsonb_build_object('source', 'pgtap'));

  -- RLS (RBAC gated): user must also have finance.read.
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.bank_accounts),
    0,
    'authenticated without finance.read cannot read bank_accounts'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.bank_accounts),
    0,
    'authenticated (other org) without finance.read cannot read bank_accounts'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT lv.id
    INTO v_perm_finance_read
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value = 'finance.read'
   LIMIT 1;

  INSERT INTO public.rbac_roles (organization_id, key, name, metadata)
  VALUES (v_org, 'finance', 'Finance', jsonb_build_object('source', 'pgtap'))
  ON CONFLICT (organization_id, key) DO UPDATE
    SET name = EXCLUDED.name,
        metadata = COALESCE(public.rbac_roles.metadata, '{}'::jsonb) || EXCLUDED.metadata
  RETURNING id INTO v_role_finance;

  INSERT INTO public.rbac_role_permissions (organization_id, role_id, permission_id, metadata)
  VALUES (v_org, v_role_finance, v_perm_finance_read, jsonb_build_object('source', 'pgtap'))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, metadata)
  VALUES (v_org, v_user, v_role_finance, jsonb_build_object('source', 'pgtap'))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_roles (organization_id, key, name, metadata)
  VALUES (v_org2, 'finance', 'Finance', jsonb_build_object('source', 'pgtap'))
  ON CONFLICT (organization_id, key) DO UPDATE
    SET name = EXCLUDED.name,
        metadata = COALESCE(public.rbac_roles.metadata, '{}'::jsonb) || EXCLUDED.metadata
  RETURNING id INTO v_role_finance2;

  INSERT INTO public.rbac_role_permissions (organization_id, role_id, permission_id, metadata)
  VALUES (v_org2, v_role_finance2, v_perm_finance_read, jsonb_build_object('source', 'pgtap'))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, metadata)
  VALUES (v_org2, v_user2, v_role_finance2, jsonb_build_object('source', 'pgtap'))
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.bank_accounts),
    1,
    'authenticated with finance.read sees own org bank_accounts'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.bank_accounts),
    1,
    'authenticated (other org) with finance.read sees own org bank_accounts'
  );

  -- Service-only RPC: record bank statement event (idempotent via finance_event_dedupe).
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT finance_event_id, created, decision_log_id
    INTO v_finance_event_id, v_created, v_decision_id
    FROM public.record_bank_statement_event_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'bank_account_key', 'main',
        'event_type', 'bank_statement',
        'direction', 'in',
        'amount', 123.45,
        'currency', 'SAR',
        'idempotency_key', 'pgtap-bank-statement-1',
        'metadata', jsonb_build_object('note', 'test')
      )
    )
   LIMIT 1;

  RETURN NEXT ok(v_finance_event_id IS NOT NULL, 'record_bank_statement_event_v1 returns finance_event_id');
  RETURN NEXT is(v_created, TRUE, 'record_bank_statement_event_v1 created=TRUE on first call');
  RETURN NEXT ok(v_decision_id IS NOT NULL, 'record_bank_statement_event_v1 returns decision_log_id');

  RETURN NEXT is(
    (SELECT event_type FROM public.finance_events WHERE id = v_finance_event_id ORDER BY occurred_at DESC LIMIT 1),
    'bank_statement',
    'finance_events row has event_type=bank_statement'
  );
  RETURN NEXT is(
    (SELECT account_type FROM public.finance_events WHERE id = v_finance_event_id ORDER BY occurred_at DESC LIMIT 1),
    'bank_account',
    'finance_events row has account_type=bank_account'
  );
  RETURN NEXT is(
    (SELECT account_id FROM public.finance_events WHERE id = v_finance_event_id ORDER BY occurred_at DESC LIMIT 1),
    v_bank_account_id,
    'finance_events row account_id matches bank_account'
  );

  SELECT finance_event_id, created
    INTO v_finance_event_id_2, v_created_2
    FROM public.record_bank_statement_event_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'bank_account_key', 'main',
        'event_type', 'bank_statement',
        'direction', 'in',
        'amount', 123.45,
        'currency', 'SAR',
        'idempotency_key', 'pgtap-bank-statement-1',
        'metadata', jsonb_build_object('note', 'test')
      )
    )
   LIMIT 1;

  RETURN NEXT is(v_finance_event_id_2, v_finance_event_id, 'idempotency returns same finance_event_id');
  RETURN NEXT is(v_created_2, FALSE, 'idempotency returns created=FALSE on replay');

  RETURN;
END;
$$;

SELECT * FROM pg_temp.test_bank_accounts_and_bank_statement_ingest_v1();

SELECT * FROM finish();

ROLLBACK;
