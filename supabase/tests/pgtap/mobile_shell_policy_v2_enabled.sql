-- Test Suite: mobile_shell_policy (V2 cutover) — 202605131600
--
-- Validates the mobile shell-level cutover policy:
--   (a) Category registered in settings_category_registry with hard_fail / branches
--   (b) Schema v1 active in schema_registry
--   (c) Global default seeded with v2_enabled=false (production stays on V1)
--   (d) Resolver wrapper public.resolve_mobile_shell_policy_row returns
--       the global default at scope_type='global'
--   (e) FE-facing envelope public.resolve_mobile_shell_policy returns
--       a JSONB envelope with v2_enabled=false by default
--   (f) Tenant-scoped override flips v2_enabled to TRUE only for that
--       tenant (ladder precedence: tenant > global)
--   (g) Unauthenticated caller falls back to the global default
--       (no leak of tenant-scoped overrides)
--   (h) Malformed policy payload defaults to v2_enabled=FALSE (fail-safe)
--   (i) GRANT/REVOKE posture: authenticated + service_role only

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

-- ----------------------------------------------------------------------------
-- (a) Category registry
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_shell_policy'
      AND requires_schema
      AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_shell_policy category registered with hard_fail + branches resource scope'
);

-- ----------------------------------------------------------------------------
-- (b) Schema registry
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.schema_registry
    WHERE category = 'mobile_shell_policy'
      AND version = 1
      AND is_active
      AND schema->'properties' ? 'v2_enabled'
  ),
  'mobile_shell_policy schema v1 active and declares v2_enabled property'
);

-- ----------------------------------------------------------------------------
-- (c) settings_versions — global default seeded with v2_enabled=false
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_shell_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND (value->>'v2_enabled')::boolean = FALSE
      AND (value->>'version')::int = 1
  ),
  'mobile_shell_policy has approved global default with v2_enabled=FALSE'
);

-- ----------------------------------------------------------------------------
-- (d) Resolver row wrapper — returns the global default for empty context
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_mobile_shell_policy_row('{}'::jsonb) r
    WHERE r.scope_type = 'global'
      AND r.value IS NOT NULL
      AND (r.value->>'v2_enabled')::boolean = FALSE
  ),
  'resolve_mobile_shell_policy_row returns global default (v2_enabled=false)'
);

-- ----------------------------------------------------------------------------
-- (e) FE envelope resolver — public.resolve_mobile_shell_policy default
-- ----------------------------------------------------------------------------

SELECT ok(
  (public.resolve_mobile_shell_policy('driver', '{}'::jsonb)->>'v2_enabled')::boolean = FALSE,
  'resolve_mobile_shell_policy envelope returns v2_enabled=false by default'
);

SELECT ok(
  public.resolve_mobile_shell_policy('driver', '{}'::jsonb) ? 'resolved_at',
  'resolve_mobile_shell_policy envelope includes resolved_at timestamp'
);

SELECT ok(
  public.resolve_mobile_shell_policy('driver', '{}'::jsonb)->>'scope_type' = 'global',
  'resolve_mobile_shell_policy envelope reports scope_type=global for default fall-through'
);

-- ----------------------------------------------------------------------------
-- (f) Tenant-scoped override: ladder precedence tenant > global
--
--     Seed a tenant-scoped row with v2_enabled=TRUE and verify
--     resolve_settings_row_from_policy_context_v1 picks it up when a
--     tenant context is passed. We use a synthetic tenant id rather
--     than depending on existing test fixture tenants.
-- ----------------------------------------------------------------------------

SELECT set_config('test.mobile_rollout_tenant', gen_random_uuid()::text, true);
SELECT set_config('test.mobile_rollout_actor', gen_random_uuid()::text, true);
INSERT INTO public.organizations (id, name, slug)
VALUES (current_setting('test.mobile_rollout_tenant')::uuid, 'Mobile rollout tenant', 'mobile-rollout-fixture');
INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
VALUES (current_setting('test.mobile_rollout_actor')::uuid, current_setting('test.mobile_rollout_tenant')::uuid,
  'mobile-rollout@example.test', 'Mobile rollout fixture driver', 'driver', 'active', 'tenant');

SELECT public.upsert_settings_value_v1(
  'mobile_shell_policy', 'tenant', current_setting('test.mobile_rollout_tenant')::uuid,
  '{"version":1,"v2_enabled":true}'::jsonb, 1, 'Fixture tenant rollout opt-in'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_mobile_shell_policy_row(
      jsonb_build_object('organization_id', current_setting('test.mobile_rollout_tenant'))
    ) r
    WHERE r.scope_type = 'tenant'
      AND r.scope_id = current_setting('test.mobile_rollout_tenant')::uuid
      AND r.value->'v2_enabled' = 'true'::jsonb
  ),
  'rollout row resolves the opted-in tenant'
);

SELECT is(auth.uid(), NULL::uuid, 'fixture starts without a signed-in user');
SELECT is(
  public.resolve_mobile_shell_policy('driver', jsonb_build_object(
    'organization_id', current_setting('test.mobile_rollout_tenant')
  ))->'v2_enabled',
  'false'::jsonb,
  'unauthenticated context cannot opt into another tenant rollout'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.mobile_rollout_actor'), true);
SELECT set_config('request.jwt.claims',
  jsonb_build_object('role', 'authenticated', 'sub', current_setting('test.mobile_rollout_actor'))::text, true);
SET LOCAL ROLE authenticated;
SELECT is(
  public.resolve_mobile_shell_policy('driver', '{}'::jsonb)->'v2_enabled',
  'true'::jsonb,
  'tenant opt-in enables V2 when all component policies resolve'
);
RESET ROLE;

-- Inject a malformed stored value to exercise fail-closed readback independently of schema validation.
UPDATE public.settings_versions v SET value = jsonb_set(v.value, '{v2_enabled}', '"maybe"')
FROM public.settings s
WHERE s.category = 'mobile_shell_policy' AND s.scope_type = 'tenant'
  AND s.scope_id = current_setting('test.mobile_rollout_tenant')::uuid
  AND v.id = s.settings_version_id AND v.scope_hash = s.scope_hash;
UPDATE public.settings
SET cached_value = jsonb_set(cached_value, '{v2_enabled}', '"maybe"')
WHERE category = 'mobile_shell_policy' AND scope_type = 'tenant'
  AND scope_id = current_setting('test.mobile_rollout_tenant')::uuid;
DELETE FROM public.settings_cache WHERE cache_key LIKE 'mobile_shell_policy:%';

SET LOCAL ROLE authenticated;
SELECT is(
  public.resolve_mobile_shell_policy('driver', '{}'::jsonb)->'v2_enabled',
  'false'::jsonb,
  'malformed rollout opt-in keeps Mobile V2 off'
);
RESET ROLE;

-- ----------------------------------------------------------------------------
-- (i) GRANT posture — only authenticated + service_role may execute
-- ----------------------------------------------------------------------------

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.resolve_mobile_shell_policy(text, jsonb)',
    'EXECUTE'
  ),
  'authenticated role has EXECUTE on public.resolve_mobile_shell_policy(text, jsonb)'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.resolve_mobile_shell_policy(text, jsonb)',
    'EXECUTE'
  ),
  'anon role does NOT have EXECUTE on public.resolve_mobile_shell_policy(text, jsonb)'
);

SELECT * FROM finish();
ROLLBACK;
