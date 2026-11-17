-- pgTAP: combined onboarding readiness includes label design readiness.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(25);

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


-- Resolver failures and malformed settings are isolated transaction-local fixtures.
-- The real readiness helper executes; original dependency definitions are restored below.
DO $fixtures$
BEGIN
  PERFORM set_config('test.label_readiness.original_settings',
    pg_get_functiondef('public.resolve_settings_row(text,text,uuid)'::regprocedure), TRUE);
  PERFORM set_config('test.label_readiness.original_policy',
    pg_get_functiondef('public.resolve_saas_onboarding_policy_v1()'::regprocedure), TRUE);
  PERFORM set_config('test.label_readiness.original_provider',
    pg_get_functiondef('public.resolve_label_renderer_invoke_config_v1(uuid)'::regprocedure), TRUE);
END;
$fixtures$;

CREATE OR REPLACE FUNCTION public.resolve_saas_onboarding_policy_v1()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fixture$ SELECT current_setting('test.label_readiness.policy')::jsonb $fixture$;

CREATE OR REPLACE FUNCTION public.resolve_settings_row(
  p_category TEXT, p_scope_type TEXT, p_scope_id UUID)
RETURNS TABLE(settings_id UUID, settings_version_id UUID, scope_type TEXT,
  scope_id UUID, value JSONB, version INT, scope_path JSONB)
LANGUAGE sql SECURITY DEFINER SET search_path TO public, extensions, pg_temp
AS $fixture$
  SELECT NULL::uuid, NULL::uuid, p_scope_type, p_scope_id,
         current_setting('test.label_readiness.setting')::jsonb, 1, '[]'::jsonb
$fixture$;

CREATE OR REPLACE FUNCTION public.resolve_label_renderer_invoke_config_v1(
  p_organization_id UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $fixture$
BEGIN
  IF current_setting('test.label_readiness.provider', TRUE) = 'error' THEN
    RAISE EXCEPTION 'provider-secret-sentinel-652';
  END IF;
  RETURN '{"invoke_url":"https://provider.invalid/private","invoke_secret":"provider-secret-sentinel-652","provider_name":"fixture"}'::jsonb;
END;
$fixture$;

DO $configure$
BEGIN
  PERFORM set_config('test.label_readiness.policy',
    '{"label_design":{"required_categories":["label_design"],"require_renderer_provider":false,"require_printer_certification":false}}', TRUE);
  PERFORM set_config('test.label_readiness.setting', '{}', TRUE);
END;
$configure$;
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'status', 'blocked',
  'missing templates key is blocked, not SQL NULL success');
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.setting', '{"templates":null}', TRUE); END; $configure$;
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'status', 'blocked',
  'JSON null templates is blocked');
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.setting', 'null', TRUE); END; $configure$;
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'present_count', '0',
  'null settings are missing');
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.setting', '{"templates":{}}', TRUE); END; $configure$;
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'status', 'warning',
  'optional missing certification warns without blocking');

DO $configure$ BEGIN PERFORM set_config('test.label_readiness.policy',
  '{"label_design":{"required_categories":[],"require_renderer_provider":true,"require_printer_certification":false}}', TRUE); END; $configure$;
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.provider', 'error', TRUE); END; $configure$;
SELECT ok(public.onboarding_label_design_readiness_v1('global', NULL)::text NOT LIKE '%provider-secret-sentinel-652%',
  'provider exception text cannot disclose credentials');
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)#>>'{renderer_provider,error}',
  'renderer_provider_configuration_unavailable', 'provider diagnostic is fixed and sanitized');
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'status', 'warning',
  'missing renderer remains a warning under the recovered contract');
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.provider', 'ready', TRUE); END; $configure$;
SELECT ok(public.onboarding_label_design_readiness_v1('global', NULL)::text NOT LIKE '%provider-secret-sentinel-652%',
  'successful provider readback does not expose the secret');
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.policy',
  '{"label_design":{"required_categories":[],"require_renderer_provider":false,"require_printer_certification":true}}', TRUE); END; $configure$;
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'status', 'blocked',
  'required missing certification blocks');
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'required_count', '0',
  'explicit empty categories remain empty instead of restoring defaults');
SELECT ok(NOT has_function_privilege('anon',
  'public.onboarding_label_design_readiness_v1(text,uuid)', 'EXECUTE'),
  'anonymous cannot execute label readiness helper');
SELECT ok(has_function_privilege('service_role',
  'public.onboarding_label_design_readiness_v1(text,uuid)', 'EXECUTE'),
  'service role can execute label readiness helper');

-- Certification fixtures exercise helper shape handling, not persistence-schema acceptance.
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.policy',
  '{"label_design":{"required_categories":["label_print_profile"],"require_renderer_provider":false,"require_printer_certification":true}}', TRUE); END; $configure$;
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.setting',
  '{"profile_key":"fixture","dpi":203,"printer_certification":null}', TRUE); END; $configure$;
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'status', 'blocked',
  'required JSON null certification blocks');
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.setting',
  '{"profile_key":"fixture","dpi":203,"printer_certification":false}', TRUE); END; $configure$;
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'status', 'blocked',
  'required false certification blocks');
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.setting',
  '{"profile_key":"fixture","dpi":203,"printer_certification":7}', TRUE); END; $configure$;
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'status', 'blocked',
  'required numeric scalar certification blocks');
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.setting',
  '{"profile_key":"fixture","dpi":203,"printer_certification":"invalid"}', TRUE); END; $configure$;
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'status', 'blocked',
  'required string scalar certification blocks');
DO $configure$ BEGIN PERFORM set_config('test.label_readiness.setting',
  '{"profile_key":"fixture","dpi":203,"printer_certification":null,"certification":{"fixture":true}}', TRUE); END; $configure$;
SELECT is(public.onboarding_label_design_readiness_v1('global', NULL)->>'status', 'healthy',
  'null leading certification alias allows later nonempty object evidence');

DO $restore$
BEGIN
  EXECUTE current_setting('test.label_readiness.original_settings');
  EXECUTE current_setting('test.label_readiness.original_policy');
  EXECUTE current_setting('test.label_readiness.original_provider');
END;
$restore$;

SELECT * FROM finish();

ROLLBACK;
