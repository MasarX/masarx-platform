-- pgTAP: onboarding Mobile V2 shell policy bootstrap.
-- Proves both tenant bootstrap and global fallback keep Mobile V2 off.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

SELECT set_config('test.mobile_v2_bootstrap_org_id', gen_random_uuid()::text, TRUE);
SELECT set_config('app.organization_onboarding_source', 'tenant_signup_review_apply_v1', TRUE);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  current_setting('test.mobile_v2_bootstrap_org_id')::uuid,
  'pgTAP Mobile V2 Shell Bootstrap Tenant',
  'pgtap-mobile-v2-shell-' || left(replace(current_setting('test.mobile_v2_bootstrap_org_id'), '-', ''), 16)
);

SELECT set_config('app.organization_onboarding_source', '', TRUE);

SELECT ok(
  (
    public.bootstrap_scope_settings_defaults_v1(
      'tenant',
      current_setting('test.mobile_v2_bootstrap_org_id')::uuid,
      public.resolve_saas_onboarding_policy_v1(),
      'pgtap:mobile-v2-shell-policy-bootstrap'
    )->'seeded_categories'
  ) ? 'mobile_shell_policy',
  'tenant onboarding bootstrap materializes mobile_shell_policy'
);

SELECT is(
  public.resolve_settings(
    'mobile_shell_policy',
    'tenant',
    current_setting('test.mobile_v2_bootstrap_org_id')::uuid
  )->>'v2_enabled',
  'false',
  'new tenant bootstrap keeps Mobile V2 off'
);

SELECT is(
  public.resolve_settings(
    'mobile_shell_policy',
    'tenant',
    current_setting('test.mobile_v2_bootstrap_org_id')::uuid
  )->>'rollout_cohort',
  NULL::text,
  'tenant bootstrap uses the canonical rollout schema'
);

SELECT is(
  (
    SELECT r.value->>'v2_enabled'
    FROM public.resolve_mobile_shell_policy_row(
      jsonb_build_object('organization_id', current_setting('test.mobile_v2_bootstrap_org_id')::uuid)
    ) AS r
    LIMIT 1
  ),
  'false',
  'row resolver keeps Mobile V2 off for new tenant context'
);

SELECT is(
  (
    SELECT r.value->>'v2_enabled'
    FROM public.resolve_mobile_shell_policy_row('{}'::jsonb) AS r
    LIMIT 1
  ),
  'false',
  'empty policy context remains fail-closed on the global Mobile shell default'
);

SELECT bag_has(
  $$ SELECT category FROM public.onboarding_policy_categories_v1(public.resolve_saas_onboarding_policy_v1(), 'tenant') $$,
  $$ VALUES
    ('mobile_damage_severity_policy'),
    ('mobile_incident_policy'),
    ('mobile_shell_policy')
  $$,
  'Mobile V2 shell and late policy categories are tenant onboarding defaults'
);

SELECT is(
  public.onboarding_readiness_snapshot_v1(
    'tenant',
    current_setting('test.mobile_v2_bootstrap_org_id')::uuid
  )->'settings_defaults'->>'status',
  'healthy',
  'new tenant settings readiness is healthy after Mobile V2 shell bootstrap'
);

SELECT is(
  public.onboarding_readiness_snapshot_v1(
    'tenant',
    current_setting('test.mobile_v2_bootstrap_org_id')::uuid
  )->'settings_defaults'->'missing_categories',
  '[]'::jsonb,
  'new tenant readiness has no missing settings categories after bootstrap'
);

SELECT * FROM finish();

ROLLBACK;
