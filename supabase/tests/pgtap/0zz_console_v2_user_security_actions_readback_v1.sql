-- pgTAP: Console V2 user security-action readback RPC contract.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(14);

SELECT has_function(
  'public',
  'ui_list_user_security_actions_v1',
  ARRAY['uuid', 'integer'],
  'public.ui_list_user_security_actions_v1 exists'
);

SELECT has_function(
  'api',
  'ui_list_user_security_actions_v1',
  ARRAY['uuid', 'integer'],
  'api.ui_list_user_security_actions_v1 wrapper exists'
);

SELECT has_function(
  'api',
  'revoke_user_role_v1',
  ARRAY['jsonb'],
  'api.revoke_user_role_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.ui_list_user_security_actions_v1(uuid, integer)', 'EXECUTE'),
  'authenticated can execute public.ui_list_user_security_actions_v1'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.ui_list_user_security_actions_v1(uuid, integer)', 'EXECUTE'),
  'authenticated can execute api.ui_list_user_security_actions_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.ui_list_user_security_actions_v1(uuid, integer)', 'EXECUTE'),
  'anon cannot execute public.ui_list_user_security_actions_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_list_user_security_actions_v1(uuid, integer)', 'EXECUTE'),
  'anon cannot execute api.ui_list_user_security_actions_v1'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.revoke_user_role_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.revoke_user_role_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.revoke_user_role_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute api.revoke_user_role_v1'
);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000001535000';
  v_user UUID := '00000000-0000-0000-0000-000001535001';
  v_decision UUID := '00000000-0000-0000-0000-000001535002';
  v_intent UUID := '00000000-0000-0000-0000-000001535003';
  v_session_decision UUID := '00000000-0000-0000-0000-000001535004';
  v_role_decision UUID := '00000000-0000-0000-0000-000001535005';
  v_assignment UUID := '00000000-0000-0000-0000-000001535006';
  v_session_id TEXT := 'ssn_security_actions_pgtap';
  v_result JSONB;
  v_api_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'User Security Actions Org', 'user-security-actions-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status,
    access_scope_type, access_scope_id, created_at
  )
  VALUES (
    v_user, v_org,
    'security-actions@example.invalid',
    'Security Actions User',
    'ops_admin', 'active',
    'tenant', NULL, now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, timestamp
  )
  VALUES
  (
    v_decision, v_org,
    'users.force_password_reset', 'user', v_user,
    'force_password_reset_v1', 'pending',
    jsonb_build_object(
      'password_reset_intent_id', v_intent,
      'reason', 'pgtap reset proof'
    ),
    'force_password_reset_v1', now() - interval '1 minute'
  ),
  (
    v_session_decision, v_org,
    'sessions.revoke', 'user', v_user,
    'revoke_session_v1', 'pending',
    jsonb_build_object(
      'session_id', v_session_id,
      'reason', 'pgtap session revoke proof'
    ),
    'revoke_session_v1', now()
  ),
  (
    v_role_decision, v_org,
    'users.grant_role', 'rbac_user_role_assignment', v_assignment,
    'grant_user_role_v1', 'granted',
    jsonb_build_object(
      'target_user_id', v_user,
      'role_key', 'ops_admin',
      'reason', 'pgtap role grant proof'
    ),
    'grant_user_role_v1', now() + interval '1 minute'
  )
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', v_user::text)::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := public.ui_list_user_security_actions_v1(v_user, 5);
  v_api_result := api.ui_list_user_security_actions_v1(v_user, 5);
  EXECUTE 'RESET ROLE';

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_result->'rows') AS row_data(row_value)
       WHERE row_value->>'decision_point' = 'force_password_reset_v1'
         AND row_value->>'password_reset_intent_id' = v_intent::text
         AND row_value->>'action_reason' = 'pgtap reset proof'
    ),
    'ui_list_user_security_actions_v1 returns password reset decision and reason evidence'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_result->'rows') AS row_data(row_value)
       WHERE row_value->>'decision_point' = 'revoke_session_v1'
         AND row_value->>'session_id' = v_session_id
         AND row_value->>'action_reason' = 'pgtap session revoke proof'
    ),
    'ui_list_user_security_actions_v1 returns session revoke decision and reason evidence'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_result->'rows') AS row_data(row_value)
       WHERE row_value->>'decision_point' = 'grant_user_role_v1'
         AND row_value->>'role_key' = 'ops_admin'
         AND row_value->>'action_reason' = 'pgtap role grant proof'
         AND row_value->'decision_inputs'->>'target_user_id' = v_user::text
    ),
    'ui_list_user_security_actions_v1 returns role assignment evidence by target_user_id'
  );

  PERFORM ok(
    (v_result->>'total')::int = 3
      AND (v_result->>'page_size')::int = 5,
    'ui_list_user_security_actions_v1 returns list metadata for drawer hydration'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_api_result->'rows') AS row_data(row_value)
       WHERE row_value->>'decision_point' = 'grant_user_role_v1'
         AND row_value->>'role_key' = 'ops_admin'
         AND row_value->'decision_inputs'->>'target_user_id' = v_user::text
    ),
    'api.ui_list_user_security_actions_v1 returns role assignment evidence by target_user_id'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
