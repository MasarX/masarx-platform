-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Ops sessions v1 (ops_sessions + ops_session_events + idempotent RPCs)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

CREATE OR REPLACE FUNCTION pg_temp.test_ops_sessions_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();

  v_user UUID := gen_random_uuid();
  v_device RECORD;

  v_sess1 RECORD;
  v_sess2 RECORD;
  v_driver_sess RECORD;
  v_driver_close RECORD;
  v_driver_readback JSONB;
  v_driver_closed_readback JSONB;

  v_tr1 RECORD;
  v_tr2 RECORD;
BEGIN
  RETURN NEXT has_table('public', 'ops_sessions', 'ops_sessions table exists');
  RETURN NEXT has_table('public', 'ops_session_events', 'ops_session_events table exists');

  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ops_sessions'), 'RLS enabled on ops_sessions');
  RETURN NEXT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ops_session_events'), 'RLS enabled on ops_session_events');

  RETURN NEXT has_function('public', 'open_ops_session_v1', ARRAY['jsonb'], 'open_ops_session_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'transition_ops_session_v1', ARRAY['jsonb'], 'transition_ops_session_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'open_ops_session_v1', ARRAY['jsonb'], 'api.open_ops_session_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'transition_ops_session_v1', ARRAY['jsonb'], 'api.transition_ops_session_v1(jsonb) exists');

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'ops_sessions'),
    'ops_sessions registered in table_contracts'
  );
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.table_contracts tc WHERE tc.table_schema = 'public' AND tc.table_name = 'ops_session_events'),
    'ops_session_events registered in table_contracts'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Ops Session Org', 'ops-sess-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'ops-br-' || left(v_branch::text, 8), 'Ops Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'ops-u-' || left(v_user::text, 8) || '@example.com', 'Ops User', 'tenant');

  -- RBAC: device + ops session RPCs are permission-gated; grant warehouse_operator to the actor.
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['warehouse_operator'], v_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'warehouse_operator'
  ON CONFLICT DO NOTHING;

  -- Simulate tenant authenticated context for device/session RPCs.
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT * INTO v_device
  FROM public.register_user_device_v1(
    jsonb_build_object(
      'device_platform', 'android',
      'device_identifier_sha256', 'pgtap-ops-session-device-1'
    )
  )
  LIMIT 1;

  SELECT * INTO v_sess1
  FROM public.open_ops_session_v1(
    jsonb_build_object(
      'session_type', 'warehouse_scan',
      'branch_id', v_branch,
      'device_id', v_device.device_id,
      'idempotency_key', 'pgtap-ops-session-1',
      'opened_at', now()
    )
  )
  LIMIT 1;

  SELECT * INTO v_sess2
  FROM public.open_ops_session_v1(
    jsonb_build_object(
      'session_type', 'warehouse_scan',
      'branch_id', v_branch,
      'device_id', v_device.device_id,
      'idempotency_key', 'pgtap-ops-session-1',
      'opened_at', now()
    )
  )
  LIMIT 1;

  RETURN NEXT ok(v_sess1.created IS TRUE, 'open_ops_session_v1 created=true');
  RETURN NEXT ok(v_sess2.created IS FALSE, 'open_ops_session_v1 replay created=false');
  RETURN NEXT is(v_sess1.ops_session_id::text, v_sess2.ops_session_id::text, 'open_ops_session_v1 returns same ops_session_id on replay');

  SELECT * INTO v_driver_sess
  FROM public.open_ops_session_v1(
    jsonb_build_object(
      'session_type', 'driver_shift',
      'device_id', v_device.device_id,
      'idempotency_key', 'pgtap-driver-shift-readback-1',
      'opened_at', now()
    )
  )
  LIMIT 1;

  v_driver_readback := api.ui_get_resource_v1('ops_sessions', v_driver_sess.ops_session_id);

  RETURN NEXT is(v_driver_readback->>'session_type', 'driver_shift', 'api.ui_get_resource_v1 reads driver_shift ops session');
  EXECUTE 'RESET ROLE';
  RETURN NEXT ok(
    NOT (v_driver_readback ? 'device_id')
      AND EXISTS (SELECT 1 FROM public.ops_sessions
                   WHERE id = v_driver_sess.ops_session_id AND device_id = v_device.device_id),
    'driver shift retains its device binding outside the generic read projection'
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT * INTO v_tr1
  FROM public.transition_ops_session_v1(
    jsonb_build_object(
      'ops_session_id', v_sess1.ops_session_id,
      'to_status', 'closed',
      'idempotency_key', 'pgtap-ops-session-close-1',
      'set_closed_at', TRUE,
      'effective_at', now()
    )
  )
  LIMIT 1;

  SELECT * INTO v_tr2
  FROM public.transition_ops_session_v1(
    jsonb_build_object(
      'ops_session_id', v_sess1.ops_session_id,
      'to_status', 'closed',
      'idempotency_key', 'pgtap-ops-session-close-1',
      'set_closed_at', TRUE,
      'effective_at', now()
    )
  )
  LIMIT 1;

  RETURN NEXT ok(v_tr1.updated IS TRUE, 'transition_ops_session_v1 updated=true');
  RETURN NEXT ok(v_tr2.updated IS FALSE, 'transition_ops_session_v1 replay updated=false');
  RETURN NEXT is(v_tr1.session_version::text, v_tr2.session_version::text, 'transition_ops_session_v1 returns same session_version on replay');

  SELECT * INTO v_driver_close
  FROM public.transition_ops_session_v1(
    jsonb_build_object(
      'ops_session_id', v_driver_sess.ops_session_id,
      'to_status', 'closed',
      'idempotency_key', 'pgtap-driver-shift-readback-close-1',
      'set_closed_at', TRUE,
      'effective_at', now()
    )
  )
  LIMIT 1;

  v_driver_closed_readback := api.ui_get_resource_v1('ops_sessions', v_driver_sess.ops_session_id);

  RETURN NEXT is(v_driver_closed_readback->>'status', 'closed', 'api.ui_get_resource_v1 reads closed driver shift state');
  RETURN NEXT ok((v_driver_closed_readback->>'closed_at') IS NOT NULL, 'api.ui_get_resource_v1 reads driver shift closed_at');

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT s.status FROM public.ops_sessions s WHERE s.organization_id = v_org AND s.id = v_sess1.ops_session_id LIMIT 1),
    'closed',
    'ops_sessions.status updated to closed'
  );

  RETURN NEXT ok(
    (SELECT s.closed_at IS NOT NULL FROM public.ops_sessions s WHERE s.organization_id = v_org AND s.id = v_sess1.ops_session_id LIMIT 1),
    'ops_sessions.closed_at set when set_closed_at=true'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.ops_session_events e WHERE e.organization_id = v_org AND e.ops_session_id = v_sess1.ops_session_id),
    2,
    'ops_session_events has opened + status_transition'
  );

  RETURN NEXT is(
    (SELECT MAX(e.session_version)::int FROM public.ops_session_events e WHERE e.organization_id = v_org AND e.ops_session_id = v_sess1.ops_session_id),
    2,
    'ops_session_events session_version increments'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_ops_sessions_v1();

SELECT * FROM finish();

ROLLBACK;
