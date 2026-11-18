-- pgTAP: Console V2 mapping tester RPC contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

SELECT has_function(
  'public',
  'ui_test_mapping_config_v1',
  ARRAY['uuid', 'jsonb'],
  'public.ui_test_mapping_config_v1(uuid, jsonb) is registered'
);

SELECT has_function(
  'api',
  'ui_test_mapping_config_v1',
  ARRAY['uuid', 'jsonb'],
  'api.ui_test_mapping_config_v1(uuid, jsonb) browser wrapper is registered'
);

SELECT is(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'ui_test_mapping_config_v1'
    LIMIT 1),
  true,
  'public.ui_test_mapping_config_v1 is SECURITY DEFINER'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.ui_test_mapping_config_v1(uuid, jsonb)', 'EXECUTE'),
  'authenticated can execute api.ui_test_mapping_config_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_test_mapping_config_v1(uuid, jsonb)', 'EXECUTE'),
  'anon cannot execute api.ui_test_mapping_config_v1'
);

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES
  (
    'mapping_operation_report_artifact_type',
    'Mapping operation report artifact type taxonomy.',
    'engineering',
    'tier_2',
    TRUE
  ),
  (
    'mapping_operation_report_operation_kind',
    'Mapping operation report operation kind taxonomy.',
    'engineering',
    'tier_2',
    TRUE
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, false, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('mapping_operation_report_artifact_type', 'mapping_config', 'Mapping Config', 50),
    ('mapping_operation_report_operation_kind', 'mapping_test', 'Mapping Test', 30)
) AS v(category, value, label, sort_order)
  ON v.category = d.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'mapping_operation_report_artifact_type'
      AND v.value = 'mapping_config'
      AND v.status = 'active'
  ),
  'mapping_config operation-report artifact type is seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'mapping_operation_report_operation_kind'
      AND v.value = 'mapping_test'
      AND v.status = 'active'
  ),
  'mapping_test operation-report kind is seeded'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'ui_test_mapping_config_v1'
      AND pg_get_functiondef(p.oid) LIKE '%v_safe_input := public.redact_sensitive_json%'
      AND pg_get_functiondef(p.oid) LIKE '%v_safe_output := public.redact_sensitive_json%'
  ),
  'mapping tester redacts sensitive input and output before browser readback'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'ui_test_mapping_config_v1'
      AND pg_get_functiondef(p.oid) LIKE '%''result_payload'', jsonb_build_object(%'
      AND pg_get_functiondef(p.oid) LIKE '%''input'', v_safe_input%'
      AND pg_get_functiondef(p.oid) LIKE '%''output'', v_safe_output%'
      AND pg_get_functiondef(p.oid) LIKE '%''transformed_payload'', v_safe_output%'
  ),
  'mapping tester persists and returns only redacted result payload evidence'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'ui_test_mapping_config_v1'
      AND pg_get_functiondef(p.oid) LIKE '%v_error := ''mapping_test_execution_failed''%'
      AND pg_get_functiondef(p.oid) LIKE '%''error'', v_error%'
      AND pg_get_functiondef(p.oid) LIKE '%''error_state'', v_error_state%'
      AND pg_get_functiondef(p.oid) NOT LIKE '%v_error := SQLERRM%'
  ),
  'mapping tester normalizes failed-run error readback instead of returning raw SQLERRM'
);

SELECT throws_ok(
  $$ SELECT api.ui_test_mapping_config_v1(NULL, '{}'::jsonb) $$,
  '42501',
  NULL,
  'unauthenticated callers fail closed before mapping execution'
);

SELECT * FROM finish();
ROLLBACK;
