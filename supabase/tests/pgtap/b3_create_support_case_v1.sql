-- Plan: frontend-design / Phase B / Subagent B3
-- pgTAP: create_support_case_v1 — capability gate + RLS + ladder + canonical envelope
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org_a UUID := gen_random_uuid();
  v_org_b UUID := gen_random_uuid();
  v_user_ops UUID := gen_random_uuid();   -- ops_admin in org A (has support.write)
  v_user_client UUID := gen_random_uuid(); -- client_admin in org A (no support.write)
  v_user_ops_b UUID := gen_random_uuid(); -- ops_admin in org B (cross-tenant guard)
  v_client_a UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES
    (v_org_a, 'B3 Support Org A', 'b3-support-' || left(v_org_a::text, 8)),
    (v_org_b, 'B3 Support Org B', 'b3-support-' || left(v_org_b::text, 8));

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES
    (v_client_a, v_org_a, 'B3 Support Client A', 'b3-support-client-' || left(v_client_a::text, 8), 'active');

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_user_ops, v_org_a, 'ops-' || left(v_user_ops::text, 8) || '@example.com', 'Ops User', 'ops_admin', 'tenant', NULL),
    (v_user_client, v_org_a, 'client-' || left(v_user_client::text, 8) || '@example.com', 'Client User', 'client_admin', 'client', v_client_a),
    (v_user_ops_b, v_org_b, 'ops-' || left(v_user_ops_b::text, 8) || '@example.com', 'Ops B', 'ops_admin', 'tenant', NULL);

  PERFORM set_config('test.b3_org_a', v_org_a::text, true);
  PERFORM set_config('test.b3_org_b', v_org_b::text, true);
  PERFORM set_config('test.b3_user_ops', v_user_ops::text, true);
  PERFORM set_config('test.b3_user_client', v_user_client::text, true);
  PERFORM set_config('test.b3_user_ops_b', v_user_ops_b::text, true);
  PERFORM set_config('test.b3_client_a', v_client_a::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- Test 1: ops_admin (has support.write) can create case → canonical envelope
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(
  COALESCE(
    (public.create_support_case_v1(
      jsonb_build_object(
        'organization_id', current_setting('test.b3_org_a')::uuid,
        'client_id', current_setting('test.b3_client_a')::uuid,
        'subject', 'B3 test case',
        'priority', 'high',
        'channel', 'email',
        'sla_minutes', 60,
        'idempotency_key', 'b3-create-test-1'
      )
    )->>'ok')::boolean,
    FALSE
  ),
  'ops_admin can create_support_case_v1 (capability gate allows; envelope.ok=true)'
);
RESET ROLE;

-- Test 2: client_admin (no support.write) is denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_client'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_client'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.create_support_case_v1(
       jsonb_build_object(
         'organization_id', current_setting('test.b3_org_a')::uuid,
         'subject', 'B3 denied'
       )
     ) $$,
  '42501',
  NULL,
  'client_admin denied: capability_denied (support.write missing)'
);
RESET ROLE;

-- Test 3: idempotency — repeat create with same key returns same support_case_id
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (public.create_support_case_v1(
    jsonb_build_object(
      'organization_id', current_setting('test.b3_org_a')::uuid,
      'client_id', current_setting('test.b3_client_a')::uuid,
      'subject', 'B3 idem',
      'idempotency_key', 'b3-create-test-1'
    )
  )->>'already_processed')::boolean,
  TRUE,
  'create_support_case_v1 short-circuits when idempotency_key already used'
);
RESET ROLE;

-- Test 4: cross-tenant guard — ops_admin in org B cannot create case targeting org A
SELECT set_config('request.jwt.claim.sub', current_setting('test.b3_user_ops_b'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.b3_user_ops_b'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.create_support_case_v1(
       jsonb_build_object(
         'organization_id', current_setting('test.b3_org_a')::uuid,
         'subject', 'cross-tenant'
       )
     ) $$,
  '42501',
  NULL,
  'cross-tenant create blocked (cannot target another organization)'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
