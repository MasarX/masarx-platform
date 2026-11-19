-- pgTAP: Console V2 tenant admin lifecycle hardening
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(21);

DO $$
DECLARE
  v_org_a UUID := '0f840000-0000-4000-8000-000000000001'::uuid;
  v_org_b UUID := '0f840000-0000-4000-8000-000000000002'::uuid;
  v_actor UUID := '0f840000-0000-4000-8000-000000000101'::uuid;
  v_existing UUID := '0f840000-0000-4000-8000-000000000102'::uuid;
  v_new UUID := '0f840000-0000-4000-8000-000000000103'::uuid;
  v_same_org_existing UUID := '0f840000-0000-4000-8000-000000000104'::uuid;
  v_same_org_invited UUID := '0f840000-0000-4000-8000-000000000105'::uuid;
  v_role UUID := '0f840000-0000-4000-8000-000000000201'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES
    (v_org_a, 'W84 Tenant A', 'w84-tenant-a', 'active'),
    (v_org_b, 'W84 Tenant B', 'w84-tenant-b', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (v_actor, v_org_a, 'w84-actor@example.com', 'W84 Actor', 'ops_admin', 'active', 'tenant', NULL),
    (v_existing, v_org_b, 'w84-existing@example.com', 'W84 Existing', 'ops_admin', 'active', 'tenant', NULL),
    (v_same_org_existing, v_org_a, 'w84-same-org@example.com', 'W84 Same Org', 'ops_admin', 'active', 'tenant', NULL),
    (v_same_org_invited, v_org_a, 'w84-same-org-invited@example.com', 'W84 Same Org Invited', 'ops_admin', 'invited', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_roles (id, organization_id, key, name, is_active)
  VALUES (v_role, v_org_a, 'w84_custom_finance', 'W84 Custom Finance', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.rbac_user_role_assignments (
    organization_id, user_id, role_id, assigned_by_user_id, metadata
  ) VALUES (
    v_org_a, v_same_org_invited, v_role, v_actor, jsonb_build_object('source', 'w84_invited_fixture')
  )
  ON CONFLICT DO NOTHING;

  PERFORM set_config('test.w84_org_a', v_org_a::text, true);
  PERFORM set_config('test.w84_actor', v_actor::text, true);
  PERFORM set_config('test.w84_new', v_new::text, true);
  PERFORM set_config('test.w84_same_org_existing', v_same_org_existing::text, true);
  PERFORM set_config('test.w84_same_org_invited', v_same_org_invited::text, true);
END $$;

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$ SELECT public.tenant_user_invite_apply_v1(jsonb_build_object(
       'actor_user_id', current_setting('test.w84_actor'),
       'organization_id', current_setting('test.w84_org_a'),
       'email', 'w84-existing@example.com',
       'full_name', 'Cross Tenant Existing',
       'role_key', 'w84_custom_finance',
       'auth_user_id', gen_random_uuid(),
       'send_invite_email_requested', false
     )) $$,
  '23505',
  NULL,
  'tenant_user_invite_apply_v1 rejects existing email owned by another tenant'
);

SELECT lives_ok(
  $$ SELECT public.tenant_user_invite_apply_v1(jsonb_build_object(
       'actor_user_id', current_setting('test.w84_actor'),
       'organization_id', current_setting('test.w84_org_a'),
       'email', 'w84-new@example.com',
       'full_name', 'W84 New',
       'role_key', 'w84_custom_finance',
       'auth_user_id', current_setting('test.w84_new'),
       'send_invite_email_requested', false
     )) $$,
  'tenant_user_invite_apply_v1 accepts tenant custom RBAC role without using it as users.user_type'
);

SELECT isnt(
  (SELECT user_type FROM public.users WHERE id = current_setting('test.w84_new')::uuid),
  'w84_custom_finance',
  'tenant_user_invite_apply_v1 stores a valid user_type separately from role_key'
);

SELECT lives_ok(
  $$ SELECT public.tenant_user_invite_apply_v1(jsonb_build_object(
       'actor_user_id', current_setting('test.w84_actor'),
       'organization_id', current_setting('test.w84_org_a'),
       'email', 'w84-same-org@example.com',
       'full_name', 'W84 Same Org Updated',
       'role_key', 'w84_custom_finance',
       'user_type', 'driver',
       'send_invite_email_requested', true,
       'invite_redirect_to', 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback'
     )) $$,
  'tenant_user_invite_apply_v1 grants same-org existing users without rewriting user access fields'
);

SELECT lives_ok(
  $$ SELECT public.tenant_user_invite_resend_assert_v1(jsonb_build_object(
       'actor_user_id', current_setting('test.w84_actor'),
       'organization_id', current_setting('test.w84_org_a'),
       'target_user_id', current_setting('test.w84_same_org_invited'),
       'email', 'w84-same-org-invited@example.com',
       'role_key', 'w84_custom_finance'
     )) $$,
  'tenant_user_invite_resend_assert_v1 allows same-tenant invited users'
);

SELECT throws_ok(
  $$ SELECT public.tenant_user_invite_resend_assert_v1(jsonb_build_object(
       'actor_user_id', current_setting('test.w84_actor'),
       'organization_id', current_setting('test.w84_org_a'),
       'target_user_id', current_setting('test.w84_same_org_existing'),
       'email', 'w84-same-org@example.com',
       'role_key', 'w84_custom_finance'
     )) $$,
  '23514',
  NULL,
  'tenant_user_invite_resend_assert_v1 rejects non-invited users'
);

SELECT throws_ok(
  $$ SELECT public.tenant_user_invite_resend_assert_v1(jsonb_build_object(
       'actor_user_id', current_setting('test.w84_actor'),
       'organization_id', current_setting('test.w84_org_a'),
       'target_user_id', '0f840000-0000-4000-8000-000000000102',
       'email', 'w84-existing@example.com',
       'role_key', 'w84_custom_finance'
     )) $$,
  '42501',
  NULL,
  'tenant_user_invite_resend_assert_v1 rejects cross-tenant targets'
);

SELECT throws_ok(
  $$ SELECT public.tenant_user_invite_resend_assert_v1(jsonb_build_object(
       'actor_user_id', current_setting('test.w84_actor'),
       'organization_id', current_setting('test.w84_org_a'),
       'target_user_id', current_setting('test.w84_same_org_invited'),
       'email', 'w84-same-org-invited@example.com',
       'role_key', 'ops_admin'
     )) $$,
  '23514',
  NULL,
  'tenant_user_invite_resend_assert_v1 rejects role mutation during resend'
);

SELECT lives_ok(
  $$ SELECT api.tenant_user_invite_resend_assert_v1(jsonb_build_object(
       'actor_user_id', current_setting('test.w84_actor'),
       'organization_id', current_setting('test.w84_org_a'),
       'target_user_id', current_setting('test.w84_same_org_invited'),
       'email', 'w84-same-org-invited@example.com',
       'role_key', 'w84_custom_finance'
     )) $$,
  'api tenant_user_invite_resend_assert_v1 wrapper resolves same-tenant invited users'
);

RESET ROLE;

SELECT ok(
  pg_get_functiondef('public.ui_list_user_security_actions_v1(uuid,integer)'::regprocedure)
    LIKE '%tenant_user_invite_apply_v1%',
  'user security action readback includes tenant invite resend decisions'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.tenant_user_invite_apply_v1(jsonb)', 'EXECUTE'),
  'tenant_user_invite_apply_v1 stays service-only and cannot be called directly by hosted browser clients'
);

SELECT is(
  (SELECT user_type FROM public.users WHERE id = current_setting('test.w84_same_org_existing')::uuid),
  'ops_admin',
  'tenant_user_invite_apply_v1 does not rewrite existing users.user_type'
);

SELECT is(
  (SELECT status FROM public.users WHERE id = current_setting('test.w84_same_org_existing')::uuid),
  'active',
  'tenant_user_invite_apply_v1 does not rewrite existing users.status'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84_actor'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.w84_actor'), 'role', 'authenticated')::text,
  true
);
SELECT set_config(
  'test.w84_driver_roles_before',
  (SELECT count(*)::text FROM public.rbac_roles
    WHERE organization_id = current_setting('test.w84_org_a')::uuid AND key = 'driver'),
  true
);
SET LOCAL ROLE authenticated;
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.ui_list_tenant_invitable_roles_v1(current_setting('test.w84_org_a')::uuid)
     WHERE role_key = 'w84_custom_finance'
  ),
  'tenant invite role catalog keeps existing tenant roles'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.ui_list_tenant_invitable_roles_v1(current_setting('test.w84_org_a')::uuid)
     WHERE role_key = 'driver'
  ),
  'tenant invite role catalog includes the active driver role'
);

