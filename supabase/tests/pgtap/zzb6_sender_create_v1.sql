-- pgTAP: public.sender_create_v1 contract (allowed/denied/RLS/decision_log)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b703';
  v_ops UUID := '00000000-0000-0000-0000-00000000b731';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b732';
  v_client UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Sen Create Org', 'b6-sen-cre-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-sen-cre-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Sen Cre Ops', 'ops_admin', 'tenant', NULL),
    (v_sender_user, v_org, 'b6-sen-cre-su-' || left(v_sender_user::text, 8) || '@example.com',
     'B6 Sen Cre SU', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B6 Sen Cre Client', 'b6-sen-cre-cli-' || left(v_client::text, 8), 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_sen_cre_org', v_org::text, true);
  PERFORM set_config('test.b6_sen_cre_ops', v_ops::text, true);
  PERFORM set_config('test.b6_sen_cre_su', v_sender_user::text, true);
  PERFORM set_config('test.b6_sen_cre_client', v_client::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin creates a sender for an in-scope client
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_sen_cre_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.sender_create_v1(jsonb_build_object(
      'client_id', current_setting('test.b6_sen_cre_client'),
      'name', 'B6 Cre Sender',
      'brand_name', 'B6 Brand'
    ))->>'ok')::bool
  ),
  'ops_admin can sender_create_v1'
);
RESET ROLE;

-- 2) Denied: non-admin user lacks senders.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_sen_cre_su'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.sender_create_v1(jsonb_build_object(
       'client_id', current_setting('test.b6_sen_cre_client'),
       'name', 'denied'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied sender_create_v1'
);
RESET ROLE;

-- 3) Decision log audit row written
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'senders.create'
       AND resource_type = 'sender'
       AND organization_id = current_setting('test.b6_sen_cre_org')::uuid
  ),
  'sender_create_v1 wrote decision_log row'
);

-- 4) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.senders'::regclass),
  'senders has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
