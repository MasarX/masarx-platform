-- pgTAP: public.sender_reactivate_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b611';
  v_ops UUID := '00000000-0000-0000-0000-00000000b711';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b712';
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Snd React Org', 'b6-snd-rea-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-snd-rea-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Snd Rea Ops', 'ops_admin', 'tenant', NULL),
    (v_sender_user, v_org, 'b6-snd-rea-sender-' || left(v_sender_user::text, 8) || '@example.com',
     'B6 Snd Rea Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B6 Snd Rea Client', 'b6-snd-rea-cli-' || left(v_client::text, 8), 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, status, suspension_reason)
  VALUES (v_sender, v_client, 'B6 Snd Rea Sender', 'suspended', 'previously suspended')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_snd_rea_org', v_org::text, true);
  PERFORM set_config('test.b6_snd_rea_ops', v_ops::text, true);
  PERFORM set_config('test.b6_snd_rea_sender_user', v_sender_user::text, true);
  PERFORM set_config('test.b6_snd_rea_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_snd_rea_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.sender_reactivate_v1(jsonb_build_object(
      'sender_id', current_setting('test.b6_snd_rea_sender')
    ))->>'ok')::bool
  ),
  'ops_admin can sender_reactivate_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_snd_rea_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.sender_reactivate_v1(jsonb_build_object(
       'sender_id', current_setting('test.b6_snd_rea_sender')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied sender_reactivate_v1'
);
RESET ROLE;

-- 3) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'senders.reactivate'
       AND resource_id = current_setting('test.b6_snd_rea_sender')::uuid
  ),
  'sender_reactivate_v1 wrote decision_log row'
);

-- 4) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.senders'::regclass),
  'senders has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
