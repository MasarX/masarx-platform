-- pgTAP: public.request_capability_grant_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000be01';
  v_ops UUID := '00000000-0000-0000-0000-00000000be11';
  v_sender UUID := '00000000-0000-0000-0000-00000000be12';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B1 Grant Org', 'b1-grant-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  -- ops_admin has access_policy.request via global access_control_policy
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b1-grant-ops-' || left(v_ops::text, 8) || '@example.com', 'B1 Grant Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b1-grant-sender-' || left(v_sender::text, 8) || '@example.com', 'B1 Grant Sender', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b1_grant_ops', v_ops::text, true);
  PERFORM set_config('test.b1_grant_sender', v_sender::text, true);
  PERFORM set_config('test.b1_grant_org', v_org::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can request capability grant
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_grant_ops'), true);
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE tmp_b1_grant_allowed_response AS
SELECT public.request_capability_grant_v1(jsonb_build_object(
    'capability_key', 'shipments.write',
    'scope_type', 'tenant',
    'scope_id', current_setting('test.b1_grant_org'),
    'duration_hours', 4,
    'reason', 'pgtap grant request test'
  )) AS body;
SELECT ok(
  (SELECT (body->>'ok')::bool FROM tmp_b1_grant_allowed_response),
  'ops_admin can request_capability_grant_v1 (access_policy.request capability)'
);
SELECT is(
  (SELECT body #>> '{request_readback,capability_key}' FROM tmp_b1_grant_allowed_response),
  'shipments.write',
  'request_capability_grant_v1 returns capability from persisted request row'
);
SELECT is(
  (SELECT body #>> '{request_readback,reason}' FROM tmp_b1_grant_allowed_response),
  'pgtap grant request test',
  'request_capability_grant_v1 returns reason from persisted request row'
);
SELECT is(
  (SELECT (body #>> '{request_readback,duration_hours}')::int FROM tmp_b1_grant_allowed_response),
  4,
  'request_capability_grant_v1 stores and returns requested duration metadata'
);
SELECT is(
  (SELECT body #>> '{request_readback,scope_id}' FROM tmp_b1_grant_allowed_response),
  current_setting('test.b1_grant_org'),
  'request_capability_grant_v1 returns scope from persisted request row'
);
SELECT is(
  (SELECT body->>'capability_grant_request_id' FROM tmp_b1_grant_allowed_response),
  (SELECT body #>> '{request_readback,id}' FROM tmp_b1_grant_allowed_response),
  'request_capability_grant_v1 top-level request id matches persisted request readback id'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.request_capability_grant_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.request_capability_grant_v1'
);
SELECT is(
  (SELECT api.request_capability_grant_v1(jsonb_build_object(
    'capability_key', 'audit_log.read',
    'scope_type', 'tenant',
    'scope_id', current_setting('test.b1_grant_org'),
    'duration_hours', 2,
    'reason', 'pgtap api grant request test'
  )) #>> '{request_readback,reason}'),
  'pgtap api grant request test',
  'api.request_capability_grant_v1 returns persisted request readback'
);
RESET ROLE;

-- 2) Denied: sender_user lacks access_policy.request
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_grant_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.request_capability_grant_v1(jsonb_build_object(
       'capability_key', 'shipments.write',
       'scope_type', 'tenant',
       'reason', 'pgtap denied'
     )) $$,
  '42501',
  NULL,
  'non-ops user denied request_capability_grant_v1'
);
RESET ROLE;

-- 3) Idempotency: second pending request collapses to existing
SELECT set_config('request.jwt.claim.sub', current_setting('test.b1_grant_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (SELECT (public.request_capability_grant_v1(jsonb_build_object(
    'capability_key', 'shipments.write',
    'scope_type', 'tenant',
    'scope_id', current_setting('test.b1_grant_org'),
    'reason', 'pgtap idempotent attempt'
  ))->>'idempotent')::bool),
  'request_capability_grant_v1 second pending duplicate is idempotent'
);
SELECT is(
  (SELECT public.request_capability_grant_v1(jsonb_build_object(
    'capability_key', 'shipments.write',
    'scope_type', 'tenant',
    'scope_id', current_setting('test.b1_grant_org'),
    'reason', 'pgtap idempotent readback'
  )) #>> '{request_readback,reason}'),
  'pgtap grant request test',
  'request_capability_grant_v1 idempotent response returns existing persisted request row'
);
RESET ROLE;

-- 4) RLS isolation: capability_grant_requests is now an authenticated,
-- RLS-backed review queue so approvers can inspect pending rows in Console V2.
SELECT ok(
  has_table_privilege('authenticated', 'public.capability_grant_requests', 'select'),
  'authenticated can SELECT capability_grant_requests through the RLS-backed review queue'
);

SELECT * FROM finish();
ROLLBACK;
