-- pgTAP: Console V2 onboarding readiness Mobile V2 tenant defaults.
-- Proves Mobile V2 policy categories are part of tenant readiness and are
-- materialized for existing tenants through canonical settings defaults.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

SELECT set_config(
  'test.first_tenant_id',
  (
    SELECT candidate.id::text
    FROM (
      SELECT o.id, 0 AS priority, o.created_at
      FROM public.organizations o
      WHERE o.name ILIKE 'First Tenant Readiness Logistics%'
        AND o.id <> '00000000-0000-0000-0000-000000000000'::uuid
      UNION ALL
      SELECT o.id, 1 AS priority, o.created_at
      FROM public.organizations o
      WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
    ) AS candidate
    ORDER BY candidate.priority, candidate.created_at DESC
    LIMIT 1
  ),
  TRUE
);

SELECT bag_has(
  $$ SELECT category FROM public.onboarding_policy_categories_v1(public.resolve_saas_onboarding_policy_v1(), 'tenant') $$,
  $$ VALUES
    ('mobile_auth_policy'),
    ('mobile_cash_policy'),
    ('mobile_damage_severity_policy'),
    ('mobile_eor_policy'),
    ('mobile_incident_policy'),
    ('mobile_linehaul_policy'),
    ('mobile_loader_policy'),
    ('mobile_pickup_policy'),
    ('mobile_pod_policy'),
    ('mobile_pre_shift_gate_policy'),
    ('mobile_returns_policy'),
    ('mobile_shell_policy'),
    ('mobile_sortation_policy'),
    ('mobile_tasks_policy')
  $$,
  'Mobile V2 policy categories are tenant readiness defaults'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    CROSS JOIN (
      VALUES
        ('mobile_auth_policy'),
        ('mobile_cash_policy'),
        ('mobile_damage_severity_policy'),
        ('mobile_eor_policy'),
        ('mobile_incident_policy'),
        ('mobile_linehaul_policy'),
        ('mobile_loader_policy'),
        ('mobile_pickup_policy'),
        ('mobile_pod_policy'),
        ('mobile_pre_shift_gate_policy'),
        ('mobile_returns_policy'),
        ('mobile_shell_policy'),
        ('mobile_sortation_policy'),
        ('mobile_tasks_policy')
    ) AS required(category)
    WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM public.settings s
        WHERE s.category = required.category
          AND s.scope_type = 'tenant'
          AND s.scope_id = o.id
      )
  ),
  'all existing organizations have tenant materialized Mobile V2 defaults'
);

SELECT is(
  public.resolve_settings(
    'mobile_cash_policy',
    'tenant',
    current_setting('test.first_tenant_id')::uuid
  )->>'currency',
  'SAR',
  'first tenant mobile_cash_policy resolves from tenant materialized settings'
);

SELECT ok(
  (
    public.resolve_settings(
      'mobile_pod_policy',
      'tenant',
      current_setting('test.first_tenant_id')::uuid
    )->'fail_reasons'
  ) @> '[{"code":"recipient_unavailable"}]'::jsonb,
  'first tenant mobile_pod_policy preserves row-driven fail reasons'
);

SELECT is(
  public.resolve_settings(
    'mobile_shell_policy',
    'tenant',
    current_setting('test.first_tenant_id')::uuid
  )->>'v2_enabled',
  'false',
  'materialized tenant defaults keep Mobile V2 off without explicit opt-in'
);

SELECT is(
  public.resolve_settings(
    'mobile_shell_policy', 'tenant', current_setting('test.first_tenant_id')::uuid
  )->>'rollout_cohort',
  NULL::text,
  'materialized tenant defaults do not assign a rollout cohort'
);

SELECT is(
  (
    SELECT r.value->>'v2_enabled'
    FROM public.resolve_mobile_shell_policy_row(
      jsonb_build_object('organization_id', current_setting('test.first_tenant_id')::uuid)
    ) AS r
    LIMIT 1
  ),
  'false',
  'mobile shell policy row resolver keeps Mobile V2 off without opt-in'
);

SELECT is(
  public.onboarding_readiness_snapshot_v1(
    'tenant',
    current_setting('test.first_tenant_id')::uuid
  )->'settings_defaults'->>'status',
  'healthy',
  'first tenant settings defaults readiness is healthy after Mobile V2 defaults backfill'
);

SELECT is(
  public.onboarding_readiness_snapshot_v1(
    'tenant',
    current_setting('test.first_tenant_id')::uuid
  )->'settings_defaults'->'missing_categories',
  '[]'::jsonb,
  'first tenant settings defaults readiness has no missing categories'
);

SELECT * FROM finish();

ROLLBACK;