RESET ROLE;
SELECT is(
  (SELECT count(*)::text FROM public.rbac_roles
    WHERE organization_id = current_setting('test.w84_org_a')::uuid AND key = 'driver'),
  current_setting('test.w84_driver_roles_before'),
  'listing template-backed invite roles leaves the driver role inventory unchanged'
);
SET LOCAL ROLE authenticated;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(
        public.ui_list_user_security_actions_v1(current_setting('test.w84_new')::uuid, 10)->'rows'
      ) AS row_data(
        decision_point TEXT,
        invite_email TEXT,
        invite_email_sent TEXT,
        send_invite_email_requested TEXT,
        invite_redirect_to TEXT,
        decision_inputs JSONB
      )
     WHERE row_data.decision_point = 'tenant_user_invite_apply_v1'
       AND row_data.invite_email = 'w84-new@example.com'
       AND row_data.invite_email_sent = 'false'
       AND row_data.send_invite_email_requested = 'false'
       AND row_data.invite_redirect_to IS NULL
       AND row_data.decision_inputs->>'role_key' = 'w84_custom_finance'
       AND row_data.decision_inputs ? 'invite_redirect_to'
       AND row_data.decision_inputs->>'invite_redirect_to' IS NULL
  ),
  'initial tenant invite appears in user security-action readback with no-email intent'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(
        public.ui_list_user_security_actions_v1(current_setting('test.w84_same_org_existing')::uuid, 10)->'rows'
      ) AS row_data(
        decision_point TEXT,
        invite_email TEXT,
        invite_email_sent TEXT,
        send_invite_email_requested TEXT,
        invite_redirect_to TEXT,
        decision_inputs JSONB
      )
     WHERE row_data.decision_point = 'tenant_user_invite_apply_v1'
       AND row_data.invite_email = 'w84-same-org@example.com'
       AND row_data.invite_email_sent = 'false'
       AND row_data.send_invite_email_requested = 'true'
       AND row_data.invite_redirect_to = 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback'
       AND row_data.decision_inputs->>'invite_redirect_to' = 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback'
  ),
  'initial hosted tenant invite appears in user security-action readback with redirect intent'
);

SELECT lives_ok(
  $$ SELECT public.ui_update_organization_profile_v1(jsonb_build_object(
       'organization_id', current_setting('test.w84_org_a'),
       'name', 'W84 Tenant A Updated'
     )) $$,
  'ui_update_organization_profile_v1 accepts a permitted profile update'
);

SELECT throws_ok(
  $$ SELECT public.ui_update_organization_profile_v1(jsonb_build_object(
       'organization_id', current_setting('test.w84_org_a'),
       'billing_status', 'suspended'
     )) $$,
  '22023',
  'Invalid profile fields',
  'ui_update_organization_profile_v1 rejects billing fields'
);
RESET ROLE;

SELECT is(
  (SELECT billing_status FROM public.organizations WHERE id = current_setting('test.w84_org_a')::uuid),
  'active',
  'ui_update_organization_profile_v1 does not mutate billing_status'
);

SELECT * FROM finish();
ROLLBACK;
