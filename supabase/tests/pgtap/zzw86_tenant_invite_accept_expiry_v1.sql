SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

SELECT ok(
  NOT has_function_privilege('anon', 'api.tenant_user_invite_accept_v1(uuid)', 'EXECUTE'),
  'anonymous users cannot execute the invite acceptance RPC'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_other_user UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES
    (v_org, 'Synthetic Invite Tenant', 'invite-tenant-' || v_org::text, 'active'),
    (v_other_org, 'Synthetic Other Tenant', 'invite-tenant-' || v_other_org::text, 'active');

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status, access_scope_type
  ) VALUES
    (v_user, v_org, 'invite-' || v_user::text || '@example.invalid',
     'Synthetic Invitee', 'ops_admin', 'invited', 'tenant'),
    (v_other_user, v_other_org, 'invite-' || v_other_user::text || '@example.invalid',
     'Synthetic Other Invitee', 'ops_admin', 'invited', 'tenant');

  PERFORM set_config('test.invite_user', v_user::text, true);
  PERFORM set_config('test.other_invite_user', v_other_user::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_user, 'role', 'authenticated', 'organization_id', v_org
  )::text, true);
END $$;

SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.ui_me_v1()$$,
  'P0001',
  'ui_me_v1 requires an active Console user profile',
  'identity hydration requires explicit invite acceptance'
);

SELECT throws_ok(
  format('SELECT api.tenant_user_invite_accept_v1(%L::uuid)', current_setting('test.other_invite_user')),
  '42501',
  'tenant_user_invite_accept_v1 cannot accept another user invite',
  'authenticated invitee cannot accept another tenant user invitation'
);

SELECT throws_ok(
  $$SELECT api.tenant_user_invite_accept_v1()$$,
  'PT410',
  'tenant_user_invite:expired',
  'an invited profile without a matching Auth invitation cannot be accepted'
);

RESET ROLE;

INSERT INTO auth.users (id, email, aud, role, invited_at)
SELECT id, email, 'authenticated', 'authenticated', clock_timestamp() - interval '25 hours'
FROM public.users
WHERE id = current_setting('test.invite_user')::uuid;

SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT api.tenant_user_invite_accept_v1()$$,
  'PT410',
  'tenant_user_invite:expired',
  'an authenticated recipient cannot accept a 25-hour-old invitation'
);

RESET ROLE;

SELECT is(
  (SELECT status FROM public.users WHERE id = current_setting('test.invite_user')::uuid),
  'invited',
  'expired acceptance leaves the recipient invited'
);

UPDATE auth.users SET invited_at = clock_timestamp() - interval '23 hours'
WHERE id = current_setting('test.invite_user')::uuid;

SET LOCAL ROLE authenticated;

SELECT is(
  api.tenant_user_invite_accept_v1(current_setting('test.invite_user')::uuid)->>'accepted',
  'true',
  'the same authenticated recipient can accept a 23-hour-old invitation'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
