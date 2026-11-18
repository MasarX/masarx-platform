-- pgTAP: public.sender_create_v1 rejects duplicate active sender names per client.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Duplicate Sender Guard Org', 'dup-sender-guard-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops,
    v_org,
    'dup-sender-guard-' || left(v_ops::text, 8) || '@example.com',
    'Duplicate Sender Guard Ops',
    'ops_admin',
    'tenant',
    NULL
  );

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Duplicate Sender Guard Client', 'dup-sender-guard-client-' || left(v_client::text, 8), 'active');

  PERFORM set_config('test.dup_sender_guard_ops', v_ops::text, true);
  PERFORM set_config('test.dup_sender_guard_client', v_client::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  lower(pg_get_functiondef('public.sender_create_v1(jsonb)'::regprocedure))
    LIKE '%duplicate active sender name%',
  'sender_create_v1 definition contains duplicate active sender guard'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.dup_sender_guard_ops'), true);
SET LOCAL ROLE authenticated;

SELECT ok(
  (
    public.sender_create_v1(jsonb_build_object(
      'client_id', current_setting('test.dup_sender_guard_client'),
      'name', 'Duplicate Sender',
      'brand_name', 'Primary'
    ))->>'ok'
  )::boolean,
  'first active sender create succeeds'
);

SELECT throws_ok(
  $$ SELECT public.sender_create_v1(jsonb_build_object(
       'client_id', current_setting('test.dup_sender_guard_client'),
       'name', '  duplicate sender  ',
       'brand_name', 'Duplicate'
     )) $$,
  '23505',
  'sender_create_v1 duplicate active sender name',
  'second active sender with same normalized name is rejected'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
