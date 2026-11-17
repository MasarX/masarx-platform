-- pgTAP: Onboarding plugin baseline + readiness contract

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

CREATE OR REPLACE FUNCTION pg_temp.test_onboarding_plugin_baseline_readiness_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org_id UUID := gen_random_uuid();
  v_client_id UUID := gen_random_uuid();
  v_plugin_id UUID;
  v_task_id UUID;
  v_readiness JSONB;
  v_reconcile JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings_category_registry
      WHERE category = 'integration_plugin_baseline_policy'
    ),
    'integration_plugin_baseline_policy category is registered'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings
      WHERE category = 'integration_plugin_baseline_policy'
        AND scope_type = 'global'
        AND scope_id IS NULL
    ),
    'integration_plugin_baseline_policy global defaults are seeded'
  );

  RETURN NEXT ok(
    to_regprocedure('public.bootstrap_integration_plugin_defaults_v1(text,uuid,text)') IS NOT NULL,
    'bootstrap_integration_plugin_defaults_v1 exists'
  );

  RETURN NEXT ok(
    to_regprocedure('public.onboarding_integration_plugin_readiness_v1(text,uuid)') IS NOT NULL,
    'onboarding_integration_plugin_readiness_v1 exists'
  );

  RETURN NEXT ok(
    to_regprocedure('public.ui_get_onboarding_readiness_v1(text,uuid)') IS NOT NULL,
    'ui_get_onboarding_readiness_v1 exists'
  );

  RETURN NEXT has_function(
    'api',
    'ui_get_onboarding_readiness_v1',
    ARRAY['text','uuid'],
    'api.ui_get_onboarding_readiness_v1 wrapper exists'
  );

  INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (
    v_org_id,
    'Baseline Readiness Org',
    format('baseline-readiness-%s', left(replace(v_org_id::text, '-', ''), 8)),
    'Asia/Riyadh',
    'en',
    'active'
  );

  SELECT p.id
    INTO v_plugin_id
    FROM public.integration_plugins p
   WHERE p.organization_id = v_org_id
     AND p.plugin_key = 'default-shipment-webhook-intake'
   LIMIT 1;

  RETURN NEXT ok(
    v_plugin_id IS NOT NULL,
    'tenant bootstrap auto-installs default shipment webhook plugin'
  );

  RETURN NEXT is(
    (SELECT p.status FROM public.integration_plugins p WHERE p.id = v_plugin_id),
    'active',
    'auto-active baseline plugin reaches active status'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.integration_plugin_bindings b
      JOIN public.integration_plugin_versions pv ON pv.id = b.plugin_version_id
      WHERE pv.plugin_id = v_plugin_id
        AND b.scope_type = 'tenant'
        AND b.scope_id = v_org_id
        AND b.binding_type = 'webhook_source'
        AND b.enabled = TRUE
    ),
    'baseline plugin binding is materialized and enabled'
  );

  SELECT t.id
    INTO v_task_id
    FROM public.tasks t
   WHERE t.organization_id = v_org_id
     AND t.resource_type IN ('integration_plugin', 'integration_plugins')
     AND t.resource_id = v_plugin_id
     AND t.status NOT IN ('completed', 'canceled')
   LIMIT 1;

  RETURN NEXT is(
    v_task_id,
    NULL,
    'auto-active baseline plugin does not create a pending-credentials task'
  );

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_client_id,
    v_org_id,
    'Baseline Readiness Client',
    format('baseline-readiness-client-%s', left(replace(v_client_id::text, '-', ''), 8)),
    'active'
  );

  v_readiness := public.onboarding_integration_plugin_readiness_v1('tenant', v_org_id);

  RETURN NEXT is(
    v_readiness->>'ok',
    'true',
    'tenant plugin readiness is green when baseline plugin is active'
  );

  RETURN NEXT is(
    v_readiness->>'pending_credentials_count',
    '0',
    'tenant readiness reports no pending credentials for auto-active baseline'
  );

  v_reconcile := public.reconcile_saas_onboarding_defaults_v1(
    p_scope_type := 'tenant',
    p_scope_id := v_org_id,
    p_trigger_source := 'pgtap:onboarding_plugin_baseline'
  );

  RETURN NEXT ok(
    COALESCE((v_reconcile->'integration_plugins'->>'ok')::boolean, FALSE),
    'tenant reconcile returns integration plugin bootstrap result'
  );

  RETURN NEXT is(
    v_reconcile->'integration_plugins'->>'baseline_profile',
    'default',
    'tenant reconcile reports the canonical baseline plugin profile'
  );
END;
$function$;

SELECT * FROM pg_temp.test_onboarding_plugin_baseline_readiness_v1();

SELECT * FROM finish();
ROLLBACK;
