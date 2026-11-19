-- pgTAP: Tenant onboarding service catalog defaults for Console V2 shipment creation

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(15);

SELECT has_function(
  'public',
  'onboarding_service_catalog_defaults_v1',
  ARRAY['jsonb'],
  'public.onboarding_service_catalog_defaults_v1 exists'
);

SELECT has_function(
  'public',
  'bootstrap_tenant_service_catalog_defaults_v1',
  ARRAY['uuid', 'jsonb', 'text'],
  'public.bootstrap_tenant_service_catalog_defaults_v1 exists'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.onboarding_service_catalog_defaults_v1(jsonb)',
    'EXECUTE'
  ),
  'service_role can execute service catalog default resolver'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.bootstrap_tenant_service_catalog_defaults_v1(uuid,jsonb,text)',
    'EXECUTE'
  ),
  'service_role can execute tenant service catalog bootstrap'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.bootstrap_tenant_service_catalog_defaults_v1(uuid,jsonb,text)',
    'EXECUTE'
  ),
  'authenticated cannot execute tenant service catalog bootstrap directly'
);

CREATE OR REPLACE FUNCTION pg_temp.exercise_tenant_onboarding_service_catalog_defaults_v1()
RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_org_slug TEXT := 'onboarding-catalog-' || left(replace(v_org::text, '-', ''), 12);
  v_bootstrap JSONB;
  v_disabled JSONB;
  v_trigger_branch_count INTEGER := 0;
  v_trigger_level_keys TEXT := '';
  v_trigger_offering_keys TEXT := '';
  v_trigger_offering_count INTEGER := 0;
  v_after_level_count INTEGER := 0;
  v_after_offering_count INTEGER := 0;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Onboarding Catalog Org', v_org_slug);

  SELECT count(*)::INTEGER
    INTO v_trigger_branch_count
    FROM public.branches b
   WHERE b.organization_id = v_org
     AND b.code = 'main'
     AND b.is_active IS TRUE;

  SELECT COALESCE(string_agg(sl.key, ',' ORDER BY sl.key), '')
    INTO v_trigger_level_keys
    FROM public.service_levels sl
   WHERE sl.organization_id = v_org
     AND sl.key IN ('standard', 'express', 'same_day')
     AND sl.is_active IS TRUE;

  SELECT
    COALESCE(string_agg(so.metadata #>> ARRAY['onboarding', 'default_key'], ',' ORDER BY so.metadata #>> ARRAY['onboarding', 'default_key']), ''),
    count(*)::INTEGER
    INTO v_trigger_offering_keys, v_trigger_offering_count
    FROM public.service_offerings so
    JOIN public.service_levels sl ON sl.id = so.service_level_id
    JOIN public.branches b ON b.id = so.branch_id
   WHERE sl.organization_id = v_org
     AND b.organization_id = v_org
     AND so.zone_id IS NULL
     AND so.is_active IS TRUE
     AND so.metadata #>> ARRAY['onboarding', 'default_key'] IN (
       'standard-main',
       'express-main',
       'same-day-main'
     );

  v_bootstrap := public.bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:tenant-service-catalog-idempotence'
  );

  SELECT count(*)::INTEGER
    INTO v_after_level_count
    FROM public.service_levels sl
   WHERE sl.organization_id = v_org
     AND sl.key IN ('standard', 'express', 'same_day');

  SELECT count(*)::INTEGER
    INTO v_after_offering_count
    FROM public.service_offerings so
    JOIN public.service_levels sl ON sl.id = so.service_level_id
    JOIN public.branches b ON b.id = so.branch_id
   WHERE sl.organization_id = v_org
     AND b.organization_id = v_org
     AND so.zone_id IS NULL
     AND so.metadata #>> ARRAY['onboarding', 'default_key'] IN (
       'standard-main',
       'express-main',
       'same-day-main'
     );

  v_disabled := public.bootstrap_tenant_service_catalog_defaults_v1(
    v_org,
    '{"service_catalog_defaults":{"enabled":false}}'::jsonb,
    'pgtap:disabled'
  );

  RETURN jsonb_build_object(
    'trigger_branch_count', v_trigger_branch_count,
    'trigger_level_keys', v_trigger_level_keys,
    'trigger_offering_keys', v_trigger_offering_keys,
    'trigger_offering_count', v_trigger_offering_count,
    'after_level_count', v_after_level_count,
    'after_offering_count', v_after_offering_count,
    'bootstrap_service_catalog_ok', COALESCE((v_bootstrap #>> ARRAY['service_catalog_defaults', 'ok'])::BOOLEAN, FALSE),
    'bootstrap_offering_count', COALESCE((v_bootstrap #>> ARRAY['service_catalog_defaults', 'service_offerings_created_or_found'])::INTEGER, 0),
    'bootstrap_has_workflow_bindings', v_bootstrap ? 'workflow_bindings',
    'bootstrap_has_integration_plugins', v_bootstrap ? 'integration_plugins',
    'bootstrap_has_readiness', v_bootstrap ? 'readiness',
    'disabled_enabled', COALESCE((v_disabled->>'enabled')::BOOLEAN, TRUE)
  );
END;
$function$;

CREATE TEMP TABLE tenant_onboarding_service_catalog_defaults_result AS
SELECT pg_temp.exercise_tenant_onboarding_service_catalog_defaults_v1() AS result;

SELECT is(
  (result->>'trigger_branch_count')::INTEGER,
  1,
  'tenant organization insert provisions the default branch through onboarding'
)
FROM tenant_onboarding_service_catalog_defaults_result;

SELECT is(
  result->>'trigger_level_keys',
  'express,same_day,standard',
  'tenant organization insert provisions the default service levels'
)
FROM tenant_onboarding_service_catalog_defaults_result;

SELECT is(
  result->>'trigger_offering_keys',
  'express-main,same-day-main,standard-main',
  'tenant organization insert provisions the default service offerings'
)
FROM tenant_onboarding_service_catalog_defaults_result;

SELECT ok(
  (result->>'bootstrap_service_catalog_ok')::BOOLEAN,
  'canonical tenant bootstrap reports service catalog defaults'
)
FROM tenant_onboarding_service_catalog_defaults_result;

SELECT is(
  (result->>'after_level_count')::INTEGER,
  3,
  're-running tenant bootstrap keeps the default service level set idempotent'
)
FROM tenant_onboarding_service_catalog_defaults_result;

SELECT is(
  (result->>'after_offering_count')::INTEGER,
  3,
  're-running tenant bootstrap keeps the default offering set idempotent'
)
FROM tenant_onboarding_service_catalog_defaults_result;

SELECT ok(
  NOT (result->>'disabled_enabled')::BOOLEAN,
  'service catalog defaults can be disabled by onboarding policy'
)
FROM tenant_onboarding_service_catalog_defaults_result;

SELECT ok(
  (result->>'bootstrap_has_workflow_bindings')::BOOLEAN,
  'tenant onboarding still reports workflow binding defaults'
)
FROM tenant_onboarding_service_catalog_defaults_result;

SELECT ok(
  (result->>'bootstrap_has_integration_plugins')::BOOLEAN,
  'tenant onboarding still reports integration plugin defaults'
)
FROM tenant_onboarding_service_catalog_defaults_result;

SELECT ok(
  (result->>'bootstrap_has_readiness')::BOOLEAN,
  'tenant onboarding still reports readiness snapshot'
)
FROM tenant_onboarding_service_catalog_defaults_result;

SELECT * FROM finish();

ROLLBACK;
