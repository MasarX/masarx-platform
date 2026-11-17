-- Persisted composition only: JSON Schema admission is exercised by the JS contract
-- test against these exact fixtures. PostgreSQL does not claim JSON Schema validation.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(23);
CREATE OR REPLACE FUNCTION pg_temp.test_persisted_label_certification()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  v_scope TEXT := public.get_root_scope_type_key_v1();
  v_schema_version INTEGER;
  v_policy_version INTEGER;
  v_policy JSONB;
  v_fixture JSONB;
  v_read JSONB;
  v_status JSONB;
  v_fixtures JSONB := $profiles$[{"alias":"printer_certification","value":{"version":1,"profile_key":"certification-fixture","dpi":203,"printer_certification":{"printer":"fixture"}},"expected":"ready"},{"alias":"printer_certification","value":{"version":1,"profile_key":"certification-fixture","dpi":203,"printer_certification":[{"printer":"fixture"}]},"expected":"ready"},{"alias":"certification","value":{"version":1,"profile_key":"certification-fixture","dpi":203,"certification":{"printer":"fixture"}},"expected":"ready"},{"alias":"certification","value":{"version":1,"profile_key":"certification-fixture","dpi":203,"certification":[{"printer":"fixture"}]},"expected":"ready"},{"alias":"certified_printers","value":{"version":1,"profile_key":"certification-fixture","dpi":203,"certified_printers":{"printer":"fixture"}},"expected":"ready"},{"alias":"certified_printers","value":{"version":1,"profile_key":"certification-fixture","dpi":203,"certified_printers":[{"printer":"fixture"}]},"expected":"ready"},{"alias":"media.certification","value":{"version":1,"profile_key":"certification-fixture","dpi":203,"media":{"certification":{"printer":"fixture"}}},"expected":"ready"},{"alias":"media.certification","value":{"version":1,"profile_key":"certification-fixture","dpi":203,"media":{"certification":[{"printer":"fixture"}]}},"expected":"ready"},{"alias":"absent","value":{"version":1,"profile_key":"certification-fixture","dpi":203},"expected":"missing"},{"alias":"null","value":{"version":1,"profile_key":"certification-fixture","dpi":203,"printer_certification":null},"expected":"missing"},{"alias":"null-fallback","value":{"version":1,"profile_key":"certification-fixture","dpi":203,"printer_certification":null,"certification":{"printer":"fixture"}},"expected":"ready"}]$profiles$::jsonb;
BEGIN
  SELECT version INTO STRICT v_schema_version FROM public.schema_registry
   WHERE category = 'label_print_profile' AND is_active ORDER BY version DESC LIMIT 1;
  RETURN NEXT ok(v_schema_version > 1, 'certification schema is appended beyond the original version');
  SELECT version INTO STRICT v_policy_version FROM public.schema_registry
   WHERE category = 'saas_onboarding_policy' AND is_active ORDER BY version DESC LIMIT 1;
  SELECT value INTO STRICT v_policy
    FROM public.resolve_settings_row('saas_onboarding_policy', v_scope, NULL);
  -- Temporary deterministic policy through the real write seam; transaction rolls back.
  v_policy := jsonb_set(v_policy, '{label_design}',
    '{"required_categories":["label_print_profile"],"require_renderer_provider":false,"require_printer_certification":true}'::jsonb);
  PERFORM public.upsert_settings_value_v1('saas_onboarding_policy', v_scope, NULL,
    v_policy, v_policy_version, 'pgTAP transaction-only certification policy');
  FOR v_fixture IN SELECT value FROM jsonb_array_elements(v_fixtures)
  LOOP
    PERFORM public.upsert_settings_value_v1('label_print_profile', v_scope, NULL,
      v_fixture->'value', v_schema_version, 'pgTAP transaction-only full print profile');
    SELECT value INTO STRICT v_read
      FROM public.resolve_settings_row('label_print_profile', v_scope, NULL);
    RETURN NEXT is(v_read, v_fixture->'value', 'persisted full profile: ' || (v_fixture->>'alias'));
    v_status := public.onboarding_label_design_readiness_v1(v_scope, NULL);
    RETURN NEXT is(v_status->>'printer_certification_status', v_fixture->>'expected',
      'original readiness reads persisted alias: ' || (v_fixture->>'alias'));
  END LOOP;
END;
$test$;
SELECT * FROM pg_temp.test_persisted_label_certification();
SELECT * FROM finish();
ROLLBACK;
