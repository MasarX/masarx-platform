-- pgTAP: public.recipient_update_v1 contract (allowed/denied/no-op/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b705';
  v_ops UUID := '00000000-0000-0000-0000-00000000b751';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000b752';
  v_client UUID := gen_random_uuid();
  v_recipient UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 Rec Update Org', 'b6-rec-upd-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-rec-upd-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Rec Upd Ops', 'ops_admin', 'tenant', NULL),
    (v_sender_user, v_org, 'b6-rec-upd-su-' || left(v_sender_user::text, 8) || '@example.com',
     'B6 Rec Upd SU', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'B6 Rec Upd Client', 'b6-rec-upd-cli-' || left(v_client::text, 8), 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number, preferred_language)
  VALUES (v_recipient, v_org, v_client, 'B6 Rec', '+12025550123', 'en')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_rec_upd_org', v_org::text, true);
  PERFORM set_config('test.b6_rec_upd_ops', v_ops::text, true);
  PERFORM set_config('test.b6_rec_upd_su', v_sender_user::text, true);
  PERFORM set_config('test.b6_rec_upd_recipient', v_recipient::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin updates editable fields
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_rec_upd_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.recipient_update_v1(jsonb_build_object(
      'recipient_id', current_setting('test.b6_rec_upd_recipient'),
      'name', 'B6 Rec v2',
      'preferred_language', 'ar',
      'preferred_comm_channel', 'whatsapp'
    ))->>'ok')::bool
  ),
  'ops_admin can recipient_update_v1'
);
RESET ROLE;

-- 2) Denied: non-admin user lacks recipients.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_rec_upd_su'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.recipient_update_v1(jsonb_build_object(
       'recipient_id', current_setting('test.b6_rec_upd_recipient'),
       'name', 'denied'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied recipient_update_v1'
);
RESET ROLE;

-- 3) No-op idempotence: empty patch returns idempotent_no_op=true
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_rec_upd_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.recipient_update_v1(jsonb_build_object(
      'recipient_id', current_setting('test.b6_rec_upd_recipient')
    ))->>'idempotent_no_op')::bool
  ),
  'recipient_update_v1 no-op flagged idempotent_no_op=true'
);
RESET ROLE;

-- 4) RLS isolation
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.recipients'::regclass),
  'recipients has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
