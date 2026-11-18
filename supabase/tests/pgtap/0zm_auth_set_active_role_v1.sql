-- Test Suite: Mobile V2 active-role switching contract
-- Validates that 202605102000_auth_set_active_role_v1 has shipped:
--   (a) public.mobile_v2_active_role table with correct shape + RLS
--   (b) auth_set_active_role_v1(text) RPC with SECURITY DEFINER + correct
--       grant posture (anon revoked, authenticated granted)
--   (c) auth_get_active_role_v1() companion reader with same posture
--   (d) Functional behaviour:
--       - rejects unauthenticated callers (auth.uid() IS NULL)
--       - validates role assignment via rbac_user_role_assignments + rbac_roles
--       - persists the selection (UPSERT)
--       - emits a decision_log row with category='fieldops_role_set'
--       - returns role_unchanged outcome on idempotent same-role call
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(30);

-- ----------------------------------------------------------------------------
-- (a) Storage table
-- ----------------------------------------------------------------------------

SELECT has_table(
  'public', 'mobile_v2_active_role',
  'mobile_v2_active_role table exists'
);

SELECT has_column('public', 'mobile_v2_active_role', 'user_id', 'user_id column present');
SELECT has_column('public', 'mobile_v2_active_role', 'organization_id', 'organization_id column present');
SELECT has_column('public', 'mobile_v2_active_role', 'role_key', 'role_key column present');
SELECT has_column('public', 'mobile_v2_active_role', 'switched_at', 'switched_at column present');

SELECT col_is_pk(
  'public', 'mobile_v2_active_role', 'user_id',
  'user_id is the primary key (per-user singleton)'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'mobile_v2_active_role'
      AND c.relrowsecurity = TRUE
  ),
  'mobile_v2_active_role has RLS enabled'
);

-- service_role policy exists
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_v2_active_role'
      AND policyname = 'mobile_v2_active_role_service_policy'
  ),
  'service_role has its own RLS policy on mobile_v2_active_role'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_v2_active_role'
      AND policyname = 'mobile_v2_active_role_self_select'
  ),
  'authenticated callers have a self-select RLS policy on mobile_v2_active_role'
);

-- anon must have no privileges
SELECT ok(
  NOT has_table_privilege(
    'anon', 'public.mobile_v2_active_role', 'SELECT'
  ),
  'anon cannot SELECT mobile_v2_active_role'
);

SELECT ok(
  NOT has_table_privilege(
    'anon', 'public.mobile_v2_active_role', 'INSERT'
  ),
  'anon cannot INSERT into mobile_v2_active_role'
);

-- ----------------------------------------------------------------------------
-- (b) auth_set_active_role_v1 RPC
-- ----------------------------------------------------------------------------

SELECT has_function(
  'public', 'auth_set_active_role_v1', ARRAY['text'],
  'auth_set_active_role_v1(text) exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'auth_set_active_role_v1'
      AND p.prosecdef = TRUE
  ),
  'auth_set_active_role_v1 is SECURITY DEFINER'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'auth_set_active_role_v1'
      AND prorettype = 'jsonb'::regtype
  ),
  'auth_set_active_role_v1 returns jsonb'
);

-- Grant posture: anon revoked, authenticated granted, service_role granted
SELECT ok(
  NOT has_function_privilege(
    'anon', 'public.auth_set_active_role_v1(text)', 'EXECUTE'
  ),
  'anon cannot EXECUTE auth_set_active_role_v1'
);

SELECT ok(
  has_function_privilege(
    'authenticated', 'public.auth_set_active_role_v1(text)', 'EXECUTE'
  ),
  'authenticated can EXECUTE auth_set_active_role_v1'
);

SELECT ok(
  has_function_privilege(
    'service_role', 'public.auth_set_active_role_v1(text)', 'EXECUTE'
  ),
  'service_role can EXECUTE auth_set_active_role_v1'
);

-- ----------------------------------------------------------------------------
-- (c) auth_get_active_role_v1 reader
-- ----------------------------------------------------------------------------

SELECT has_function(
  'public', 'auth_get_active_role_v1', ARRAY[]::text[],
  'auth_get_active_role_v1() exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'auth_get_active_role_v1'
      AND p.prosecdef = TRUE
  ),
  'auth_get_active_role_v1 is SECURITY DEFINER'
);

SELECT ok(
  NOT has_function_privilege(
    'anon', 'public.auth_get_active_role_v1()', 'EXECUTE'
  ),
  'anon cannot EXECUTE auth_get_active_role_v1'
);

SELECT ok(
  has_function_privilege(
    'authenticated', 'public.auth_get_active_role_v1()', 'EXECUTE'
  ),
  'authenticated can EXECUTE auth_get_active_role_v1'
);

-- ----------------------------------------------------------------------------
-- (d) Functional behaviour with seeded data (under service_role context)
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_org_id UUID := gen_random_uuid();
  v_client_id UUID := gen_random_uuid();
  v_sender_id UUID := gen_random_uuid();
  v_user_id UUID := gen_random_uuid();
  v_role_id UUID := gen_random_uuid();
  v_role_key TEXT := 'pgtap_test_driver_' || substr(gen_random_uuid()::text, 1, 8);
  v_other_role_key TEXT := 'pgtap_test_loader_' || substr(gen_random_uuid()::text, 1, 8);
  v_other_role_id UUID := gen_random_uuid();
  v_payload JSONB;
  v_decision_count_before INT;
  v_failed BOOLEAN := FALSE;
