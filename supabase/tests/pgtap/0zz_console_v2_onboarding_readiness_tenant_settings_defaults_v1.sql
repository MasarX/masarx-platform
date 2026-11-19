-- pgTAP: Console V2 onboarding readiness tenant settings defaults.
-- Proves newly required settings categories are materialized for tenant scope
-- instead of relying on global fallback while readiness requires scope rows.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

CREATE TEMP TABLE first_tenant_readiness_subject AS
SELECT o.id
  FROM public.organizations o
 WHERE o.name ILIKE 'First Tenant Readiness Logistics%'
   AND o.id <> '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY o.created_at DESC, o.id
 LIMIT 1;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'support_policy'
      AND requires_global_default IS TRUE
      AND allowed_scopes ? 'tenant'
  ),
  'support_policy is a tenant-allowed required settings default'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'workflow_binding_defaults'
      AND requires_global_default IS TRUE
      AND allowed_scopes ? 'tenant'
  ),
  'workflow_binding_defaults is a tenant-allowed required settings default'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    CROSS JOIN (
      VALUES
        ('support_policy'),
        ('workflow_binding_defaults')
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
  'all existing organizations have tenant materialized support/workflow defaults'
);

SELECT is(
  public.resolve_settings('support_policy', 'tenant', (
    SELECT o.id
    FROM public.organizations o
    WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY o.created_at DESC
    LIMIT 1
  ))->>'recent_decisions_limit',
  '5',
  'tenant support_policy resolves with the expected decision limit'
);

SELECT is(
  public.resolve_settings('workflow_binding_defaults', 'tenant', (
    SELECT o.id
    FROM public.organizations o
    WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY o.created_at DESC
    LIMIT 1
  ))->>'default_scope_type',
  'tenant',
  'tenant workflow_binding_defaults resolves tenant default scope'
);

DO $first_tenant$
DECLARE
  v_tenant_id UUID;
BEGIN
  SELECT id INTO v_tenant_id
    FROM first_tenant_readiness_subject
   LIMIT 1;

  IF v_tenant_id IS NULL THEN
    PERFORM skip(1, 'first-tenant fixture not present; generic tenant default coverage remains enforced');
  ELSE
    PERFORM ok(
      NOT (
        COALESCE(
          public.onboarding_readiness_snapshot_v1(
            'tenant',
            v_tenant_id
          )->'settings_defaults'->'missing_categories',
          '[]'::jsonb
        ) ?| ARRAY['support_policy', 'workflow_binding_defaults']
      ),
      'first-tenant onboarding readiness no longer reports support/workflow defaults missing'
    );
  END IF;
END;
$first_tenant$;

SELECT * FROM finish();

ROLLBACK;
