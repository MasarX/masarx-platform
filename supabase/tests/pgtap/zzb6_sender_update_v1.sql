-- pgTAP: public.sender_update_v1 contract (allowed/denied/no-op/status-forbidden)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b704';
  v_ops UUID := '00000000-0000-0000-0000-00000000b741';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b742';
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Sen Update Org', 'b6-sen-upd-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-sen-upd-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Sen Upd Ops', 'ops_admin', 'tenant', NULL),
    (v_sender_user, v_org, 'b6-sen-upd-su-' || left(v_sender_user::text, 8) || '@example.com',
     'B6 Sen Upd SU', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B6 Sen Upd Client', 'b6-sen-upd-cli-' || left(v_client::text, 8), 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
  VALUES (v_sender, v_client, 'B6 Sen Upd', 'B6 Brand', false, true, 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_sen_upd_org', v_org::text, true);
  PERFORM set_config('test.b6_sen_upd_ops', v_ops::text, true);
  PERFORM set_config('test.b6_sen_upd_su', v_sender_user::text, true);
  PERFORM set_config('test.b6_sen_upd_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin updates editable fields
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_sen_upd_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.sender_update_v1(jsonb_build_object(
      'sender_id', current_setting('test.b6_sen_upd_sender'),
      'name', 'B6 Sen Upd v2',
      'brand_name', 'B6 Brand v2'
    ))->>'ok')::bool
  ),
  'ops_admin can sender_update_v1'
);
RESET ROLE;

-- 2) Denied: non-admin user lacks senders.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_sen_upd_su'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.sender_update_v1(jsonb_build_object(
       'sender_id', current_setting('test.b6_sen_upd_sender'),
       'name', 'denied'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied sender_update_v1'
);
RESET ROLE;

-- 3) Status edit explicitly forbidden (lifecycle SSOT owned by suspend/reactivate)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_sen_upd_ops'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.sender_update_v1(jsonb_build_object(
       'sender_id', current_setting('test.b6_sen_upd_sender'),
       'status', 'inactive'
     )) $$,
  '42P01',
  NULL,
  'sender_update_v1 forbids status mutation (use suspend/reactivate)'
);
RESET ROLE;

-- 4) No-op idempotence: empty patch returns idempotent_no_op=true
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_sen_upd_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.sender_update_v1(jsonb_build_object(
      'sender_id', current_setting('test.b6_sen_upd_sender')
    ))->>'idempotent_no_op')::bool
  ),
  'sender_update_v1 no-op flagged idempotent_no_op=true'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