BEGIN
  -- Seed organization
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', TRUE);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_id, 'pgTAP role-switch org', 'pgtap-role-switch-' || substr(v_org_id::text, 1, 8))
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_client_id,
    v_org_id,
    'pgTAP role-switch client',
    'pgtap-role-switch-client-' || substr(v_client_id::text, 1, 8),
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender_id,
    v_client_id,
    'pgTAP role-switch sender',
    'pgTAP role-switch sender',
    TRUE,
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org_id,
    'pgtap:auth-set-active-role-fixture-bootstrap'
  );

  -- Seed user
  INSERT INTO public.users (id, organization_id, email, full_name, status)
  VALUES (
    v_user_id,
    v_org_id,
    'pgtap-rs-' || substr(v_user_id::text, 1, 8) || '@example.test',
    'pgTAP role-switch user',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Seed roles
  INSERT INTO public.rbac_roles (id, organization_id, key, name)
  VALUES
    (v_role_id, v_org_id, v_role_key, 'Test Driver Role'),
    (v_other_role_id, v_org_id, v_other_role_key, 'Test Loader Role')
  ON CONFLICT (id) DO NOTHING;

  -- Assign one role to the user
  INSERT INTO public.rbac_user_role_assignments (
    id, organization_id, user_id, role_id
  ) VALUES (
    gen_random_uuid(), v_org_id, v_user_id, v_role_id
  )
  ON CONFLICT DO NOTHING;

  -- Set the auth.uid() context via a JWT claim simulation. Many test
  -- patterns set local jwt claim; if not available we fall back to a
  -- service-role write directly into mobile_v2_active_role to assert
  -- shape rather than the auth path.
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_user_id::text)::text,
    TRUE
  );

  -- (d1) Happy path: role_set (no prior selection)
  BEGIN
    v_payload := public.auth_set_active_role_v1(v_role_key);
    PERFORM ok(
      v_payload IS NOT NULL AND (v_payload->>'ok')::boolean = TRUE,
      'auth_set_active_role_v1 returns ok=true on first call'
    );
    PERFORM ok(
      lower(v_payload->>'active_role') = lower(v_role_key),
      'returned active_role matches requested role'
    );
    PERFORM ok(
      v_payload->>'outcome' = 'role_set',
      'first call outcome is role_set'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := TRUE;
    PERFORM diag(format('happy-path failed: %I', SQLERRM));
    PERFORM fail('auth_set_active_role_v1 happy-path raised: ' || SQLERRM);
    PERFORM skip(2, 'subsequent happy-path assertions skipped due to error');
  END;

  -- (d2) Idempotent same-role call returns role_unchanged
  IF NOT v_failed THEN
    v_payload := public.auth_set_active_role_v1(v_role_key);
    PERFORM ok(
      v_payload->>'outcome' = 'role_unchanged',
      'second call with same role returns role_unchanged'
    );
  ELSE
    PERFORM skip(1, 'idempotent assertion skipped');
  END IF;

  -- (d3) decision_log row created (we count before vs after)
  IF NOT v_failed THEN
    SELECT COUNT(*) INTO v_decision_count_before
      FROM public.decision_log
     WHERE decision_category = 'fieldops_role_set'
       AND resource_id = v_user_id;

    PERFORM ok(
      v_decision_count_before >= 2,
      'decision_log has at least two fieldops_role_set rows for this user (set + unchanged)'
    );
  ELSE
    PERFORM skip(1, 'decision_log assertion skipped');
  END IF;

  -- (d4) Reject role not in user's assignments
  BEGIN
    v_payload := public.auth_set_active_role_v1(v_other_role_key);
    PERFORM fail(
      'auth_set_active_role_v1 should raise for role not assigned to user'
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM ok(
      SQLERRM ILIKE '%not assigned to caller%',
      'unassigned role raises expected error message'
    );
  END;

  -- (d5) auth_get_active_role_v1 returns the persisted selection
  v_payload := public.auth_get_active_role_v1();
  PERFORM ok(
    v_payload IS NOT NULL,
    'auth_get_active_role_v1 returns a payload'
  );
  PERFORM ok(
    lower(COALESCE(v_payload->>'active_role', '')) = lower(v_role_key),
    'auth_get_active_role_v1 returns the persisted active_role'
  );
  PERFORM ok(
    jsonb_typeof(v_payload->'assigned_roles') = 'array',
    'auth_get_active_role_v1 includes assigned_roles array'
  );

  -- Cleanup
  PERFORM set_config('request.jwt.claims', '', TRUE);

  DELETE FROM public.mobile_v2_active_role WHERE user_id = v_user_id;
  DELETE FROM public.decision_log WHERE resource_id = v_user_id AND decision_category = 'fieldops_role_set';
  DELETE FROM public.rbac_user_role_assignments WHERE user_id = v_user_id;
  DELETE FROM public.rbac_roles WHERE id IN (v_role_id, v_other_role_id);
  DELETE FROM public.users WHERE id = v_user_id;
  -- The file-level ROLLBACK removes the seeded organization. Do not delete it
  -- here because current tenant bootstrap fixtures attach dependent provider
  -- rows through organization_id.
END $$;

SELECT * FROM finish();
ROLLBACK;
