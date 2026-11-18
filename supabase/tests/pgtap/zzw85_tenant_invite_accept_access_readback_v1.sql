-- pgTAP: tenant invite acceptance and access readback
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

DO $$
DECLARE
  v_org UUID := '0f850000-0000-4000-8000-000000000001'::uuid;
  v_user UUID := '0f850000-0000-4000-8000-000000000101'::uuid;
  v_role UUID := '0f850000-0000-4000-8000-000000000201'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES (v_org, 'W85 Invite Accept Tenant', 'w85-invite-accept-tenant', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id
  ) VALUES (
    v_user, v_org, 'w85-invited@example.com', 'W85 Invited User',
    'ops_admin', 'invited', 'tenant', NULL
  )
  ON CONFLICT (id) DO UPDATE
  SET status = 'invited',
      last_login_at = NULL,
      access_scope_type = 'tenant',
      access_scope_id = NULL;

  INSERT INTO public.rbac_roles (id, organization_id, key, name, is_active)
  VALUES (v_role, v_org, 'ops_admin', 'Ops Admin', TRUE)
  ON CONFLICT (organization_id, key) DO UPDATE
  SET name = EXCLUDED.name,
      is_active = TRUE
  RETURNING id INTO v_role;

  INSERT INTO public.rbac_user_role_assignments (
    organization_id, user_id, role_id, assigned_by_user_id, metadata
  ) VALUES (
    v_org, v_user, v_role, v_user, jsonb_build_object('source', 'w85_invite_accept_fixture')
  )
  ON CONFLICT DO NOTHING;

  DELETE FROM public.decision_log
   WHERE resource_type = 'user'
     AND resource_id = v_user
     AND decision_point = 'tenant_user_invite_accept_v1';

  DELETE FROM public.domain_events
   WHERE resource_type = 'user'
     AND resource_id = v_user
     AND event_type = 'user.invite_accepted';

  PERFORM set_config('test.w85_org', v_org::text, true);
  PERFORM set_config('test.w85_user', v_user::text, true);
END $$;

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', current_setting('test.w85_user'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', current_setting('test.w85_user'),
    'role', 'authenticated',
    'organization_id', current_setting('test.w85_org')
  )::text,
  true
);
SET LOCAL ROLE authenticated;

CREATE TEMP TABLE w85_first_identity AS
SELECT public.ui_me_v1() AS payload;

SELECT is(
  (SELECT payload#>>'{user,status}' FROM w85_first_identity),
  'active',
  'ui_me_v1 returns active status after invite acceptance'
);

SELECT is(
  (SELECT payload#>>'{invite_acceptance,accepted}' FROM w85_first_identity),
  'true',
  'ui_me_v1 reports that the invite was accepted on first authenticated access'
);

SELECT is(
  (SELECT payload#>>'{access_scope,scope_type}' FROM w85_first_identity),
  'tenant',
  'ui_me_v1 keeps tenant access scope visible after invite acceptance'
);

SELECT ok(
  (SELECT payload#>'{access_scope}' ? 'scope_id' FROM w85_first_identity)
    AND (SELECT payload#>>'{access_scope,scope_id}' FROM w85_first_identity) IS NULL,
  'tenant access scope id remains null in the browser identity contract'
);

RESET ROLE;
SET LOCAL ROLE postgres;

SELECT is(
  (SELECT status FROM public.users WHERE id = current_setting('test.w85_user')::uuid),
  'active',
  'tenant_user_invite_accept_v1 persists users.status=active'
);

SELECT ok(
  (SELECT last_login_at IS NOT NULL FROM public.users WHERE id = current_setting('test.w85_user')::uuid),
  'tenant_user_invite_accept_v1 records last_login_at backend readback'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE resource_type = 'user'
       AND resource_id = current_setting('test.w85_user')::uuid
       AND decision_point = 'tenant_user_invite_accept_v1'
       AND decision_outcome = 'accepted'
       AND decision_inputs->>'email' = 'w85-invited@example.com'
       AND decision_inputs->>'accepted_from_status' = 'invited'
       AND decision_inputs->>'accepted_to_status' = 'active'
       AND decision_inputs->>'access_scope_type' = 'tenant'
  ),
  'invite acceptance writes decision-log access evidence'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE resource_type = 'user'
       AND resource_id = current_setting('test.w85_user')::uuid
       AND event_type = 'user.invite_accepted'
  ),
  'invite acceptance writes domain event lineage'
);

SET LOCAL ROLE authenticated;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(
        public.ui_list_user_security_actions_v1(current_setting('test.w85_user')::uuid, 10)->'rows'
      ) AS row_data(
        decision_point TEXT,
        invite_email TEXT,
        accepted_from_status TEXT,
        accepted_to_status TEXT,
        decision_inputs JSONB
      )
     WHERE row_data.decision_point = 'tenant_user_invite_accept_v1'
       AND row_data.invite_email = 'w85-invited@example.com'
       AND row_data.accepted_from_status = 'invited'
       AND row_data.accepted_to_status = 'active'
       AND row_data.decision_inputs->>'access_scope_type' = 'tenant'
  ),
  'user security-action readback includes invite acceptance evidence'
);

CREATE TEMP TABLE w85_second_identity AS
SELECT public.ui_me_v1() AS payload;

SELECT is(
  (SELECT payload#>>'{invite_acceptance,accepted}' FROM w85_second_identity),
  'false',
  'repeat identity hydration does not re-accept an already active invite'
);

RESET ROLE;
SET LOCAL ROLE postgres;

SELECT is(
  (
    SELECT count(*)::int
      FROM public.decision_log
     WHERE resource_type = 'user'
       AND resource_id = current_setting('test.w85_user')::uuid
       AND decision_point = 'tenant_user_invite_accept_v1'
  ),
  1,
  'invite acceptance decision is written once'
);

SET LOCAL ROLE authenticated;

SELECT is(
  api.tenant_user_invite_accept_v1(current_setting('test.w85_user')::uuid)->>'accepted',
  'false',
  'api tenant_user_invite_accept_v1 wrapper returns idempotent readback for active users'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
