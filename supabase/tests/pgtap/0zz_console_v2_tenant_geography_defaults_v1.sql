-- pgTAP: Console V2 tenant onboarding materializes tenant-owned geography defaults.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT ok(
  to_regprocedure('public.onboarding_geography_defaults_v1(jsonb)') IS NOT NULL,
  'onboarding_geography_defaults_v1(jsonb) exists'
);

SELECT ok(
  to_regprocedure('public.bootstrap_tenant_geography_defaults_v1(uuid,jsonb,text)') IS NOT NULL,
  'bootstrap_tenant_geography_defaults_v1(uuid,jsonb,text) exists'
);

SELECT ok(
  public.resolve_saas_onboarding_policy_v1() #> '{geography_defaults,cities}' IS NOT NULL,
  'saas_onboarding_policy carries row-driven geography defaults'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.bootstrap_tenant_onboarding_v1(uuid,text)'))
    LIKE '%bootstrap_tenant_geography_defaults_v1%',
  'tenant bootstrap invokes geography defaults before readiness snapshot'
);

DO $do$
DECLARE
  v_org UUID := gen_random_uuid();
  v_result JSONB;
BEGIN
  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES (v_org, 'Console V2 Geography Defaults Org', 'console-v2-geo-' || left(v_org::text, 8), 'active');

  v_result := public.bootstrap_tenant_geography_defaults_v1(
    v_org,
    public.resolve_saas_onboarding_policy_v1(),
    'pgtap'
  );

  PERFORM ok(
    COALESCE((v_result->>'cities_created_or_found')::INT, 0) > 0,
    'geography bootstrap creates or finds tenant cities'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.canonical_districts d
        JOIN public.canonical_cities c ON c.id = d.city_id
       WHERE d.organization_id = v_org
         AND c.organization_id = v_org
         AND d.centroid_lat IS NOT NULL
         AND d.centroid_lng IS NOT NULL
    ),
    'geography bootstrap creates tenant districts with map centroids'
  );
END;
$do$;

SELECT * FROM finish();

ROLLBACK;
