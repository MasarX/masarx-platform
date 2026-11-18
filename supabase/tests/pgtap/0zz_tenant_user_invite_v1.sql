-- Native authorization/partial-outcome proof. No Auth HTTP or email provider calls.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path = public, pgtap, extensions, pg_temp;
SELECT no_plan();

CREATE FUNCTION pg_temp.invite_actor(p_id UUID, p_role TEXT DEFAULT 'authenticated', p_session UUID DEFAULT NULL) RETURNS VOID
LANGUAGE plpgsql AS $$ BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_id::text, ''), TRUE);
  PERFORM set_config('request.jwt.claim.role', p_role, TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_id, 'role', p_role, 'session_id', p_session)::text, TRUE);
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.invite_actor(UUID, TEXT, UUID) TO authenticated, service_role;

CREATE FUNCTION pg_temp.test_tenant_user_invite_v1() RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := gen_random_uuid(); v_other_org UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid(); v_without_cap UUID := gen_random_uuid(); v_platform UUID := gen_random_uuid();
  v_foreign UUID := gen_random_uuid(); v_target UUID := gen_random_uuid(); v_partial_user UUID := gen_random_uuid();
  v_role UUID := gen_random_uuid(); v_escalating_role UUID := gen_random_uuid(); v_platform_role UUID := gen_random_uuid();
  v_other_role UUID := gen_random_uuid(); v_client UUID := gen_random_uuid(); v_foreign_client UUID := gen_random_uuid();
  v_permission UUID; v_write_permission UUID; v_request UUID := gen_random_uuid();
  v_partial UUID := gen_random_uuid(); v_resend UUID := gen_random_uuid();
  v_identity RECORD; v_identity_request UUID; v_provider_state TEXT;
  v_token_hash TEXT := encode(extensions.digest('synthetic-mailbox-proof', 'sha256'), 'hex');
  v_identity_token TEXT; v_old_session UUID; v_new_session UUID;
  v_generic JSONB; v_auth_before JSONB; v_password_before TEXT;
  v_old_password TEXT := 'Old attacker password!'; v_new_password TEXT := 'New mailbox owner password!';
  v_policy JSONB; v_wild_policy JSONB; v_args JSONB; v_result JSONB; v_email TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM pg_temp.invite_actor(NULL, 'service_role');
  INSERT INTO public.organizations(id, name, slug) VALUES
    (v_org, 'Synthetic invite tenant', 'invite-' || replace(v_org::text, '-', '')),
    (v_other_org, 'Synthetic other tenant', 'invite-' || replace(v_other_org::text, '-', ''));
  INSERT INTO public.clients(id, organization_id, name, slug) VALUES
    (v_client, v_org, 'Synthetic client', 'invite-client'), (v_foreign_client, v_other_org, 'Other client', 'invite-client');
  INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id) VALUES
    (v_actor, v_org, v_actor || '@example.test', 'Manager', 'ops_admin', 'active', 'tenant', NULL),
    (v_without_cap, v_org, v_without_cap || '@example.test', 'Reader', 'account_manager', 'active', 'tenant', NULL),
    (v_platform, v_org, v_platform || '@example.test', 'Platform', 'super_admin', 'active', 'platform', NULL),
    (v_foreign, v_other_org, v_foreign || '@example.test', 'Other tenant', 'account_manager', 'active', 'tenant', NULL);
  INSERT INTO auth.users(id, email, aud, role) VALUES(v_foreign, v_foreign || '@example.test', 'authenticated', 'authenticated');
  INSERT INTO public.rbac_roles(id, organization_id, key, name) VALUES
    (v_role, v_org, 'invite-reader', 'Invite Reader'), (v_escalating_role, v_org, 'invite-writer', 'Invite Writer'),
    (v_platform_role, v_org, 'super_admin', 'Forbidden platform role'), (v_other_role, v_other_org, 'invite-reader', 'Other Reader');
  SELECT lv.id INTO v_permission FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'rbac_permission' AND lv.value = 'shipments.read';
  SELECT lv.id INTO v_write_permission FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'rbac_permission' AND lv.value = 'shipments.write';
  INSERT INTO public.rbac_role_permissions(organization_id, role_id, permission_id) VALUES
    (v_org, v_role, v_permission), (v_org, v_escalating_role, v_write_permission);
  INSERT INTO public.rbac_user_role_assignments(organization_id, user_id, role_id) VALUES(v_org, v_actor, v_role);
  SELECT policy INTO v_policy FROM public.resolve_access_control_policy_v1('global', NULL, FALSE) LIMIT 1;
  v_policy := jsonb_set(v_policy, '{roles}', (SELECT jsonb_agg(CASE
    WHEN r->>'key' = 'ops_admin' THEN jsonb_set(r, '{capability_keys}', '["users.manage","shipments.read"]')
    WHEN r->>'key' IN ('account_manager', 'client_admin') THEN jsonb_set(r, '{capability_keys}', '["shipments.read"]')
    ELSE r END) FROM jsonb_array_elements(v_policy->'roles') r));
  v_policy := jsonb_set(v_policy, '{denies}', '[]');
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org, v_policy, 1, 'Synthetic invite subset fixture');

  RETURN NEXT is((SELECT count(*)::INT FROM pg_constraint c
    WHERE c.conrelid = 'public.tenant_user_invite_requests'::regclass AND c.contype = 'c'
      AND public.constraint_has_literal_allowlist_v1(pg_get_constraintdef(c.oid))), 0,
    'receipt has no literal-list enum CHECKs under the actual catalog validator');
  RETURN NEXT is((SELECT count(*)::INT FROM public.lookup_column_contracts lc
    JOIN (VALUES
      ('action', 'tenant_user_invite_action', ARRAY['invite', 'resend']::TEXT[]),
      ('access_scope_type', 'scope_type', ARRAY['tenant', 'client', 'sender']::TEXT[]),
      ('provider_state', 'tenant_user_invite_provider_state', ARRAY['ready', 'accepted', 'failed', 'unknown']::TEXT[]),
      ('membership_state', 'tenant_user_invite_membership_state', ARRAY['pending', 'applied']::TEXT[])
    ) expected(column_name, category, allowed_values) ON expected.column_name = lc.column_name
      AND expected.category = lc.lookup_category AND expected.allowed_values = lc.allowed_values
    WHERE lc.table_schema = 'public' AND lc.table_name = 'tenant_user_invite_requests' AND NOT lc.allow_inactive), 4,
    'four exact lookup contracts preserve the receipt vocabulary and tenant-only scope subset');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.tenant_user_invite_requests'::regclass
    AND NOT t.tgisinternal AND t.tgfoid = 'public.enforce_lookup_column_contracts()'::regprocedure),
    'canonical lookup enforcement is attached to the receipt table');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM pg_constraint fk
    WHERE fk.conrelid = 'public.tenant_user_invite_requests'::regclass AND fk.contype = 'f'
      AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid = fk.conrelid AND i.indisvalid AND i.indpred IS NULL
        AND ARRAY(SELECT k.attnum FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
          WHERE k.ord <= cardinality(fk.conkey) ORDER BY k.ord) = fk.conkey)),
    'every actual receipt foreign key has a valid nonpartial referencing-prefix index');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.tenant_user_invite_requests'::regclass
    AND t.tgname = 'trg_tenant_user_invite_requests_set_updated_at' AND t.tgtype = 19
    AND t.tgfoid = 'public.set_updated_at()'::regprocedure), 'canonical updated_at trigger has the actual function and timing');
  RETURN NEXT is((SELECT count(*)::INT FROM pg_trigger t WHERE t.tgrelid = 'public.tenant_user_invite_requests'::regclass
    AND t.tgfoid = 'public.audit_capture_row_change()'::regprocedure
    AND ((t.tgname = 'audit_row_change' AND t.tgtype = 31)
      OR (t.tgname = 'audit_truncate_change' AND t.tgtype = 32))), 2,
    'audit-enabled receipt has both canonical row and truncate audit triggers');

  RETURN NEXT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_user_invite_requests'::regclass),
    'receipt retains RLS with its explicit service-only policy');
  RETURN NEXT is((SELECT count(*)::INT FROM pg_policy WHERE polrelid = 'public.tenant_user_invite_requests'::regclass), 1,
    'receipt has only its explicit service policy; no shared RLS changes');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid = 'public.tenant_user_invite_requests'::regclass
    AND p.polname = 'tenant_user_invite_requests_service_policy' AND p.polcmd = '*' AND p.polpermissive
    AND p.polroles = ARRAY['service_role'::regrole::oid]
    AND pg_get_expr(p.polqual, p.polrelid) = 'true' AND pg_get_expr(p.polwithcheck, p.polrelid) = 'true'),
    'sole policy is service-role-only using the canonical predicate');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
    WHERE c.oid = 'public.tenant_user_invite_requests'::regclass
      AND acl.grantee = ANY(ARRAY[0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid])),
    'no direct table ACL is introduced for PUBLIC, anon, authenticated or service role');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM pg_attribute a
    CROSS JOIN LATERAL aclexplode(NULLIF(a.attacl, '{}'::aclitem[])) acl
    WHERE a.attrelid = 'public.tenant_user_invite_requests'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND acl.grantee = ANY(ARRAY[0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid])),
    'no column ACL bypasses the facade-only receipt boundary');
  EXECUTE 'SET LOCAL ROLE anon';
  RETURN NEXT throws_ok('SELECT id FROM public.tenant_user_invite_requests LIMIT 1', '42501', NULL,
    'anon cannot read the receipt table');
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok('SELECT id FROM public.tenant_user_invite_requests LIMIT 1', '42501', NULL,
    'authenticated cannot read the receipt table');
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok('UPDATE public.tenant_user_invite_requests SET provider_state = ''accepted'' WHERE false', '42501', NULL,
    'service role cannot bypass the facade ACL even with its explicit RLS policy');
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(NOT has_table_privilege('authenticated', 'public.tenant_user_invite_requests', 'INSERT'), 'authenticated cannot forge provider receipts');
  RETURN NEXT ok(NOT has_table_privilege('service_role', 'public.tenant_user_invite_requests', 'UPDATE'), 'service cannot bypass receipt facades');
  RETURN NEXT ok(NOT has_function_privilege('service_role', 'public.tenant_user_invite_finalize_v1(uuid)', 'EXECUTE'), 'service cannot apply tenant membership');
  RETURN NEXT ok(NOT has_function_privilege('authenticated', 'public.tenant_user_invite_provider_result_v1(uuid,text,uuid)', 'EXECUTE'), 'browser cannot report provider acceptance');
  RETURN NEXT ok(NOT has_function_privilege('authenticated', 'api.tenant_user_invite_mailbox_issue_v1(uuid,text,uuid)', 'EXECUTE'), 'browser cannot attest a new Auth identity');
  RETURN NEXT ok(has_function_privilege('authenticated', 'api.tenant_user_invite_mailbox_claim_v1(uuid,text,text)', 'EXECUTE'), 'recipient has only the checked token facade');
  RETURN NEXT ok(NOT has_function_privilege('anon', 'api.tenant_user_invite_mailbox_accept_v1(uuid,text,text)', 'EXECUTE'), 'anonymous cannot redeem a token directly');
  RETURN NEXT ok(NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'tenant_user_invite_live_session_v1'),
    'invites install no global restrictive RLS quarantine');
  RETURN NEXT ok(to_regprocedure('public.tenant_user_invite_pre_request_v1()') IS NULL,
    'invites install no PostgREST pre-request quarantine');
  RETURN NEXT ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'tenant_user_invite_%'
      AND pg_get_functiondef(p.oid) ~* '(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)[[:space:]]+auth[.]'),
    'invite functions contain no Auth-schema writes');

  v_email := v_target || '@example.test';
  v_args := jsonb_build_object('action', 'invite', 'email', v_email, 'full_name', 'Synthetic invited reader',
    'user_type', 'account_manager', 'role_id', v_role, 'access_scope_type', 'tenant');
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.tenant_user_invite_prepare_v1(v_request, v_args);
  RETURN NEXT is(v_result->>'provider_state', 'ready', 'actual tenant actor prepares a neutral invitation');
  v_generic := v_result - ARRAY['id', 'request_id'];
  RETURN NEXT ok(NOT (v_result ?| ARRAY['auth_user_id', 'auth_created_by_invite', 'acceptance_mode',
    'mailbox_token_hash', 'password_fingerprint']), 'public prepare never exposes identity or eligibility');
  RETURN NEXT is(api.tenant_user_invite_prepare_v1(v_request, v_args)->>'id', v_request::text, 'same request reuses its receipt');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', v_request,
    v_args || '{"full_name":"Changed"}'), '42501', 'tenant_user_invite:request_conflict', 'request id cannot change intent');
  RETURN NEXT is(api.tenant_user_invite_dispatch_v1(v_request)->>'should_dispatch', 'true', 'one explicit dispatch is claimed');
  RETURN NEXT is(api.tenant_user_invite_dispatch_v1(v_request)->>'should_dispatch', 'false', 'same request cannot send again');
  RETURN NEXT is(api.tenant_user_invite_finalize_v1(v_request)->>'membership_state', 'pending', 'no mailbox proof means no membership');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', gen_random_uuid(), v_args),
    '55000', 'tenant_user_invite:provider_outcome_pending', 'same-tenant unresolved dispatch cannot automatically retry');

  EXECUTE 'SET LOCAL ROLE postgres';
  -- Models ONLY the successful server createUser response for this exact new identity.
  INSERT INTO auth.users(id, email, aud, role, is_anonymous, email_confirmed_at, encrypted_password)
    VALUES(v_target, v_email, 'authenticated', 'authenticated', FALSE, now(),
      extensions.crypt('Unrevealed synthetic placeholder!', extensions.gen_salt('bf')));
  PERFORM pg_temp.invite_actor(NULL, 'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(api.tenant_user_invite_mailbox_issue_v1(v_request, v_token_hash, v_target)->>'acceptance_mode',
    'new_account', 'only this invite successful createUser response attests the new identity');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_provider_result_v1(%L,%L,NULL)', v_request, 'accepted'),
    '42501', 'tenant_user_invite:provider_identity_mismatch', 'non-support provider acceptance still binds the actual Auth UID');
  PERFORM api.tenant_user_invite_provider_result_v1(v_request, 'accepted', v_target);
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_issue_v1(%L,%L,%L)', v_request, v_token_hash, v_target),
    '55000', 'tenant_user_invite:mailbox_already_issued_or_unavailable', 'issued token cannot be replaced');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_accept_v1(%L,%L,%L)', v_request, v_token_hash, v_new_password),
    '42501', 'tenant_user_invite:mailbox_token_invalid', 'new-account acceptance requires the token claim');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.tenant_user_invite_finalize_v1(v_request)->>'membership_state', 'pending',
    'auto-confirmed new account still cannot attach before THIS invite proof');
  RETURN NEXT is(api.tenant_user_invite_finalize_v1(v_request)->>'provider_state', 'unknown',
    'public result does not reveal the private provider acceptance');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_claim_v1(%L,%L,%L)', v_request, v_token_hash, v_new_password),
    '42501', 'tenant_user_invite:mailbox_token_invalid', 'sender cannot redeem the new account token');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(NULL, 'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_claim_v1(%L,%L,%L)', v_request, repeat('0',64), v_new_password),
    '42501', 'tenant_user_invite:mailbox_token_invalid', 'wrong token does not claim the invitation');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_claim_v1(%L,%L,%L)', v_request, v_token_hash, 'short'),
    '22023', 'tenant_user_invite:new_password_required', 'invalid new password does not consume the token');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.tenant_user_invite_requests SET mailbox_expires_at = clock_timestamp() - interval '1 second' WHERE id = v_request;
  PERFORM pg_temp.invite_actor(NULL, 'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_claim_v1(%L,%L,%L)', v_request, v_token_hash, v_new_password),
    '42501', 'tenant_user_invite:mailbox_token_invalid', 'expired token cannot be claimed');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.tenant_user_invite_requests SET mailbox_expires_at = clock_timestamp() + interval '1 hour' WHERE id = v_request;
  PERFORM pg_temp.invite_actor(NULL, 'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(api.tenant_user_invite_mailbox_claim_v1(v_request, v_token_hash, v_new_password)->>'acceptance_mode',
    'new_account', 'valid new-account proof claims once');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_claim_v1(%L,%L,%L)', v_request, v_token_hash, v_new_password),
    '42501', 'tenant_user_invite:mailbox_token_invalid', 'a concurrent/replayed claim cannot repeat a password update');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_accept_v1(%L,%L,%L)', v_request, v_token_hash, v_new_password),
    '42501', 'tenant_user_invite:new_account_password_required', 'unrevealed placeholder is not the recipient chosen password');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE auth.users SET encrypted_password = extensions.crypt(v_new_password, extensions.gen_salt('bf')) WHERE id = v_target;
  SELECT encrypted_password INTO v_password_before FROM auth.users WHERE id = v_target;
  PERFORM pg_temp.invite_actor(NULL, 'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(api.tenant_user_invite_mailbox_accept_v1(v_request, v_token_hash, v_new_password)->>'accepted',
    'true', 'this invite token accepts the positively created new account');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_accept_v1(%L,%L,%L)', v_request, v_token_hash, v_new_password),
    '42501', 'tenant_user_invite:mailbox_token_invalid', 'a used mailbox token cannot be replayed');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE auth.users SET encrypted_password = extensions.crypt('Changed before attachment!', extensions.gen_salt('bf')) WHERE id = v_target;
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_finalize_v1(%L)', v_request), '42501',
    'tenant_user_invite:accepted_credentials_changed', 'changed new-account credentials cannot attach');
  EXECUTE 'SET LOCAL ROLE postgres'; UPDATE auth.users SET encrypted_password = v_password_before WHERE id = v_target;
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.tenant_user_invite_finalize_v1(v_request)->>'membership_state', 'applied', 'fresh manager authority applies accepted new membership');
  RETURN NEXT is(api.tenant_user_invite_finalize_v1(v_request)->>'membership_state', 'applied', 'finalization is idempotent');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.users u JOIN public.rbac_user_role_assignments r ON r.user_id = u.id
    WHERE u.id = v_target AND u.organization_id = v_org AND u.user_type = 'account_manager'
      AND u.access_scope_type = 'tenant' AND u.access_scope_id IS NULL AND r.organization_id = v_org
      AND r.role_id = v_role AND r.revoked_at IS NULL), 'exact new Auth UID, scoped membership and role read back');
  RETURN NEXT is((SELECT count(*)::INT FROM public.rbac_user_role_assignments WHERE user_id = v_target AND revoked_at IS NULL), 1,
    'new identity receives one active role assignment');
  RETURN NEXT is((SELECT assigned_by_user_id::text FROM public.rbac_user_role_assignments WHERE user_id = v_target), v_actor::text,
    'real inviter retains role assignment attribution');
  RETURN NEXT throws_ok(format('UPDATE public.tenant_user_invite_requests SET action = %L WHERE id = %L', 'invented', v_request),
    '23514', NULL, 'lookup contract rejects an unknown action');
  RETURN NEXT throws_ok(format('UPDATE public.tenant_user_invite_requests SET access_scope_type = %L WHERE id = %L', 'global', v_request),
    '23514', NULL, 'scope lookup subset rejects a global receipt scope');
  RETURN NEXT throws_ok(format('UPDATE public.tenant_user_invite_requests SET provider_state = %L WHERE id = %L', 'invented', v_request),
    '23514', NULL, 'lookup contract rejects an unknown provider outcome');
  RETURN NEXT throws_ok(format('UPDATE public.tenant_user_invite_requests SET membership_state = %L WHERE id = %L', 'invented', v_request),
    '23514', NULL, 'lookup contract rejects an unknown membership outcome');
  UPDATE public.tenant_user_invite_requests SET updated_at = '2000-01-01T00:00:00Z' WHERE id = v_request;
  RETURN NEXT ok((SELECT updated_at > '2000-01-01T00:00:00Z' FROM public.tenant_user_invite_requests WHERE id = v_request),
    'canonical timestamp trigger replaces a stale timestamp');

  -- A auto-confirmed, B unconfirmed, C pending OAuth linking: every pre-existing orphan stays unattached.
  FOR v_identity IN SELECT * FROM (VALUES
    (gen_random_uuid(), 'A', TRUE), (gen_random_uuid(), 'B', FALSE), (gen_random_uuid(), 'C', TRUE)
  ) fixture(id, attack, confirmed) LOOP
    v_identity_request := gen_random_uuid(); v_old_session := gen_random_uuid();
    v_identity_token := encode(extensions.digest(v_identity_request::text, 'sha256'), 'hex');
    INSERT INTO auth.users(id, email, aud, role, email_confirmed_at, is_anonymous, encrypted_password)
      VALUES(v_identity.id, v_identity.id || '@example.test', 'authenticated', 'authenticated',
        CASE WHEN v_identity.confirmed THEN now() END, FALSE, extensions.crypt(v_old_password, extensions.gen_salt('bf')));
    INSERT INTO auth.sessions(id, user_id, created_at, updated_at) VALUES(v_old_session, v_identity.id, now(), now());
    IF v_identity.attack = 'C' THEN
      INSERT INTO auth.flow_state(id, user_id, auth_code, provider_type, authentication_method,
        code_challenge, code_challenge_method, linking_target_id, created_at, updated_at)
      VALUES(gen_random_uuid(), NULL, gen_random_uuid()::text, 'github', 'oauth', 'synthetic-challenge', 's256', v_identity.id, now(), now());
    END IF;
    SELECT to_jsonb(u) INTO v_auth_before FROM auth.users u WHERE id = v_identity.id;
    PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
    v_result := api.tenant_user_invite_prepare_v1(v_identity_request,
      v_args || jsonb_build_object('email', v_identity.id || '@example.test'));
    RETURN NEXT is(v_result - ARRAY['id','request_id'], v_generic, format('attack %s prepare is non-enumerating', v_identity.attack));
    RETURN NEXT is(api.tenant_user_invite_dispatch_v1(v_identity_request)->>'should_dispatch', 'true', 'orphan attempt gets the same one-dispatch contract');
    EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(NULL, 'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
    RETURN NEXT is(api.tenant_user_invite_mailbox_issue_v1(v_identity_request, v_identity_token, NULL)->>'acceptance_mode',
      'support_only', format('attack %s pre-existing orphan cannot acquire an acceptance token', v_identity.attack));
    RETURN NEXT is(api.tenant_user_invite_mailbox_issue_v1(v_identity_request, v_identity_token, v_identity.id)->>'acceptance_mode',
      'support_only', 'a pre-prepare Auth identity cannot be relabeled as created by this invitation');
    PERFORM api.tenant_user_invite_provider_result_v1(v_identity_request, 'accepted', NULL);
    RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_claim_v1(%L,%L,%L)',
      v_identity_request, v_identity_token, v_new_password), '42501', 'tenant_user_invite:mailbox_token_invalid',
      'support-only receipt has no redeemable token');
    EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(v_identity.id, 'authenticated', v_old_session);
    EXECUTE 'SET LOCAL ROLE authenticated';
    RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_claim_v1(%L,%L,%L)',
      v_identity_request, v_identity_token, NULL), '42501', 'tenant_user_invite:mailbox_token_invalid',
      'even a matching live orphan session cannot redeem an unissued token');
    EXECUTE 'SET LOCAL ROLE postgres';
    RETURN NEXT ok((SELECT mailbox_support_only AND provider_state = 'accepted'
      FROM public.tenant_user_invite_requests WHERE id = v_identity_request),
      'real support delivery acceptance is private and confers no mailbox acceptance');
    IF v_identity.attack = 'B' THEN UPDATE auth.users SET email_confirmed_at = now() WHERE id = v_identity.id; END IF;
    IF v_identity.attack = 'C' THEN
      INSERT INTO auth.identities(user_id, provider_id, identity_data, provider) VALUES(v_identity.id, v_identity.id::text, '{}'::jsonb, 'github');
      INSERT INTO auth.sessions(id, user_id, created_at, updated_at) VALUES(gen_random_uuid(), v_identity.id, now(), now());
    END IF;
    PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
    v_result := api.tenant_user_invite_finalize_v1(v_identity_request);
    RETURN NEXT is(v_result->>'membership_state', 'pending', format('attack %s remains unattached after confirmation/callback', v_identity.attack));
    RETURN NEXT is(v_result->>'provider_state', 'unknown', 'private provider state cannot reveal orphan eligibility');
    EXECUTE 'SET LOCAL ROLE postgres';
    RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.users WHERE id = v_identity.id), 'pre-existing orphan has no app membership');
    RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.rbac_user_role_assignments WHERE user_id = v_identity.id), 'pre-existing orphan has no RBAC grant');
    RETURN NEXT ok((SELECT mailbox_token_hash IS NULL AND NOT auth_created_by_invite AND mailbox_accepted_at IS NULL
      FROM public.tenant_user_invite_requests WHERE id = v_identity_request), 'orphan receipt has no forged creation or acceptance proof');
    RETURN NEXT ok((SELECT extensions.crypt(v_old_password, encrypted_password) = encrypted_password
      FROM auth.users WHERE id = v_identity.id), 'existing orphan credentials are untouched');
    IF v_identity.attack <> 'B' THEN
      RETURN NEXT is((SELECT to_jsonb(u) FROM auth.users u WHERE id = v_identity.id), v_auth_before, 'invite functions never mutate the orphan Auth row');
    END IF;
    RETURN NEXT ok(EXISTS(SELECT 1 FROM auth.sessions WHERE id = v_old_session), 'existing orphan session is not globally revoked');
  END LOOP;

  -- A signup racing after prepare is not positive createUser attestation.
  v_identity_request := gen_random_uuid(); v_new_session := gen_random_uuid();
  v_identity_token := encode(extensions.digest(v_identity_request::text, 'sha256'), 'hex');
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM api.tenant_user_invite_prepare_v1(v_identity_request, v_args || jsonb_build_object('email', v_new_session || '@example.test'));
  PERFORM api.tenant_user_invite_dispatch_v1(v_identity_request);
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO auth.users(id,email,aud,role,is_anonymous,email_confirmed_at,encrypted_password)
    VALUES(v_new_session,v_new_session || '@example.test','authenticated','authenticated',FALSE,now(),
      extensions.crypt(v_old_password, extensions.gen_salt('bf')));
  PERFORM pg_temp.invite_actor(NULL,'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(api.tenant_user_invite_mailbox_issue_v1(v_identity_request,v_identity_token,NULL)->>'acceptance_mode',
    'support_only', 'recent created_at and post-prepare existence cannot substitute for actual createUser success');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.tenant_user_invite_finalize_v1(v_identity_request)->>'membership_state','pending','raced signup cannot attach');

  -- Foreign active members are neutral and unchanged until multi-tenant support is separately approved.
  v_identity_request := gen_random_uuid(); v_identity_token := encode(extensions.digest(v_identity_request::text,'sha256'),'hex');
  v_result := api.tenant_user_invite_prepare_v1(v_identity_request,v_args || jsonb_build_object('email',v_foreign || '@example.test'));
  RETURN NEXT is(v_result - ARRAY['id','request_id'],v_generic,'foreign member prepare is the same neutral outcome');
  PERFORM api.tenant_user_invite_dispatch_v1(v_identity_request);
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(NULL,'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(api.tenant_user_invite_mailbox_issue_v1(v_identity_request,v_identity_token,NULL)->>'acceptance_mode','support_only',
    'foreign member is not transferred or assigned a second unrepresented organization');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.tenant_user_invite_finalize_v1(v_identity_request)->>'membership_state','pending','foreign membership stays safely unattached');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT organization_id::text FROM public.users WHERE id=v_foreign),v_other_org::text,'foreign organization is unchanged');

  PERFORM pg_temp.invite_actor(v_without_cap); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', gen_random_uuid(), v_args),
    '42501', 'Capability denied: users.manage', 'read role cannot invite');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(v_platform); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', gen_random_uuid(), v_args),
    '42501', 'tenant_user_invite:tenant_manager_required', 'platform identity is not tenant invite authority');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', gen_random_uuid(),
    v_args || jsonb_build_object('role_id', v_other_role)), '42501', 'tenant_user_invite:role_outside_tenant', 'foreign role rejected');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', gen_random_uuid(),
    v_args || jsonb_build_object('role_id', v_escalating_role)), '42501', 'tenant_user_invite:permission_escalation', 'missing actor RBAC permission rejects escalation');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', gen_random_uuid(),
    v_args || jsonb_build_object('role_id', v_platform_role)), '42501', 'tenant_user_invite:capability_escalation', 'wildcard platform capability cannot be delegated');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', gen_random_uuid(),
    v_args || jsonb_build_object('user_type', 'client_admin', 'access_scope_type', 'client', 'access_scope_id', v_foreign_client)),
    '42501', 'tenant_user_invite:scope_outside_tenant', 'client scope must belong to actor tenant');
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', gen_random_uuid(),
    v_args || '{"user_type":"super_admin","access_scope_type":"platform"}'), '42501', 'tenant_user_invite:incompatible_user_scope', 'platform user type forbidden');

  -- ACTIVE same-tenant member: mailbox token plus that recipient's already-signed-in account.
  v_identity_request := gen_random_uuid(); v_identity_token := encode(extensions.digest(v_identity_request::text,'sha256'),'hex');
  v_old_session := gen_random_uuid();
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES(v_old_session,v_target,now(),now());
  INSERT INTO auth.identities(user_id,provider_id,identity_data,provider) VALUES(v_target,v_target::text,'{}'::jsonb,'github');
  INSERT INTO auth.mfa_factors(id,user_id,factor_type,status,secret,created_at,updated_at)
    VALUES(gen_random_uuid(),v_target,'totp','unverified','SYNTHETIC-UNUSED',now(),now());
  SELECT to_jsonb(u) INTO v_auth_before FROM auth.users u WHERE id=v_target;
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.tenant_user_invite_prepare_v1(v_identity_request,v_args);
  RETURN NEXT is(v_result - ARRAY['id','request_id'],v_generic,'active member prepare reveals no account eligibility');
  PERFORM api.tenant_user_invite_dispatch_v1(v_identity_request);
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(NULL,'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is(api.tenant_user_invite_mailbox_issue_v1(v_identity_request,v_identity_token,NULL)->>'acceptance_mode','active_member',
    'private service resolver recognizes only the active same-tenant member');
  PERFORM api.tenant_user_invite_provider_result_v1(v_identity_request,'accepted',v_target);
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_claim_v1(%L,%L,%L)',v_identity_request,v_identity_token,NULL),
    '42501','tenant_user_invite:recipient_session_required','service cannot impersonate an existing member');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_claim_v1(%L,%L,%L)',v_identity_request,v_identity_token,NULL),
    '42501','tenant_user_invite:recipient_session_required','inviter session is not recipient acceptance authority');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(v_target); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_claim_v1(%L,%L,%L)',v_identity_request,v_identity_token,NULL),
    '42501','tenant_user_invite:recipient_session_required','recipient UID without a live session is insufficient');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(v_target,'authenticated',v_old_session); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.tenant_user_invite_mailbox_claim_v1(v_identity_request,v_identity_token,NULL)->>'acceptance_mode','active_member',
    'matching already-authenticated member may claim the exact token');
  EXECUTE 'SET LOCAL ROLE postgres'; UPDATE public.users SET status='suspended' WHERE id=v_target;
  PERFORM pg_temp.invite_actor(v_target,'authenticated',v_old_session); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_mailbox_accept_v1(%L,%L,%L)',v_identity_request,v_identity_token,NULL),
    '42501','tenant_user_invite:recipient_session_required','suspended member cannot complete acceptance');
  EXECUTE 'SET LOCAL ROLE postgres'; UPDATE public.users SET status='active' WHERE id=v_target;
  PERFORM pg_temp.invite_actor(v_target,'authenticated',v_old_session); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.tenant_user_invite_mailbox_accept_v1(v_identity_request,v_identity_token,NULL)->>'accepted','true',
    'active same-account recipient and token complete acceptance without a credential reset');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.tenant_user_invite_finalize_v1(v_identity_request)->>'membership_state','applied','manager reconciles accepted same-tenant member');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT to_jsonb(u) FROM auth.users u WHERE id=v_target),v_auth_before,'existing member Auth row is byte-for-byte unchanged');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM auth.sessions WHERE id=v_old_session),'existing member session is preserved');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM auth.identities WHERE user_id=v_target AND provider='github'),'existing linked identity is preserved');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM auth.mfa_factors WHERE user_id=v_target),'existing MFA factor is preserved');
  RETURN NEXT is((SELECT count(*)::INT FROM public.rbac_user_role_assignments WHERE user_id=v_target AND revoked_at IS NULL),1,
    'member reconciliation does not duplicate the existing role');
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.tenant_user_invite_prepare_v1(v_resend,jsonb_build_object('action','resend','target_user_id',v_target,
    'role_id',v_escalating_role,'user_type','super_admin','access_scope_type','platform'));
  RETURN NEXT is(v_result->>'role_id',v_role::text,'explicit resend derives existing role instead of caller role');
  RETURN NEXT is(v_result->>'user_type','account_manager','resend cannot overwrite existing user type');

  -- Loss of capability through an explicit deny is honored, not raw role-array inclusion.
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(NULL, 'service_role');
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org,
    jsonb_set(v_policy, '{denies}', '[{"capability_key":"shipments.read"}]'), 1, 'Synthetic explicit deny');
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', gen_random_uuid(), v_args),
    '42501', 'tenant_user_invite:capability_escalation', 'effective deny blocks otherwise assigned capability');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(NULL, 'service_role');
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org, v_policy, 1, 'Restore synthetic invite policy');

  v_wild_policy := jsonb_set(v_policy, '{roles}',
    (SELECT jsonb_agg(CASE WHEN r->>'key' = 'ops_admin'
      THEN jsonb_set(r, '{capability_keys}', '["users.manage","shipments.*"]') ELSE r END)
      FROM jsonb_array_elements(v_policy->'roles') r)
    || '[{"key":"invite-reader","label":"Bounded wildcard","capability_keys":["shipments.*"]}]'::jsonb);
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org, v_wild_policy, 1, 'Synthetic tenant wildcard');
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.tenant_user_invite_prepare_v1(gen_random_uuid(), v_args || jsonb_build_object('email', gen_random_uuid() || '@example.test'));
  RETURN NEXT is(v_result->>'provider_state', 'ready', 'bounded tenant wildcard resolves registered domain against effective actor rights');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(NULL, 'service_role');
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org,
    jsonb_set(v_wild_policy, '{denies}', '[{"capability_key":"shipments.write"}]'), 1, 'Synthetic wildcard deny');
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_prepare_v1(%L,%L::jsonb)', gen_random_uuid(),
    v_args || jsonb_build_object('email', gen_random_uuid() || '@example.test')), '42501',
    'tenant_user_invite:capability_escalation', 'covering wildcard alone cannot bypass effective deny');
  EXECUTE 'SET LOCAL ROLE postgres'; PERFORM pg_temp.invite_actor(NULL, 'service_role');
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org, v_policy, 1, 'Restore synthetic invite policy');

  -- Accepted mailbox proof does not replace the inviter's current authority.
  v_args := v_args || jsonb_build_object('email',v_partial_user || '@example.test');
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM api.tenant_user_invite_prepare_v1(v_partial,v_args); PERFORM api.tenant_user_invite_dispatch_v1(v_partial);
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO auth.users(id,email,aud,role,email_confirmed_at,is_anonymous,encrypted_password)
    VALUES(v_partial_user,v_partial_user || '@example.test','authenticated','authenticated',now(),FALSE,
      extensions.crypt('Unrevealed partial placeholder!',extensions.gen_salt('bf')));
  v_identity_token:=encode(extensions.digest(v_partial::text,'sha256'),'hex');
  PERFORM pg_temp.invite_actor(NULL,'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM api.tenant_user_invite_mailbox_issue_v1(v_partial,v_identity_token,v_partial_user);
  PERFORM api.tenant_user_invite_provider_result_v1(v_partial,'accepted',v_partial_user);
  PERFORM api.tenant_user_invite_mailbox_claim_v1(v_partial,v_identity_token,v_new_password);
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE auth.users SET encrypted_password=extensions.crypt(v_new_password,extensions.gen_salt('bf')) WHERE id=v_partial_user;
  PERFORM pg_temp.invite_actor(NULL,'service_role'); EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM api.tenant_user_invite_mailbox_accept_v1(v_partial,v_identity_token,v_new_password);
  EXECUTE 'SET LOCAL ROLE postgres'; UPDATE public.users SET user_type='account_manager' WHERE id=v_actor;
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_finalize_v1(%L)',v_partial),'42501',
    'Capability denied: users.manage','accepted token cannot bypass lost inviter capability');
  EXECUTE 'SET LOCAL ROLE postgres'; UPDATE public.users SET user_type='ops_admin',status='suspended' WHERE id=v_actor;
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.tenant_user_invite_finalize_v1(%L)',v_partial),'42501',
    'tenant_user_invite:tenant_manager_required','suspended inviter cannot finalize');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT membership_state FROM public.tenant_user_invite_requests WHERE id=v_partial),'pending','authority failure remains pending');
  RETURN NEXT is((SELECT provider_state FROM public.tenant_user_invite_requests WHERE id=v_partial),'accepted','actual private provider outcome is preserved');
  UPDATE public.users SET status='active' WHERE id=v_actor;
  PERFORM pg_temp.invite_actor(v_actor); EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.tenant_user_invite_finalize_v1(v_partial)->>'membership_state','applied','same receipt reconciles after real authority recovery');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.audit_table_changes WHERE table_name='tenant_user_invite_requests'
    AND pk->>'id'=v_partial::text AND row_new->>'mailbox_token_hash'='[REDACTED]'
    AND row_new->>'password_fingerprint'='[REDACTED]' AND row_new->>'auth_user_id'='[REDACTED]'),
    'audit never stores the token digest, credential fingerprint or global Auth ID');
END;
$$;
SELECT * FROM pg_temp.test_tenant_user_invite_v1();
SELECT * FROM finish();
ROLLBACK;
