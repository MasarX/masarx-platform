-- pgTAP: Console V2 user-session readback RPC contract.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

SELECT has_function(
  'public',
  'ui_list_user_sessions_v1',
  ARRAY['uuid', 'integer'],
  'public.ui_list_user_sessions_v1 exists'
);

SELECT has_function(
  'api',
  'ui_list_user_sessions_v1',
  ARRAY['uuid', 'integer'],
  'api.ui_list_user_sessions_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.ui_list_user_sessions_v1(uuid, integer)', 'EXECUTE'),
  'authenticated can execute public.ui_list_user_sessions_v1'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.ui_list_user_sessions_v1(uuid, integer)', 'EXECUTE'),
  'authenticated can execute api.ui_list_user_sessions_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.ui_list_user_sessions_v1(uuid, integer)', 'EXECUTE'),
  'anon cannot execute public.ui_list_user_sessions_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_list_user_sessions_v1(uuid, integer)', 'EXECUTE'),
  'anon cannot execute api.ui_list_user_sessions_v1'
);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000001620000';
  v_user UUID := '00000000-0000-0000-0000-000001620001';
  v_session UUID := '00000000-0000-0000-0000-000001620002';
  v_revoke UUID := '00000000-0000-0000-0000-000001620003';
  v_public JSONB;
  v_api JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'User Sessions Readback Org', 'user-sessions-readback-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO auth.users (
    id, aud, role, email, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  )
  VALUES (
    v_user, 'authenticated', 'authenticated', 'sessions-readback@example.invalid',
    now(), '{}'::jsonb, '{}'::jsonb, now() - interval '2 hours', now()
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        updated_at = EXCLUDED.updated_at;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status,
    access_scope_type, access_scope_id, created_at
  )
  VALUES (
    v_user, v_org,
    'sessions-readback@example.invalid',
    'Sessions Readback User',
    'ops_admin', 'active',
    'tenant', NULL, now() - interval '2 hours'
  )
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        email = EXCLUDED.email,
        user_type = EXCLUDED.user_type,
        status = EXCLUDED.status;

  INSERT INTO auth.sessions (
    id, user_id, created_at, updated_at, aal, user_agent, ip, not_after
  )
  VALUES (
    v_session, v_user,
    now() - interval '1 hour',
    now() - interval '5 minutes',
    'aal2'::auth.aal_level,
    'pgTAP Browser Agent',
    '127.0.0.1'::inet,
    now() + interval '7 days'
  )
  ON CONFLICT (id) DO UPDATE
    SET updated_at = EXCLUDED.updated_at,
        aal = EXCLUDED.aal,
        user_agent = EXCLUDED.user_agent,
        ip = EXCLUDED.ip,
        not_after = EXCLUDED.not_after;

  INSERT INTO public.revocation_audit (
    id, organization_id, target_user_id, session_id, reason,
    revoked_by, status, correlation_id, created_at
  )
  VALUES (
    v_revoke, v_org, v_user, v_session::text, 'pgtap session revoke proof',
    v_user, 'pending', gen_random_uuid()::text, now() - interval '1 minute'
  )
  ON CONFLICT (id) DO UPDATE
    SET session_id = EXCLUDED.session_id,
        reason = EXCLUDED.reason,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.session_id', v_session::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'role', 'authenticated',
      'sub', v_user::text,
      'session_id', v_session::text
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_public := public.ui_list_user_sessions_v1(v_user, 5);
  v_api := api.ui_list_user_sessions_v1(v_user, 5);
  EXECUTE 'RESET ROLE';

  PERFORM ok(
    jsonb_array_length(v_public->'rows') = 1
      AND v_public#>>'{rows,0,id}' = v_session::text
      AND v_public#>>'{rows,0,user_email}' = 'sessions-readback@example.invalid'
      AND v_public#>>'{rows,0,aal}' = 'aal2',
    'ui_list_user_sessions_v1 returns scoped auth session row'
  );

  PERFORM ok(
    (v_public#>>'{rows,0,is_current}')::boolean = TRUE
      AND v_public#>>'{rows,0,revocation_status}' = 'pending'
      AND v_public#>>'{rows,0,revocation_reason}' = 'pgtap session revoke proof',
    'ui_list_user_sessions_v1 returns current-session and revocation readback evidence'
  );

  PERFORM ok(
    (v_api->>'total')::int = 1
      AND (v_api->>'page_size')::int = 5
      AND v_api#>>'{rows,0,id}' = v_session::text,
    'api.ui_list_user_sessions_v1 returns list metadata and rows'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
