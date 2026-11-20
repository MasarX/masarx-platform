BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SET LOCAL statement_timeout = '30s';
SELECT plan(14);

-- Model a platform profile without an organization inside this rollback-only test.
ALTER TABLE public.users ALTER COLUMN organization_id DROP NOT NULL;
DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_tenant uuid := gen_random_uuid();
  v_platform uuid := gen_random_uuid();
  v_orgless uuid := gen_random_uuid();
  v_unprivileged uuid := gen_random_uuid();
  v_flag uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES (v_org, 'Feature Flag Gate Test', 'feature-flag-gate-' || v_org::text, 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_tenant, v_org, v_tenant::text || '@example.test', 'Tenant Operator', 'ops_admin', 'active', 'tenant'),
    (v_platform, v_org, v_platform::text || '@example.test', 'Platform Admin', 'super_admin', 'active', 'platform'),
    (v_orgless, NULL, v_orgless::text || '@example.test', 'Platform Admin Without Org', 'super_admin', 'active', 'platform'),
    (v_unprivileged, NULL, v_unprivileged::text || '@example.test', 'Platform Reader', 'client_admin', 'active', 'platform');

  INSERT INTO public.feature_flags (id, name, scope_type, scope_id, enabled, rollout_percentage)
  VALUES (v_flag, 'pgtap.feature-flag-gate.' || v_flag::text, 'global', NULL, false, 0);

  PERFORM set_config('test.feature_flag_gate.tenant', v_tenant::text, true);
  PERFORM set_config('test.feature_flag_gate.platform', v_platform::text, true);
  PERFORM set_config('test.feature_flag_gate.orgless', v_orgless::text, true);
  PERFORM set_config('test.feature_flag_gate.unprivileged', v_unprivileged::text, true);
  PERFORM set_config('test.feature_flag_gate.flag', v_flag::text, true);
END;
$$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.feature_flag_gate.tenant'), true),
       set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.feature_flag_gate.tenant'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- Mutation: the original unscoped capability check permits creating a flag.
SELECT throws_ok($$SELECT api.create_feature_flag_v1(jsonb_build_object(
  'flag_key', 'pgtap.denied.' || current_setting('test.feature_flag_gate.flag')))$$,
  '42501', 'Capability denied: feature_flags.write', 'tenant ops_admin cannot create a flag');

-- Mutation: the original gate permits updating a global flag.
SELECT throws_ok($$SELECT api.update_feature_flag_v1(jsonb_build_object(
  'feature_flag_id', current_setting('test.feature_flag_gate.flag'), 'description', 'Denied update'))$$,
  '42501', 'Capability denied: feature_flags.write', 'tenant ops_admin cannot update a global flag');

-- Mutation: the original gate attempts the update on a global flag.
SELECT throws_ok($$SELECT api.toggle_feature_flag_v1(jsonb_build_object(
  'feature_flag_id', current_setting('test.feature_flag_gate.flag'), 'enabled', true))$$,
  '42501', 'Capability denied: feature_flags.write', 'tenant ops_admin cannot toggle a global flag');

-- Mutation: the original gate permits engaging the kill switch on an off flag.
SELECT throws_ok($$SELECT api.engage_kill_switch_v1(jsonb_build_object(
  'feature_flag_id', current_setting('test.feature_flag_gate.flag'), 'reason', 'Denied engage'))$$,
  '42501', 'Capability denied: feature_flags.write', 'tenant ops_admin cannot engage the kill switch');

-- Mutation: the original gate permits an idempotent kill switch release.
SELECT throws_ok($$SELECT api.release_kill_switch_v1(jsonb_build_object(
  'feature_flag_id', current_setting('test.feature_flag_gate.flag'), 'reason', 'Denied release',
  'target_enabled', false, 'target_rollout', 0))$$,
  '42501', 'Capability denied: feature_flags.write', 'tenant ops_admin cannot release the kill switch');

-- Mutation: the original gate permits an idempotent rollout write.
SELECT throws_ok($$SELECT api.set_rollout_v1(jsonb_build_object(
  'feature_flag_id', current_setting('test.feature_flag_gate.flag'), 'rollout_percentage', 0))$$,
  '42501', 'Capability denied: feature_flags.write', 'tenant ops_admin cannot set rollout');

-- Mutation: removing the bulk gate returns a per-flag error instead of rejecting the request.
SELECT throws_ok($$SELECT api.bulk_toggle_feature_flags_v1(jsonb_build_object(
  'flags', jsonb_build_array(jsonb_build_object('feature_flag_id', current_setting('test.feature_flag_gate.flag'))),
  'enabled', true))$$,
  '42501', 'Capability denied: feature_flags.write', 'tenant ops_admin cannot bulk toggle flags');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.feature_flag_gate.platform'), true),
       set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.feature_flag_gate.platform'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- Mutation: rejecting platform users with an org breaks create.
SELECT ok((api.create_feature_flag_v1(jsonb_build_object(
  'flag_key', 'pgtap.created.' || current_setting('test.feature_flag_gate.platform')))->>'ok')::boolean,
  'platform admin with an org can create a flag');

-- Mutation: rejecting platform users with an org breaks the idempotent toggle.
SELECT ok((api.toggle_feature_flag_v1(jsonb_build_object(
  'feature_flag_id', current_setting('test.feature_flag_gate.flag'), 'enabled', false))->>'idempotent')::boolean,
  'platform admin with an org can keep a global flag disabled');

-- Mutation: rejecting platform users with an org breaks engagement on an off flag.
SELECT ok((api.engage_kill_switch_v1(jsonb_build_object(
  'feature_flag_id', current_setting('test.feature_flag_gate.flag'), 'reason', 'Platform engagement'))->>'ok')::boolean,
  'platform admin with an org can engage the kill switch on an off flag');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.feature_flag_gate.orgless'), true),
       set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.feature_flag_gate.orgless'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- Mutation: requiring an org in the scope resolver breaks create for this admin.
SELECT ok((api.create_feature_flag_v1(jsonb_build_object(
  'flag_key', 'pgtap.created.' || current_setting('test.feature_flag_gate.orgless')))->>'ok')::boolean,
  'platform admin without an org can create a flag');

-- Mutation: requiring an org in the scope resolver breaks the idempotent toggle.
SELECT ok((api.toggle_feature_flag_v1(jsonb_build_object(
  'feature_flag_id', current_setting('test.feature_flag_gate.flag'), 'enabled', false))->>'idempotent')::boolean,
  'platform admin without an org can keep a global flag disabled');

-- Mutation: requiring an org in the scope resolver breaks engagement on an off flag.
SELECT ok((api.engage_kill_switch_v1(jsonb_build_object(
  'feature_flag_id', current_setting('test.feature_flag_gate.flag'), 'reason', 'Platform engagement'))->>'ok')::boolean,
  'platform admin without an org can engage the kill switch on an off flag');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.feature_flag_gate.unprivileged'), true),
       set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.feature_flag_gate.unprivileged'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- Mutation: dropping the global capability check permits writes by a platform reader.
SELECT throws_ok($$SELECT api.create_feature_flag_v1(jsonb_build_object(
  'flag_key', 'pgtap.denied.' || current_setting('test.feature_flag_gate.unprivileged')))$$,
  '42501', 'Capability denied: feature_flags.write', 'platform scope alone does not grant flag writes');
RESET ROLE;

SELECT finish();
ROLLBACK;
