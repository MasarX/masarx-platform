-- pgTAP: combined onboarding readiness includes label design readiness.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

CREATE OR REPLACE FUNCTION pg_temp.test_onboarding_workflow_plugin_label_readiness_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_label JSONB;
  v_snapshot JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (
    v_org,
    'Onboarding Workflow Plugin Label Probe Org',
    'onboarding-wpl-probe-' || left(replace(v_org::text, '-', ''), 12)
  );

  RETURN NEXT has_function(
    'public',
    'onboarding_label_design_readiness_v1',
    ARRAY['text', 'uuid'],
    'onboarding_label_design_readiness_v1 exists'
  );

  RETURN NEXT ok(
    NOT has_function_privilege(
      'authenticated',
      'public.onboarding_label_design_readiness_v1(text,uuid)',
      'EXECUTE'
    ),
    'authenticated cannot execute the label readiness helper directly'
  );

  SELECT public.onboarding_label_design_readiness_v1('tenant', v_org)
    INTO v_label;

  RETURN NEXT ok(
    jsonb_typeof(v_label) = 'object',
    'label readiness helper returns a JSON object'
  );

  RETURN NEXT ok(
    COALESCE((v_label->>'required_count')::int, 0) >= 3,
    'label readiness helper checks label design, render policy, and print profile categories'
  );

  RETURN NEXT ok(
    v_label ? 'renderer_provider'
    AND COALESCE(v_label #>> '{renderer_provider,invoke_secret}', '') <> 'EXAMPLE_PASSWORD',
    'label readiness helper returns provider status without exposing renderer secrets'
  );

  SELECT public.onboarding_readiness_snapshot_v1('tenant', v_org)
    INTO v_snapshot;

  RETURN NEXT ok(
    v_snapshot ? 'label_design',
    'onboarding readiness snapshot includes label_design component'
  );

  RETURN NEXT ok(
    COALESCE(v_snapshot #>> '{label_design,items}', '') LIKE '%label_design%',
    'onboarding readiness snapshot carries label design item readback'
  );

  RETURN NEXT ok(
    COALESCE(v_snapshot::text, '') NOT LIKE '%EXAMPLE_PASSWORD%',
    'onboarding readiness snapshot keeps label provider secrets redacted'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_onboarding_workflow_plugin_label_readiness_v1();

SELECT * FROM finish();

ROLLBACK;
