-- pgTAP: Console V2 tenant provider defaults
-- Provider catalog rows are required before first-tenant credential setup can
-- be completed from Console V2. pgTAP proves the backend contract only; the
-- operator journey is still verified separately through Browser clicks.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

SELECT has_function(
  'public',
  'onboarding_provider_defaults_v1',
  ARRAY['jsonb'],
  'onboarding_provider_defaults_v1(jsonb) is registered'
);

SELECT has_function(
  'public',
  'bootstrap_tenant_provider_defaults_v1',
  ARRAY['uuid', 'jsonb', 'text'],
  'bootstrap_tenant_provider_defaults_v1(uuid,jsonb,text) is registered'
);

SELECT ok(
  pg_get_functiondef('public.bootstrap_tenant_onboarding_v1(uuid,text)'::regprocedure)
    LIKE '%bootstrap_tenant_provider_defaults_v1%',
  'tenant onboarding bootstrap invokes provider-default materialization'
);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_tenant_provider_defaults_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000087100001';
  v_result JSONB;
  v_count_one INTEGER;
  v_count_two INTEGER;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Provider Defaults Org', 'console-v2-provider-defaults')
  ON CONFLICT (id) DO NOTHING;

  v_result := public.bootstrap_tenant_provider_defaults_v1(
    v_org,
    '{}'::jsonb,
    'pgtap-provider-defaults'
  );

  SELECT COUNT(*)
    INTO v_count_one
    FROM public.providers
   WHERE organization_id = v_org;

  RETURN NEXT ok(
    COALESCE((v_result->>'ok')::boolean, FALSE)
    AND v_count_one >= 7,
    'provider bootstrap materializes the default provider catalog'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.providers
       WHERE organization_id = v_org
         AND provider_type = 'webhook'
         AND metadata #>> ARRAY['onboarding', 'default_key'] = 'default-shipment-webhook-intake'
    ),
    'provider bootstrap creates the webhook intake provider needed before credential setup'
  );

  RETURN NEXT ok(
    ARRAY['comms', 'delivery', 'geocoding', 'payment', 'routing', 'webhook'] <@ (
      SELECT array_agg(DISTINCT provider_type ORDER BY provider_type)
        FROM public.providers
       WHERE organization_id = v_org
    ),
    'provider bootstrap covers first-tenant integration, routing, comms, payment, and delivery provider types'
  );

  PERFORM public.bootstrap_tenant_provider_defaults_v1(
    v_org,
    '{}'::jsonb,
    'pgtap-provider-defaults-repeat'
  );

  SELECT COUNT(*)
    INTO v_count_two
    FROM public.providers
   WHERE organization_id = v_org;

  RETURN NEXT is(
    v_count_two,
    v_count_one,
    'provider bootstrap is idempotent for repeated readiness repair runs'
  );
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_tenant_provider_defaults_v1();

SELECT * FROM finish();
ROLLBACK;
